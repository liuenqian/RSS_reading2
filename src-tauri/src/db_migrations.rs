use crate::services::entry_identity_service;
use rusqlite::{params, Connection, OptionalExtension};

const PUBMED_SCHEMA_VERSION: i64 = 15;

fn ensure_briefing_scope_columns(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS briefings (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            period        TEXT NOT NULL,
            title         TEXT NOT NULL,
            lead_in       TEXT NOT NULL,
            content       TEXT NOT NULL,
            article_count INTEGER NOT NULL,
            feed_count    INTEGER NOT NULL,
            generated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )
    .map_err(|error| format!("创建简报表失败: {}", error))?;
    let columns = conn
        .prepare("SELECT name FROM pragma_table_info('briefings')")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("读取简报表结构失败: {}", error))?;
    if !columns.iter().any(|column| column == "source_scope") {
        conn.execute(
            "ALTER TABLE briefings ADD COLUMN source_scope TEXT NOT NULL DEFAULT 'all'",
            [],
        )
        .map_err(|error| format!("添加简报来源范围失败: {}", error))?;
    }
    if !columns.iter().any(|column| column == "source_name") {
        conn.execute(
            "ALTER TABLE briefings ADD COLUMN source_name TEXT NOT NULL DEFAULT '全部来源'",
            [],
        )
        .map_err(|error| format!("添加简报来源名称失败: {}", error))?;
    }
    Ok(())
}

fn ensure_briefing_annotation_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS briefing_annotations (
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
            ON briefing_annotations(briefing_id, updated_at DESC, id DESC);",
    )
    .map_err(|error| format!("创建简报标注表失败: {}", error))?;
    Ok(())
}

