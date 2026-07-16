use crate::db::DbState;
use crate::services::{cost_service, pubmed_service, settings_service};
use tauri::State;

#[tauri::command]
pub async fn build_pubmed_rss_url(query: String, limit: u32) -> Result<String, String> {
    pubmed_service::build_rss_url(&query, limit).await
}

#[tauri::command]
pub async fn build_pubmed_author_query(
    state: State<'_, DbState>,
    author_name: String,
    affiliation: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<String, String> {
    let settings = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        settings_service::get_settings(&conn)
    };
    if settings.api_key.is_empty() {
        return Err("请先在设置中配置当前 AI 服务的 API Key".to_string());
    }

    let (query, usage) = pubmed_service::natural_language_to_author_query(
        &settings,
        &author_name,
        affiliation.as_deref(),
        start_date.as_deref(),
        end_date.as_deref(),
    )
    .await?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    Ok(query)
}

#[tauri::command]
pub async fn natural_to_pubmed_query(
    state: State<'_, DbState>,
    text: String,
) -> Result<String, String> {
    let settings = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        settings_service::get_settings(&conn)
    };

    if settings.api_key.is_empty() {
        return Err("请先在设置中配置当前 AI 服务的 API Key".to_string());
    }

    let (query, usage) = pubmed_service::natural_language_to_query(&settings, &text).await?;
    let query_result = pubmed_service::validate_query_syntax(&query);
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    query_result.map_err(|error| format!("AI 生成的检索式不完整：{}。请重新生成", error))
}
