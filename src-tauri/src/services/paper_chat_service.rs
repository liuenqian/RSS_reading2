use crate::db::DbState;
use crate::models::{
    DeepSeekSettings, PaperChatAttachment, PaperChatAttachmentImport, PaperChatMessage,
    PubmedScreeningSuggestion, PubmedScreeningSuggestionResult, ReadingPromptProfile, TokenUsage,
};
use crate::services::{reading_service, translate_service};
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_HISTORY_MESSAGES: usize = 12;
const MAX_SCREENING_ENTRIES: usize = 30;
const MAX_CONTEXT_CHARS: usize = 180_000;
const MAX_ATTACHMENT_FILES: usize = 20;
const MAX_ATTACHMENT_CHARS: usize = 100_000;
const MAX_ATTACHMENT_CHARS_PER_FILE: usize = 50_000;
const MAX_TEXT_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PDF_FILE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 2_000;
const MAX_DIRECTORY_DEPTH: usize = 8;

const TEXT_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm",
    "tex", "rst", "log",
];

pub fn import_attachments(paths: Vec<String>) -> Result<PaperChatAttachmentImport, String> {
    if paths.is_empty() {
        return Err("请选择文件或文件夹".to_string());
    }

    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut visited_entries = 0;
    for raw_path in paths {
        collect_attachment_files(
            Path::new(&raw_path),
            0,
            &mut visited_entries,
            &mut files,
            &mut skipped,
        );
        if files.len() >= MAX_ATTACHMENT_FILES || visited_entries >= MAX_DIRECTORY_ENTRIES {
            break;
        }
    }

    let mut seen = HashSet::new();
    let mut attachments = Vec::new();
    let mut total_chars = 0;
    for file in files {
        let canonical = file.canonicalize().unwrap_or_else(|_| file.clone());
        let path_key = canonical.to_string_lossy().to_string();
        if !seen.insert(path_key.clone()) {
            continue;
        }

        match extract_attachment(&canonical, MAX_ATTACHMENT_CHARS.saturating_sub(total_chars)) {
            Ok(Some(mut attachment)) => {
                attachment.path = path_key;
                total_chars += attachment.char_count;
                attachments.push(attachment);
                if attachments.len() >= MAX_ATTACHMENT_FILES || total_chars >= MAX_ATTACHMENT_CHARS
                {
                    break;
                }
            }
            Ok(None) => {}
            Err(message) => skipped.push(message),
        }
    }

    if attachments.is_empty() {
        let detail = skipped.first().cloned().unwrap_or_else(|| {
            "没有找到支持的文件。支持 PDF、TXT、Markdown、CSV、JSON、YAML、XML、HTML、LaTeX 和日志文本。".to_string()
        });
        return Err(detail);
    }

    if files_limit_reached(&attachments, total_chars, visited_entries) {
        skipped.push(format!(
            "已达到附件上限（最多 {} 个文件、合计 {} 个字符）",
            MAX_ATTACHMENT_FILES, MAX_ATTACHMENT_CHARS
        ));
    }

    Ok(PaperChatAttachmentImport {
        attachments,
        skipped,
    })
}

fn files_limit_reached(
    attachments: &[PaperChatAttachment],
    total_chars: usize,
    visited_entries: usize,
) -> bool {
    attachments.len() >= MAX_ATTACHMENT_FILES
        || total_chars >= MAX_ATTACHMENT_CHARS
        || visited_entries >= MAX_DIRECTORY_ENTRIES
}