fn briefing_annotation_colors_are_current(conn: &Connection) -> Result<bool, String> {
    let schema = conn
        .query_row(
            "SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'briefing_annotations'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("读取简报标注颜色结构失败: {}", error))?;
    Ok(schema
        .as_deref()
        .is_some_and(|sql| sql.contains("color GLOB '#[0-9A-Fa-f]")))
}

fn ensure_briefing_annotation_color_schema(conn: &Connection) -> Result<(), String> {
    if briefing_annotation_colors_are_current(conn)? {
        return Ok(());
    }

    conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
        .map_err(|error| format!("开始简报颜色迁移失败: {}", error))?;
    let result = conn
        .execute_batch(
            "DROP TABLE IF EXISTS briefing_annotations_v2;
             CREATE TABLE briefing_annotations_v2 (
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
             INSERT INTO briefing_annotations_v2 (
                id, briefing_id, kind, selected_text, anchor_json, color, note,
                created_at, updated_at
             )
             SELECT id, briefing_id, kind, selected_text, anchor_json, color, note,
                    created_at, updated_at
             FROM briefing_annotations;
             DROP TABLE briefing_annotations;
             ALTER TABLE briefing_annotations_v2 RENAME TO briefing_annotations;
             CREATE INDEX idx_briefing_annotations_briefing
                ON briefing_annotations(briefing_id, updated_at DESC, id DESC);",
        )
        .map_err(|error| format!("迁移简报颜色失败: {}", error));
    finish_migration(conn, result, "简报颜色")
}

fn current_schema_version(conn: &Connection) -> Result<i64, String> {
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
    Ok(version)
}

pub fn needs_migration(conn: &Connection) -> Result<bool, String> {
    let version = current_schema_version(conn)?;

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
    if feed_id_not_null != 0 {
        return Ok(true);
    }
    let briefing_scope_columns = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('briefings')
             WHERE name IN ('source_scope', 'source_name')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取简报表结构失败: {}", e))?;
    if briefing_scope_columns != 2 {
        return Ok(true);
    }
    let briefing_annotations_exists = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'briefing_annotations'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取简报标注表结构失败: {}", e))?;
    if briefing_annotations_exists != 1 {
        return Ok(true);
    }
    Ok(!briefing_annotation_colors_are_current(conn)?)
}

pub fn migrate(conn: &Connection) -> Result<(), String> {
    if !needs_migration(conn)? {
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("启用外键失败: {}", e))?;
        return Ok(());
    }

    let version = current_schema_version(conn)?;
    let rebuild_entries = entries_feed_id_is_not_null(conn)?;
    ensure_briefing_scope_columns(conn)?;
    ensure_briefing_annotation_table(conn)?;
    ensure_briefing_annotation_color_schema(conn)?;
    if version >= 13 && !rebuild_entries {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
            [PUBMED_SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| format!("保存数据库版本失败: {}", e))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("启用外键失败: {}", e))?;
        return Ok(());
    }
    if current_schema_version(conn)? == 5 && !rebuild_entries {
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS entry_pdf_fulltexts (
                entry_id    INTEGER PRIMARY KEY,
                content     TEXT NOT NULL,
                source_url  TEXT,
                indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
             );
             INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '6');
             COMMIT;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| format!("升级 PDF 全文索引失败: {}", e))?;
        return Ok(());
    }
    if version == 6 && !rebuild_entries {
        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始初筛状态迁移失败: {}", e))?;
        let result = (|| -> Result<(), String> {
            create_screening_state_tables(conn)?;
            create_author_identity_tables(conn)?;
            create_structured_author_tables(conn)?;
            ensure_author_run_columns(conn)?;
            create_pmc_gallery_searches_table(conn)?;
            ensure_pmc_gallery_figure_metric_columns(conn)?;
            ensure_screening_columns(conn)?;
            backfill_feed_screening_status(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
                [PUBMED_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| format!("保存数据库版本失败: {}", e))?;
            Ok(())
        })();
        return finish_migration(conn, result, "初筛状态");
    }
    if version == 7 && !rebuild_entries {
        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始作者身份状态迁移失败: {}", e))?;
        let result = (|| -> Result<(), String> {
            create_author_identity_tables(conn)?;
            create_structured_author_tables(conn)?;
            ensure_author_run_columns(conn)?;
            create_pmc_gallery_searches_table(conn)?;
            ensure_pmc_gallery_figure_metric_columns(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
                [PUBMED_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| format!("保存数据库版本失败: {}", e))?;
            Ok(())
        })();
        return finish_migration(conn, result, "作者身份状态");
    }
    if version == 8 && !rebuild_entries {
        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始 PMC 图库检索迁移失败: {}", e))?;
        let result = (|| -> Result<(), String> {
            create_pmc_gallery_searches_table(conn)?;
            ensure_pmc_gallery_figure_metric_columns(conn)?;
            create_structured_author_tables(conn)?;
            ensure_author_run_columns(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
                [PUBMED_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| format!("保存数据库版本失败: {}", e))?;
            Ok(())
        })();
        return finish_migration(conn, result, "PMC 图库检索");
    }
    if version == 9 && !rebuild_entries {
        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始 PMC 期刊筛选迁移失败: {}", e))?;
        let result = (|| -> Result<(), String> {
            conn.execute(
                "ALTER TABLE pmc_gallery_searches ADD COLUMN journal_filter TEXT NOT NULL DEFAULT 'all'",
                [],
            )
            .map_err(|e| format!("添加 PMC 期刊筛选字段失败: {}", e))?;
            ensure_pmc_gallery_figure_metric_columns(conn)?;
            create_structured_author_tables(conn)?;
            ensure_author_run_columns(conn)?;
            ensure_pmc_gallery_figure_metric_columns(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
                [PUBMED_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| format!("保存数据库版本失败: {}", e))?;
            Ok(())
        })();
        return finish_migration(conn, result, "PMC 期刊筛选");
    }
    if version == 10 && !rebuild_entries {
        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始结构化作者迁移失败: {}", e))?;
        let result = (|| -> Result<(), String> {
            create_structured_author_tables(conn)?;
            ensure_author_run_columns(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
                [PUBMED_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| format!("保存数据库版本失败: {}", e))?;
            Ok(())
        })();
        return finish_migration(conn, result, "结构化作者");
    }
    if version == 11 && !rebuild_entries {
        conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
            .map_err(|e| format!("开始 PMC 高分摘要图迁移失败: {}", e))?;
        let result = (|| -> Result<(), String> {
            ensure_pmc_gallery_figure_metric_columns(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
                [PUBMED_SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| format!("保存数据库版本失败: {}", e))?;
            Ok(())
        })();
        return finish_migration(conn, result, "PMC 高分摘要图");
    }
    conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
        .map_err(|e| format!("开始数据库迁移失败: {}", e))?;

    let result = (|| -> Result<(), String> {
        if rebuild_entries {
            rebuild_entries_table(conn)?;
        }
        create_pubmed_tables(conn)?;
        ensure_pubmed_search_retrieval_columns(conn)?;
        create_screening_state_tables(conn)?;
        create_author_identity_tables(conn)?;
        create_structured_author_tables(conn)?;
        ensure_author_run_columns(conn)?;
        create_pmc_gallery_searches_table(conn)?;
        ensure_briefing_scope_columns(conn)?;
        ensure_pmc_gallery_figure_metric_columns(conn)?;
        ensure_screening_columns(conn)?;
        backfill_feed_memberships(conn)?;
        backfill_feed_screening_status(conn)?;
        backfill_identity_display_columns(conn)?;
        entry_identity_service::canonicalize_existing_entries(conn)?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?1)",
            [PUBMED_SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| format!("保存数据库版本失败: {}", e))?;
        Ok(())
    })();

    finish_migration(conn, result, "数据库")
}

fn finish_migration(
    conn: &Connection,
    result: Result<(), String>,
    label: &str,
) -> Result<(), String> {
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT; PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("提交{}迁移失败: {}", label, e))?,
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
            run_type      TEXT NOT NULL DEFAULT 'standard',
            profile_version INTEGER,
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

        CREATE TABLE IF NOT EXISTS entry_pdf_fulltexts (
            entry_id    INTEGER PRIMARY KEY,
            content     TEXT NOT NULL,
            source_url  TEXT,
            indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
        );
        ",
    )
    .map_err(|e| format!("创建 PubMed 数据表失败: {}", e))
}

fn create_pmc_gallery_searches_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS pmc_gallery_searches (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            name                  TEXT NOT NULL,
            mode                  TEXT NOT NULL DEFAULT 'topic' CHECK(mode IN ('topic', 'author')),
            question              TEXT,
            author_name           TEXT,
            affiliation           TEXT,
            start_date            TEXT,
            end_date              TEXT,
            query                 TEXT NOT NULL,
            article_limit         INTEGER NOT NULL DEFAULT 8,
            journal_filter        TEXT NOT NULL DEFAULT 'all',
            impact_factor_filter  TEXT NOT NULL DEFAULT 'all',
            jcr_quartile_filter   TEXT NOT NULL DEFAULT 'all',
            cas_partition_filter  TEXT NOT NULL DEFAULT 'all',
            top_filter            TEXT NOT NULL DEFAULT 'all',
            created_at            TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
            last_success_at       TEXT,
            last_result_count     INTEGER NOT NULL DEFAULT 0,
            last_scanned_articles INTEGER NOT NULL DEFAULT 0,
            last_figure_count     INTEGER NOT NULL DEFAULT 0,
            last_next_offset      INTEGER NOT NULL DEFAULT 0,
            last_has_more         INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_pmc_gallery_searches_updated
            ON pmc_gallery_searches(updated_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS pmc_gallery_figures (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            search_id      INTEGER NOT NULL,
            pmcid          TEXT NOT NULL,
            article_title  TEXT NOT NULL,
            article_url    TEXT NOT NULL,
            label          TEXT NOT NULL,
            caption        TEXT NOT NULL,
            image_url      TEXT NOT NULL,
            license        TEXT NOT NULL,
            figure_kind    TEXT NOT NULL,
            journal        TEXT NOT NULL DEFAULT '',
            publication_year INTEGER,
            impact_factor  TEXT,
            jcr_quartile   TEXT,
            cas_partition  TEXT,
            is_top         INTEGER,
            position       INTEGER NOT NULL DEFAULT 0,
            UNIQUE(search_id, image_url),
            FOREIGN KEY (search_id) REFERENCES pmc_gallery_searches(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pmc_gallery_figures_search
            ON pmc_gallery_figures(search_id, position, id);
        ",
    )
    .map_err(|e| format!("创建 PMC 图库检索表失败: {}", e))
}

fn ensure_pmc_gallery_figure_metric_columns(conn: &Connection) -> Result<(), String> {
    let table_exists = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pmc_gallery_figures'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("读取 PMC 图库缓存表结构失败: {}", e))?
        .is_some();
    if !table_exists {
        return Ok(());
    }

    for (name, definition) in [
        ("journal", "TEXT NOT NULL DEFAULT ''"),
        ("publication_year", "INTEGER"),
        ("impact_factor", "TEXT"),
        ("jcr_quartile", "TEXT"),
        ("cas_partition", "TEXT"),
        ("is_top", "INTEGER"),
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('pmc_gallery_figures') WHERE name = ?1",
                [name],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("读取 pmc_gallery_figures.{} 结构失败: {}", name, e))?
            .is_some();
        if !exists {
            conn.execute_batch(&format!(
                "ALTER TABLE pmc_gallery_figures ADD COLUMN {} {};",
                name, definition
            ))
            .map_err(|e| format!("添加 pmc_gallery_figures.{} 失败: {}", name, e))?;
        }
    }
    Ok(())
}

fn create_screening_state_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
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
        ",
    )
    .map_err(|e| format!("创建初筛状态表失败: {}", e))
}

fn create_author_identity_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS pubmed_author_identity_states (
            search_id      INTEGER PRIMARY KEY,
            schema_version INTEGER NOT NULL DEFAULT 1,
            state_json     TEXT NOT NULL,
            updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (search_id) REFERENCES pubmed_searches(id) ON DELETE CASCADE
        );
        ",
    )
    .map_err(|e| format!("创建作者身份状态表失败: {}", e))
}

