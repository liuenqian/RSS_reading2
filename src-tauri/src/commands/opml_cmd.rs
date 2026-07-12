use crate::db::DbState;
use crate::services::opml_service::{self, OpmlImportReport};
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn export_opml(state: State<DbState>, path: String) -> Result<usize, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    opml_service::export_opml(&conn, &PathBuf::from(path))
}

#[tauri::command]
pub fn import_opml(state: State<DbState>, path: String) -> Result<OpmlImportReport, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    opml_service::import_opml(&conn, &PathBuf::from(path))
}
