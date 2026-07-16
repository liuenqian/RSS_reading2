// Update checker.
//
// Reads a JSON manifest from
//   https://github.com/<owner>/<repo>/releases/latest/download/latest.json
// which GitHub serves as a CDN-backed stable redirect to the `latest.json`
// asset attached to the most recent published (non-prerelease) release.
// The manifest is produced by `.github/workflows/publish-manifest.yml`
// whenever a release is published.
//
// Why this URL instead of api.github.com:
//   The anonymous REST API limits to 60 requests/hour/IP. Behind shared
//   egress (CGNAT, corporate NAT, VPN, mobile carrier — common in China)
//   that budget gets split across many users, so a non-trivial fraction
//   of update checks would fail with 403 "rate limit exceeded". The
//   `releases/latest/download/` redirect has no such per-IP cap, so the
//   check stays reliable no matter how the user's network is configured.
//
// Manifest may be missing or stale (CDN propagation, brand-new release
// before the workflow finishes, GitHub outage). We cache the last good
// result in the `settings` table and fall back to it on any failure, so
// the UI never shows a raw error to the user under normal conditions.

use crate::db::DbState;
use crate::models::{UpdateDownloadProgress, UpdateDownloadResult, UpdateInfo};
use reqwest::Client;
use rusqlite::Connection;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;
use tracing::warn;

const REPO_OWNER: &str = "liuenqian";
const REPO_NAME: &str = "RSS_reading2";

const CACHE_KEY: &str = "update_release_cache";
pub const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "update-download-progress";

fn manifest_url() -> String {
    format!(
        "https://github.com/{}/{}/releases/latest/download/latest.json",
        REPO_OWNER, REPO_NAME
    )
}

fn releases_page_url() -> String {
    format!("https://github.com/{}/{}/releases", REPO_OWNER, REPO_NAME)
}

fn unavailable_update_info(current_version: String) -> UpdateInfo {
    UpdateInfo {
        current_version: current_version.clone(),
        latest_version: current_version,
        has_update: false,
        source_available: false,
        release_url: releases_page_url(),
        release_notes: None,
        asset_name: None,
        asset_url: None,
    }
}

#[derive(Deserialize)]
struct ReleaseManifest {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<ManifestAsset>,
}

#[derive(Deserialize)]
struct ManifestAsset {
    name: String,
    browser_download_url: String,
}

fn pick_asset(assets: &[ManifestAsset]) -> Option<(String, String)> {
    pick_asset_for_target(assets, std::env::consts::OS, std::env::consts::ARCH)
}

fn pick_asset_for_target(
    assets: &[ManifestAsset],
    target_os: &str,
    target_arch: &str,
) -> Option<(String, String)> {
    let is_installer = |asset: &&ManifestAsset| {
        let name = asset.name.to_lowercase();
        match target_os {
            "macos" => name.ends_with(".dmg"),
            "windows" => {
                name.ends_with(".msi")
                    || name.ends_with("-setup.exe")
                    || name.ends_with("_setup.exe")
            }
            "linux" => name.ends_with(".appimage"),
            _ => false,
        }
    };

    let arch_markers: &[&str] = match target_arch {
        "aarch64" => &["aarch64", "arm64"],
        "x86_64" => &["x86_64", "amd64", "x64"],
        "x86" | "i686" => &["i686", "x86"],
        _ => &[],
    };
    let known_arch_markers = ["aarch64", "arm64", "x86_64", "amd64", "x64", "i686"];

    let installers: Vec<&ManifestAsset> = assets.iter().filter(is_installer).collect();
    let picked = installers
        .iter()
        .copied()
        .find(|asset| {
            let name = asset.name.to_lowercase();
            arch_markers.iter().any(|marker| name.contains(marker))
        })
        .or_else(|| {
            installers.iter().copied().find(|asset| {
                let name = asset.name.to_lowercase();
                name.contains("universal")
                    || !known_arch_markers
                        .iter()
                        .any(|marker| name.contains(marker))
            })
        });

    picked.map(|a| (a.name.clone(), a.browser_download_url.clone()))
}

fn parse_release_version(tag: &str) -> Option<String> {
    let version = tag.trim().strip_prefix('v').unwrap_or(tag.trim());
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some(version.to_string())
}

fn asset_filename_from_url(url: &str) -> String {
    let no_query = url.split('?').next().unwrap_or(url);
    no_query
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("RSS Reading Update.dmg")
        .to_string()
}

fn percent(downloaded: u64, total: Option<u64>) -> Option<f64> {
    total
        .filter(|total| *total > 0)
        .map(|total| (downloaded as f64 / total as f64) * 100.0)
}

