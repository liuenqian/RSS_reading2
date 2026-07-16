use crate::services::entry_identity_service;
use rusqlite::{params, Connection, OptionalExtension};

const PUBMED_SCHEMA_VERSION: i64 = 5;

pub fn needs_migration(conn: &Connection) -> Result<bool, String> {
    let version = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取数据库版本失败: {}", e))?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);

    if version < PUBMED_SCHEMA_VERSION {
        return Ok(true);
    }

    let feed_id_not_null = conn
        .query_row(
            "SELECT \"notnull\" FROM pragma_table_info('entries') WHERE name = 'feed_id'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("读取 entries 结构失败: {}", e))?
        .unwrap_or(1);
    Ok(feed_id_not_null != 0)
}

pub fn migrate(conn: &Connection) -> Result<(), String> {
    if !needs_migration(conn)? {
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("启用外键失败: {}", e))?;
        return Ok(());
    }

    let rebuild_entries = entries_feed_id_is_not_null(conn)?;
    conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
        .map_err(|e| format!("开始数据库迁移失败: {}", e))?;

    let result = (|| -> Result<(), String> {
        if rebuild_entries {
            rebuild_entries_table(conn)?;
        }
        create_pubmed_tables(conn)?;
        ensure_pubmed_search_retrieval_columns(conn)?;
        backfill_feed_memberships(conn)?;
        backfill_identity_display_columns(conn)?;
        entry_identity_service::canonicalize_existing_entries(conn)?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
            [PUBMED_SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| format!("保存数据库版本失败: {}", e))?;
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("COMMIT; PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("提交数据库迁移失败: {}", e))?,
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
            return Err(error);
        }
    }

    let foreign_key_errors: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("检查数据库外键失败: {}", e))?;
    if foreign_key_errors != 0 {
        return Err(format!(
            "数据库迁移后存在 {} 个外键错误",
            foreign_key_errors
        ));
    }
    Ok(())
}

fn entries_feed_id_is_not_null(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT \"notnull\" FROM pragma_table_info('entries') WHERE name = 'feed_id'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|e| format!("读取 entries.feed_id 结构失败: {}", e))
}

fn rebuild_entries_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE entries_v2 (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            feed_id      INTEGER,
            guid         TEXT NOT NULL,
            title        TEXT NOT NULL,
            link         TEXT NOT NULL,
            summary      TEXT,
            summary_source TEXT,
            author       TEXT,
            published_at TEXT,
            publication_date TEXT,
            publication_date_raw TEXT,
            publication_date_precision TEXT,
            publication_sort_key INTEGER,
            source       TEXT,
            pmid         TEXT,
            pmcid        TEXT,
            doi          TEXT,
            pmid_normalized TEXT,
            doi_normalized TEXT,
            affiliation  TEXT,
            has_free_fulltext INTEGER,
            fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
            is_read      INTEGER NOT NULL DEFAULT 0,
            read_at      TEXT,
            FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE SET NULL
        );

        INSERT INTO entries_v2 (
            id, feed_id, guid, title, link, summary, summary_source, author,
            published_at, publication_date, publication_date_raw,
            publication_date_precision, publication_sort_key, source, pmid,
            pmcid, doi, pmid_normalized, doi_normalized, affiliation,
            has_free_fulltext, fetched_at, is_read, read_at
        )
        SELECT
            id, feed_id, guid, title, link, summary, summary_source, author,
            published_at, publication_date, publication_date_raw,
            publication_date_precision, publication_sort_key, source, pmid,
            pmcid, doi, pmid_normalized, doi_normalized, affiliation,
            has_free_fulltext, fetched_at, is_read, read_at
        FROM entries;

        DROP TABLE entries;
        ALTER TABLE entries_v2 RENAME TO entries;
        CREATE INDEX idx_entries_feed_id ON entries(feed_id);
        CREATE INDEX idx_entries_pmid_normalized ON entries(pmid_normalized);
        CREATE INDEX idx_entries_doi_normalized ON entries(doi_normalized);
        ",
    )
    .map_err(|e| format!("重建 entries 表失败: {}", e))
}

