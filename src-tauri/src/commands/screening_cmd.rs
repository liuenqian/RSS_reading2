use crate::db::DbState;
use crate::services::pubmed_search_service;
use crate::services::screening_scope_service::{
    self, ScreeningPage, ScreeningScopeRequest, ScreeningSelection, ScreeningSort,
};
use crate::services::screening_state_service::{
    self, FeedScreeningState, ScreeningTablePreferences, StarredMigrationReport,
};
use crate::services::screening_xlsx_service;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedScreeningWorkbook {
    pub scope_id: i64,
    pub name: String,
    pub path: String,
    pub article_count: usize,
    pub created: bool,
}

#[tauri::command]
pub fn open_screening_window(
    app: AppHandle,
    scope_kind: String,
    scope_id: i64,
) -> Result<(), String> {
    if !matches!(scope_kind.as_str(), "pubmed" | "feed") || scope_id <= 0 {
        return Err("初筛范围不正确".to_string());
    }
    let label = format!("screening-{scope_kind}-{scope_id}");
    if let Some(window) = app.get_webview_window(&label) {
        window
            .show()
            .map_err(|error| format!("显示初筛窗口失败: {error}"))?;
        let _ = window.unminimize();
        window
            .set_focus()
            .map_err(|error| format!("聚焦初筛窗口失败: {error}"))?;
        window
            .eval("window.location.reload()")
            .map_err(|error| format!("刷新初筛窗口失败: {error}"))?;
        return Ok(());
    }
    let url = format!("index.html?screeningScope={scope_kind}&screeningId={scope_id}");
    let title = if scope_kind == "pubmed" {
        "PubMed 初筛工作台"
    } else {
        "RSS 初筛工作台"
    };
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1580.0, 900.0)
        .min_inner_size(1100.0, 650.0)
        .resizable(true)
        .build()
        .map_err(|error| format!("创建初筛窗口失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_screening_xlsx(app: AppHandle, path: String) -> Result<(), String> {
    let workbook_path = Path::new(&path);
    let is_xlsx = workbook_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("xlsx"));
    if !is_xlsx {
        return Err("只能打开初筛 Excel (.xlsx) 文件".to_string());
    }
    if !workbook_path.is_file() {
        return Err("已绑定的 Excel 文件不存在或已移动，请重新选择文件".to_string());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error| format!("打开 Excel 文件失败: {error}"))
}

#[tauri::command]
pub fn list_starred_entry_ids(state: State<DbState>) -> Result<Vec<i64>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::list_starred_entry_ids(&conn)
}

#[tauri::command]
pub fn migrate_legacy_starred_ids(
    state: State<DbState>,
    entry_ids: Vec<i64>,
) -> Result<StarredMigrationReport, String> {
    let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::migrate_legacy_starred_ids(&mut conn, &entry_ids)
}

#[tauri::command]
pub fn set_entry_starred(
    state: State<DbState>,
    entry_id: i64,
    is_starred: bool,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::set_entry_starred(&conn, entry_id, is_starred)
}

#[tauri::command]
pub fn bulk_set_entries_starred(
    state: State<DbState>,
    entry_ids: Vec<i64>,
    is_starred: bool,
) -> Result<usize, String> {
    let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::bulk_set_entries_starred(&mut conn, &entry_ids, is_starred)
}

#[tauri::command]
pub fn set_feed_screening_state(
    state: State<DbState>,
    feed_id: i64,
    entry_id: i64,
    status: String,
    exclusion_reason: Option<String>,
    screening_note: Option<String>,
) -> Result<FeedScreeningState, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::set_feed_screening_state(
        &conn,
        feed_id,
        entry_id,
        &status,
        exclusion_reason.as_deref(),
        screening_note.as_deref(),
    )
}

#[tauri::command]
pub fn list_feed_screening_states(
    state: State<DbState>,
    feed_id: i64,
) -> Result<std::collections::HashMap<i64, FeedScreeningState>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::list_feed_screening_states(&conn, feed_id)
}

