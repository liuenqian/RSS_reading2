use crate::models::{DeepSeekSettings, ReadingNote, ReadingPromptProfile};
use crate::services::{
    article_service,
    translate_service::{self, TranslationOutput},
};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PAPER_CHAT_NOTE_PROFILE_ID: &str = "paper-chat-excerpts";
const PAPER_CHAT_NOTE_PROFILE_NAME: &str = "对话摘录";
const MANUAL_READING_NOTE_PROFILE_PREFIX: &str = "manual-note";
const MANUAL_READING_NOTE_PROFILE_NAME: &str = "手动笔记";

pub(crate) struct EntryReadingContext {
    pub(crate) title: String,
    pub(crate) link: String,
    pub(crate) guid: String,
    pub(crate) author: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) published_at: Option<String>,
    pub(crate) publication_date: Option<String>,
    pub(crate) affiliation: Option<String>,
    pub(crate) title_translated: Option<String>,
    pub(crate) summary: Option<String>,
    pub(crate) summary_translated: Option<String>,
}

pub(crate) fn get_entry_context(
    conn: &Connection,
    entry_id: i64,
) -> Result<EntryReadingContext, String> {
    conn.query_row(
        "SELECT
            e.title,
            e.link,
            e.guid,
            e.author,
            e.source,
            e.published_at,
            e.publication_date,
            e.affiliation,
            t_title.translated_text,
            e.summary,
            t_summary.translated_text
         FROM entries e
         LEFT JOIN translations t_title
           ON t_title.entry_id = e.id AND t_title.field = 'title' AND length(trim(t_title.translated_text)) > 0
         LEFT JOIN translations t_summary
           ON t_summary.entry_id = e.id AND t_summary.field = 'summary' AND length(trim(t_summary.translated_text)) > 0
         WHERE e.id = ?1",
        [entry_id],
        |row| {
            Ok(EntryReadingContext {
                title: row.get(0)?,
                link: row.get(1)?,
                guid: row.get(2)?,
                author: row.get(3)?,
                source: row.get(4)?,
                published_at: row.get(5)?,
                publication_date: row.get(6)?,
                affiliation: row.get(7)?,
                title_translated: row.get(8)?,
                summary: row.get(9)?,
                summary_translated: row.get(10)?,
            })
        },
    )
    .map_err(|e| format!("文献不存在: {}", e))
}