fn collect_attachment_files(
    path: &Path,
    depth: usize,
    visited_entries: &mut usize,
    files: &mut Vec<PathBuf>,
    skipped: &mut Vec<String>,
) {
    if files.len() >= MAX_ATTACHMENT_FILES || *visited_entries >= MAX_DIRECTORY_ENTRIES {
        return;
    }
    *visited_entries += 1;

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            skipped.push(format!("无法读取 {}：{}", path.display(), error));
            return;
        }
    };
    if metadata.file_type().is_symlink() {
        skipped.push(format!("已跳过符号链接：{}", path.display()));
        return;
    }
    if metadata.is_file() {
        if is_supported_attachment(path) {
            files.push(path.to_path_buf());
        }
        return;
    }
    if !metadata.is_dir() {
        return;
    }
    if depth >= MAX_DIRECTORY_DEPTH {
        skipped.push(format!(
            "文件夹层级超过 {} 层：{}",
            MAX_DIRECTORY_DEPTH,
            path.display()
        ));
        return;
    }

    let mut entries = match fs::read_dir(path) {
        Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(error) => {
            skipped.push(format!("无法读取文件夹 {}：{}", path.display(), error));
            return;
        }
    };
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        collect_attachment_files(&entry.path(), depth + 1, visited_entries, files, skipped);
        if files.len() >= MAX_ATTACHMENT_FILES || *visited_entries >= MAX_DIRECTORY_ENTRIES {
            break;
        }
    }
}

fn is_supported_attachment(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    extension == "pdf" || TEXT_ATTACHMENT_EXTENSIONS.contains(&extension.as_str())
}

