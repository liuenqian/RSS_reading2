use crate::services::feed_service;
use rusqlite::Connection;
use serde::Serialize;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct OpmlImportReport {
    pub added: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

pub fn export_opml(conn: &Connection, path: &Path) -> Result<usize, String> {
    let feeds = feed_service::list_feeds(conn)?;
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<opml version=\"2.0\">\n");
    out.push_str("  <head>\n");
    out.push_str("    <title>RSS Reading Subscriptions</title>\n");
    let _ = writeln!(out, "    <dateCreated>{}</dateCreated>", chrono_like_now());
    out.push_str("  </head>\n");
    out.push_str("  <body>\n");
    for f in &feeds {
        let title = f.title.clone().unwrap_or_else(|| f.url.clone());
        let _ = writeln!(
            out,
            "    <outline type=\"rss\" text=\"{title}\" title=\"{title}\" xmlUrl=\"{url}\"/>",
            title = xml_escape(&title),
            url = xml_escape(&f.url),
        );
    }
    out.push_str("  </body>\n");
    out.push_str("</opml>\n");

    fs::write(path, out).map_err(|e| format!("写入失败: {}", e))?;
    Ok(feeds.len())
}

pub fn import_opml(conn: &Connection, path: &Path) -> Result<OpmlImportReport, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("读取失败: {}", e))?;
    let doc = roxmltree::Document::parse(&content).map_err(|e| format!("OPML 解析失败: {}", e))?;

    let mut added = 0usize;
    let mut skipped = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for node in doc.descendants().filter(|n| n.has_tag_name("outline")) {
        let Some(url) = node
            .attribute("xmlUrl")
            .or_else(|| node.attribute("xmlURL"))
            .or_else(|| node.attribute("xmlurl"))
        else {
            continue;
        };
        let url = url.trim();
        if url.is_empty() {
            continue;
        }
        let title = node
            .attribute("title")
            .or_else(|| node.attribute("text"))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());

        match insert_feed(conn, url, title) {
            Ok(true) => added += 1,
            Ok(false) => skipped += 1,
            Err(e) => errors.push(format!("{}: {}", url, e)),
        }
    }

    Ok(OpmlImportReport {
        added,
        skipped,
        errors,
    })
}

fn insert_feed(conn: &Connection, url: &str, title: Option<&str>) -> Result<bool, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("非 HTTP(S) URL".to_string());
    }

    let result = conn.execute(
        "INSERT INTO feeds (url, title) VALUES (?1, ?2)",
        rusqlite::params![url, title],
    );

    match result {
        Ok(_) => Ok(true),
        Err(e) => {
            if e.to_string().contains("UNIQUE") {
                Ok(false)
            } else {
                Err(e.to_string())
            }
        }
    }
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // RFC 822-ish using only the timestamp; OPML readers tolerate any string here.
    format!("{}", secs)
}
