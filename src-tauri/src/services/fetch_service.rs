use crate::models::{EntryIdentifiers, Feed, FeedFetchResult, FetchResult};
use crate::services::{article_service, entry_identity_service, feed_service, settings_service};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Mutex;
use tracing::{info, warn};

#[derive(Debug, Default)]
struct ProcessFeedOutcome {
    new_entries: usize,
    errors: Vec<String>,
}

pub async fn fetch_all_feeds(conn_mutex: &Mutex<Connection>) -> Result<FetchResult, String> {
    let (feeds, settings) = {
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        let feeds = crate::services::feed_service::list_feeds(&conn)?;
        let s = settings_service::get_settings(&conn);
        (feeds, s)
    };

    // We allow fetching without an API key — only the translation pipeline
    // requires it. New entries land in the DB, pipeline will pick them up
    // once the user configures the key.
    let _ = &settings;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("RSSReading/0.1")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut result = FetchResult {
        total_feeds: feeds.len(),
        new_entries: 0,
        translated_titles: 0,
        fetched_summaries: 0,
        translated_summaries: 0,
        errors: Vec::new(),
        feeds: Vec::with_capacity(feeds.len()),
    };

    for feed in &feeds {
        info!(feed_id = feed.id, url = %feed.url, "开始刷新订阅源");
        match process_feed(conn_mutex, &client, feed).await {
            Ok(outcome) => {
                result.new_entries += outcome.new_entries;
                result.errors.extend(
                    outcome
                        .errors
                        .into_iter()
                        .map(|error| format!("{}: {}", feed.url, error)),
                );
                result.feeds.push(FeedFetchResult {
                    feed_id: feed.id,
                    feed_title: feed.title.clone().unwrap_or_else(|| feed.url.clone()),
                    new_entries: outcome.new_entries,
                });
                {
                    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
                    let _ = feed_service::mark_feed_fetched(&conn, feed.id);
                }
                info!(
                    feed_id = feed.id,
                    new_entries = outcome.new_entries,
                    "订阅源刷新完成"
                );
            }
            Err(e) => {
                warn!(feed_id = feed.id, error = %e, "订阅源刷新失败");
                result.errors.push(format!("{}: {}", feed.url, e));
            }
        }
    }

    Ok(result)
}