pub fn list_reading_notes(conn: &Connection, entry_id: i64) -> Result<Vec<ReadingNote>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, entry_id, profile_id, profile_name, content, generated_at
             FROM reading_notes
             WHERE entry_id = ?1
             ORDER BY generated_at DESC, id DESC",
        )
        .map_err(|e| format!("读取阅读笔记失败: {}", e))?;
    let rows = stmt
        .query_map([entry_id], |row| {
            Ok(ReadingNote {
                id: row.get(0)?,
                entry_id: row.get(1)?,
                profile_id: row.get(2)?,
                profile_name: row.get(3)?,
                content: row.get(4)?,
                generated_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("读取阅读笔记失败: {}", e))?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn reading_note_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingNote> {
    Ok(ReadingNote {
        id: row.get(0)?,
        entry_id: row.get(1)?,
        profile_id: row.get(2)?,
        profile_name: row.get(3)?,
        content: row.get(4)?,
        generated_at: row.get(5)?,
    })
}

pub fn upsert_reading_note(
    conn: &Connection,
    entry_id: i64,
    profile: &ReadingPromptProfile,
    content: &str,
) -> Result<ReadingNote, String> {
    conn.execute(
        "INSERT INTO reading_notes (entry_id, profile_id, profile_name, content, generated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(entry_id, profile_id) DO UPDATE SET
           profile_name = excluded.profile_name,
           content = excluded.content,
           generated_at = datetime('now')",
        rusqlite::params![entry_id, &profile.id, &profile.name, content],
    )
    .map_err(|e| format!("保存阅读笔记失败: {}", e))?;

    conn.query_row(
        "SELECT id, entry_id, profile_id, profile_name, content, generated_at
         FROM reading_notes
         WHERE entry_id = ?1 AND profile_id = ?2",
        rusqlite::params![entry_id, &profile.id],
        reading_note_from_row,
    )
    .map_err(|e| format!("读取新笔记失败: {}", e))
}

pub fn add_manual_reading_note(
    conn: &Connection,
    entry_id: i64,
    content: &str,
) -> Result<ReadingNote, String> {
    if content.trim().is_empty() {
        return Err("手动笔记内容不能为空".to_string());
    }

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let profile_id = format!("{}-{}", MANUAL_READING_NOTE_PROFILE_PREFIX, suffix);
    conn.execute(
        "INSERT INTO reading_notes (entry_id, profile_id, profile_name, content, generated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        rusqlite::params![
            entry_id,
            &profile_id,
            MANUAL_READING_NOTE_PROFILE_NAME,
            content.trim()
        ],
    )
    .map_err(|e| format!("保存手动笔记失败: {}", e))?;

    conn.query_row(
        "SELECT id, entry_id, profile_id, profile_name, content, generated_at
         FROM reading_notes
         WHERE id = ?1",
        [conn.last_insert_rowid()],
        reading_note_from_row,
    )
    .map_err(|e| format!("读取手动笔记失败: {}", e))
}

pub fn delete_reading_note(conn: &Connection, note_id: i64) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM reading_notes WHERE id = ?1", [note_id])
        .map_err(|e| format!("删除阅读笔记失败: {}", e))?;
    if changed == 0 {
        return Err("阅读笔记不存在或已删除".to_string());
    }
    Ok(())
}

pub fn update_reading_note(
    conn: &Connection,
    note_id: i64,
    content: &str,
) -> Result<ReadingNote, String> {
    if content.trim().is_empty() {
        return Err("阅读笔记内容不能为空".to_string());
    }

    let changed = conn
        .execute(
            "UPDATE reading_notes
             SET content = ?2,
                 generated_at = datetime('now')
             WHERE id = ?1",
            rusqlite::params![note_id, content],
        )
        .map_err(|e| format!("更新阅读笔记失败: {}", e))?;
    if changed == 0 {
        return Err("阅读笔记不存在或已删除".to_string());
    }

    conn.query_row(
        "SELECT id, entry_id, profile_id, profile_name, content, generated_at
         FROM reading_notes
         WHERE id = ?1",
        [note_id],
        reading_note_from_row,
    )
    .map_err(|e| format!("读取更新后的阅读笔记失败: {}", e))
}

pub fn import_reading_skill(dir_path: &str) -> Result<ReadingPromptProfile, String> {
    let dir = PathBuf::from(dir_path);
    if !dir.is_dir() {
        return Err("所选路径不是文件夹".to_string());
    }

    let skill_md_path = dir.join("SKILL.md");
    if !skill_md_path.is_file() {
        return Err("未找到 SKILL.md；这不是一个可导入的 skill 文件夹".to_string());
    }

    let raw =
        fs::read_to_string(&skill_md_path).map_err(|e| format!("读取 SKILL.md 失败: {}", e))?;
    let (frontmatter, body) = split_frontmatter(&raw);
    let folder_name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-skill");

    let name = frontmatter
        .as_deref()
        .and_then(|fm| frontmatter_value(fm, "name"))
        .unwrap_or(folder_name)
        .trim()
        .to_string();
    let description = frontmatter
        .as_deref()
        .and_then(|fm| frontmatter_value(fm, "description"))
        .unwrap_or("导入的阅读 skill")
        .trim_matches('"')
        .trim()
        .to_string();

    let rules = collect_markdown_dir(&dir.join("rules"))?;
    let templates = collect_markdown_dir(&dir.join("templates"))?;
    let skill_context = build_skill_context(&dir, &raw, &body, &rules, &templates);

    Ok(ReadingPromptProfile {
        id: format!("skill-{}", slugify(folder_name)),
        name,
        description,
        prompt: "严格执行导入 skill 的 workflow、rules 和 templates。不要退化成普通总结，优先复现 skill 规定的固定章节和判断口径。".to_string(),
        source_label: "导入 skill".to_string(),
        reading_mode: "deep".to_string(),
        source_kind: "skill".to_string(),
        skill_dir: Some(dir.to_string_lossy().to_string()),
        skill_context: Some(skill_context),
    })
}

pub fn append_paper_chat_excerpt(
    conn: &Connection,
    entry_id: i64,
    note_id: Option<i64>,
    content: &str,
) -> Result<ReadingNote, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("没有可追加的对话内容".to_string());
    }

    if let Some(note_id) = note_id {
        return append_to_existing_note(conn, entry_id, note_id, trimmed);
    }

    create_paper_chat_note(conn, entry_id, trimmed)
}

