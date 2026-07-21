use crate::models::{Feed, PubmedSearch};
use crate::services::{feed_service, pubmed_search_service};
use rusqlite::{params, Connection};

pub fn query_key(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

pub fn find_search_by_query(
    conn: &Connection,
    query: &str,
) -> Result<Option<PubmedSearch>, String> {
    let key = query_key(query);
    Ok(pubmed_search_service::list_searches(conn)?
        .into_iter()
        .find(|search| query_key(&search.query) == key))
}

pub fn find_feed_by_query(conn: &Connection, query: &str) -> Result<Option<Feed>, String> {
    let key = query_key(query);
    Ok(feed_service::list_feeds(conn)?
        .into_iter()
        .find(|feed| feed.pubmed_query.as_deref().map(query_key).as_deref() == Some(key.as_str())))
}

pub fn prepare_feed_to_search(
    conn: &Connection,
    feed_id: i64,
) -> Result<(PubmedSearch, bool), String> {
    let feed = feed_service::get_feed(conn, feed_id)?;
    let query = feed
        .pubmed_query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "该 PubMed RSS 未保存原始检索式，请先编辑订阅并补充检索式".to_string())?;

    if let Some(search) = find_search_by_query(conn, query)? {
        return Ok((search, false));
    }

    let name = conversion_name(feed.title.as_deref(), query);
    let search = pubmed_search_service::create_search(conn, &name, None, query)?;
    Ok((search, true))
}

pub fn finish_feed_to_search(
    conn: &Connection,
    feed_id: i64,
    search_id: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE pubmed_search_entries
         SET screening_status = (
                SELECT ess.screening_status
                FROM entry_screening_status ess
                WHERE ess.entry_id = pubmed_search_entries.entry_id
             ),
             screened_at = CASE
                WHEN (
                    SELECT ess.screening_status
                    FROM entry_screening_status ess
                    WHERE ess.entry_id = pubmed_search_entries.entry_id
                ) = 'unreviewed'
                THEN NULL ELSE COALESCE(screened_at, datetime('now'))
             END
         WHERE search_id = ?1
           AND EXISTS (
                SELECT 1 FROM entry_screening_status ess
                WHERE ess.entry_id = pubmed_search_entries.entry_id
           )",
        [search_id],
    )
    .map_err(|e| format!("迁移 RSS 筛选状态失败: {}", e))?;
    feed_service::delete_feed(conn, feed_id)
}

pub fn rollback_created_search(conn: &Connection, search_id: i64) {
    let _ = pubmed_search_service::delete_search(conn, search_id);
}

pub fn finish_search_to_feed(
    conn: &Connection,
    search_id: i64,
    generated_url: Option<&str>,
    limit: i64,
) -> Result<Feed, String> {
    let search = pubmed_search_service::get_search(conn, search_id)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始 PubMed 转换事务失败: {}", e))?;

    let feed = if let Some(feed) = find_feed_by_query(&tx, &search.query)? {
        feed
    } else {
        let url = generated_url.ok_or_else(|| "缺少新生成的 PubMed RSS 链接".to_string())?;
        let created = feed_service::add_feed(&tx, url)?;
        feed_service::update_feed(
            &tx,
            created.id,
            url,
            Some(&search.name),
            Some(&search.query),
            Some(limit),
        )?;
        feed_service::get_feed(&tx, created.id)?
    };

    tx.execute(
        "INSERT OR IGNORE INTO entry_feed_memberships
            (entry_id, feed_id, guid, first_seen_at, last_seen_at)
         SELECT pse.entry_id, ?1,
                CASE
                    WHEN COALESCE(NULLIF(e.pmid_normalized, ''), NULLIF(e.pmid, '')) IS NOT NULL
                    THEN 'pubmed:' || COALESCE(NULLIF(e.pmid_normalized, ''), NULLIF(e.pmid, ''))
                    ELSE 'entry:' || e.id
                END,
                pse.first_seen_at, pse.last_seen_at
         FROM pubmed_search_entries pse
         JOIN entries e ON e.id = pse.entry_id
         WHERE pse.search_id = ?2",
        params![feed.id, search_id],
    )
    .map_err(|e| format!("迁移 RSS 文献归属失败: {}", e))?;

    tx.execute(
        "UPDATE entries
         SET feed_id = ?1
         WHERE feed_id IS NULL
           AND id IN (SELECT entry_id FROM pubmed_search_entries WHERE search_id = ?2)",
        params![feed.id, search_id],
    )
    .map_err(|e| format!("更新文献订阅来源失败: {}", e))?;

    tx.execute(
        "INSERT INTO entry_screening_status (entry_id, screening_status, screened_at)
         SELECT entry_id, screening_status, screened_at
         FROM pubmed_search_entries
         WHERE search_id = ?1
         ON CONFLICT(entry_id) DO UPDATE SET
            screening_status = excluded.screening_status,
            screened_at = excluded.screened_at",
        [search_id],
    )
    .map_err(|e| format!("迁移文献筛选状态失败: {}", e))?;

    pubmed_search_service::delete_search(&tx, search_id)?;
    tx.commit()
        .map_err(|e| format!("提交 PubMed 转换失败: {}", e))?;
    feed_service::get_feed(conn, feed.id)
}