fn create_structured_author_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
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
        ",
    )
    .map_err(|e| format!("创建结构化作者表失败: {}", e))
}

fn ensure_author_run_columns(conn: &Connection) -> Result<(), String> {
    let runs_exist = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pubmed_search_runs'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("读取 PubMed 运行表结构失败: {}", e))?
        .is_some();
    if !runs_exist {
        return Ok(());
    }

    for (name, definition) in [
        ("run_type", "TEXT NOT NULL DEFAULT 'standard'"),
        ("profile_version", "INTEGER"),
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('pubmed_search_runs') WHERE name = ?1",
                [name],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("读取 pubmed_search_runs.{} 结构失败: {}", name, e))?
            .is_some();
        if !exists {
            conn.execute_batch(&format!(
                "ALTER TABLE pubmed_search_runs ADD COLUMN {} {};",
                name, definition
            ))
            .map_err(|e| format!("添加 pubmed_search_runs.{} 失败: {}", name, e))?;
        }
    }
    Ok(())
}

fn ensure_screening_columns(conn: &Connection) -> Result<(), String> {
    for (name, definition) in [
        ("exclusion_reason", "TEXT"),
        ("screening_note", "TEXT"),
        ("updated_at", "TEXT"),
    ] {
        let exists = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('pubmed_search_entries') WHERE name = ?1",
                [name],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("读取 pubmed_search_entries.{} 结构失败: {}", name, e))?
            .is_some();
        if !exists {
            conn.execute_batch(&format!(
                "ALTER TABLE pubmed_search_entries ADD COLUMN {} {};",
                name, definition
            ))
            .map_err(|e| format!("添加 pubmed_search_entries.{} 失败: {}", name, e))?;
            if name == "updated_at" {
                conn.execute(
                    "UPDATE pubmed_search_entries SET updated_at = datetime('now') WHERE updated_at IS NULL",
                    [],
                )
                .map_err(|e| format!("回填 pubmed_search_entries.updated_at 失败: {}", e))?;
            }
        }
    }
    Ok(())
}