pub async fn check(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let client = Client::builder()
        .user_agent(format!(
            "RSSReading/{} (https://github.com/{}/{})",
            current_version, REPO_OWNER, REPO_NAME
        ))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("无法创建网络客户端: {}", e))?;

    let response = match client.get(manifest_url()).send().await {
        Ok(r) => r,
        Err(e) => {
            // Network failed — surface the cache if we have one.
            if let Some(info) = read_cache(app, &current_version) {
                warn!(error = %e, "更新检查网络失败，使用缓存结果");
                return Ok(info);
            }
            return Err(format!("无法访问 GitHub: {}", e));
        }
    };

    let status = response.status();

    // 404 = the release manifest is not reachable yet: wrong repo name,
    // private/missing repo, or a published release without `latest.json`.
    // Surface this explicitly so the UI does not mislead the user with
    // "已是最新版".
    if status.as_u16() == 404 {
        return Ok(unavailable_update_info(current_version));
    }

    if !status.is_success() {
        if let Some(info) = read_cache(app, &current_version) {
            warn!("GitHub 返回 {}，使用缓存结果", status.as_u16());
            return Ok(info);
        }
        return Err(format!("GitHub 返回 {}", status.as_u16()));
    }

    let manifest: ReleaseManifest = match response.json().await {
        Ok(m) => m,
        Err(e) => {
            if let Some(info) = read_cache(app, &current_version) {
                warn!(error = %e, "解析更新清单失败，使用缓存结果");
                return Ok(info);
            }
            return Err(format!("解析更新清单失败: {}", e));
        }
    };

    let latest_version = parse_release_version(&manifest.tag_name)
        .ok_or_else(|| format!("更新清单版本号无效：{}（应为 v1.2.3）", manifest.tag_name))?;
    let has_update = is_newer(&latest_version, &current_version);

    let asset = pick_asset(&manifest.assets);
    let (asset_name, asset_url) = match asset {
        Some((name, url)) => (Some(name), Some(url)),
        None => (None, None),
    };

    let info = UpdateInfo {
        current_version,
        latest_version,
        has_update,
        source_available: true,
        release_url: manifest.html_url,
        release_notes: manifest.body,
        asset_name,
        asset_url,
    };

    write_cache(app, &info);

    Ok(info)
}

pub async fn download_installer(app: &AppHandle) -> Result<UpdateDownloadResult, String> {
    let info = check(app).await?;
    if !info.source_available {
        return Err("更新源暂不可用，请稍后重试".to_string());
    }
    if !info.has_update {
        return Err(format!("当前已是最新版（v{}）", info.current_version));
    }

    let asset_url = info
        .asset_url
        .clone()
        .ok_or_else(|| "当前版本缺少可下载的安装包，请前往发布页下载".to_string())?;
    let file_name = info
        .asset_name
        .clone()
        .unwrap_or_else(|| asset_filename_from_url(&asset_url));

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("无法定位下载目录: {}", e))?
        .join("RSS Reading Updates");
    fs::create_dir_all(&download_dir)
        .await
        .map_err(|e| format!("无法创建更新下载目录: {}", e))?;

    let final_path = download_dir.join(&file_name);
    let temp_path = final_path.with_extension(format!(
        "{}.download",
        final_path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("tmp")
    ));

    let client = Client::builder()
        .user_agent(format!(
            "RSSReading/{} (https://github.com/{}/{})",
            info.current_version, REPO_OWNER, REPO_NAME
        ))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("无法创建下载客户端: {}", e))?;

    let mut response = client
        .get(&asset_url)
        .send()
        .await
        .map_err(|e| format!("下载更新包失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "下载更新包失败：GitHub 返回 {}",
            response.status().as_u16()
        ));
    }

    let total = response.content_length();
    emit_download_progress(app, 0, total);

    let mut file = File::create(&temp_path)
        .await
        .map_err(|e| format!("无法创建更新文件: {}", e))?;
    let mut downloaded = 0_u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("下载更新包失败: {}", e))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入更新文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        emit_download_progress(app, downloaded, total);
    }

    file.flush()
        .await
        .map_err(|e| format!("保存更新文件失败: {}", e))?;
    drop(file);

    fs::rename(&temp_path, &final_path)
        .await
        .map_err(|e| format!("保存更新文件失败: {}", e))?;

    emit_download_progress(app, downloaded, total.or(Some(downloaded)));

    Ok(UpdateDownloadResult {
        local_path: final_path.to_string_lossy().to_string(),
        file_name,
    })
}

pub fn open_downloaded_installer(app: &AppHandle, path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_path(path.to_string(), None::<&str>)
        .map_err(|e| format!("无法打开安装包: {}", e))
}

pub fn reveal_downloaded_installer(app: &AppHandle, path: &str) -> Result<(), String> {
    use std::path::Path;
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .reveal_item_in_dir(Path::new(path))
        .map_err(|e| format!("无法在文件管理器中定位安装包: {}", e))
}

fn emit_download_progress(app: &AppHandle, downloaded_bytes: u64, total_bytes: Option<u64>) {
    let _ = app.emit(
        UPDATE_DOWNLOAD_PROGRESS_EVENT,
        UpdateDownloadProgress {
            downloaded_bytes,
            total_bytes,
            percent: percent(downloaded_bytes, total_bytes),
        },
    );
}

