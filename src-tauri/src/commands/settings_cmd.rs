use crate::db::DbState;
use crate::models::{ApiTokenProfileList, DeepSeekBalance, DeepSeekSettings};
use crate::services::{settings_service, translate_service};
use tauri::State;

#[tauri::command]
pub fn get_settings(state: State<DbState>) -> Result<DeepSeekSettings, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(settings_service::get_settings(&conn))
}

#[tauri::command]
pub fn get_provider_settings(
    state: State<DbState>,
    provider: String,
) -> Result<DeepSeekSettings, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(settings_service::get_provider_settings(&conn, &provider))
}

#[tauri::command]
pub fn save_settings(state: State<DbState>, settings: DeepSeekSettings) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    settings_service::save_settings(&conn, &settings)
}

#[tauri::command]
pub fn list_api_token_profiles(
    state: State<DbState>,
    provider: String,
) -> Result<ApiTokenProfileList, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    settings_service::list_api_token_profiles(&conn, &provider)
}

#[tauri::command]
pub fn upsert_api_token_profile(
    state: State<DbState>,
    provider: String,
    profile_id: Option<String>,
    name: String,
    api_key: String,
) -> Result<ApiTokenProfileList, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    settings_service::upsert_api_token_profile(
        &conn,
        &provider,
        profile_id.as_deref(),
        &name,
        &api_key,
    )
}

#[tauri::command]
pub fn activate_api_token_profile(
    state: State<DbState>,
    provider: String,
    profile_id: String,
) -> Result<ApiTokenProfileList, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    settings_service::activate_api_token_profile(&conn, &provider, &profile_id)
}

#[tauri::command]
pub fn delete_api_token_profile(
    state: State<DbState>,
    provider: String,
    profile_id: String,
) -> Result<ApiTokenProfileList, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    settings_service::delete_api_token_profile(&conn, &provider, &profile_id)
}

#[tauri::command]
pub async fn test_connection(settings: DeepSeekSettings) -> Result<bool, String> {
    if settings.api_key.is_empty() {
        return Err("请先填写 API Key".to_string());
    }

    translate_service::test_connection(&settings).await
}

/// Read the API key from the DB and query DeepSeek's official `/user/balance`
/// endpoint. The frontend renders the returned numbers in the settings panel.
#[tauri::command]
pub async fn fetch_deepseek_balance(state: State<'_, DbState>) -> Result<DeepSeekBalance, String> {
    let settings = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        settings_service::get_settings(&conn)
    };
    translate_service::fetch_balance(&settings).await
}