fn extract_attachment(
    path: &Path,
    remaining_chars: usize,
) -> Result<Option<PaperChatAttachment>, String> {
    if remaining_chars == 0 {
        return Ok(None);
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let max_bytes = if extension == "pdf" {
        MAX_PDF_FILE_BYTES
    } else {
        MAX_TEXT_FILE_BYTES
    };
    let metadata =
        fs::metadata(path).map_err(|error| format!("无法读取 {}：{}", path.display(), error))?;
    if metadata.len() > max_bytes {
        return Err(format!("文件过大，已跳过：{}", path.display()));
    }

    let raw_content = if extension == "pdf" {
        pdf_extract::extract_text(path)
            .map_err(|error| format!("PDF 文字提取失败 {}：{}", path.display(), error))?
    } else {
        let bytes =
            fs::read(path).map_err(|error| format!("无法读取 {}：{}", path.display(), error))?;
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let cleaned = raw_content.replace('\0', "").trim().to_string();
    if cleaned.is_empty() {
        return Err(format!("文件中没有可提取的文字：{}", path.display()));
    }

    let original_char_count = cleaned.chars().count();
    let limit = remaining_chars.min(MAX_ATTACHMENT_CHARS_PER_FILE);
    let truncated = original_char_count > limit;
    let content = if truncated {
        const SUFFIX: &str = "\n[附件内容已按容量截断]";
        let content_limit = limit.saturating_sub(SUFFIX.chars().count());
        let mut value = cleaned.chars().take(content_limit).collect::<String>();
        value.push_str(SUFFIX);
        value
    } else {
        cleaned
    };
    let char_count = content.chars().count();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名附件")
        .to_string();

    Ok(Some(PaperChatAttachment {
        path: path.to_string_lossy().to_string(),
        name,
        content,
        char_count,
        truncated,
    }))
}

fn normalize_attachments(
    attachments: Vec<PaperChatAttachment>,
) -> Result<Vec<PaperChatAttachment>, String> {
    let mut normalized = Vec::new();
    let mut total_chars = 0;
    let mut seen = HashSet::new();
    for mut attachment in attachments.into_iter().take(MAX_ATTACHMENT_FILES) {
        attachment.name = attachment.name.trim().chars().take(200).collect();
        attachment.content = attachment.content.trim().to_string();
        if attachment.name.is_empty() || attachment.content.is_empty() {
            continue;
        }
        if !seen.insert(attachment.path.clone()) {
            continue;
        }
        let remaining = MAX_ATTACHMENT_CHARS.saturating_sub(total_chars);
        if remaining == 0 {
            break;
        }
        if attachment.content.chars().count() > remaining {
            attachment.content = attachment.content.chars().take(remaining).collect();
            attachment.truncated = true;
        }
        attachment.char_count = attachment.content.chars().count();
        total_chars += attachment.char_count;
        normalized.push(attachment);
    }
    if normalized.len() > MAX_ATTACHMENT_FILES || total_chars > MAX_ATTACHMENT_CHARS {
        return Err("附件内容超过允许范围".to_string());
    }
    Ok(normalized)
}

pub fn normalize_entry_ids(mut entry_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    entry_ids.retain(|id| *id > 0);
    entry_ids.sort_unstable();
    entry_ids.dedup();

    if entry_ids.is_empty() {
        return Err("请先选择至少 1 篇文献".to_string());
    }
    Ok(entry_ids)
}

pub fn normalize_screening_entry_ids(mut entry_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    entry_ids.retain(|id| *id > 0);
    entry_ids.sort_unstable();
    entry_ids.dedup();
    if entry_ids.is_empty() {
        return Err("请先选择至少 1 篇文献".to_string());
    }
    if entry_ids.len() > MAX_SCREENING_ENTRIES {
        return Err(format!(
            "AI 筛选单次最多支持 {} 篇文献",
            MAX_SCREENING_ENTRIES
        ));
    }
    Ok(entry_ids)
}

pub fn normalize_profile_id(profile_id: Option<String>) -> Option<String> {
    profile_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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
    attachments: Vec<PaperChatAttachment>,
) -> Result<(Vec<PaperChatMessage>, TokenUsage), String> {
    let attachments = normalize_attachments(attachments)?;
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
    let context_prompt = build_context_prompt(&entries, &attachments);

    let mut messages = Vec::with_capacity(history.len() + 3);
    messages.push(("system".to_string(), system_prompt.to_string()));
    messages.push(("user".to_string(), context_prompt));
    messages.extend(history);
    messages.push(("user".to_string(), question.trim().to_string()));

    let output = translate_service::complete_with_messages(settings, messages, 0.2, 1600).await?;

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let saved_question = question_with_attachment_names(question, &attachments);
    save_exchange(
        &conn,
        &scope_key,
        entry_ids,
        &saved_question,
        &output.content,
    )?;
    let messages = list_messages(&conn, entry_ids, profile_id)?;
    Ok((messages, output.usage))
}

pub async fn suggest_pubmed_screening(
    state: &DbState,
    settings: &DeepSeekSettings,
    search_id: i64,
    entry_ids: &[i64],
    criteria: &str,
) -> Result<(PubmedScreeningSuggestionResult, TokenUsage), String> {
    let records = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut records = Vec::with_capacity(entry_ids.len());
        for entry_id in entry_ids {
            let record = conn
                .query_row(
                    "SELECT e.id, e.pmid, e.title, tt.translated_text, e.summary, e.source,
                            e.publication_date
                     FROM pubmed_search_entries pse
                     JOIN entries e ON e.id = pse.entry_id
                     LEFT JOIN translations tt ON tt.entry_id = e.id AND tt.field = 'title'
                     WHERE pse.search_id = ?1 AND e.id = ?2",
                    params![search_id, entry_id],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, Option<String>>(6)?,
                        ))
                    },
                )
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => {
                        format!("文献 {} 不属于当前检索批次", entry_id)
                    }
                    other => format!("读取筛选文献失败: {}", other),
                })?;
            records.push(record);
        }
        records
    };

    let mut context = format!(
        "研究者的纳入/排除标准：\n{}\n\n请逐篇判断。只能使用 keep、maybe、exclude 三种状态。\n",
        criteria.trim()
    );
    for (index, (entry_id, pmid, title, title_zh, summary, journal, date)) in
        records.iter().enumerate()
    {
        let summary = summary.as_deref().unwrap_or("暂无摘要");
        let summary = summary.chars().take(4_000).collect::<String>();
        context.push_str(&format!(
            "\n[{}] entry_id={} PMID={}\n中文标题：{}\n原文标题：{}\n期刊：{}\n日期：{}\n摘要：{}\n",
            index + 1,
            entry_id,
            pmid.as_deref().unwrap_or("未知"),
            title_zh.as_deref().unwrap_or("未翻译"),
            title,
            journal.as_deref().unwrap_or("未知"),
            date.as_deref().unwrap_or("未知"),
            summary,
        ));
    }
    context.push_str(
        "\n只返回 JSON 数组，不要 Markdown 代码块。每项严格包含 entry_id、pmid、status、reason。reason 用中文且不超过 80 字；材料不足时用 maybe。",
    );
    let system = "你是严谨的医学文献初筛助手。只能依据给定标题、摘要和标准判断，不能编造。你只提供建议，最终决定由研究者确认。";
    let output = translate_service::complete_with_messages(
        settings,
        vec![
            ("system".to_string(), system.to_string()),
            ("user".to_string(), context),
        ],
        0.1,
        2400,
    )
    .await?;

    let suggestions = parse_screening_suggestions(&output.content, entry_ids).unwrap_or_default();
    let question = format!("AI 辅助筛选标准：{}", criteria.trim());
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let chat_scope = scope_key(entry_ids, None);
    save_exchange(&conn, &chat_scope, entry_ids, &question, &output.content)?;
    Ok((
        PubmedScreeningSuggestionResult {
            raw_answer: output.content,
            suggestions,
        },
        output.usage,
    ))
}

