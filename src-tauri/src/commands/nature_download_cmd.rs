use crate::models::{NatureDownloadItem, NatureDownloadReport};
use crate::services::nature_download_service;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn download_papers_with_nature(
    app: AppHandle,
    items: Vec<NatureDownloadItem>,
    output_dir: String,
    open_access: bool,
) -> Result<NatureDownloadReport, String> {
    let script = app
        .path()
        .resolve(
            "resources/nature-skills/nature-downloader/scripts/batch_download.mjs",
            BaseDirectory::Resource,
        )
        .map_err(|e| format!("定位内置 nature-downloader 失败: {}", e))?;
    let proxy_script = app
        .path()
        .resolve(
            "resources/nature-skills/nature-downloader/scripts/cento_cdp_proxy.mjs",
            BaseDirectory::Resource,
        )
        .map_err(|e| format!("定位内置浏览器代理失败: {}", e))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("定位应用数据目录失败: {}", e))?;
    nature_download_service::download(
        &script,
        &proxy_script,
        &app_data_dir,
        &items,
        &output_dir,
        open_access,
    )
    .await
}
