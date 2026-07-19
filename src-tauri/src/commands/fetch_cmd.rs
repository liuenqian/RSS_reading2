use crate::db::DbState;
use crate::models::FetchResult;
use crate::services::{fetch_service, scheduler};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn fetch_all_feeds(
    app: AppHandle,
    state: State<'_, DbState>,
) -> Result<FetchResult, String> {
    let result = fetch_service::fetch_all_feeds(&state.conn).await?;
    // Mirror the scheduler's behavior: fire banner notifications for any feed
    // that opted in and picked up new entries. Manual refresh and background
    // refresh end up looking identical to the user.
    scheduler::dispatch_notifications(&app, &result);
    Ok(result)
}

#[tauri::command]
pub async fn fetch_feed(
    app: AppHandle,
    state: State<'_, DbState>,
    feed_id: i64,
) -> Result<FetchResult, String> {
    let result = fetch_service::fetch_feed(&state.conn, feed_id).await?;
    scheduler::dispatch_notifications(&app, &result);
    Ok(result)
}
