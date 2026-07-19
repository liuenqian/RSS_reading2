use crate::db::DbState;
use crate::models::PmcGallerySearch;
use crate::services::pmc_gallery_service::{
    PmcGalleryJournalOptionsResult, PmcGalleryPreviewResult,
};
use crate::services::pmc_gallery_service::{PmcGalleryMetricFilters, PmcGallerySearchResult};
use crate::services::{pmc_gallery_search_service, pmc_gallery_service};
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PmcGallerySearchPayload {
    pub name: String,
    pub mode: String,
    pub question: Option<String>,
    pub author_name: Option<String>,
    pub affiliation: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub query: String,
    pub article_limit: usize,
    pub journal_filter: String,
    pub impact_factor_filter: String,
    pub jcr_quartile_filter: String,
    pub cas_partition_filter: String,
    pub top_filter: String,
}

fn input(
    payload: &PmcGallerySearchPayload,
) -> pmc_gallery_search_service::PmcGallerySearchInput<'_> {
    pmc_gallery_search_service::PmcGallerySearchInput {
        name: &payload.name,
        mode: &payload.mode,
        question: payload.question.as_deref(),
        author_name: payload.author_name.as_deref(),
        affiliation: payload.affiliation.as_deref(),
        start_date: payload.start_date.as_deref(),
        end_date: payload.end_date.as_deref(),
        query: &payload.query,
        article_limit: payload.article_limit,
        journal_filter: &payload.journal_filter,
        impact_factor_filter: &payload.impact_factor_filter,
        jcr_quartile_filter: &payload.jcr_quartile_filter,
        cas_partition_filter: &payload.cas_partition_filter,
        top_filter: &payload.top_filter,
    }
}

#[tauri::command]
pub fn list_pmc_gallery_searches(state: State<DbState>) -> Result<Vec<PmcGallerySearch>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    pmc_gallery_search_service::list_searches(&conn)
}

#[tauri::command]
pub fn create_pmc_gallery_search(
    state: State<DbState>,
    payload: PmcGallerySearchPayload,
) -> Result<PmcGallerySearch, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    pmc_gallery_search_service::create_search(&conn, &input(&payload))
}

#[tauri::command]
pub fn update_pmc_gallery_search(
    state: State<DbState>,
    id: i64,
    payload: PmcGallerySearchPayload,
) -> Result<PmcGallerySearch, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    pmc_gallery_search_service::update_search(&conn, id, &input(&payload))
}

#[tauri::command]
pub fn rename_pmc_gallery_search(
    state: State<DbState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    pmc_gallery_search_service::rename_search(&conn, id, &name)
}

#[tauri::command]
pub fn delete_pmc_gallery_search(state: State<DbState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    pmc_gallery_search_service::delete_search(&conn, id)
}

#[tauri::command]
pub fn load_pmc_gallery_cache(
    state: State<DbState>,
    id: i64,
) -> Result<PmcGallerySearchResult, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    pmc_gallery_search_service::load_cached_result(&conn, id)
}

#[tauri::command]
pub async fn list_pmc_gallery_journals(
    query: String,
    sample_limit: Option<usize>,
) -> Result<PmcGalleryJournalOptionsResult, String> {
    pmc_gallery_service::list_journal_options(&query, sample_limit.unwrap_or(200)).await
}

#[tauri::command]
pub async fn preview_pmc_gallery_search(
    query: String,
    sample_limit: Option<usize>,
) -> Result<PmcGalleryPreviewResult, String> {
    pmc_gallery_service::preview_gallery(&query, sample_limit.unwrap_or(10)).await
}

#[tauri::command]
pub async fn search_pmc_gallery(
    state: State<'_, DbState>,
    query: String,
    article_limit: Option<usize>,
    article_offset: Option<usize>,
    metric_filters: Option<PmcGalleryMetricFilters>,
    search_id: Option<i64>,
) -> Result<PmcGallerySearchResult, String> {
    let metric_filters = metric_filters.unwrap_or_default();
    let result = pmc_gallery_service::search_gallery(
        &query,
        article_limit.unwrap_or(8),
        article_offset.unwrap_or(0),
        &metric_filters,
    )
    .await?;
    if let Some(search_id) = search_id {
        let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
        pmc_gallery_search_service::cache_result(
            &mut conn,
            search_id,
            &result,
            article_offset.unwrap_or(0) == 0,
        )?;
    }
    Ok(result)
}
