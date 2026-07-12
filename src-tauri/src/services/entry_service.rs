use crate::models::{DeepSeekSettings, Entry, ReadingStats};
use crate::services::article_service;
use rusqlite::{params, Connection};
use serde_json::Value;

pub fn list_entries(conn: &Connection, feed_id: Option<i64>) -> Result<Vec<Entry>, String> {
    let retention_days: i64 = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'read_retention_days'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let retention_clause = if retention_days > 0 {
        format!(
            "AND (e.is_read = 0 OR e.read_at IS NULL OR e.read_at > datetime('now', '-{} days'))",
            retention_days
        )
    } else {
        String::new()
    };

    let select = "SELECT e.id, e.feed_id, e.guid, e.title, e.link, e.summary, e.summary_source, e.author,
            e.published_at, e.publication_date, e.source, e.pmid, e.pmcid, e.doi, e.fetched_at, e.is_read, e.read_at,
            t_title.translated_text,
            t_summary.translated_text,
            e.affiliation,
            EXISTS(SELECT 1 FROM reading_notes rn WHERE rn.entry_id = e.id),
            (SELECT GROUP_CONCAT(tag, char(31))
               FROM (SELECT tag
                       FROM entry_tags et
                      WHERE et.entry_id = e.id
                      ORDER BY lower(tag), tag)),
            e.has_free_fulltext
     FROM entries e
     LEFT JOIN translations t_title ON t_title.entry_id = e.id AND t_title.field = 'title' AND length(trim(t_title.translated_text)) > 0
     LEFT JOIN translations t_summary ON t_summary.entry_id = e.id AND t_summary.field = 'summary' AND length(trim(t_summary.translated_text)) > 0";

    let sql = if feed_id.is_some() {
        format!(
            "{} WHERE e.feed_id = ?1 {} ORDER BY e.published_at DESC, e.fetched_at DESC",
            select, retention_clause
        )
    } else {
        format!(
            "{} WHERE 1=1 {} ORDER BY e.published_at DESC, e.fetched_at DESC LIMIT 200",
            select, retention_clause
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("查询失败: {}", e))?;

    let entries = if let Some(fid) = feed_id {
        stmt.query_map([fid], map_entry)
            .map_err(|e| format!("查询失败: {}", e))?
            .filter_map(|r| r.ok())
            .collect()
    } else {
        stmt.query_map([], map_entry)
            .map_err(|e| format!("查询失败: {}", e))?
            .filter_map(|r| r.ok())
            .collect()
    };

    Ok(entries)
}

fn map_entry(row: &rusqlite::Row) -> rusqlite::Result<Entry> {
    let summary: Option<String> = row.get(5)?;
    let metadata = article_service::extract_rss_metadata(summary.as_deref());
    let publication_date: Option<String> = row.get(9)?;
    let source: Option<String> = row.get(10)?;
    let affiliation_raw: Option<String> = row.get(19)?;
    let tags_raw: Option<String> = row.get(21)?;
    let affiliation = affiliation_raw.map(|s| article_service::dedupe_repeated(&s));

    Ok(Entry {
        id: row.get(0)?,
        feed_id: row.get(1)?,
        guid: row.get(2)?,
        title: row.get(3)?,
        link: row.get(4)?,
        summary: if metadata.is_metadata_only {
            None
        } else {
            summary
        },
        summary_source: row.get(6)?,
        author: row.get(7)?,
        published_at: row.get(8)?,
        publication_date: publication_date.or(metadata.publication_date),
        source: source.or(metadata.source),
        pmid: row.get(11)?,
        pmcid: row.get(12)?,
        doi: row.get(13)?,
        affiliation,
        fetched_at: row.get(14)?,
        is_read: row.get(15)?,
        read_at: row.get(16)?,
        title_translated: row.get(17)?,
        summary_translated: row.get(18)?,
        has_reading_note: row.get(20)?,
        tags: parse_entry_tags(tags_raw.as_deref()),
        has_free_fulltext: row.get(22)?,
    })
}

pub fn add_entry_tag(conn: &Connection, entry_id: i64, tag: &str) -> Result<Vec<String>, String> {
    let tag = normalize_entry_tag(tag)?;
    conn.execute(
        "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?1, ?2)",
        params![entry_id, tag],
    )
    .map_err(|e| format!("添加标签失败: {}", e))?;
    list_tags_for_entry(conn, entry_id)
}

pub fn remove_entry_tag(
    conn: &Connection,
    entry_id: i64,
    tag: &str,
) -> Result<Vec<String>, String> {
    let tag = normalize_entry_tag(tag)?;
    conn.execute(
        "DELETE FROM entry_tags WHERE entry_id = ?1 AND lower(tag) = lower(?2)",
        params![entry_id, tag],
    )
    .map_err(|e| format!("删除标签失败: {}", e))?;
    list_tags_for_entry(conn, entry_id)
}

fn list_tags_for_entry(conn: &Connection, entry_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT tag
             FROM entry_tags
             WHERE entry_id = ?1
             ORDER BY lower(tag), tag",
        )
        .map_err(|e| format!("读取标签失败: {}", e))?;

    let rows = stmt
        .query_map([entry_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("读取标签失败: {}", e))?;

    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn normalize_entry_tag(tag: &str) -> Result<String, String> {
    let compact = tag.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return Err("标签不能为空".to_string());
    }
    if compact.chars().count() > 40 {
        return Err("标签不能超过 40 个字符".to_string());
    }
    Ok(compact)
}

fn parse_entry_tags(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split('\u{1f}')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// Compute reading stats from the immutable `reading_events` log. Decoupled
/// from `entries` so feed deletion and retention-based pruning never erase a
/// user's historical stats.
pub fn reading_stats(conn: &Connection) -> Result<ReadingStats, String> {
    let total_entries: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM reading_events WHERE kind = 'fetched'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("统计抓取数失败: {}", e))?;

    let total_read: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM reading_events WHERE kind = 'read'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("统计已读数失败: {}", e))?;

    let mut day_stmt = conn
        .prepare(
            "SELECT date(occurred_at, 'localtime') AS day, COUNT(*)
             FROM reading_events
             WHERE kind = 'read' AND occurred_at IS NOT NULL
             GROUP BY day
             ORDER BY day",
        )
        .map_err(|e| format!("统计每日阅读失败: {}", e))?;
    let day_counts: Vec<(String, i64)> = day_stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("统计每日阅读失败: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Per-day fetched counts mirror day_counts for the "抓取" card so the
    // frontend can slice both metrics with the same window logic.
    let mut fetched_day_stmt = conn
        .prepare(
            "SELECT date(occurred_at, 'localtime') AS day, COUNT(*)
             FROM reading_events
             WHERE kind = 'fetched' AND occurred_at IS NOT NULL
             GROUP BY day
             ORDER BY day",
        )
        .map_err(|e| format!("统计每日抓取失败: {}", e))?;
    let fetched_day_counts: Vec<(String, i64)> = fetched_day_stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| format!("统计每日抓取失败: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // 24-bucket histogram of read events by local hour-of-day. Pre-aggregating
    // server-side keeps the payload tiny (24 ints) regardless of history size.
    let mut hour_stmt = conn
        .prepare(
            "SELECT CAST(strftime('%H', occurred_at, 'localtime') AS INTEGER) AS hr, COUNT(*)
             FROM reading_events
             WHERE kind = 'read' AND occurred_at IS NOT NULL
             GROUP BY hr",
        )
        .map_err(|e| format!("统计阅读时段失败: {}", e))?;
    let mut read_hour_counts = vec![0i64; 24];
    let hour_rows = hour_stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| format!("统计阅读时段失败: {}", e))?;
    for r in hour_rows.flatten() {
        let (hr, c) = r;
        if (0..24).contains(&hr) {
            read_hour_counts[hr as usize] = c;
        }
    }

    // Per-feed read counts. The snapshot title is the latest-known feed name
    // captured at event time, so deleted feeds still surface a recognizable
    // label in the top-5 ranking.
    let mut feed_stmt = conn
        .prepare(
            "SELECT
                feed_id,
                (SELECT feed_title_snapshot
                   FROM reading_events r2
                  WHERE r2.feed_id = r.feed_id AND r2.feed_title_snapshot IS NOT NULL
                  ORDER BY r2.occurred_at DESC LIMIT 1) AS title_snapshot,
                COUNT(*)
             FROM reading_events r
             WHERE kind = 'read' AND feed_id IS NOT NULL
             GROUP BY feed_id
             ORDER BY COUNT(*) DESC",
        )
        .map_err(|e| format!("统计订阅源阅读失败: {}", e))?;
    let feed_read_counts: Vec<(i64, Option<String>, i64)> = feed_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("统计订阅源阅读失败: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(ReadingStats {
        total_entries,
        total_read,
        day_counts,
        fetched_day_counts,
        read_hour_counts,
        feed_read_counts,
    })
}

