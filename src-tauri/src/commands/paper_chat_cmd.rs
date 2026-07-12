use crate::db::DbState;
use crate::models::PaperChatMessage;
use crate::services::{cost_service, paper_chat_service, settings_service};
use tauri::State;

#[tauri::command]
pub fn list_paper_chat_messages(
    state: State<DbState>,
    entry_ids: Vec<i64>,
    profile_id: Option<String>,
) -> Result<Vec<PaperChatMessage>, String> {
    let entry_ids = paper_chat_service::normalize_entry_ids(entry_ids)?;
    let profile_id = paper_chat_service::normalize_profile_id(profile_id);
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    paper_chat_service::list_messages(&conn, &entry_ids, profile_id.as_deref())
}

#[tauri::command]
pub fn clear_paper_chat(
    state: State<DbState>,
    entry_ids: Vec<i64>,
    profile_id: Option<String>,
) -> Result<(), String> {
    let entry_ids = paper_chat_service::normalize_entry_ids(entry_ids)?;
    let profile_id = paper_chat_service::normalize_profile_id(profile_id);
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    paper_chat_service::clear_messages(&conn, &entry_ids, profile_id.as_deref())
}

#[tauri::command]
pub async fn ask_paper_chat(
    state: State<'_, DbState>,
    entry_ids: Vec<i64>,
    question: String,
    profile_id: Option<String>,
) -> Result<Vec<PaperChatMessage>, String> {
    let entry_ids = paper_chat_service::normalize_entry_ids(entry_ids)?;
    let profile_id = paper_chat_service::normalize_profile_id(profile_id);
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("请输入问题后再发送".to_string());
    }

    let (settings, chat_profile) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let settings = settings_service::get_settings(&conn);
        if settings.api_key.trim().is_empty() {
            return Err("请先在设置里配置 DeepSeek API Key，再使用文献对话".to_string());
        }
        let chat_profile = if let Some(profile_id) = profile_id.as_deref() {
            Some(
                settings_service::get_reading_profiles(&conn)
                    .into_iter()
                    .find(|item| item.id == profile_id)
                    .ok_or_else(|| "未找到所选对话提示词或 skill".to_string())?,
            )
        } else {
            None
        };
        (settings, chat_profile)
    };

    let (messages, usage) = paper_chat_service::ask_question(
        &state,
        &settings,
        &entry_ids,
        profile_id.as_deref(),
        chat_profile.as_ref(),
        &question,
    )
    .await?;

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.model, &usage);
    Ok(messages)
}
