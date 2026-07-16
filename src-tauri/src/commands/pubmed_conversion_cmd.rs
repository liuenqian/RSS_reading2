use crate::db::DbState;
use crate::models::{Feed, PubmedSearch};
use crate::services::{
    pubmed_conversion_service, pubmed_search_service, pubmed_service, translation_pipeline,
};
use tauri::{AppHandle, State};

const CONVERTED_RSS_LIMIT: u32 = 100;

#[tauri::command]
pub async fn convert_pubmed_feed_to_search(
    app: AppHandle,
    state: State<'_, DbState>,
    feed_id: i64,
) -> Result<PubmedSearch, String> {
    let (search, created) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        pubmed_conversion_service::prepare_feed_to_search(&conn, feed_id)?
    };

    let result = pubmed_search_service::run_search(&app, state.inner(), search.id, None).await;
    match result {
        Ok(result) if result.status == "completed" => {
            let converted = {
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                pubmed_conversion_service::finish_feed_to_search(&conn, feed_id, search.id)?;
                pubmed_search_service::get_search(&conn, search.id)?
            };
            translation_pipeline::spawn(app);
            Ok(converted)
        }
        Ok(result) => {
            if created {
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                pubmed_conversion_service::rollback_created_search(&conn, search.id);
            }
            Err(result
                .error_message
                .unwrap_or_else(|| format!("PubMed 检索未完成: {}", result.status)))
        }
        Err(error) => {
            if created {
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                pubmed_conversion_service::rollback_created_search(&conn, search.id);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn convert_pubmed_search_to_feed(
    state: State<'_, DbState>,
    search_id: i64,
) -> Result<Feed, String> {
    let (search, existing_feed) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let search = pubmed_search_service::get_search(&conn, search_id)?;
        let feed = pubmed_conversion_service::find_feed_by_query(&conn, &search.query)?;
        (search, feed)
    };

    let generated_url = if existing_feed.is_some() {
        None
    } else {
        Some(pubmed_service::build_rss_url(&search.query, CONVERTED_RSS_LIMIT).await?)
    };

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    pubmed_conversion_service::finish_search_to_feed(
        &conn,
        search_id,
        generated_url.as_deref(),
        CONVERTED_RSS_LIMIT as i64,
    )
}
