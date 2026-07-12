use crate::db::DbState;
use crate::models::{DeepSeekSettings, PaperChatMessage, ReadingPromptProfile, TokenUsage};
use crate::services::{reading_service, translate_service};
use rusqlite::{params, Connection};

const MAX_SCOPE_ENTRIES: usize = 5;
const MAX_HISTORY_MESSAGES: usize = 12;

pub fn normalize_entry_ids(mut entry_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    entry_ids.retain(|id| *id > 0);
    entry_ids.sort_unstable();
    entry_ids.dedup();

    if entry_ids.is_empty() {
        return Err("请先选择至少 1 篇文献".to_string());
    }
    if entry_ids.len() > MAX_SCOPE_ENTRIES {
        return Err(format!("当前最多支持 {} 篇文献联合对话", MAX_SCOPE_ENTRIES));
    }

    Ok(entry_ids)
}

pub fn normalize_profile_id(profile_id: Option<String>) -> Option<String> {
    profile_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

pub fn list_messages(
    conn: &Connection,
    entry_ids: &[i64],
    profile_id: Option<&str>,
) -> Result<Vec<PaperChatMessage>, String> {
    let scope_key = scope_key(entry_ids, profile_id);
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content, created_at
             FROM paper_chat_messages
             WHERE scope_key = ?1
             ORDER BY id ASC",
        )
        .map_err(|e| format!("读取文献对话失败: {}", e))?;
    let rows = stmt
        .query_map([scope_key], |row| {
            Ok(PaperChatMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| format!("读取文献对话失败: {}", e))?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

pub fn clear_messages(
    conn: &Connection,
    entry_ids: &[i64],
    profile_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM paper_chat_sessions WHERE scope_key = ?1",
        [scope_key(entry_ids, profile_id)],
    )
    .map_err(|e| format!("清空文献对话失败: {}", e))?;
    Ok(())
}

pub async fn ask_question(
    state: &DbState,
    settings: &DeepSeekSettings,
    entry_ids: &[i64],
    profile_id: Option<&str>,
    chat_profile: Option<&ReadingPromptProfile>,
    question: &str,
) -> Result<(Vec<PaperChatMessage>, TokenUsage), String> {
    let scope_key = scope_key(entry_ids, profile_id);
    let (entries, history) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let entries = entry_ids
            .iter()
            .map(|entry_id| reading_service::get_entry_context(&conn, *entry_id))
            .collect::<Result<Vec<_>, _>>()?;
        let history = load_recent_history(&conn, &scope_key)?;
        (entries, history)
    };

    let system_prompt = build_system_prompt(chat_profile);
    let context_prompt = build_context_prompt(&entries);

    let mut messages = Vec::with_capacity(history.len() + 3);
    messages.push(("system".to_string(), system_prompt.to_string()));
    messages.push(("user".to_string(), context_prompt));
    messages.extend(history);
    messages.push(("user".to_string(), question.trim().to_string()));

    let output = translate_service::complete_with_messages(settings, messages, 0.2, 1600).await?;

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    save_exchange(
        &conn,
        &scope_key,
        entry_ids,
        question.trim(),
        &output.content,
    )?;
    let messages = list_messages(&conn, entry_ids, profile_id)?;
    Ok((messages, output.usage))
}

fn load_recent_history(
    conn: &Connection,
    scope_key: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT role, content
             FROM paper_chat_messages
             WHERE scope_key = ?1
             ORDER BY id DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("读取文献对话历史失败: {}", e))?;
    let rows = stmt
        .query_map(params![scope_key, MAX_HISTORY_MESSAGES as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取文献对话历史失败: {}", e))?;

    let mut history = rows.filter_map(|row| row.ok()).collect::<Vec<_>>();
    history.reverse();
    Ok(history)
}

fn save_exchange(
    conn: &Connection,
    scope_key: &str,
    entry_ids: &[i64],
    question: &str,
    answer: &str,
) -> Result<(), String> {
    let entry_ids_json =
        serde_json::to_string(entry_ids).map_err(|e| format!("序列化对话范围失败: {}", e))?;
    conn.execute(
        "INSERT INTO paper_chat_sessions (scope_key, entry_ids_json, created_at, updated_at)
         VALUES (?1, ?2, datetime('now'), datetime('now'))
         ON CONFLICT(scope_key) DO UPDATE SET
           entry_ids_json = excluded.entry_ids_json,
           updated_at = datetime('now')",
        params![scope_key, entry_ids_json],
    )
    .map_err(|e| format!("保存文献对话失败: {}", e))?;

    conn.execute(
        "INSERT INTO paper_chat_messages (scope_key, role, content, created_at)
         VALUES (?1, 'user', ?2, datetime('now'))",
        params![scope_key, question],
    )
    .map_err(|e| format!("保存提问失败: {}", e))?;

    conn.execute(
        "INSERT INTO paper_chat_messages (scope_key, role, content, created_at)
         VALUES (?1, 'assistant', ?2, datetime('now'))",
        params![scope_key, answer],
    )
    .map_err(|e| format!("保存回答失败: {}", e))?;

    Ok(())
}

fn build_system_prompt(chat_profile: Option<&ReadingPromptProfile>) -> String {
    let base_prompt = "你是一个严谨的医学文献对话助手。你只能基于当前给定的文献信息回答，不能编造实验结果、样本量、机制或结论。若材料不足，必须明确写“基于当前标题/摘要无法确认，需要阅读全文验证”。回答使用中文，优先给出直接结论，再补充依据；涉及多篇文献比较时，请用 [1]、[2] 这样的编号指代文献。";

    if let Some(profile) = chat_profile {
        let mut sections = vec![
            base_prompt.to_string(),
            format!(
                "当前额外启用了对话提示词/skill：{}\n来源：{}\n描述：{}",
                profile.name,
                profile.source_label,
                if profile.description.trim().is_empty() {
                    "无".to_string()
                } else {
                    profile.description.trim().to_string()
                }
            ),
            format!("请额外遵循以下要求：\n{}", profile.prompt.trim()),
        ];

        if let Some(skill_context) = profile.skill_context.as_deref() {
            if !skill_context.trim().is_empty() {
                sections.push(format!("以下是该 skill 的补充上下文：\n{}", skill_context.trim()));
            }
        }

        sections.join("\n\n")
    } else {
        base_prompt.to_string()
    }
}

fn build_context_prompt(entries: &[reading_service::EntryReadingContext]) -> String {
    let scope_label = if entries.len() == 1 {
        "当前是单篇文献对话。"
    } else {
        "当前是多篇文献联合对话。请在回答中区分不同文献。"
    };

    let mut sections = vec![
        "下面是本轮对话可用的全部材料。当前版本仅基于标题、期刊、作者、日期、链接和摘要，不代表已阅读全文。".to_string(),
        scope_label.to_string(),
    ];

    for (index, entry) in entries.iter().enumerate() {
        sections.push(format!(
            "## 文献 [{idx}]\n\
             标题（中文）：{title_zh}\n\
             标题（原文）：{title}\n\
             期刊：{journal}\n\
             作者：{author}\n\
             发表日期：{publication_date}\n\
             链接：{link}\n\
             摘要（中文）：\n{summary_zh}\n\
             摘要（原文）：\n{summary}",
            idx = index + 1,
            title_zh = entry.title_translated.as_deref().unwrap_or("未翻译"),
            title = entry.title,
            journal = entry.source.as_deref().unwrap_or("未知"),
            author = entry.author.as_deref().unwrap_or("未知"),
            publication_date = entry
                .publication_date
                .as_deref()
                .or(entry.published_at.as_deref())
                .unwrap_or("未知"),
            link = entry.link,
            summary_zh = entry
                .summary_translated
                .as_deref()
                .unwrap_or("暂无中文摘要"),
            summary = entry.summary.as_deref().unwrap_or("暂无英文摘要"),
        ));
    }

    sections.join("\n\n")
}

fn scope_key(entry_ids: &[i64], profile_id: Option<&str>) -> String {
    let entry_key = entry_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    match profile_id {
        Some(profile_id) => format!("profile:{}|entries:{}", profile_id, entry_key),
        None => format!("profile:default|entries:{}", entry_key),
    }
}