fn append_to_existing_note(
    conn: &Connection,
    entry_id: i64,
    note_id: i64,
    excerpt: &str,
) -> Result<ReadingNote, String> {
    let (existing_entry_id, existing_content): (i64, String) = conn
        .query_row(
            "SELECT entry_id, content FROM reading_notes WHERE id = ?1",
            [note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("目标笔记不存在: {}", e))?;
    if existing_entry_id != entry_id {
        return Err("目标笔记不属于当前文献".to_string());
    }

    let next_content = build_appended_note_content(conn, &existing_content, excerpt);
    conn.execute(
        "UPDATE reading_notes
         SET content = ?1, generated_at = datetime('now')
         WHERE id = ?2",
        rusqlite::params![next_content, note_id],
    )
    .map_err(|e| format!("追加对话摘录失败: {}", e))?;

    conn.query_row(
        "SELECT id, entry_id, profile_id, profile_name, content, generated_at
         FROM reading_notes
         WHERE id = ?1",
        [note_id],
        reading_note_from_row,
    )
    .map_err(|e| format!("读取对话摘录失败: {}", e))
}

fn create_paper_chat_note(
    conn: &Connection,
    entry_id: i64,
    excerpt: &str,
) -> Result<ReadingNote, String> {
    let content = format!(
        "## 对话摘录\n\n### {}\n\n{}",
        timestamp_label(conn),
        excerpt
    );
    let profile_id = format!("{}-{}", PAPER_CHAT_NOTE_PROFILE_ID, unique_note_suffix());

    conn.execute(
        "INSERT INTO reading_notes (entry_id, profile_id, profile_name, content, generated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        rusqlite::params![entry_id, &profile_id, PAPER_CHAT_NOTE_PROFILE_NAME, content],
    )
    .map_err(|e| format!("创建对话摘录失败: {}", e))?;

    let note_id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, entry_id, profile_id, profile_name, content, generated_at
         FROM reading_notes
         WHERE id = ?1",
        [note_id],
        reading_note_from_row,
    )
    .map_err(|e| format!("读取对话摘录失败: {}", e))
}

fn build_appended_note_content(conn: &Connection, existing_content: &str, excerpt: &str) -> String {
    let base = existing_content.trim_end();
    if base.is_empty() {
        return format!("### {}\n\n{}", timestamp_label(conn), excerpt);
    }
    format!(
        "{}\n\n---\n\n### {}\n\n{}",
        base,
        timestamp_label(conn),
        excerpt
    )
}

fn unique_note_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub(crate) async fn generate_reading_note(
    settings: &DeepSeekSettings,
    profile: &ReadingPromptProfile,
    entry: &EntryReadingContext,
) -> Result<TranslationOutput, String> {
    let reading_mode = if profile.reading_mode.eq_ignore_ascii_case("deep") {
        "deep"
    } else {
        "quick"
    };
    let material = load_reading_material(entry, reading_mode).await?;
    let is_skill_profile = profile.source_kind.eq_ignore_ascii_case("skill");
    let system_prompt = if is_skill_profile {
        "你是一个结构化医学文献阅读助手。当前任务来自一个导入的 reading skill。你必须把 skill 文件中的 workflow、rules、templates 视为最高优先级指令，尽量复现其固定章节、判断口径和表格结构。你必须：1）只基于给定文献信息判断；2）证据不足时明确写“需要原文验证”；3）输出纯 Markdown，不要代码块，不要额外寒暄。"
    } else {
        "你是一个结构化医学文献阅读助手。你的任务不是泛泛总结，而是按照用户选择的阅读模板生成高密度、可执行的阅读笔记。你必须：1）只基于给定文献信息判断；2）证据不足时明确写“需要原文验证”；3）输出纯 Markdown，不要代码块，不要额外寒暄。"
    };
    let skill_block = if is_skill_profile {
        format!(
            "## 导入 Skill 上下文\n\
            路径：{skill_dir}\n\n\
            {skill_context}\n\n",
            skill_dir = profile.skill_dir.as_deref().unwrap_or("未知"),
            skill_context = profile.skill_context.as_deref().unwrap_or("无")
        )
    } else {
        String::new()
    };

    let user_prompt = format!(
        "请根据下面这篇文献的信息，严格按照所选阅读模板输出中文阅读笔记。\n\n\
        ## 所选模板\n\
        名称：{profile_name}\n\
        说明：{profile_desc}\n\
        类型：{profile_kind}\n\
        模式：{reading_mode_label}\n\
        模板内容：\n{profile_prompt}\n\n\
        {skill_block}\
        ## 阅读材料状态\n\
        - 当前依据：{material_source}\n\
        - 状态说明：{material_notice}\n\n\
        ## 文献信息\n\
        标题（原文）：{title}\n\
        标题（中文）：{title_zh}\n\
        期刊：{journal}\n\
        作者：{author}\n\
        发表日期：{publication_date}\n\
        单位：{affiliation}\n\
        链接：{link}\n\n\
        ### 摘要（中文）\n{summary_zh}\n\n\
        ### 摘要（原文）\n{summary}\n\n\
        ### 正文材料\n{full_text}\n\n\
        额外约束：\n\
        - 不要把文章内容机械重复成长摘要。\n\
        - 判断必须明确，优先输出真正有用的研究决策信息。\n\
        - 如果没有拿到全文，不得假装看过全文，必须明确写“未获取全文，仅基于摘要”。\n\
        - 如果摘要无法支撑机制级判断，必须明确标注不确定性。\n\
        - 最后加一个 `## 一句话结论` 小节，用一句话说明这篇文献值不值得继续追。",
        profile_name = profile.name,
        profile_desc = profile.description,
        profile_kind = if is_skill_profile {
            "导入 skill"
        } else {
            "普通提示词"
        },
        reading_mode_label = if reading_mode == "deep" {
            "深度笔记"
        } else {
            "快速笔记"
        },
        profile_prompt = profile.prompt,
        skill_block = skill_block,
        material_source = material.source_label,
        material_notice = material.notice,
        title = entry.title,
        title_zh = entry.title_translated.as_deref().unwrap_or("未翻译"),
        journal = entry.source.as_deref().unwrap_or("未知"),
        author = entry.author.as_deref().unwrap_or("未知"),
        publication_date = entry
            .publication_date
            .as_deref()
            .or(entry.published_at.as_deref())
            .unwrap_or("未知"),
        affiliation = entry.affiliation.as_deref().unwrap_or("未知"),
        link = entry.link,
        summary_zh = material.summary_zh,
        summary = material.summary,
        full_text = material.full_text,
    );

    let max_tokens = if reading_mode == "deep" { 2200 } else { 1800 };
    translate_service::complete_with_prompts(settings, system_prompt, &user_prompt, 0.4, max_tokens)
        .await
}

