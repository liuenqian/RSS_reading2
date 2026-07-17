use crate::db::DbState;
use crate::models::{
    KeptPubmedEntry, PubmedArticleRecord, PubmedExportMetric, PubmedPreviewAssessment,
    PubmedRetrievalOptions, PubmedScreeningSuggestion, PubmedSearch, PubmedSearchEntry,
    PubmedSearchPreview, PubmedSearchRunResult,
};
use crate::services::{
    cost_service, google_translate_xlsx_service, pubmed_search_service, settings_service,
    translation_pipeline,
};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn preview_pubmed_search(
    query: String,
    options: PubmedRetrievalOptions,
) -> Result<PubmedSearchPreview, String> {
    pubmed_search_service::preview_query(&query, &options).await
}

#[tauri::command]
pub async fn assess_pubmed_search_preview(
    state: State<'_, DbState>,
    question: String,
    query: String,
    entries: Vec<PubmedArticleRecord>,
) -> Result<PubmedPreviewAssessment, String> {
    let settings = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        settings_service::get_settings(&conn)
    };
    if settings.api_key.trim().is_empty() {
        return Err("请先在设置里配置当前 AI 服务的 API Key，再进行 AI 初判".to_string());
    }

    let (assessment, usage) =
        pubmed_search_service::assess_preview(&settings, &question, &query, &entries).await?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    Ok(assessment)
}

#[tauri::command]
pub fn create_pubmed_search(
    state: State<DbState>,
    name: String,
    question: Option<String>,
    query: String,
    options: PubmedRetrievalOptions,
) -> Result<PubmedSearch, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::create_search_with_options(
        &conn,
        &name,
        question.as_deref(),
        &query,
        &options,
    )
}

#[tauri::command]
pub fn list_pubmed_searches(state: State<DbState>) -> Result<Vec<PubmedSearch>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::list_searches(&conn)
}

#[tauri::command]
pub fn get_pubmed_search(state: State<DbState>, id: i64) -> Result<PubmedSearch, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::get_search(&conn, id)
}

#[tauri::command]
pub fn clone_pubmed_search(
    state: State<DbState>,
    id: i64,
    name: String,
) -> Result<PubmedSearch, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::clone_search(&conn, id, &name)
}

#[tauri::command]
pub fn rename_pubmed_search(state: State<DbState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::rename_search(&conn, id, &name)
}

#[tauri::command]
pub fn update_pubmed_search(
    state: State<DbState>,
    id: i64,
    name: String,
    question: Option<String>,
    query: String,
    options: PubmedRetrievalOptions,
) -> Result<PubmedSearch, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::update_search_with_options(
        &conn,
        id,
        &name,
        question.as_deref(),
        &query,
        &options,
    )
}

#[tauri::command]
pub fn delete_pubmed_search(state: State<DbState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::delete_search(&conn, id)
}

#[tauri::command]
pub async fn run_pubmed_search(
    app: AppHandle,
    state: State<'_, DbState>,
    search_id: i64,
) -> Result<PubmedSearchRunResult, String> {
    let result = pubmed_search_service::run_search(&app, state.inner(), search_id, None).await?;
    translation_pipeline::spawn(app);
    Ok(result)
}

#[tauri::command]
pub async fn resume_pubmed_search_run(
    app: AppHandle,
    state: State<'_, DbState>,
    run_id: i64,
) -> Result<PubmedSearchRunResult, String> {
    let search_id = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        pubmed_search_service::search_id_for_run(&conn, run_id)?
    };
    let result =
        pubmed_search_service::run_search(&app, state.inner(), search_id, Some(run_id)).await?;
    translation_pipeline::spawn(app);
    Ok(result)
}

#[tauri::command]
pub fn cancel_pubmed_search_run(state: State<DbState>, run_id: i64) -> Result<(), String> {
    pubmed_search_service::cancel_run(state.inner(), run_id)
}

