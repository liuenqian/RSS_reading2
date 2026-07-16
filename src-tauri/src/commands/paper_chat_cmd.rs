use crate::db::DbState;
use crate::models::{
    PaperChatAttachment, PaperChatAttachmentImport, PaperChatMessage,
    PubmedScreeningSuggestionResult,
};
use crate::services::{cost_service, paper_chat_service, settings_service};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;
use tokio::sync::oneshot;

#[derive(Default)]
pub struct PaperChatRequestState {
    active: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl PaperChatRequestState {
    fn start(&self, request_id: &str) -> Result<oneshot::Receiver<()>, String> {
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        if active.contains_key(request_id) {
            return Err("文献对话请求 ID 重复".to_string());
        }
        let (sender, receiver) = oneshot::channel();
        active.insert(request_id.to_string(), sender);
        Ok(receiver)
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(request_id);
        }
    }

    fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let sender = self
            .active
            .lock()
            .map_err(|e| e.to_string())?
            .remove(request_id);
        Ok(sender.is_some_and(|sender| sender.send(()).is_ok()))
    }
}

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
pub fn import_paper_chat_attachments(
    paths: Vec<String>,
) -> Result<PaperChatAttachmentImport, String> {
    paper_chat_service::import_attachments(paths)
}

#[tauri::command]
pub fn cancel_paper_chat(
    request_state: State<'_, PaperChatRequestState>,
    request_id: String,
) -> Result<bool, String> {
    request_state.cancel(request_id.trim())
}

#[tauri::command]
pub async fn ask_paper_chat(
    state: State<'_, DbState>,
    request_state: State<'_, PaperChatRequestState>,
    entry_ids: Vec<i64>,
    question: String,
    profile_id: Option<String>,
    attachments: Vec<PaperChatAttachment>,
    request_id: String,
) -> Result<Vec<PaperChatMessage>, String> {
    let entry_ids = paper_chat_service::normalize_entry_ids(entry_ids)?;
    let profile_id = paper_chat_service::normalize_profile_id(profile_id);
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("请输入问题后再发送".to_string());
    }
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("文献对话请求 ID 无效".to_string());
    }

    let (settings, chat_profile) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let settings = settings_service::get_settings(&conn);
        if settings.api_key.trim().is_empty() {
            return Err("请先在设置里配置当前 AI 服务的 API Key，再使用文献对话".to_string());
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

    let cancellation = request_state.start(&request_id)?;
    let result = tokio::select! {
        result = paper_chat_service::ask_question(
            &state,
            &settings,
            &entry_ids,
            profile_id.as_deref(),
            chat_profile.as_ref(),
            &question,
            attachments,
        ) => result,
        _ = cancellation => Err("文献对话已停止".to_string()),
    };
    request_state.finish(&request_id);
    let (messages, usage) = result?;

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    Ok(messages)
}

#[tauri::command]
pub async fn suggest_pubmed_screening(
    state: State<'_, DbState>,
    search_id: i64,
    entry_ids: Vec<i64>,
    criteria: String,
) -> Result<PubmedScreeningSuggestionResult, String> {
    let entry_ids = paper_chat_service::normalize_screening_entry_ids(entry_ids)?;
    let criteria = criteria.trim().to_string();
    if criteria.is_empty() {
        return Err("请输入筛选标准".to_string());
    }
    let settings = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let settings = settings_service::get_settings(&conn);
        if settings.api_key.trim().is_empty() {
            return Err("请先在设置里配置当前 AI 服务的 API Key，再使用 AI 筛选".to_string());
        }
        settings
    };
    let (result, usage) = paper_chat_service::suggest_pubmed_screening(
        state.inner(),
        &settings,
        search_id,
        &entry_ids,
        &criteria,
    )
    .await?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::PaperChatRequestState;

    #[tokio::test]
    async fn cancellation_releases_waiting_chat_request() {
        let state = PaperChatRequestState::default();
        let receiver = state.start("request-1").unwrap();

        assert!(state.cancel("request-1").unwrap());
        assert!(receiver.await.is_ok());
        assert!(!state.cancel("request-1").unwrap());
    }
}