/// Loose semver-style compare: split on `.`, compare numerically per component.
/// Non-numeric suffixes (e.g. `0.2.0-beta.1`) are stripped before parsing so
/// `0.2.0-beta.1` is treated as `0.2.0` — good enough for the kind of tagging
/// Cento will use, and never reports a downgrade as an update.
fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        let core = s.split_once('-').map(|(prefix, _)| prefix).unwrap_or(s);
        core.split('.')
            .map(|p| {
                let cut = p.find(|c: char| !c.is_ascii_digit()).unwrap_or(p.len());
                p[..cut].parse().unwrap_or(0)
            })
            .collect()
    };
    let a = parse(candidate);
    let b = parse(current);
    let n = a.len().max(b.len());
    for i in 0..n {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return av > bv;
        }
    }
    false
}

// ── Cache helpers ───────────────────────────────────────

fn read_cache(app: &AppHandle, current_version: &str) -> Option<UpdateInfo> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().ok()?;
    let raw = read_setting(&conn, CACHE_KEY)?;
    let mut info: UpdateInfo = serde_json::from_str(&raw).ok()?;
    // `has_update` was computed against the version that was current when
    // the cache was written. If the app has been upgraded since, that
    // decision is stale — recompute.
    info.current_version = current_version.to_string();
    info.has_update = is_newer(&info.latest_version, current_version);
    Some(info)
}

fn write_cache(app: &AppHandle, info: &UpdateInfo) {
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else { return };
    if let Ok(json) = serde_json::to_string(info) {
        let _ = write_setting(&conn, CACHE_KEY, &json);
    }
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .ok()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        [key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> ManifestAsset {
        ManifestAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.test/{name}"),
        }
    }

    #[test]
    fn picks_windows_nsis_installer_for_x64() {
        let assets = vec![
            asset("RSS.Reading_1.1.0_aarch64.dmg"),
            asset("RSS.Reading_1.1.0_x64-setup.exe"),
        ];

        let picked = pick_asset_for_target(&assets, "windows", "x86_64").unwrap();

        assert_eq!(picked.0, "RSS.Reading_1.1.0_x64-setup.exe");
    }

    #[test]
    fn picks_matching_macos_architecture() {
        let assets = vec![
            asset("RSS.Reading_1.1.0_x64.dmg"),
            asset("RSS.Reading_1.1.0_aarch64.dmg"),
        ];

        let picked = pick_asset_for_target(&assets, "macos", "aarch64").unwrap();

        assert_eq!(picked.0, "RSS.Reading_1.1.0_aarch64.dmg");
    }

    #[test]
    fn never_falls_back_to_wrong_architecture() {
        let assets = vec![asset("RSS.Reading_1.1.0_x64.dmg")];

        assert!(pick_asset_for_target(&assets, "macos", "aarch64").is_none());
    }

    #[test]
    fn validates_release_versions() {
        assert_eq!(parse_release_version("v1.2.3"), Some("1.2.3".to_string()));
        assert_eq!(parse_release_version("1.2.3"), Some("1.2.3".to_string()));
        assert_eq!(parse_release_version("main"), None);
        assert_eq!(parse_release_version("v1.2"), None);
    }

    #[test]
    fn detects_newer_minor() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
    }
    #[test]
    fn rejects_same_or_older() {
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
    }
    #[test]
    fn handles_prerelease_suffix() {
        assert!(!is_newer("0.1.0-beta.1", "0.1.0"));
        assert!(is_newer("0.2.0-beta.1", "0.1.0"));
    }

    #[test]
    fn unavailable_source_is_not_reported_as_latest() {
        let info = unavailable_update_info("1.0.0".to_string());
        assert!(!info.has_update);
        assert!(!info.source_available);
        assert_eq!(info.current_version, "1.0.0");
        assert_eq!(info.latest_version, "1.0.0");
    }
}

/// Run a check and, if an update is found, fire a system notification.
/// Caller is responsible for deciding *when* to run this; see
/// `scheduler::start_update_checker`.
pub async fn check_and_notify_if_update(app: &tauri::AppHandle) {
    use tauri::Emitter;

    match check(app).await {
        Ok(info) => {
            // Always emit to the frontend so the about card can refresh its
            // "last checked" timestamp and version line.
            let _ = app.emit("update-checked", &info);
            if info.has_update {
                let body = format!(
                    "RSS Reading {} 已发布，当前版本 {}。前往设置 → 其他设置查看下载。",
                    info.latest_version, info.current_version
                );
                if let Err(e) = crate::services::notify::show(app, "RSS Reading 有新版本", &body)
                {
                    warn!(error = %e, "发送更新通知失败");
                }
            }
        }
        Err(e) => {
            warn!(error = %e, "更新检查失败");
        }
    }
}