fn create_pubmed_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS entry_identifiers (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id         INTEGER NOT NULL,
            kind             TEXT NOT NULL CHECK(kind IN ('pmid', 'doi')),
            value_normalized TEXT NOT NULL,
            status           TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'conflicted')),
            source           TEXT,
            created_at       TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(entry_id, kind, value_normalized),
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_entry_identifiers_lookup
            ON entry_identifiers(kind, value_normalized, status);

        CREATE TABLE IF NOT EXISTS entry_identity_conflicts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL,
            value       TEXT NOT NULL,
            entry_ids_json TEXT NOT NULL,
            source      TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS entry_feed_memberships (
            entry_id     INTEGER NOT NULL,
            feed_id      INTEGER NOT NULL,
            guid         TEXT NOT NULL,
            first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (entry_id, feed_id),
            UNIQUE(feed_id, guid),
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
            FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_entry_feed_memberships_feed
            ON entry_feed_memberships(feed_id, entry_id);

        CREATE TABLE IF NOT EXISTS entry_screening_status (
            entry_id          INTEGER PRIMARY KEY,
            screening_status  TEXT NOT NULL DEFAULT 'unreviewed' CHECK(screening_status IN ('unreviewed', 'keep', 'maybe', 'exclude')),
            screened_at       TEXT,
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_entry_screening_status_status
            ON entry_screening_status(screening_status);

        CREATE TABLE IF NOT EXISTS pubmed_searches (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            name              TEXT NOT NULL,
            question          TEXT,
            query             TEXT NOT NULL,
            retrieval_scope   TEXT NOT NULL DEFAULT 'all',
            retrieval_limit   INTEGER,
            retrieval_date_from TEXT,
            retrieval_date_to TEXT,
            retrieval_sort    TEXT NOT NULL DEFAULT 'most_recent',
            created_at        TEXT NOT NULL DEFAULT (datetime('now')),
            last_attempt_at   TEXT,
            last_success_at   TEXT,
            last_result_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS pubmed_search_runs (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            search_id     INTEGER NOT NULL,
            started_at    TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at  TEXT,
            status        TEXT NOT NULL CHECK(status IN ('running', 'completed', 'partial', 'failed', 'cancelled')),
            matched_count INTEGER NOT NULL DEFAULT 0,
            added_count   INTEGER NOT NULL DEFAULT 0,
            reused_count  INTEGER NOT NULL DEFAULT 0,
            failed_count  INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            FOREIGN KEY (search_id) REFERENCES pubmed_searches(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pubmed_search_runs_search
            ON pubmed_search_runs(search_id, id DESC);

        CREATE TABLE IF NOT EXISTS pubmed_search_entries (
            search_id          INTEGER NOT NULL,
            entry_id           INTEGER NOT NULL,
            screening_status   TEXT NOT NULL DEFAULT 'unreviewed' CHECK(screening_status IN ('unreviewed', 'keep', 'maybe', 'exclude')),
            first_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
            first_seen_run_id  INTEGER,
            screened_at        TEXT,
            is_current_match   INTEGER NOT NULL DEFAULT 1,
            pubmed_rank        INTEGER,
            PRIMARY KEY (search_id, entry_id),
            FOREIGN KEY (search_id) REFERENCES pubmed_searches(id) ON DELETE CASCADE,
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
            FOREIGN KEY (first_seen_run_id) REFERENCES pubmed_search_runs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pubmed_search_entries_status
            ON pubmed_search_entries(search_id, screening_status);

        CREATE TABLE IF NOT EXISTS pubmed_search_run_items (
            run_id         INTEGER NOT NULL,
            pmid           TEXT NOT NULL,
            rank           INTEGER NOT NULL,
            status         TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'fetched', 'reused', 'failed')),
            entry_id       INTEGER,
            error_message  TEXT,
            PRIMARY KEY (run_id, pmid),
            FOREIGN KEY (run_id) REFERENCES pubmed_search_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pubmed_search_run_items_status
            ON pubmed_search_run_items(run_id, status);
        ",
    )
    .map_err(|e| format!("创建 PubMed 数据表失败: {}", e))
}

fn ensure_pubmed_search_retrieval_columns(conn: &Connection) -> Result<(), String> {
    for (name, definition) in [
        ("retrieval_scope", "TEXT NOT NULL DEFAULT 'all'"),
        ("retrieval_limit", "INTEGER"),
        ("retrieval_date_from", "TEXT"),
        ("retrieval_date_to", "TEXT"),
        ("retrieval_sort", "TEXT NOT NULL DEFAULT 'most_recent'"),
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('pubmed_searches') WHERE name = ?1",
                [name],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("读取 pubmed_searches.{} 结构失败: {}", name, e))?
            .is_some();
        if !exists {
            conn.execute_batch(&format!(
                "ALTER TABLE pubmed_searches ADD COLUMN {} {};",
                name, definition
            ))
            .map_err(|e| format!("添加 pubmed_searches.{} 失败: {}", name, e))?;
        }
    }
    Ok(())
}

fn backfill_feed_memberships(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO entry_feed_memberships
            (entry_id, feed_id, guid, first_seen_at, last_seen_at)
         SELECT id, feed_id, guid, fetched_at, fetched_at
         FROM entries
         WHERE feed_id IS NOT NULL",
        [],
    )
    .map_err(|e| format!("回填 RSS 成员关系失败: {}", e))?;
    Ok(())
}

fn backfill_identity_display_columns(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, pmid, doi FROM entries")
        .map_err(|e| format!("读取文献身份失败: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("读取文献身份失败: {}", e))?;

    for row in rows {
        let (entry_id, pmid, doi) = row.map_err(|e| format!("读取文献身份失败: {}", e))?;
        let pmid_normalized = pmid.as_deref().and_then(normalize_pmid);
        let doi_normalized = doi.as_deref().and_then(normalize_doi);
        conn.execute(
            "UPDATE entries SET pmid_normalized = ?1, doi_normalized = ?2 WHERE id = ?3",
            params![pmid_normalized, doi_normalized, entry_id],
        )
        .map_err(|e| format!("回填标准化身份失败: {}", e))?;
        if let Some(value) = pmid_normalized {
            conn.execute(
                "INSERT OR IGNORE INTO entry_identifiers (entry_id, kind, value_normalized, source)
                 VALUES (?1, 'pmid', ?2, 'migration')",
                params![entry_id, value],
            )
            .map_err(|e| format!("回填 PMID 身份失败: {}", e))?;
        }
        if let Some(value) = doi_normalized {
            conn.execute(
                "INSERT OR IGNORE INTO entry_identifiers (entry_id, kind, value_normalized, source)
                 VALUES (?1, 'doi', ?2, 'migration')",
                params![entry_id, value],
            )
            .map_err(|e| format!("回填 DOI 身份失败: {}", e))?;
        }
    }
    Ok(())
}

fn normalize_pmid(raw: &str) -> Option<String> {
    let value: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    (!value.is_empty()).then_some(value)
}

fn normalize_doi(raw: &str) -> Option<String> {
    let mut value = raw.trim().to_ascii_lowercase();
    for prefix in ["https://doi.org/", "http://doi.org/", "doi:"] {
        if let Some(stripped) = value.strip_prefix(prefix) {
            value = stripped.trim().to_string();
            break;
        }
    }
    let value = value.split_whitespace().collect::<String>();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn old_schema() -> Connection {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE feeds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL UNIQUE,
                title TEXT
            );
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                feed_id INTEGER NOT NULL,
                guid TEXT NOT NULL,
                title TEXT NOT NULL,
                link TEXT NOT NULL,
                summary TEXT,
                summary_source TEXT,
                author TEXT,
                published_at TEXT,
                publication_date TEXT,
                publication_date_raw TEXT,
                publication_date_precision TEXT,
                publication_sort_key INTEGER,
                source TEXT,
                pmid TEXT,
                pmcid TEXT,
                doi TEXT,
                pmid_normalized TEXT,
                doi_normalized TEXT,
                affiliation TEXT,
                has_free_fulltext INTEGER,
                fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
                is_read INTEGER NOT NULL DEFAULT 0,
                read_at TEXT,
                UNIQUE(feed_id, guid),
                FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE translations (
                id INTEGER PRIMARY KEY,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                field TEXT NOT NULL,
                original_text TEXT NOT NULL,
                translated_text TEXT NOT NULL
            );
            CREATE TABLE reading_notes (
                id INTEGER PRIMARY KEY,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                profile_id TEXT NOT NULL,
                profile_name TEXT NOT NULL,
                content TEXT NOT NULL
            );
            CREATE TABLE entry_tags (
                id INTEGER PRIMARY KEY,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                tag TEXT NOT NULL
            );
            CREATE TABLE paper_chat_sessions (
                scope_key TEXT PRIMARY KEY,
                entry_ids_json TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE TABLE paper_chat_messages (
                id INTEGER PRIMARY KEY,
                scope_key TEXT NOT NULL REFERENCES paper_chat_sessions(scope_key) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT
            );
            CREATE TABLE reading_events (
                id INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                feed_id INTEGER,
                feed_title_snapshot TEXT,
                entry_id INTEGER,
                occurred_at TEXT
            );
            INSERT INTO feeds (id, url, title) VALUES (7, 'https://example.test/rss', 'Test');
            INSERT INTO entries (id, feed_id, guid, title, link, pmid, doi)
                VALUES (42, 7, 'g-42', 'Paper', 'https://example.test/paper', 'PMID: 12345', 'https://doi.org/10.1/ABC');
            INSERT INTO translations (id, entry_id, field, original_text, translated_text)
                VALUES (1, 42, 'title', 'Paper', '论文');
            INSERT INTO reading_notes (id, entry_id, profile_id, profile_name, content)
                VALUES (2, 42, 'p1', '模板', 'note');
            INSERT INTO entry_tags (id, entry_id, tag) VALUES (3, 42, 'tag');
            ",
        )
        .expect("seed old schema");
        conn
    }

    #[test]
    fn migrates_old_entries_without_changing_ids_or_children() {
        let conn = old_schema();
        migrate(&conn).expect("migrate");

        let not_null: i64 = conn
            .query_row(
                "SELECT \"notnull\" FROM pragma_table_info('entries') WHERE name = 'feed_id'",
                [],
                |row| row.get(0),
            )
            .expect("feed_id shape");
        assert_eq!(not_null, 0);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entries WHERE id = 42", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM translations WHERE entry_id = 42",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM entry_feed_memberships WHERE entry_id = 42 AND feed_id = 7",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let identities: (String, String) = conn
            .query_row(
                "SELECT pmid_normalized, doi_normalized FROM entries WHERE id = 42",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(identities, ("12345".to_string(), "10.1/abc".to_string()));
        let retrieval_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('pubmed_searches')
                 WHERE name IN ('retrieval_scope', 'retrieval_limit', 'retrieval_date_from',
                                'retrieval_date_to', 'retrieval_sort')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retrieval_columns, 5);
        let fk_errors: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(fk_errors, 0);
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = old_schema();
        migrate(&conn).expect("first migration");
        migrate(&conn).expect("second migration");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entry_feed_memberships", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn migrates_existing_pubmed_search_strategy_defaults() {
        let conn = old_schema();
        conn.execute_batch(
            "
            CREATE TABLE pubmed_searches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                question TEXT,
                query TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_attempt_at TEXT,
                last_success_at TEXT,
                last_result_count INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO pubmed_searches (id, name, query) VALUES (9, 'Existing', 'ischemia');
            INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '4');
            ",
        )
        .unwrap();

        migrate(&conn).expect("migrate existing search");
        let strategy: (String, Option<i64>, String) = conn
            .query_row(
                "SELECT retrieval_scope, retrieval_limit, retrieval_sort
                 FROM pubmed_searches WHERE id = 9",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            strategy,
            ("all".to_string(), None, "most_recent".to_string())
        );
    }
}