struct ReadingMaterial {
    source_label: String,
    notice: String,
    summary_zh: String,
    summary: String,
    full_text: String,
}

const MAX_FULLTEXT_CHARS: usize = 28_000;

async fn load_reading_material(
    entry: &EntryReadingContext,
    reading_mode: &str,
) -> Result<ReadingMaterial, String> {
    let effective_summary = ensure_effective_summary(entry).await?;
    let summary = effective_summary
        .as_deref()
        .or(entry.summary.as_deref())
        .unwrap_or("暂无英文摘要")
        .to_string();
    let summary_zh = entry
        .summary_translated
        .clone()
        .unwrap_or_else(|| "暂无中文摘要".to_string());

    if reading_mode != "deep" {
        return Ok(ReadingMaterial {
            source_label: "摘要".to_string(),
            notice: "快速笔记模式：只基于摘要和元数据。".to_string(),
            summary_zh,
            summary,
            full_text: "本模式不加载全文。".to_string(),
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("RSSReading/0.1 (https://github.com/liuenqian/RSS_reading)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let pmid = if let Some(p) = article_service::extract_pmid_from_link(&entry.link) {
        Some(p)
    } else if let Some(p) = article_service::extract_pmid_from_guid(&entry.guid) {
        Some(p)
    } else if let Some(p) = entry
        .summary
        .as_deref()
        .and_then(article_service::extract_pmid_from_text)
    {
        Some(p)
    } else {
        article_service::find_pubmed_pmid_by_title(&client, &entry.title).await?
    };

    if let Some(pmid) = pmid {
        if let Some(fulltext) = article_service::fetch_pmc_fulltext_by_pmid(&pmid).await? {
            let (full_text, truncated) = truncate_for_prompt(&fulltext.text, MAX_FULLTEXT_CHARS);
            return Ok(ReadingMaterial {
                source_label: "PMC 免费全文".to_string(),
                notice: if truncated {
                    "已获取 PMC 免费全文；因输入长度限制，仅保留前段重点正文。".to_string()
                } else {
                    "已获取 PMC 免费全文，优先基于全文生成深度笔记。".to_string()
                },
                summary_zh,
                summary,
                full_text,
            });
        }
    }

    Ok(ReadingMaterial {
        source_label: "摘要回退".to_string(),
        notice: "未获取到可用 PMC 免费全文，本次深度笔记已回退为基于摘要的保守判断。".to_string(),
        summary_zh,
        summary,
        full_text: "未获取到可用全文。".to_string(),
    })
}

async fn ensure_effective_summary(entry: &EntryReadingContext) -> Result<Option<String>, String> {
    if let Some(summary) = entry.summary.as_deref() {
        let metadata = article_service::extract_rss_metadata(Some(summary));
        if !metadata.is_metadata_only && !summary.trim().is_empty() {
            return Ok(Some(summary.to_string()));
        }
    }

    Ok(article_service::fetch_abstract(&entry.title)
        .await?
        .map(|result| result.text))
}

fn truncate_for_prompt(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    let truncated: String = text.chars().take(max_chars).collect();
    (format!("{}\n\n[内容因长度限制已截断]", truncated), true)
}

fn timestamp_label(conn: &Connection) -> String {
    conn.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M', 'now', 'localtime')",
        [],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| "当前时间".to_string())
}

fn split_frontmatter(raw: &str) -> (Option<String>, String) {
    let mut lines = raw.lines();
    if lines.next() != Some("---") {
        return (None, raw.to_string());
    }
    let mut frontmatter = Vec::new();
    for line in lines.by_ref() {
        if line == "---" {
            let rest = lines.collect::<Vec<_>>().join("\n");
            return (Some(frontmatter.join("\n")), rest);
        }
        frontmatter.push(line);
    }
    (None, raw.to_string())
}

fn frontmatter_value<'a>(frontmatter: &'a str, key: &str) -> Option<&'a str> {
    frontmatter.lines().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if k.trim() == key {
            Some(v.trim())
        } else {
            None
        }
    })
}

