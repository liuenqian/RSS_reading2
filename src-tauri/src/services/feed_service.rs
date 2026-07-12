use crate::models::Feed;
use rusqlite::Connection;

const SELECT_COLUMNS: &str =
    "id, url, title, description, created_at, refresh_interval, notify, last_fetched_at, pubmed_query, pubmed_limit";

fn row_to_feed(row: &rusqlite::Row<'_>) -> rusqlite::Result<Feed> {
    Ok(Feed {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        created_at: row.get(4)?,
        refresh_interval: row.get(5)?,
        notify: row.get::<_, i64>(6)? != 0,
        last_fetched_at: row.get(7)?,
        pubmed_query: row.get(8)?,
        pubmed_limit: row.get(9)?,
    })
}

pub fn add_feed(conn: &Connection, url: &str) -> Result<Feed, String> {
    let url = validate_feed_url(url)?;

    conn.execute("INSERT INTO feeds (url) VALUES (?1)", [url])
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "该订阅源已存在".to_string()
            } else {
                format!("添加失败: {}", e)
            }
        })?;

    let id = conn.last_insert_rowid();
    let feed = conn
        .query_row(
            &format!("SELECT {} FROM feeds WHERE id = ?1", SELECT_COLUMNS),
            [id],
            row_to_feed,
        )
        .map_err(|e| format!("读取失败: {}", e))?;

    Ok(feed)
}

pub fn list_feeds(conn: &Connection) -> Result<Vec<Feed>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM feeds ORDER BY created_at DESC",
            SELECT_COLUMNS
        ))
        .map_err(|e| format!("查询失败: {}", e))?;

    let feeds = stmt
        .query_map([], row_to_feed)
        .map_err(|e| format!("查询失败: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(feeds)
}

pub fn get_feed(conn: &Connection, id: i64) -> Result<Feed, String> {
    conn.query_row(
        &format!("SELECT {} FROM feeds WHERE id = ?1", SELECT_COLUMNS),
        [id],
        row_to_feed,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "订阅源不存在".to_string(),
        other => format!("读取订阅源失败: {}", other),
    })
}

pub fn delete_feed(conn: &Connection, id: i64) -> Result<(), String> {
    let affected = conn
        .execute("DELETE FROM feeds WHERE id = ?1", [id])
        .map_err(|e| format!("删除失败: {}", e))?;

    if affected == 0 {
        return Err("订阅源不存在".to_string());
    }

    Ok(())
}

pub fn rename_feed(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }

    let affected = conn
        .execute(
            "UPDATE feeds SET title = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )
        .map_err(|e| format!("重命名失败: {}", e))?;

    if affected == 0 {
        return Err("订阅源不存在".to_string());
    }

    Ok(())
}

pub fn update_feed(
    conn: &Connection,
    id: i64,
    url: &str,
    title: Option<&str>,
    pubmed_query: Option<&str>,
    pubmed_limit: Option<i64>,
) -> Result<(), String> {
    let url = validate_feed_url(url)?;
    let title = normalize_optional_text(title);
    let pubmed_query = normalize_optional_text(pubmed_query);
    let pubmed_limit = match pubmed_limit {
        Some(limit) if !(5..=200).contains(&limit) => {
            return Err(format!("抓取数量必须在 5 到 200 之间: {}", limit));
        }
        other => other,
    };

    let affected = conn
        .execute(
            "UPDATE feeds
             SET url = ?1,
                 title = ?2,
                 pubmed_query = ?3,
                 pubmed_limit = ?4
             WHERE id = ?5",
            rusqlite::params![url, title, pubmed_query, pubmed_limit, id],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "该订阅源已存在".to_string()
            } else {
                format!("更新订阅源失败: {}", e)
            }
        })?;

    if affected == 0 {
        return Err("订阅源不存在".to_string());
    }

    Ok(())
}

const ALLOWED_INTERVALS: &[&str] = &["15m", "1h", "12h", "1d", "3d", "1w", "manual"];

pub fn set_feed_interval(conn: &Connection, id: i64, interval: &str) -> Result<(), String> {
    if !ALLOWED_INTERVALS.contains(&interval) {
        return Err(format!("无效的刷新频率: {}", interval));
    }
    let affected = conn
        .execute(
            "UPDATE feeds SET refresh_interval = ?1 WHERE id = ?2",
            rusqlite::params![interval, id],
        )
        .map_err(|e| format!("保存刷新频率失败: {}", e))?;
    if affected == 0 {
        return Err("订阅源不存在".to_string());
    }
    Ok(())
}

pub fn set_feed_notify(conn: &Connection, id: i64, on: bool) -> Result<(), String> {
    let affected = conn
        .execute(
            "UPDATE feeds SET notify = ?1 WHERE id = ?2",
            rusqlite::params![if on { 1 } else { 0 }, id],
        )
        .map_err(|e| format!("保存通知偏好失败: {}", e))?;
    if affected == 0 {
        return Err("订阅源不存在".to_string());
    }
    Ok(())
}

pub fn mark_feed_fetched(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE feeds SET last_fetched_at = datetime('now') WHERE id = ?1",
        [id],
    )
    .map_err(|e| format!("更新刷新时间戳失败: {}", e))?;
    Ok(())
}

fn validate_feed_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("URL 不能为空".to_string());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("请输入有效的 HTTP/HTTPS URL".to_string());
    }
    Ok(url)
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}