#[tauri::command]
pub fn query_screening_scope(
    state: State<DbState>,
    request: ScreeningScopeRequest,
) -> Result<ScreeningPage, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_scope_service::query_scope(&conn, &request)
}

#[tauri::command]
pub fn resolve_screening_selection(
    state: State<DbState>,
    scope_kind: String,
    scope_id: i64,
    selection: ScreeningSelection,
    sorts: Vec<ScreeningSort>,
) -> Result<Vec<i64>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_scope_service::resolve_selection(&conn, &scope_kind, scope_id, &selection, &sorts)
}

#[tauri::command]
pub fn get_screening_table_preferences(
    state: State<DbState>,
    scope_kind: String,
    scope_id: i64,
) -> Result<Option<ScreeningTablePreferences>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::get_table_preferences(&conn, &scope_kind, scope_id)
}

#[tauri::command]
pub fn list_screening_table_preferences(
    state: State<DbState>,
) -> Result<Vec<ScreeningTablePreferences>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::list_table_preferences(&conn)
}

#[tauri::command]
pub fn save_screening_table_preferences(
    state: State<DbState>,
    scope_kind: String,
    scope_id: i64,
    schema_version: i64,
    config_json: String,
) -> Result<ScreeningTablePreferences, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_state_service::save_table_preferences(
        &conn,
        &scope_kind,
        scope_id,
        schema_version,
        &config_json,
    )
}

#[tauri::command]
pub fn export_screening_xlsx(
    state: State<DbState>,
    path: String,
    scope_kind: String,
    scope_id: i64,
    selection: ScreeningSelection,
    sorts: Vec<ScreeningSort>,
) -> Result<screening_xlsx_service::ScreeningXlsxExportReport, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_xlsx_service::export_xlsx(
        &conn,
        &PathBuf::from(path),
        &scope_kind,
        scope_id,
        &selection,
        &sorts,
    )
}

#[tauri::command]
pub fn ensure_pubmed_screening_workbooks(
    app: AppHandle,
    state: State<DbState>,
) -> Result<Vec<ManagedScreeningWorkbook>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取初筛工作簿目录: {error}"))?
        .join("screening-workbooks");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建初筛工作簿目录: {error}"))?;
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let searches = pubmed_search_service::list_searches(&conn)?;
    let sorts = vec![ScreeningSort {
        field: "publication".to_string(),
        direction: "desc".to_string(),
    }];
    searches
        .into_iter()
        .map(|search| {
            let path = directory.join(format!("pubmed-{}-screening.xlsx", search.id));
            let created = !path.is_file();
            if created {
                screening_xlsx_service::export_xlsx(
                    &conn,
                    &path,
                    "pubmed",
                    search.id,
                    &ScreeningSelection::AllFiltered {
                        filters: Default::default(),
                        excluded_entry_ids: vec![],
                    },
                    &sorts,
                )?;
            }
            Ok(ManagedScreeningWorkbook {
                scope_id: search.id,
                name: format!("{} · 初筛.xlsx", search.name),
                path: path.to_string_lossy().to_string(),
                article_count: usize::try_from(search.total_entries).unwrap_or(0),
                created,
            })
        })
        .collect()
}

#[tauri::command]
pub fn preview_screening_xlsx_import(
    state: State<DbState>,
    path: String,
    scope_kind: String,
    scope_id: i64,
) -> Result<screening_xlsx_service::ScreeningImportPreview, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_xlsx_service::preview_import(&conn, &PathBuf::from(path), &scope_kind, scope_id)
}

#[tauri::command]
pub fn apply_screening_xlsx_import(
    state: State<DbState>,
    scope_kind: String,
    scope_id: i64,
    candidates: Vec<screening_xlsx_service::ScreeningImportCandidate>,
    resolutions: HashMap<String, String>,
) -> Result<screening_xlsx_service::ScreeningImportReport, String> {
    let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
    screening_xlsx_service::apply_import(
        &mut conn,
        &scope_kind,
        scope_id,
        &candidates,
        &resolutions,
    )
}