fn conversion_name(title: Option<&str>, query: &str) -> String {
    let raw = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(query);
    raw.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversion_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE feeds (
                id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
                title TEXT, description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
                refresh_interval TEXT NOT NULL DEFAULT '1d', notify INTEGER NOT NULL DEFAULT 0,
                last_fetched_at TEXT, pubmed_query TEXT, pubmed_limit INTEGER
            );
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY, feed_id INTEGER, pmid TEXT, pmid_normalized TEXT
            );
            CREATE TABLE entry_feed_memberships (
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
                guid TEXT NOT NULL, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY(entry_id, feed_id), UNIQUE(feed_id, guid)
            );
            CREATE TABLE entry_screening_status (
                entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
                screening_status TEXT NOT NULL DEFAULT 'unreviewed',
                screened_at TEXT
            );
            CREATE TABLE pubmed_searches (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, question TEXT,
                query TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_attempt_at TEXT, last_success_at TEXT, last_result_count INTEGER NOT NULL DEFAULT 0,
                retrieval_scope TEXT NOT NULL DEFAULT 'all', retrieval_limit INTEGER,
                retrieval_date_from TEXT, retrieval_date_to TEXT,
                retrieval_sort TEXT NOT NULL DEFAULT 'most_recent'
            );
            CREATE TABLE pubmed_search_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, search_id INTEGER NOT NULL,
                status TEXT NOT NULL, added_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE pubmed_search_run_items (
                run_id INTEGER NOT NULL, pmid TEXT NOT NULL, rank INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', entry_id INTEGER, error_message TEXT,
                PRIMARY KEY(run_id, pmid)
            );
            CREATE TABLE pubmed_search_entries (
                search_id INTEGER NOT NULL REFERENCES pubmed_searches(id) ON DELETE CASCADE,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                screening_status TEXT NOT NULL DEFAULT 'unreviewed',
                first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                first_seen_run_id INTEGER, screened_at TEXT,
                is_current_match INTEGER NOT NULL DEFAULT 1, pubmed_rank INTEGER,
                PRIMARY KEY(search_id, entry_id)
            );
            ",
        )
        .expect("create schema");
        conn
    }

    #[test]
    fn query_key_ignores_case_and_extra_whitespace() {
        assert_eq!(query_key("  Heart   AND Ischemia "), "heart and ischemia");
    }

    #[test]
    fn search_to_feed_moves_memberships_and_removes_search() {
        let conn = conversion_db();
        let search = pubmed_search_service::create_search(&conn, "Heart", None, "heart[Title]")
            .expect("create search");
        conn.execute(
            "INSERT INTO entries (id, pmid, pmid_normalized) VALUES (10, '123', '123')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pubmed_search_entries (search_id, entry_id) VALUES (?1, 10)",
            [search.id],
        )
        .unwrap();

        let feed = finish_search_to_feed(
            &conn,
            search.id,
            Some("https://pubmed.ncbi.nlm.nih.gov/rss/search/token/?limit=100"),
            100,
        )
        .expect("convert to feed");

        assert_eq!(feed.pubmed_query.as_deref(), Some("heart[Title]"));
        assert_eq!(
            conn.query_row(
                "SELECT guid FROM entry_feed_memberships WHERE feed_id = ?1",
                [feed.id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "pubmed:123"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pubmed_searches", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
