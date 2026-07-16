use crate::db::DbState;
use crate::models::{ReadingNote, ReadingPromptProfile};
use crate::services::{cost_service, reading_service, settings_service};
use tauri::State;

#[tauri::command]
pub fn get_reading_profiles(state: State<DbState>) -> Result<Vec<ReadingPromptProfile>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(settings_service::get_reading_profiles(&conn))
}

#[tauri::command]
pub fn save_reading_profiles(
    state: State<DbState>,
    profiles: Vec<ReadingPromptProfile>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    settings_service::save_reading_profiles(&conn, &profiles)
}

#[tauri::command]
pub fn import_reading_skill(skill_dir: String) -> Result<ReadingPromptProfile, String> {
    reading_service::import_reading_skill(&skill_dir)
}

#[tauri::command]
pub fn list_reading_notes(
    state: State<DbState>,
    entry_id: i64,
) -> Result<Vec<ReadingNote>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    reading_service::list_reading_notes(&conn, entry_id)
}

#[tauri::command]
pub fn delete_reading_note(state: State<DbState>, note_id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    reading_service::delete_reading_note(&conn, note_id)
}

#[tauri::command]
pub fn update_reading_note(
    state: State<DbState>,
    note_id: i64,
    content: String,
) -> Result<ReadingNote, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    reading_service::update_reading_note(&conn, note_id, &content)
}

#[tauri::command]
pub fn append_paper_chat_to_note(
    state: State<DbState>,
    entry_id: i64,
    note_id: Option<i64>,
    content: String,
) -> Result<ReadingNote, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    reading_service::append_paper_chat_excerpt(&conn, entry_id, note_id, &content)
}

#[tauri::command]
pub async fn generate_reading_note(
    state: State<'_, DbState>,
    entry_id: i64,
    profile_id: String,
) -> Result<ReadingNote, String> {
    let (settings, profile, entry_context) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let settings = settings_service::get_settings(&conn);
        if settings.api_key.trim().is_empty() {
            return Err("请先在设置里配置当前 AI 服务的 API Key，再生成阅读笔记".to_string());
        }
        let profile = settings_service::get_reading_profiles(&conn)
            .into_iter()
            .find(|item| item.id == profile_id)
            .ok_or_else(|| "未找到所选阅读提示词".to_string())?;
        let entry_context = reading_service::get_entry_context(&conn, entry_id)?;
        (settings, profile, entry_context)
    };

    let output =
        reading_service::generate_reading_note(&settings, &profile, &entry_context).await?;

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &output.usage);
    reading_service::upsert_reading_note(&conn, entry_id, &profile, &output.content)
}