fn backfill_feed_screening_status(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO feed_entry_screening_status
            (feed_id, entry_id, screening_status, screened_at, updated_at)
         SELECT m.feed_id, m.entry_id, COALESCE(s.screening_status, 'unreviewed'),
                s.screened_at, COALESCE(s.screened_at, datetime('now'))
         FROM entry_feed_memberships m
         LEFT JOIN entry_screening_status s ON s.entry_id = m.entry_id",
        [],
    )
    .map_err(|e| format!("回填 RSS 来源初筛状态失败: {}", e))?;
    Ok(())
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
    fn briefing_scope_columns_preserve_existing_rows() {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "CREATE TABLE briefings (
                id INTEGER PRIMARY KEY,
                period TEXT NOT NULL,
                title TEXT NOT NULL,
                lead_in TEXT NOT NULL,
                content TEXT NOT NULL,
                article_count INTEGER NOT NULL,
                feed_count INTEGER NOT NULL,
                generated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO briefings
                (id, period, title, lead_in, content, article_count, feed_count)
             VALUES (1, '旧周期', '旧简报', '', '正文', 2, 1);",
        )
        .unwrap();

        ensure_briefing_scope_columns(&conn).expect("add briefing scope");
        let row: (String, String, String) = conn
            .query_row(
                "SELECT title, source_scope, source_name FROM briefings WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("旧简报".into(), "all".into(), "全部来源".into()));
    }

    #[test]
    fn schema_five_uses_fast_pdf_index_migration() {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE entries (id INTEGER PRIMARY KEY, feed_id INTEGER);
             INSERT INTO settings (key, value) VALUES ('schema_version', '5');
             INSERT INTO entries (id, feed_id) VALUES (42, NULL);",
        )
        .unwrap();

        migrate(&conn).expect("fast migration");
        assert_eq!(current_schema_version(&conn).unwrap(), 6);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'entry_pdf_fulltexts'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn schema_seven_adds_author_identity_state_storage() {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE entries (id INTEGER PRIMARY KEY, feed_id INTEGER);
             CREATE TABLE pubmed_searches (id INTEGER PRIMARY KEY);
             INSERT INTO settings (key, value) VALUES ('schema_version', '7');",
        )
        .unwrap();

        migrate(&conn).expect("migrate author identity state");
        assert_eq!(
            current_schema_version(&conn).unwrap(),
            PUBMED_SCHEMA_VERSION
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'pubmed_author_identity_states'",
                [],
                |row| row.get::<_, i64>(0),
            )
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

    #[test]
    fn schema_ten_adds_structured_authors_and_multi_query_runs() {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE entries (id INTEGER PRIMARY KEY, feed_id INTEGER);
             CREATE TABLE pubmed_searches (id INTEGER PRIMARY KEY);
             CREATE TABLE pubmed_search_runs (
                id INTEGER PRIMARY KEY,
                search_id INTEGER NOT NULL REFERENCES pubmed_searches(id) ON DELETE CASCADE
             );
             CREATE TABLE pubmed_search_run_items (
                run_id INTEGER NOT NULL REFERENCES pubmed_search_runs(id) ON DELETE CASCADE,
                pmid TEXT NOT NULL,
                rank INTEGER NOT NULL,
                PRIMARY KEY (run_id, pmid)
             );
             INSERT INTO settings (key, value) VALUES ('schema_version', '10');",
        )
        .expect("seed schema ten");

        migrate(&conn).expect("migrate structured authors");

        for table in [
            "pubmed_entry_authors",
            "pubmed_entry_author_affiliations",
            "pubmed_search_run_queries",
            "pubmed_search_run_item_sources",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "missing table {table}");
        }

        let run_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('pubmed_search_runs')
                 WHERE name IN ('run_type', 'profile_version')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(run_columns, 2);
        assert_eq!(
            current_schema_version(&conn).unwrap(),
            PUBMED_SCHEMA_VERSION
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }

    #[test]
    fn schema_eleven_adds_pmc_quality_fields_without_losing_cached_figures() {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE entries (id INTEGER PRIMARY KEY, feed_id INTEGER);
             CREATE TABLE pmc_gallery_figures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                search_id INTEGER NOT NULL,
                pmcid TEXT NOT NULL,
                article_title TEXT NOT NULL,
                article_url TEXT NOT NULL,
                label TEXT NOT NULL,
                caption TEXT NOT NULL,
                image_url TEXT NOT NULL,
                license TEXT NOT NULL,
                figure_kind TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO pmc_gallery_figures
                (search_id, pmcid, article_title, article_url, label, caption, image_url,
                 license, figure_kind, position)
             VALUES
                (1, 'PMC1', 'Paper', 'https://example.test/PMC1', 'Graphical Abstract',
                 'Overview', 'https://example.test/ga.jpg', 'CC BY', 'graphical_abstract', 0);
             INSERT INTO settings (key, value) VALUES ('schema_version', '11');",
        )
        .expect("seed schema eleven");

        migrate(&conn).expect("migrate PMC quality fields");

        let metric_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('pmc_gallery_figures')
                 WHERE name IN ('journal', 'publication_year', 'impact_factor', 'jcr_quartile',
                                'cas_partition', 'is_top')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(metric_columns, 6);
        assert_eq!(
            conn.query_row(
                "SELECT image_url FROM pmc_gallery_figures WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "https://example.test/ga.jpg"
        );
        assert_eq!(
            current_schema_version(&conn).unwrap(),
            PUBMED_SCHEMA_VERSION
        );
    }

    #[test]
    fn schema_fourteen_preserves_annotations_and_accepts_custom_colors() {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE entries (id INTEGER PRIMARY KEY, feed_id INTEGER);
             CREATE TABLE briefings (
                id INTEGER PRIMARY KEY,
                period TEXT NOT NULL,
                title TEXT NOT NULL,
                lead_in TEXT NOT NULL,
                content TEXT NOT NULL,
                article_count INTEGER NOT NULL,
                feed_count INTEGER NOT NULL,
                generated_at TEXT NOT NULL,
                source_scope TEXT NOT NULL DEFAULT 'all',
                source_name TEXT NOT NULL DEFAULT '全部来源'
             );
             CREATE TABLE briefing_annotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                briefing_id INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('note', 'highlight')),
                selected_text TEXT NOT NULL DEFAULT '',
                anchor_json TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT 'yellow'
                    CHECK(color IN ('yellow', 'green', 'blue', 'pink')),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (briefing_id) REFERENCES briefings(id) ON DELETE CASCADE
             );
             INSERT INTO settings (key, value) VALUES ('schema_version', '14');
             INSERT INTO briefings VALUES
                (7, '本周', '测试简报', '', '', 1, 1, datetime('now'), 'all', '全部来源');
             INSERT INTO briefing_annotations
                (id, briefing_id, kind, selected_text, color, note)
             VALUES (9, 7, 'highlight', '保留内容', 'blue', '保留备注');",
        )
        .expect("seed schema fourteen");

        migrate(&conn).expect("migrate custom briefing colors");

        assert_eq!(
            current_schema_version(&conn).unwrap(),
            PUBMED_SCHEMA_VERSION
        );
        assert_eq!(
            conn.query_row(
                "SELECT selected_text, color, note FROM briefing_annotations WHERE id = 9",
                [],
                |row| Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?
                )),
            )
            .unwrap(),
            (
                "保留内容".to_string(),
                "blue".to_string(),
                "保留备注".to_string()
            )
        );
        conn.execute(
            "INSERT INTO briefing_annotations (briefing_id, kind, selected_text, color)
             VALUES (7, 'highlight', '自定义颜色', '#58a6a6')",
            [],
        )
        .expect("insert custom color");
    }
}