/// Ask DeepSeek to produce a fresh batch of easter-egg "flavor" templates for
/// the reading-stats card. The frontend treats this as best-effort enrichment
/// on top of its built-in local pool — failures are silent and the local pool
/// keeps the UI alive. Templates may contain `{read}`, `{fetched}`,
/// `{activeDays}`, `{hour}`, `{hourBand}` placeholders that the frontend fills.
pub async fn generate_flavor_pool(
    settings: &DeepSeekSettings,
    fetched: i64,
    read: i64,
    active_days: i64,
    peak_hour: i64,
) -> Result<Vec<String>, String> {
    if settings.api_key.trim().is_empty() {
        return Err("未配置 DeepSeek API Key".to_string());
    }
    let hour_label = match peak_hour {
        h if h < 0 => "未知".to_string(),
        0 => "凌晨 12 点".to_string(),
        h if h < 6 => format!("凌晨 {} 点", h),
        h if h < 12 => format!("上午 {} 点", h),
        12 => "中午 12 点".to_string(),
        h if h < 18 => format!("下午 {} 点", h - 12),
        h => format!("晚上 {} 点", h - 12),
    };
    let user_prompt = format!(
        "你是一款叫 RSS Reading 的 RSS 阅读器里的「彩蛋文案师」。基于以下用户阅读数据，写 10 条不同的中文短句，每条不超过 22 字。\n\
        要求：\n\
        - 风格温暖、俏皮、有惊喜感，可用比喻、拟人、双关、轻量诗意；不要说教，不要堆砌励志词。\n\
        - 可使用占位符：{{read}}、{{fetched}}、{{activeDays}}、{{hour}}、{{hourBand}}（渲染时会替换为真实数据）；至少 5 条带占位符。\n\
        - 输出严格 JSON 数组（字符串元素），不要解释、不要 Markdown、不要代码块。\n\n\
        用户数据（全期）：抓取 {fetched} 篇，已读 {read} 篇，活跃 {active_days} 天，高峰时段 {hour_label}。",
        fetched = fetched,
        read = read,
        active_days = active_days,
        hour_label = hour_label,
    );

    let url = format!(
        "{}/chat/completions",
        settings.base_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "model": settings.model,
        "messages": [
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 1.1,
        "max_tokens": 600,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", settings.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DeepSeek 请求失败: {}", e))?;

    let status = resp.status();
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 DeepSeek 响应失败: {}", e))?;

    if !status.is_success() {
        let msg = value["error"]["message"].as_str().unwrap_or("未知错误");
        return Err(format!("DeepSeek {} — {}", status.as_u16(), msg));
    }

    let content = value["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    // Strip code fences if the model added them despite our instructions.
    let cleaned = content
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: Vec<String> = serde_json::from_str(cleaned).unwrap_or_default();
    let lines: Vec<String> = parsed
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.chars().count() <= 40)
        .take(20)
        .collect();
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::{normalize_entry_tag, parse_entry_tags};

    #[test]
    fn normalize_entry_tag_trims_and_collapses_spaces() {
        assert_eq!(normalize_entry_tag("  肿瘤   免疫  ").unwrap(), "肿瘤 免疫");
    }

    #[test]
    fn parse_entry_tags_splits_internal_separator() {
        let tags = parse_entry_tags(Some("综述\u{1f}方法学\u{1f}转化医学"));
        assert_eq!(tags, vec!["综述", "方法学", "转化医学"]);
    }
}

pub fn set_entry_read(conn: &Connection, entry_id: i64, is_read: bool) -> Result<(), String> {
    // Only the 0→1 transition produces a `read` event — marking an already-read
    // article doesn't double-count, and unmarking never retracts the historical
    // fact that it was once read.
    if is_read {
        let affected = conn
            .execute(
                "UPDATE entries
                 SET is_read = 1,
                     read_at = COALESCE(read_at, datetime('now'))
                 WHERE id = ?1 AND is_read = 0",
                rusqlite::params![entry_id],
            )
            .map_err(|e| format!("更新已读状态失败: {}", e))?;

        if affected > 0 {
            let _ = conn.execute(
                "INSERT INTO reading_events (kind, feed_id, feed_title_snapshot, entry_id)
                 SELECT 'read', e.feed_id, f.title, e.id
                 FROM entries e LEFT JOIN feeds f ON f.id = e.feed_id
                 WHERE e.id = ?1",
                rusqlite::params![entry_id],
            );
        }
    } else {
        conn.execute(
            "UPDATE entries
             SET is_read = 0, read_at = NULL
             WHERE id = ?1",
            rusqlite::params![entry_id],
        )
        .map_err(|e| format!("更新已读状态失败: {}", e))?;
    }
    Ok(())
}
