use crate::db_migrations;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

const DB_FILE_NAME: &str = "cento.db";
const LEGACY_DB_FILE_NAME: &str = "rss reading.db";
const LEGACY_APP_DIRS: &[&str] = &["io.github.itsdrchen.cento"];

pub struct DbState {
    pub conn: Mutex<Connection>,
    /// Set to true while `briefing_service::generate_briefing` is in flight.
    /// Prevents the user from kicking off a second briefing (by clicking the
    /// button again while the first request is still pending against the slow
    /// DeepSeek API) — which used to silently produce 5-10 duplicate rows
    /// covering the same period.
    pub briefing_in_flight: AtomicBool,
    pub pubmed_run_cancellations: Mutex<HashMap<i64, Arc<AtomicBool>>>,
}

fn schema_sql() -> &'static str {
    "
    CREATE TABLE IF NOT EXISTS feeds (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        url         TEXT NOT NULL UNIQUE,
        title       TEXT,
        description TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_id      INTEGER,
        guid         TEXT NOT NULL,
        title        TEXT NOT NULL,
        link         TEXT NOT NULL,
        summary      TEXT,
        summary_source TEXT,
        author       TEXT,
        published_at TEXT,
        pmid         TEXT,
        pmcid        TEXT,
        doi          TEXT,
        pmid_normalized TEXT,
        doi_normalized TEXT,
        publication_date_raw TEXT,
        publication_date_precision TEXT,
        publication_sort_key INTEGER,
        fetched_at   TEXT NOT NULL DEFAULT (datetime('now')),
        is_read      INTEGER NOT NULL DEFAULT 0,
        read_at      TEXT,
        FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS translations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id        INTEGER NOT NULL,
        field           TEXT NOT NULL CHECK(field IN ('title', 'summary')),
        original_text   TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        model           TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(entry_id, field),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cost_log (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        month                    TEXT NOT NULL,
        model                    TEXT NOT NULL,
        prompt_cache_hit_tokens  INTEGER NOT NULL DEFAULT 0,
        prompt_cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens        INTEGER NOT NULL DEFAULT 0,
        UNIQUE(month, model)
    );

    CREATE TABLE IF NOT EXISTS briefings (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        period        TEXT NOT NULL,
        source_scope  TEXT NOT NULL DEFAULT 'all',
        source_name   TEXT NOT NULL DEFAULT '全部来源',
        title         TEXT NOT NULL,
        lead_in       TEXT NOT NULL,
        content       TEXT NOT NULL,
        article_count INTEGER NOT NULL,
        feed_count    INTEGER NOT NULL,
        generated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS briefing_annotations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        briefing_id     INTEGER NOT NULL,
        kind            TEXT NOT NULL CHECK(kind IN ('note', 'highlight')),
        selected_text   TEXT NOT NULL DEFAULT '',
        anchor_json     TEXT NOT NULL DEFAULT '',
        color           TEXT NOT NULL DEFAULT 'yellow'
            CHECK(
                color IN ('yellow', 'green', 'blue', 'pink', 'purple', 'orange')
                OR color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'
            ),
        note            TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (briefing_id) REFERENCES briefings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_briefing_annotations_briefing
        ON briefing_annotations(briefing_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS reading_notes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id      INTEGER NOT NULL,
        profile_id    TEXT NOT NULL,
        profile_name  TEXT NOT NULL,
        content       TEXT NOT NULL,
        generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(entry_id, profile_id),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reading_notes_entry
        ON reading_notes(entry_id);

    CREATE TABLE IF NOT EXISTS entry_pdf_fulltexts (
        entry_id    INTEGER PRIMARY KEY,
        content     TEXT NOT NULL,
        source_url  TEXT,
        indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS paper_chat_sessions (
        scope_key      TEXT PRIMARY KEY,
        entry_ids_json TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_chat_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key  TEXT NOT NULL,
        role       TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (scope_key) REFERENCES paper_chat_sessions(scope_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_paper_chat_messages_scope
        ON paper_chat_messages(scope_key, id);

    CREATE TABLE IF NOT EXISTS entry_tags (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id      INTEGER NOT NULL,
        tag           TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entry_tags_entry
        ON entry_tags(entry_id);
    CREATE INDEX IF NOT EXISTS idx_entry_tags_tag
        ON entry_tags(tag);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_tags_entry_tag_nocase
        ON entry_tags(entry_id, lower(tag));

    CREATE TABLE IF NOT EXISTS entry_user_state (
        entry_id    INTEGER PRIMARY KEY,
        is_starred  INTEGER NOT NULL DEFAULT 0,
        starred_at  TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS feed_entry_screening_status (
        feed_id            INTEGER NOT NULL,
        entry_id           INTEGER NOT NULL,
        screening_status   TEXT NOT NULL DEFAULT 'unreviewed'
            CHECK(screening_status IN ('unreviewed', 'keep', 'maybe', 'exclude')),
        exclusion_reason   TEXT,
        screening_note     TEXT,
        screened_at        TEXT,
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (feed_id, entry_id),
        FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_feed_entry_screening_status
        ON feed_entry_screening_status(feed_id, screening_status);

    CREATE TABLE IF NOT EXISTS screening_table_preferences (
        scope_kind    TEXT NOT NULL CHECK(scope_kind IN ('pubmed', 'feed', 'project')),
        scope_id      INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        config_json   TEXT NOT NULL,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scope_kind, scope_id)
    );

    CREATE TABLE IF NOT EXISTS pubmed_author_identity_states (
        search_id      INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        state_json     TEXT NOT NULL,
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (search_id) REFERENCES pubmed_searches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pubmed_entry_authors (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id        INTEGER NOT NULL,
        author_order    INTEGER NOT NULL,
        last_name       TEXT,
        fore_name       TEXT,
        initials        TEXT,
        collective_name TEXT,
        display_name    TEXT NOT NULL,
        orcid           TEXT,
        UNIQUE(entry_id, author_order),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pubmed_entry_authors_entry
        ON pubmed_entry_authors(entry_id, author_order);
    CREATE INDEX IF NOT EXISTS idx_pubmed_entry_authors_orcid
        ON pubmed_entry_authors(orcid) WHERE orcid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS pubmed_entry_author_affiliations (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_author_id   INTEGER NOT NULL,
        affiliation_order INTEGER NOT NULL,
        raw_text          TEXT NOT NULL,
        UNIQUE(entry_author_id, affiliation_order),
        FOREIGN KEY (entry_author_id) REFERENCES pubmed_entry_authors(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pubmed_author_affiliations_author
        ON pubmed_entry_author_affiliations(entry_author_id, affiliation_order);

    CREATE TABLE IF NOT EXISTS pubmed_search_run_queries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL,
        query_kind      TEXT NOT NULL CHECK(query_kind IN ('base', 'expansion')),
        query           TEXT NOT NULL,
        profile_version INTEGER,
        status          TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'completed', 'failed')),
        result_count    INTEGER NOT NULL DEFAULT 0,
        error_message   TEXT,
        UNIQUE(run_id, query_kind),
        FOREIGN KEY (run_id) REFERENCES pubmed_search_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pubmed_search_run_queries_run
        ON pubmed_search_run_queries(run_id, id);

    CREATE TABLE IF NOT EXISTS pubmed_search_run_item_sources (
        run_id       INTEGER NOT NULL,
        pmid         TEXT NOT NULL,
        run_query_id INTEGER NOT NULL,
        rank         INTEGER NOT NULL,
        PRIMARY KEY (run_query_id, pmid),
        FOREIGN KEY (run_id, pmid)
            REFERENCES pubmed_search_run_items(run_id, pmid) ON DELETE CASCADE,
        FOREIGN KEY (run_query_id)
            REFERENCES pubmed_search_run_queries(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pubmed_run_item_sources_item
        ON pubmed_search_run_item_sources(run_id, pmid);

    -- Immutable append-only log driving reading stats. Deliberately NOT
    -- foreign-keyed to feeds/entries: deleting a feed (or pruning entries via
    -- read_retention_days) must NOT erase the historical record of what the
    -- user fetched and read.
    CREATE TABLE IF NOT EXISTS reading_events (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        kind                TEXT NOT NULL CHECK(kind IN ('fetched', 'read')),
        feed_id             INTEGER,
        feed_title_snapshot TEXT,
        entry_id            INTEGER,
        occurred_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reading_events_kind_date
        ON reading_events(kind, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_reading_events_kind_feed
        ON reading_events(kind, feed_id);

    PRAGMA foreign_keys = ON;

    INSERT OR IGNORE INTO settings (key, value) VALUES ('base_url', 'https://api.deepseek.com');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('model', 'deepseek-v4-flash');
    "
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| format!("读取表结构失败: {}", e))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("读取表结构失败: {}", e))?;

    for existing in columns {
        if existing.map_err(|e| format!("读取表结构失败: {}", e))? == column {
            return Ok(());
        }
    }

    conn.execute(
        &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, definition),
        [],
    )
    .map_err(|e| format!("迁移数据库失败: {}", e))?;
    Ok(())
}

pub fn initialize(app_data_dir: PathBuf) -> Result<DbState, String> {
    fs::create_dir_all(&app_data_dir).map_err(|e| format!("无法创建数据目录: {}", e))?;

    let db_path = app_data_dir.join(DB_FILE_NAME);

    maybe_restore_legacy_db(&app_data_dir, &db_path)?;

    let conn = Connection::open(&db_path).map_err(|e| format!("无法打开数据库: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("无法设置 WAL 模式: {}", e))?;

    conn.execute_batch(schema_sql())
        .map_err(|e| format!("无法创建表: {}", e))?;

    let needs_pubmed_migration = db_migrations::needs_migration(&conn)?;
    if needs_pubmed_migration && current_db_has_user_data(&db_path)? {
        conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
            .map_err(|e| format!("迁移前同步数据库失败: {}", e))?;
        backup_pubmed_migration_db(&app_data_dir, &db_path)?;
    }

    ensure_column(&conn, "entries", "publication_date", "TEXT")?;
    ensure_column(&conn, "entries", "source", "TEXT")?;
    ensure_column(&conn, "entries", "pmid", "TEXT")?;
    ensure_column(&conn, "entries", "pmcid", "TEXT")?;
    ensure_column(&conn, "entries", "doi", "TEXT")?;
    ensure_column(&conn, "entries", "summary_source", "TEXT")?;
    ensure_column(&conn, "entries", "is_read", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "entries", "read_at", "TEXT")?;
    ensure_column(&conn, "entries", "affiliation", "TEXT")?;
    ensure_column(&conn, "entries", "has_free_fulltext", "INTEGER")?;
    ensure_column(&conn, "entries", "pmid_normalized", "TEXT")?;
    ensure_column(&conn, "entries", "doi_normalized", "TEXT")?;
    ensure_column(&conn, "entries", "publication_date_raw", "TEXT")?;
    ensure_column(&conn, "entries", "publication_date_precision", "TEXT")?;
    ensure_column(&conn, "entries", "publication_sort_key", "INTEGER")?;
    ensure_column(
        &conn,
        "feeds",
        "refresh_interval",
        "TEXT NOT NULL DEFAULT '1d'",
    )?;
    ensure_column(&conn, "feeds", "notify", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "feeds", "last_fetched_at", "TEXT")?;
    ensure_column(&conn, "feeds", "pubmed_query", "TEXT")?;
    ensure_column(&conn, "feeds", "pubmed_limit", "INTEGER")?;
    conn.execute(
        "UPDATE entries
         SET summary_source = 'rss'
         WHERE summary_source IS NULL AND summary IS NOT NULL AND trim(summary) <> ''",
        [],
    )
    .map_err(|e| format!("回填摘要来源失败: {}", e))?;
    conn.execute("DELETE FROM settings WHERE key = 'elsevier_api_key'", [])
        .map_err(|e| format!("清理旧设置失败: {}", e))?;

    db_migrations::migrate(&conn)?;

    backfill_reading_events(&conn)?;

    Ok(DbState {
        conn: Mutex::new(conn),
        briefing_in_flight: AtomicBool::new(false),
        pubmed_run_cancellations: Mutex::new(HashMap::new()),
    })
}

fn maybe_restore_legacy_db(app_data_dir: &Path, current_db_path: &Path) -> Result<(), String> {
    let Some(legacy_db_path) = find_legacy_db_candidate(app_data_dir)? else {
        return Ok(());
    };

    if current_db_has_user_data(current_db_path)? || !db_has_user_data(&legacy_db_path)? {
        return Ok(());
    }

    if current_db_path.exists() {
        backup_current_db_family(app_data_dir, current_db_path)?;
    }

    remove_db_family(current_db_path)?;
    copy_db_family(&legacy_db_path, current_db_path)?;
    Ok(())
}

fn find_legacy_db_candidate(app_data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let mut candidates = vec![app_data_dir.join(LEGACY_DB_FILE_NAME)];

    if let Some(parent) = app_data_dir.parent() {
        for legacy_dir in LEGACY_APP_DIRS {
            candidates.push(parent.join(legacy_dir).join(DB_FILE_NAME));
        }
    }

    for candidate in candidates {
        if candidate.exists() && db_has_user_data(&candidate)? {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
}

fn current_db_has_user_data(current_db_path: &Path) -> Result<bool, String> {
    if !current_db_path.exists() {
        return Ok(false);
    }
    db_has_user_data(current_db_path)
}

fn db_has_user_data(db_path: &Path) -> Result<bool, String> {
    if !db_path.exists() {
        return Ok(false);
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法读取数据库 {}: {}", db_path.display(), e))?;

    let table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('feeds', 'entries')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取数据库结构失败 {}: {}", db_path.display(), e))?;

    if table_count == 0 {
        return Ok(false);
    }

    let user_rows: i64 = conn
        .query_row(
            "SELECT
                COALESCE((SELECT COUNT(*) FROM feeds), 0) +
                COALESCE((SELECT COUNT(*) FROM entries), 0)",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取数据库内容失败 {}: {}", db_path.display(), e))?;

    Ok(user_rows > 0)
}

fn backup_current_db_family(app_data_dir: &Path, current_db_path: &Path) -> Result<(), String> {
    let backup_db_path = app_data_dir.join("cento.pre-legacy-restore.db");
    copy_sidecar_if_exists(current_db_path, &backup_db_path)?;
    Ok(())
}

fn backup_pubmed_migration_db(app_data_dir: &Path, current_db_path: &Path) -> Result<(), String> {
    let backup_db_path = app_data_dir.join("cento.pre-pubmed-migration.db");
    copy_sidecar_if_exists(current_db_path, &backup_db_path)
}

fn remove_db_family(db_path: &Path) -> Result<(), String> {
    for path in db_family_paths(db_path) {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("无法删除旧数据库文件 {}: {}", path.display(), e))?;
        }
    }
    Ok(())
}

fn copy_db_family(from_db_path: &Path, to_db_path: &Path) -> Result<(), String> {
    copy_sidecar_if_exists(from_db_path, to_db_path)?;
    Ok(())
}

fn copy_sidecar_if_exists(from_db_path: &Path, to_db_path: &Path) -> Result<(), String> {
    for (from, to) in db_family_paths(from_db_path)
        .into_iter()
        .zip(db_family_paths(to_db_path).into_iter())
    {
        if from.exists() {
            fs::copy(&from, &to).map_err(|e| {
                format!(
                    "无法复制数据库文件 {} -> {}: {}",
                    from.display(),
                    to.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

fn db_family_paths(db_path: &Path) -> [PathBuf; 3] {
    let file_name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(DB_FILE_NAME);
    [
        db_path.to_path_buf(),
        db_path.with_file_name(format!("{}-wal", file_name)),
        db_path.with_file_name(format!("{}-shm", file_name)),
    ]
}

/// One-shot backfill for pre-existing installs: derive `reading_events` rows
/// from whatever is currently in `entries`. Gated by a settings flag so it
/// never runs twice and never duplicates events for fresh installs.
fn backfill_reading_events(conn: &Connection) -> Result<(), String> {
    let already: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'reading_events_backfilled'",
            [],
            |row| row.get(0),
        )
        .ok();
    if already.as_deref() == Some("1") {
        return Ok(());
    }

    conn.execute(
        "INSERT INTO reading_events (kind, feed_id, feed_title_snapshot, entry_id, occurred_at)
         SELECT 'fetched', e.feed_id, f.title, e.id, COALESCE(e.fetched_at, datetime('now'))
         FROM entries e LEFT JOIN feeds f ON f.id = e.feed_id",
        [],
    )
    .map_err(|e| format!("回填抓取事件失败: {}", e))?;

    conn.execute(
        "INSERT INTO reading_events (kind, feed_id, feed_title_snapshot, entry_id, occurred_at)
         SELECT 'read', e.feed_id, f.title, e.id, e.read_at
         FROM entries e LEFT JOIN feeds f ON f.id = e.feed_id
         WHERE e.is_read = 1 AND e.read_at IS NOT NULL",
        [],
    )
    .map_err(|e| format!("回填阅读事件失败: {}", e))?;

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('reading_events_backfilled', '1')",
        [],
    )
    .map_err(|e| format!("设置回填标志失败: {}", e))?;

    Ok(())
}