#[tauri::command]
pub fn list_pubmed_search_entries(
    state: State<DbState>,
    search_id: i64,
) -> Result<Vec<PubmedSearchEntry>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::list_search_entries(&conn, search_id)
}

#[tauri::command]
pub fn set_pubmed_screening_status(
    app: AppHandle,
    state: State<DbState>,
    search_id: i64,
    entry_id: i64,
    status: String,
) -> Result<Vec<PubmedSearchEntry>, String> {
    let entries = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        pubmed_search_service::set_screening_status(&conn, search_id, &[entry_id], &status)?
    };
    if status == "keep" {
        translation_pipeline::spawn(app);
    }
    Ok(entries)
}

#[tauri::command]
pub fn bulk_set_pubmed_screening_status(
    app: AppHandle,
    state: State<DbState>,
    search_id: i64,
    entry_ids: Vec<i64>,
    status: String,
) -> Result<Vec<PubmedSearchEntry>, String> {
    let entries = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        pubmed_search_service::set_screening_status(&conn, search_id, &entry_ids, &status)?
    };
    if status == "keep" {
        translation_pipeline::spawn(app);
    }
    Ok(entries)
}

#[tauri::command]
pub fn list_kept_pubmed_entries(state: State<DbState>) -> Result<Vec<KeptPubmedEntry>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::list_kept_entries(&conn)
}

#[tauri::command]
pub fn export_pubmed_entries(
    state: State<DbState>,
    path: String,
    format: String,
    search_id: Option<i64>,
    entry_ids: Vec<i64>,
    fields: Vec<String>,
    metrics: Vec<PubmedExportMetric>,
) -> Result<usize, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_search_service::export_entries(
        &conn,
        &PathBuf::from(path),
        &format,
        search_id,
        &entry_ids,
        &fields,
        &metrics,
    )
}

#[tauri::command]
pub fn export_google_translate_xlsx(
    state: State<DbState>,
    path: String,
    search_id: Option<i64>,
    entry_ids: Vec<i64>,
    include_title: bool,
    include_summary: bool,
    only_untranslated: bool,
) -> Result<google_translate_xlsx_service::GoogleTranslateExportReport, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    pubmed_search_service::export_google_translate_entries(
        &conn,
        &PathBuf::from(path),
        search_id,
        &entry_ids,
        include_title,
        include_summary,
        only_untranslated,
    )
}

#[tauri::command]
pub fn preview_google_translate_import(
    state: State<DbState>,
    paths: Vec<String>,
) -> Result<google_translate_xlsx_service::GoogleTranslateImportPreview, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    google_translate_xlsx_service::preview_import(&conn, &paths)
}

#[tauri::command]
pub fn apply_google_translate_import(
    app: AppHandle,
    state: State<DbState>,
    candidates: Vec<google_translate_xlsx_service::GoogleTranslateImportCandidate>,
    overwrite: bool,
) -> Result<google_translate_xlsx_service::GoogleTranslateImportReport, String> {
    let report = {
        let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
        google_translate_xlsx_service::apply_import(&mut conn, &candidates, overwrite)?
    };
    for item in &report.applied {
        let _ = app.emit(
            "translation-progress",
            serde_json::json!({
                "kind": "done",
                "entry_id": item.entry_id,
                "field": item.field,
                "text": item.text,
                "error": null,
            }),
        );
    }
    Ok(report)
}

#[tauri::command]
pub fn apply_pubmed_screening_suggestions(
    app: AppHandle,
    state: State<DbState>,
    search_id: i64,
    suggestions: Vec<PubmedScreeningSuggestion>,
) -> Result<Vec<PubmedSearchEntry>, String> {
    let has_keep = suggestions
        .iter()
        .any(|suggestion| suggestion.status == "keep");
    let entries = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        pubmed_search_service::apply_screening_suggestions(&conn, search_id, &suggestions)?
    };
    if has_keep {
        translation_pipeline::spawn(app);
    }
    Ok(entries)
}
