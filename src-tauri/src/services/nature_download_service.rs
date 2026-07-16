use crate::models::{NatureDownloadItem, NatureDownloadReport};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use tokio::time::{sleep, Duration};

const MAX_DOWNLOAD_ITEMS: usize = 20;

pub async fn download(
    script: &Path,
    proxy_script: &Path,
    app_data_dir: &Path,
    items: &[NatureDownloadItem],
    output_dir: &str,
    open_access: bool,
) -> Result<NatureDownloadReport, String> {
    let items = normalize_items(items)?;
    let output_dir = PathBuf::from(output_dir.trim());
    if output_dir.as_os_str().is_empty() {
        return Err("请选择 PDF 保存文件夹".to_string());
    }
    if !output_dir.is_dir() {
        return Err("PDF 保存文件夹不存在".to_string());
    }
    if !script.is_file() {
        return Err("内置 nature-downloader 脚本缺失，请重新安装应用".to_string());
    }
    let node = find_node().await?;
    if !open_access {
        ensure_cdp_proxy(&node, proxy_script, app_data_dir).await?;
    }
    let mut results = Vec::new();
    let output_path = output_dir.to_string_lossy().to_string();

    for item in &items {
        results.extend(run_item_downloader(&node, script, item, &output_path, open_access).await?);
    }

    let downloaded = results
        .iter()
        .filter(|result| {
            matches!(
                result.get("status").and_then(Value::as_str),
                Some("downloaded" | "downloaded_with_si" | "open_access_downloaded")
            )
        })
        .count();
    let needs_user_action = results
        .iter()
        .filter(|result| {
            result
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| {
                    status.contains("waiting_user") || status == "verification_auto_failed"
                })
        })
        .count();
    Ok(NatureDownloadReport {
        total: items.len(),
        downloaded,
        needs_user_action,
        output_dir: output_dir.to_string_lossy().to_string(),
        results,
    })
}

async fn ensure_cdp_proxy(
    node: &Path,
    proxy_script: &Path,
    app_data_dir: &Path,
) -> Result<(), String> {
    if endpoint_ready("http://127.0.0.1:3456/targets").await {
        return Ok(());
    }
    if !proxy_script.is_file() {
        return Err("内置 Chrome 下载代理缺失，请重新安装应用".to_string());
    }
    if !endpoint_ready("http://127.0.0.1:9222/json/version").await {
        start_download_chrome(app_data_dir).await?;
        wait_for_endpoint("http://127.0.0.1:9222/json/version", 12).await?;
    }
    Command::new(node)
        .arg(proxy_script)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动内置 Chrome 下载代理失败: {}", e))?;
    wait_for_endpoint("http://127.0.0.1:3456/targets", 8).await
}