fn parse_screening_suggestions(
    raw: &str,
    allowed_entry_ids: &[i64],
) -> Result<Vec<PubmedScreeningSuggestion>, String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: Vec<PubmedScreeningSuggestion> =
        serde_json::from_str(cleaned).map_err(|e| format!("AI 筛选结果不是有效 JSON: {}", e))?;
    let allowed = allowed_entry_ids
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let mut seen = std::collections::HashSet::new();
    let mut suggestions = Vec::new();
    for mut suggestion in parsed {
        if !allowed.contains(&suggestion.entry_id) || !seen.insert(suggestion.entry_id) {
            continue;
        }
        if !matches!(suggestion.status.as_str(), "keep" | "maybe" | "exclude") {
            suggestion.status = "maybe".to_string();
        }
        suggestion.reason = suggestion.reason.trim().chars().take(80).collect();
        suggestions.push(suggestion);
    }
    if suggestions.is_empty() {
        return Err("AI 未返回可匹配到所选文献的筛选建议".to_string());
    }
    Ok(suggestions)
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
    let base_prompt = "你是一个严谨的医学文献对话助手。你只能基于当前给定的文献信息和用户附件回答，不能编造实验结果、样本量、机制或结论。若材料不足，必须明确说明需要补充哪些材料。回答使用中文，优先给出直接结论，再补充依据；涉及多篇文献比较时，请用 [1]、[2] 这样的编号指代文献。";

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
                sections.push(format!(
                    "以下是该 skill 的补充上下文：\n{}",
                    skill_context.trim()
                ));
            }
        }

        sections.join("\n\n")
    } else {
        base_prompt.to_string()
    }
}

fn build_context_prompt(
    entries: &[reading_service::EntryReadingContext],
    attachments: &[PaperChatAttachment],
) -> String {
    let scope_label = if entries.len() == 1 {
        "当前是单篇文献对话。"
    } else {
        "当前是多篇文献联合对话。请在回答中区分不同文献。"
    };

    let mut sections = vec![
        if attachments.is_empty() {
            "下面是本轮对话可用的全部材料。当前仅提供标题、期刊、作者、日期、链接和摘要，不代表已阅读全文。".to_string()
        } else {
            "下面是本轮对话可用的全部材料，包括文献条目和用户本轮添加的附件。附件可能经过文字提取或容量截断。".to_string()
        },
        scope_label.to_string(),
    ];

    let per_entry_summary_chars = (MAX_CONTEXT_CHARS / entries.len().max(1)).max(500);
    let per_language_chars = (per_entry_summary_chars / 2).max(250);
    for (index, entry) in entries.iter().enumerate() {
        let summary_zh = truncate_chars(
            entry
                .summary_translated
                .as_deref()
                .unwrap_or("暂无中文摘要"),
            per_language_chars,
        );
        let summary = truncate_chars(
            entry.summary.as_deref().unwrap_or("暂无英文摘要"),
            per_language_chars,
        );
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
            summary_zh = summary_zh,
            summary = summary,
        ));
    }

    for (index, attachment) in attachments.iter().enumerate() {
        sections.push(format!(
            "## 用户附件 [A{idx}]：{name}\n{content}",
            idx = index + 1,
            name = attachment.name,
            content = attachment.content,
        ));
    }

    sections.join("\n\n")
}

