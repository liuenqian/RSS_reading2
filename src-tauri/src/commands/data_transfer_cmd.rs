use crate::db::DbState;
use crate::services::data_transfer_service::{
    self, TransferExportReport, TransferImportReport, TransferPreview,
};
use std::path::{Path, PathBuf};
use tauri::State;

fn paths_match(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

#[tauri::command]
pub fn export_transfer_database(
    state: State<'_, DbState>,
    path: String,
) -> Result<TransferExportReport, String> {
    let target = PathBuf::from(path);
    if paths_match(&target, &state.db_path) {
        return Err("不能把迁移包保存到当前应用数据库位置".to_string());
    }
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    data_transfer_service::export_transfer_database(&conn, &target)
}

#[tauri::command]
pub fn preview_transfer_database(
    state: State<'_, DbState>,
    path: String,
) -> Result<TransferPreview, String> {
    let source = PathBuf::from(path);
    if paths_match(&source, &state.db_path) {
        return Err("不能把当前正在使用的数据库作为迁移包导入".to_string());
    }
    data_transfer_service::preview_transfer_database(&source)
}

#[tauri::command]
pub fn import_transfer_database(
    state: State<'_, DbState>,
    path: String,
) -> Result<TransferImportReport, String> {
    let source = PathBuf::from(path);
    if paths_match(&source, &state.db_path) {
        return Err("不能把当前正在使用的数据库作为迁移包导入".to_string());
    }
    let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
    data_transfer_service::import_transfer_database(&mut conn, &state.db_path, &source)
}