async fn endpoint_ready(url: &str) -> bool {
    reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

async fn wait_for_endpoint(url: &str, attempts: usize) -> Result<(), String> {
    for _ in 0..attempts {
        if endpoint_ready(url).await {
            return Ok(());
        }
        sleep(Duration::from_millis(500)).await;
    }
    Err("无法启动 Chrome 下载会话；请确认已安装 Google Chrome 后重试".to_string())
}

#[cfg(target_os = "macos")]
async fn start_download_chrome(app_data_dir: &Path) -> Result<(), String> {
    let profile = app_data_dir
        .join("nature-downloader")
        .join("chrome-profile");
    std::fs::create_dir_all(&profile)
        .map_err(|e| format!("创建 Chrome 下载配置目录失败: {}", e))?;
    Command::new("open")
        .args([
            "-na",
            "Google Chrome",
            "--args",
            "--remote-debugging-port=9222",
        ])
        .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
        .spawn()
        .map_err(|e| format!("启动 Chrome 下载会话失败: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
async fn start_download_chrome(app_data_dir: &Path) -> Result<(), String> {
    let profile = app_data_dir
        .join("nature-downloader")
        .join("chrome-profile");
    std::fs::create_dir_all(&profile)
        .map_err(|e| format!("创建 Chrome 下载配置目录失败: {}", e))?;
    Command::new("cmd")
        .args(["/C", "start", "", "chrome", "--remote-debugging-port=9222"])
        .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
        .spawn()
        .map_err(|e| format!("启动 Chrome 下载会话失败: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn start_download_chrome(app_data_dir: &Path) -> Result<(), String> {
    let profile = app_data_dir
        .join("nature-downloader")
        .join("chrome-profile");
    std::fs::create_dir_all(&profile)
        .map_err(|e| format!("创建 Chrome 下载配置目录失败: {}", e))?;
    Command::new("google-chrome")
        .arg("--remote-debugging-port=9222")
        .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
        .spawn()
        .map_err(|e| format!("启动 Chrome 下载会话失败: {}", e))?;
    Ok(())
}

fn normalize_items(items: &[NatureDownloadItem]) -> Result<Vec<NatureDownloadItem>, String> {
    if items.is_empty() {
        return Err("请至少选择 1 篇文献".to_string());
    }
    if items.len() > MAX_DOWNLOAD_ITEMS {
        return Err(format!(
            "nature-downloader 单次最多支持 {} 篇文献",
            MAX_DOWNLOAD_ITEMS
        ));
    }
    items
        .iter()
        .map(|item| {
            let title = item.title.trim().to_string();
            if title.is_empty() {
                return Err("下载文献缺少标题".to_string());
            }
            Ok(NatureDownloadItem {
                title,
                doi: item
                    .doi
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string),
                pmid: item
                    .pmid
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string),
                pmcid: item
                    .pmcid
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string),
            })
        })
        .collect()
}

async fn run_item_downloader(
    node: &Path,
    script: &Path,
    item: &NatureDownloadItem,
    output_path: &str,
    open_access: bool,
) -> Result<Vec<Value>, String> {
    let has_identifier = item.doi.is_some() || item.pmid.is_some() || item.pmcid.is_some();
    let mut args = vec!["--title", item.title.as_str()];
    if let Some(doi) = item.doi.as_deref() {
        args.extend(["--doi", doi]);
    }
    if let Some(pmid) = item.pmid.as_deref() {
        args.extend(["--pmid", pmid]);
    }
    if let Some(pmcid) = item.pmcid.as_deref() {
        args.extend(["--pmcid", pmcid]);
    }
    if open_access {
        args.push("--open-access");
    } else if !has_identifier {
        args.extend(["--topic", item.title.as_str(), "--count", "1"]);
    }
    args.extend(["--out", output_path]);
    run_downloader(node, script, &args).await
}

async fn find_node() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("NODE_BINARY") {
        candidates.push(PathBuf::from(path));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("node"),
    ]);
    for candidate in candidates {
        if let Ok(output) = Command::new(&candidate).arg("--version").output().await {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout);
                let major = version
                    .trim()
                    .trim_start_matches('v')
                    .split('.')
                    .next()
                    .and_then(|value| value.parse::<u32>().ok());
                if major.is_some_and(|value| value >= 22) {
                    return Ok(candidate);
                }
            }
        }
    }
    Err(
        "nature-downloader 需要 Node.js 22 或更高版本；请安装 Node.js，或通过 NODE_BINARY 指定路径"
            .to_string(),
    )
}

async fn run_downloader(node: &Path, script: &Path, args: &[&str]) -> Result<Vec<Value>, String> {
    let output = Command::new(node)
        .arg(script)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("启动 nature-downloader 失败: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "nature-downloader 运行失败: {}",
            stderr
                .lines()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    let payload: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("解析 nature-downloader 结果失败: {}", e))?;
    Ok(payload
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_download_batch_size_and_metadata() {
        assert!(normalize_items(&[]).is_err());
        let too_many = (0..=MAX_DOWNLOAD_ITEMS)
            .map(|index| NatureDownloadItem {
                title: format!("Paper {}", index),
                doi: None,
                pmid: None,
                pmcid: None,
            })
            .collect::<Vec<_>>();
        assert!(normalize_items(&too_many).is_err());
        let one = normalize_items(&[NatureDownloadItem {
            title: "  Paper  ".to_string(),
            doi: Some(" 10.1000/test ".to_string()),
            pmid: Some(" 42 ".to_string()),
            pmcid: Some(" PMC99 ".to_string()),
        }])
        .unwrap();
        assert_eq!(one[0].title, "Paper");
        assert_eq!(one[0].doi.as_deref(), Some("10.1000/test"));
        assert_eq!(one[0].pmid.as_deref(), Some("42"));
        assert_eq!(one[0].pmcid.as_deref(), Some("PMC99"));
    }
}