pub async fn fetch_feed(
    conn_mutex: &Mutex<Connection>,
    feed_id: i64,
) -> Result<FetchResult, String> {
    let feed = {
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        feed_service::get_feed(&conn, feed_id)?
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("RSSReading/0.1")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    info!(feed_id = feed.id, url = %feed.url, "开始手动刷新单个订阅源");

    let mut result = FetchResult {
        total_feeds: 1,
        new_entries: 0,
        translated_titles: 0,
        fetched_summaries: 0,
        translated_summaries: 0,
        errors: Vec::new(),
        feeds: Vec::with_capacity(1),
    };

    match process_feed(conn_mutex, &client, &feed).await {
        Ok(outcome) => {
            result.new_entries = outcome.new_entries;
            result.errors.extend(
                outcome
                    .errors
                    .into_iter()
                    .map(|error| format!("{}: {}", feed.url, error)),
            );
            result.feeds.push(FeedFetchResult {
                feed_id: feed.id,
                feed_title: feed.title.clone().unwrap_or_else(|| feed.url.clone()),
                new_entries: outcome.new_entries,
            });
            let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
            let _ = feed_service::mark_feed_fetched(&conn, feed.id);
            info!(
                feed_id = feed.id,
                new_entries = outcome.new_entries,
                "单个订阅源刷新完成"
            );
        }
        Err(e) => {
            warn!(feed_id = feed.id, error = %e, "单个订阅源刷新失败");
            result.errors.push(format!("{}: {}", feed.url, e));
        }
    }

    Ok(result)
}

/// Fetch only feeds whose configured interval has elapsed since `last_fetched_at`.
/// Used by the background scheduler so we don't refresh every feed on every tick.
pub async fn fetch_due_feeds(conn_mutex: &Mutex<Connection>) -> Result<FetchResult, String> {
    let all_feeds = {
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        feed_service::list_feeds(&conn)?
    };

    let due: Vec<Feed> = all_feeds.into_iter().filter(is_feed_due).collect();

    let mut result = FetchResult {
        total_feeds: due.len(),
        new_entries: 0,
        translated_titles: 0,
        fetched_summaries: 0,
        translated_summaries: 0,
        errors: Vec::new(),
        feeds: Vec::with_capacity(due.len()),
    };

    if due.is_empty() {
        return Ok(result);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("RSSReading/0.1")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    for feed in &due {
        info!(feed_id = feed.id, url = %feed.url, "调度刷新订阅源");
        match process_feed(conn_mutex, &client, feed).await {
            Ok(outcome) => {
                result.new_entries += outcome.new_entries;
                result.errors.extend(
                    outcome
                        .errors
                        .into_iter()
                        .map(|error| format!("{}: {}", feed.url, error)),
                );
                result.feeds.push(FeedFetchResult {
                    feed_id: feed.id,
                    feed_title: feed.title.clone().unwrap_or_else(|| feed.url.clone()),
                    new_entries: outcome.new_entries,
                });
                {
                    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
                    let _ = feed_service::mark_feed_fetched(&conn, feed.id);
                }
                info!(
                    feed_id = feed.id,
                    new_entries = outcome.new_entries,
                    "订阅源刷新完成"
                );
            }
            Err(e) => {
                warn!(feed_id = feed.id, error = %e, "订阅源刷新失败");
                result.errors.push(format!("{}: {}", feed.url, e));
            }
        }
    }

    Ok(result)
}

fn is_feed_due(feed: &Feed) -> bool {
    if feed.refresh_interval == "manual" {
        return false;
    }
    let Some(window_secs) = interval_to_secs(&feed.refresh_interval) else {
        return false;
    };
    let Some(last) = feed.last_fetched_at.as_deref() else {
        return true; // never fetched → due
    };
    // SQLite `datetime('now')` stores "YYYY-MM-DD HH:MM:SS" in UTC.
    let Some(last_secs) = parse_sqlite_utc(last) else {
        return true;
    };
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    (now_secs - last_secs) >= window_secs as i64
}

fn interval_to_secs(s: &str) -> Option<u64> {
    Some(match s {
        "15m" => 15 * 60,
        "1h" => 60 * 60,
        "12h" => 12 * 60 * 60,
        "1d" => 24 * 60 * 60,
        "3d" => 3 * 24 * 60 * 60,
        "1w" => 7 * 24 * 60 * 60,
        _ => return None,
    })
}

fn parse_sqlite_utc(s: &str) -> Option<i64> {
    // Format: "YYYY-MM-DD HH:MM:SS"
    if s.len() < 19 {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    let min: u32 = s.get(14..16)?.parse().ok()?;
    let sec: u32 = s.get(17..19)?.parse().ok()?;
    Some(
        days_from_civil(year, month, day) * 86400
            + hour as i64 * 3600
            + min as i64 * 60
            + sec as i64,
    )
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    // Howard Hinnant's algorithm — inverse of civil_from_days.
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let m = m as i64;
    let d = d as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = ((153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1) as u64;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

async fn process_feed(
    conn_mutex: &Mutex<Connection>,
    client: &reqwest::Client,
    feed: &Feed,
) -> Result<ProcessFeedOutcome, String> {
    let response = client
        .get(&feed.url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let parsed = feed_rs::parser::parse(&bytes[..]).map_err(|e| format!("RSS 解析失败: {}", e))?;
    info!(
        feed_id = feed.id,
        entry_count = parsed.entries.len(),
        "RSS 解析完成"
    );

    process_parsed_feed(conn_mutex, client, feed, &parsed).await
}

async fn process_parsed_feed(
    conn_mutex: &Mutex<Connection>,
    client: &reqwest::Client,
    feed: &Feed,
    parsed: &feed_rs::model::Feed,
) -> Result<ProcessFeedOutcome, String> {
    let feed_title = parsed.title.as_ref().map(|t| t.content.clone());

    {
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        if let Some(ref title) = feed_title {
            let _ = conn.execute(
                "UPDATE feeds
                 SET title = ?1
                 WHERE id = ?2 AND (title IS NULL OR trim(title) = '' OR title = url)",
                rusqlite::params![title, feed.id],
            );
        }
    }

    let mut outcome = ProcessFeedOutcome::default();

    for entry in &parsed.entries {
        let guid = entry.id.clone();

        let title = entry
            .title
            .as_ref()
            .map(|t| t.content.clone())
            .unwrap_or_else(|| "(无标题)".to_string());

        let link = entry
            .links
            .first()
            .map(|l| l.href.clone())
            .unwrap_or_default();

        let summary = entry
            .content
            .as_ref()
            .and_then(|c| c.body.clone())
            .or_else(|| entry.summary.as_ref().map(|t| t.content.clone()));
        let metadata = article_service::extract_rss_metadata(summary.as_deref());
        let mut identifiers =
            article_service::extract_entry_identifiers(&link, &guid, summary.as_deref());
        if identifiers.pmid.is_some() || identifiers.pmcid.is_some() || identifiers.doi.is_some() {
            let _ = article_service::enrich_entry_identifiers(client, &mut identifiers).await;
        }

        let author = if entry.authors.is_empty() {
            None
        } else {
            Some(
                entry
                    .authors
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        };

        let published_at = entry.published.or(entry.updated).map(|d| d.to_rfc3339());

        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        let upsert_result = upsert_feed_entry(
            &conn,
            feed.id,
            &guid,
            &title,
            &link,
            summary.as_deref(),
            author.as_deref(),
            published_at.as_deref(),
            metadata.publication_date.as_deref(),
            metadata.source.as_deref(),
            &identifiers,
        );

        let (entry_id, added_to_feed) = match upsert_result {
            Ok(value) => value,
            Err(error) => {
                let label = entry_label(&title, &guid, &link);
                warn!(
                    feed_id = feed.id,
                    entry = %label,
                    error = %error,
                    "跳过失败的 RSS 条目"
                );
                outcome.errors.push(format!("{}: {}", label, error));
                continue;
            }
        };

        if added_to_feed {
            outcome.new_entries += 1;
            // Log an immutable "fetched" event so the stats survive feed deletion
            // or retention-based entry pruning. feed_title may be None on the very
            // first fetch of a brand-new feed (UPDATE above runs in a sibling lock
            // scope), in which case the snapshot stays NULL — the stats query
            // falls back to the live feeds table when present.
            let _ = conn.execute(
                "INSERT INTO reading_events (kind, feed_id, feed_title_snapshot, entry_id)
                 VALUES ('fetched', ?1, ?2, ?3)",
                rusqlite::params![feed.id, feed_title.as_deref(), entry_id],
            );
        }
    }

    Ok(outcome)
}

fn entry_label(title: &str, guid: &str, link: &str) -> String {
    for value in [title, guid, link] {
        let value = value.trim();
        if !value.is_empty() {
            return value.chars().take(80).collect();
        }
    }
    "(无法识别的条目)".to_string()
}

#[allow(clippy::too_many_arguments)]
fn upsert_feed_entry(
    conn: &Connection,
    feed_id: i64,
    guid: &str,
    title: &str,
    link: &str,
    summary: Option<&str>,
    author: Option<&str>,
    published_at: Option<&str>,
    publication_date: Option<&str>,
    source: Option<&str>,
    identifiers: &EntryIdentifiers,
) -> Result<(i64, bool), String> {
    let membership_entry = conn
        .query_row(
            "SELECT entry_id FROM entry_feed_memberships WHERE feed_id = ?1 AND guid = ?2",
            params![feed_id, guid],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("查询 RSS 归属失败: {}", e))?;

    let resolved_entry = match membership_entry {
        Some(entry_id) => Some(entry_id),
        None => entry_identity_service::resolve_entry_id(
            conn,
            identifiers.pmid.as_deref(),
            identifiers.doi.as_deref(),
        )?,
    };

    let entry_id = if let Some(entry_id) = resolved_entry {
        conn.execute(
            "UPDATE entries
             SET feed_id = COALESCE(feed_id, ?1),
                 title = CASE WHEN trim(title) = '' OR title = '(无标题)' THEN ?2 ELSE title END,
                 link = CASE WHEN trim(link) = '' THEN ?3 ELSE link END,
                 summary = COALESCE(NULLIF(summary, ''), ?4),
                 summary_source = CASE
                     WHEN (summary IS NULL OR trim(summary) = '') AND ?4 IS NOT NULL THEN 'rss'
                     ELSE summary_source
                 END,
                 author = COALESCE(NULLIF(author, ''), ?5),
                 published_at = COALESCE(NULLIF(published_at, ''), ?6),
                 publication_date = COALESCE(NULLIF(publication_date, ''), ?7),
                 source = COALESCE(NULLIF(source, ''), ?8),
                 pmid = COALESCE(NULLIF(pmid, ''), ?9),
                 pmcid = COALESCE(NULLIF(pmcid, ''), ?10),
                 doi = COALESCE(NULLIF(doi, ''), ?11)
             WHERE id = ?12",
            params![
                feed_id,
                title,
                link,
                summary,
                author,
                published_at,
                publication_date,
                source,
                identifiers.pmid.as_deref(),
                identifiers.pmcid.as_deref(),
                identifiers.doi.as_deref(),
                entry_id,
            ],
        )
        .map_err(|e| format!("更新规范文献失败: {}", e))?;
        entry_id
    } else {
        conn.execute(
            "INSERT INTO entries
             (feed_id, guid, title, link, summary, summary_source, author, published_at,
              publication_date, source, pmid, pmcid, doi)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                feed_id,
                guid,
                title,
                link,
                summary,
                summary.map(|_| "rss"),
                author,
                published_at,
                publication_date,
                source,
                identifiers.pmid.as_deref(),
                identifiers.pmcid.as_deref(),
                identifiers.doi.as_deref(),
            ],
        )
        .map_err(|e| format!("文献入库失败: {}", e))?;
        conn.last_insert_rowid()
    };

    entry_identity_service::register_entry_identities(
        conn,
        entry_id,
        identifiers.pmid.as_deref(),
        identifiers.doi.as_deref(),
        "rss",
    )?;

    let had_membership = conn
        .query_row(
            "SELECT 1 FROM entry_feed_memberships WHERE entry_id = ?1 AND feed_id = ?2",
            params![entry_id, feed_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("查询 RSS 归属失败: {}", e))?
        .is_some();

    if had_membership {
        conn.execute(
            "UPDATE entry_feed_memberships
             SET last_seen_at = datetime('now')
             WHERE entry_id = ?1 AND feed_id = ?2",
            params![entry_id, feed_id],
        )
        .map_err(|e| format!("更新 RSS 归属失败: {}", e))?;
    } else {
        conn.execute(
            "INSERT INTO entry_feed_memberships (entry_id, feed_id, guid)
             VALUES (?1, ?2, ?3)",
            params![entry_id, feed_id, guid],
        )
        .map_err(|e| format!("保存 RSS 归属失败: {}", e))?;
    }

    Ok((entry_id, !had_membership))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn membership_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE feeds (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE);
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feed_id INTEGER,
                guid TEXT NOT NULL,
                title TEXT NOT NULL,
                link TEXT NOT NULL,
                summary TEXT,
                summary_source TEXT,
                author TEXT,
                published_at TEXT,
                publication_date TEXT,
                source TEXT,
                pmid TEXT,
                pmcid TEXT,
                doi TEXT,
                pmid_normalized TEXT,
                doi_normalized TEXT
            );
            CREATE TABLE entry_identifiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                value_normalized TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                source TEXT,
                UNIQUE(entry_id, kind, value_normalized)
            );
            CREATE UNIQUE INDEX idx_entry_identifiers_active_unique
                ON entry_identifiers(kind, value_normalized) WHERE status = 'active';
            CREATE TABLE entry_identity_conflicts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                value TEXT NOT NULL,
                entry_ids_json TEXT NOT NULL,
                source TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE entry_feed_memberships (
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
                guid TEXT NOT NULL,
                first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY(entry_id, feed_id),
                UNIQUE(feed_id, guid)
            );
            INSERT INTO feeds (id, url) VALUES
                (1, 'https://one.test/rss'),
                (2, 'https://two.test/rss');
            ",
        )
        .expect("create schema");
        conn
    }

    #[test]
    fn same_pmid_from_two_feeds_reuses_entry_and_adds_memberships() {
        let conn = membership_db();
        let ids = EntryIdentifiers {
            pmid: Some("123456".to_string()),
            pmcid: None,
            doi: Some("10.1000/test".to_string()),
        };

        let first = upsert_feed_entry(
            &conn,
            1,
            "feed-one-guid",
            "Paper",
            "https://example.test/1",
            Some("Abstract"),
            None,
            Some("2026-07-01"),
            Some("2026-07"),
            Some("Journal"),
            &ids,
        )
        .expect("insert first feed");
        let second = upsert_feed_entry(
            &conn,
            2,
            "feed-two-guid",
            "Paper",
            "https://example.test/2",
            None,
            None,
            Some("2026-07-01"),
            Some("2026-07"),
            Some("Journal"),
            &ids,
        )
        .expect("insert second feed");

        assert_eq!(first.0, second.0);
        assert!(first.1);
        assert!(second.1);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entry_feed_memberships", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn parsed_feed_continues_after_one_entry_write_failure() {
        let conn = membership_db();
        conn.execute_batch(
            "
            CREATE TRIGGER reject_bad_entry
            BEFORE INSERT ON entries
            WHEN NEW.title = 'Bad entry'
            BEGIN
                SELECT RAISE(FAIL, 'forced entry failure');
            END;
            ",
        )
        .expect("create failure trigger");

        let rss = br#"
            <rss version="2.0">
              <channel>
                <title>Failure tolerant feed</title>
                <item>
                  <guid>good-1</guid>
                  <title>Good entry one</title>
                  <link>https://example.test/good-1</link>
                </item>
                <item>
                  <guid>bad-1</guid>
                  <title>Bad entry</title>
                  <link>https://example.test/bad-1</link>
                </item>
                <item>
                  <guid>good-2</guid>
                  <title>Good entry two</title>
                  <link>https://example.test/good-2</link>
                </item>
              </channel>
            </rss>
        "#;
        let parsed = feed_rs::parser::parse(&rss[..]).expect("parse rss");
        let feed = Feed {
            id: 1,
            url: "https://one.test/rss".to_string(),
            title: None,
            description: None,
            created_at: "2026-07-19 00:00:00".to_string(),
            refresh_interval: "1d".to_string(),
            notify: false,
            last_fetched_at: None,
            pubmed_query: None,
            pubmed_limit: None,
        };
        let client = reqwest::Client::builder().build().expect("client");
        let conn_mutex = Mutex::new(conn);

        let outcome = process_parsed_feed(&conn_mutex, &client, &feed, &parsed)
            .await
            .expect("process parsed feed");

        assert_eq!(outcome.new_entries, 2);
        assert_eq!(outcome.errors.len(), 1);
        assert!(outcome.errors[0].contains("Bad entry"));
        assert!(outcome.errors[0].contains("forced entry failure"));

        let conn = conn_mutex.lock().expect("lock database");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM entries WHERE title = 'Bad entry'",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .unwrap(),
            0
        );
    }
}