fn question_with_attachment_names(question: &str, attachments: &[PaperChatAttachment]) -> String {
    if attachments.is_empty() {
        return question.trim().to_string();
    }
    let names = attachments
        .iter()
        .map(|attachment| attachment.name.as_str())
        .collect::<Vec<_>>()
        .join("、");
    format!("{}\n\n附件：{}", question.trim(), names)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated = value.chars().take(limit).collect::<String>();
    truncated.push_str("…[摘要已按上下文容量截断]");
    truncated
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn attachment(path: &str, name: &str, content: String) -> PaperChatAttachment {
        let char_count = content.chars().count();
        PaperChatAttachment {
            path: path.to_string(),
            name: name.to_string(),
            content,
            char_count,
            truncated: false,
        }
    }

    #[test]
    fn parses_screening_json_by_entry_id_and_ignores_out_of_scope_rows() {
        let raw = r#"```json
        [
          {"entry_id": 2, "pmid": "20", "status": "keep", "reason": "符合标准"},
          {"entry_id": 99, "pmid": "99", "status": "exclude", "reason": "越界"},
          {"entry_id": 1, "pmid": "10", "status": "unknown", "reason": "材料不足"},
          {"entry_id": 2, "pmid": "20", "status": "exclude", "reason": "重复"}
        ]
        ```"#;
        let parsed = parse_screening_suggestions(raw, &[1, 2]).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].entry_id, 2);
        assert_eq!(parsed[0].status, "keep");
        assert_eq!(parsed[1].entry_id, 1);
        assert_eq!(parsed[1].status, "maybe");
    }

    #[test]
    fn screening_scope_has_separate_higher_limit() {
        let ids = (1..=30).collect::<Vec<_>>();
        assert_eq!(normalize_screening_entry_ids(ids).unwrap().len(), 30);
        assert!(normalize_screening_entry_ids((1..=31).collect()).is_err());
    }

    #[test]
    fn abstract_chat_accepts_all_selected_entries() {
        let ids = (1..=79).collect::<Vec<_>>();
        assert_eq!(normalize_entry_ids(ids).unwrap().len(), 79);
    }

    #[test]
    fn context_truncation_is_explicit() {
        let text = "a".repeat(20);
        let value = truncate_chars(&text, 5);
        assert!(value.starts_with("aaaaa"));
        assert!(value.contains("摘要已按上下文容量截断"));
    }

    #[test]
    fn imports_supported_files_from_nested_folder() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "cento-paper-chat-attachments-{}-{}",
            std::process::id(),
            suffix
        ));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("notes.txt"), "alpha finding").unwrap();
        fs::write(nested.join("methods.md"), "beta method").unwrap();
        fs::write(nested.join("ignored.bin"), [0_u8, 1, 2]).unwrap();

        let report = import_attachments(vec![root.to_string_lossy().to_string()]).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(report.attachments.len(), 2);
        assert!(report
            .attachments
            .iter()
            .any(|item| item.name == "notes.txt" && item.content.contains("alpha")));
        assert!(report
            .attachments
            .iter()
            .any(|item| item.name == "methods.md" && item.content.contains("beta")));
    }

    #[test]
    fn attachment_context_and_saved_question_keep_clear_boundaries() {
        let attachments = vec![attachment(
            "/tmp/paper.txt",
            "paper.txt",
            "full attachment evidence".to_string(),
        )];
        let context = build_context_prompt(&[], &attachments);
        let saved_question = question_with_attachment_names("What changed?", &attachments);

        assert!(context.contains("用户附件 [A1]：paper.txt"));
        assert!(context.contains("full attachment evidence"));
        assert!(saved_question.contains("附件：paper.txt"));
        assert!(!saved_question.contains("full attachment evidence"));
    }

    #[test]
    fn normalizes_duplicate_attachments_and_enforces_total_character_limit() {
        let first = attachment("/tmp/a.txt", "a.txt", "a".repeat(60_000));
        let duplicate = first.clone();
        let second = attachment("/tmp/b.txt", "b.txt", "b".repeat(60_000));

        let normalized = normalize_attachments(vec![first, duplicate, second]).unwrap();
        let total_chars = normalized.iter().map(|item| item.char_count).sum::<usize>();

        assert_eq!(normalized.len(), 2);
        assert_eq!(total_chars, MAX_ATTACHMENT_CHARS);
        assert!(normalized[1].truncated);
    }
}