fn collect_markdown_dir(dir: &Path) -> Result<Vec<(String, String)>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(dir)
        .map_err(|e| format!("读取目录失败 ({}): {}", dir.display(), e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().and_then(|x| x.to_str()) == Some("md"))
        .collect::<Vec<_>>();
    files.sort();

    files
        .into_iter()
        .map(|path| {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("读取文件失败 ({}): {}", path.display(), e))?;
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown.md")
                .to_string();
            Ok((name, content))
        })
        .collect()
}

fn build_skill_context(
    dir: &Path,
    raw_skill_md: &str,
    skill_body: &str,
    rules: &[(String, String)],
    templates: &[(String, String)],
) -> String {
    let mut parts = Vec::new();
    parts.push(format!("# Skill Folder\n{}", dir.display()));
    parts.push(format!("## SKILL.md\n{}", raw_skill_md.trim()));
    if !skill_body.trim().is_empty() {
        parts.push(format!("## Skill Body\n{}", skill_body.trim()));
    }
    if !rules.is_empty() {
        let section = rules
            .iter()
            .map(|(name, content)| format!("### {}\n{}", name, content.trim()))
            .collect::<Vec<_>>()
            .join("\n\n");
        parts.push(format!("## Rules\n{}", section));
    }
    if !templates.is_empty() {
        let section = templates
            .iter()
            .map(|(name, content)| format!("### {}\n{}", name, content.trim()))
            .collect::<Vec<_>>()
            .join("\n\n");
        parts.push(format!("## Templates\n{}", section));
    }
    parts.join("\n\n")
}

fn slugify(text: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in text.chars() {
        let keep = ch.is_ascii_alphanumeric();
        if keep {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "imported-skill".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            "
            CREATE TABLE reading_notes (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id      INTEGER NOT NULL,
                profile_id    TEXT NOT NULL,
                profile_name  TEXT NOT NULL,
                content       TEXT NOT NULL,
                generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(entry_id, profile_id)
            );
            ",
        )
        .expect("create schema");
        conn
    }

    #[test]
    fn update_reading_note_rejects_empty_content() {
        let conn = setup_conn();
        conn.execute(
            "INSERT INTO reading_notes (entry_id, profile_id, profile_name, content)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![1_i64, "p1", "模板", "old"],
        )
        .expect("seed note");

        let err = update_reading_note(&conn, 1, "   ").expect_err("should reject empty content");
        assert_eq!(err, "阅读笔记内容不能为空");
    }

    #[test]
    fn update_reading_note_persists_new_content() {
        let conn = setup_conn();
        conn.execute(
            "INSERT INTO reading_notes (entry_id, profile_id, profile_name, content)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![1_i64, "p1", "模板", "old"],
        )
        .expect("seed note");

        let updated = update_reading_note(&conn, 1, "new content").expect("update note");
        assert_eq!(updated.id, 1);
        assert_eq!(updated.content, "new content");
    }
}
