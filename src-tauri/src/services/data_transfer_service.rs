use crate::db_migrations;
use rusqlite::backup::Backup;
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TRANSFER_FORMAT_VERSION: i64 = 1;
const REQUIRED_TABLES: &[&str] = &["feeds", "entries", "translations", "settings"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPreview {
    pub file_name: String,
    pub created_at: String,
    pub app_version: String,
    pub file_bytes: u64,
    pub feed_count: i64,
    pub entry_count: i64,
    pub note_count: i64,
    pub search_count: i64,
    pub chat_message_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferExportReport {
    pub file_path: String,
    #[serde(flatten)]
    pub preview: TransferPreview,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferImportReport {
    pub backup_path: String,
    #[serde(flatten)]
    pub preview: TransferPreview,
}

#[derive(Debug)]
struct CostRow {
    month: String,
    model: String,
    prompt_cache_hit_tokens: i64,
    prompt_cache_miss_tokens: i64,
    completion_tokens: i64,
}

fn sqlite_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{}: {}", context, error)
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{}", std::process::id(), nanos)
}

fn temporary_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "导出路径缺少父目录".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "导出文件名无效".to_string())?;
    Ok(parent.join(format!(".{}.{}.tmp", name, unique_suffix())))
}

fn copy_database(source: &Connection, destination: &mut Connection) -> Result<(), String> {
    let backup = Backup::new(source, destination)
        .map_err(|error| sqlite_error("创建数据库快照失败", error))?;
    backup
        .run_to_completion(128, Duration::from_millis(5), None)
        .map_err(|error| sqlite_error("复制数据库快照失败", error))
}

fn backup_to_path(source: &Connection, path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| sqlite_error("清理旧备份文件失败", error))?;
    }
    let mut destination =
        Connection::open(path).map_err(|error| sqlite_error("创建数据库备份文件失败", error))?;
    copy_database(source, &mut destination)?;
    destination
        .execute_batch("PRAGMA journal_mode = DELETE;")
        .map_err(|error| sqlite_error("完成数据库备份失败", error))?;
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|error| sqlite_error("读取迁移包结构失败", error))
}

fn table_count(conn: &Connection, table: &str) -> Result<i64, String> {
    if !table_exists(conn, table)? {
        return Ok(0);
    }
    conn.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", table), [], |row| {
        row.get(0)
    })
    .map_err(|error| sqlite_error("统计迁移包内容失败", error))
}

fn validate_integrity(conn: &Connection) -> Result<(), String> {
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| sqlite_error("检查迁移包完整性失败", error))?;
    if result != "ok" {
        return Err(format!("迁移包完整性检查未通过: {}", result));
    }
    let foreign_key_errors: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|error| sqlite_error("检查迁移包外键失败", error))?;
    if foreign_key_errors != 0 {
        return Err(format!("迁移包存在 {} 条外键错误", foreign_key_errors));
    }
    Ok(())
}

fn read_preview(conn: &Connection, path: &Path) -> Result<TransferPreview, String> {
    for table in REQUIRED_TABLES {
        if !table_exists(conn, table)? {
            return Err(format!(
                "这不是有效的 RSS Reading 迁移包：缺少 {} 表",
                table
            ));
        }
    }
    if !table_exists(conn, "cento_transfer_metadata")? {
        return Err("这不是应用导出的脱敏迁移包".to_string());
    }

    let (format_version, app_version, created_at, sanitized): (i64, String, String, i64) = conn
        .query_row(
            "SELECT format_version, app_version, created_at, sanitized
             FROM cento_transfer_metadata LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| sqlite_error("读取迁移包标记失败", error))?;
    if format_version != TRANSFER_FORMAT_VERSION {
        return Err(format!("暂不支持迁移包格式版本 {}", format_version));
    }
    if sanitized != 1 {
        return Err("迁移包未通过隐私脱敏标记检查".to_string());
    }

    let unsafe_settings: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings
             WHERE key NOT IN ('schema_version', 'reading_events_backfilled')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("检查迁移包设置失败", error))?;
    if unsafe_settings != 0 || table_count(conn, "cost_log")? != 0 {
        return Err("迁移包包含不应共享的设置或 Token 用量".to_string());
    }
    if table_count(conn, "entry_pdf_fulltexts")? != 0 {
        return Err("迁移包包含本机 PDF 全文缓存，已拒绝导入".to_string());
    }

    validate_integrity(conn)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("RSS-Reading.cento-db")
        .to_string();
    let file_bytes = fs::metadata(path)
        .map_err(|error| sqlite_error("读取迁移包大小失败", error))?
        .len();
    Ok(TransferPreview {
        file_name,
        created_at,
        app_version,
        file_bytes,
        feed_count: table_count(conn, "feeds")?,
        entry_count: table_count(conn, "entries")?,
        note_count: table_count(conn, "reading_notes")?,
        search_count: table_count(conn, "pubmed_searches")?,
        chat_message_count: table_count(conn, "paper_chat_messages")?,
    })
}

fn replace_file_atomically(temporary: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return fs::rename(temporary, target)
            .map_err(|error| sqlite_error("保存迁移包失败", error));
    }

    let previous = target.with_file_name(format!(
        ".{}.{}.previous",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("transfer"),
        unique_suffix()
    ));
    fs::rename(target, &previous).map_err(|error| sqlite_error("暂存原文件失败", error))?;
    match fs::rename(temporary, target) {
        Ok(()) => {
            let _ = fs::remove_file(previous);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&previous, target);
            Err(sqlite_error("保存迁移包失败", error))
        }
    }
}

pub fn export_transfer_database(
    source: &Connection,
    target: &Path,
) -> Result<TransferExportReport, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "导出路径缺少父目录".to_string())?;
    if !parent.exists() {
        return Err("导出目录不存在".to_string());
    }

    let temporary = temporary_path(target)?;
    let result = (|| -> Result<(), String> {
        backup_to_path(source, &temporary)?;
        let sanitized = Connection::open(&temporary)
            .map_err(|error| sqlite_error("打开迁移包临时文件失败", error))?;
        sanitized
            .execute_batch(
                "PRAGMA secure_delete = ON;
                 DELETE FROM settings
                 WHERE key NOT IN ('schema_version', 'reading_events_backfilled');
                 DELETE FROM cost_log;
                 DELETE FROM entry_pdf_fulltexts;
                 DROP TABLE IF EXISTS cento_transfer_metadata;
                 CREATE TABLE cento_transfer_metadata (
                    format_version INTEGER NOT NULL,
                    app_version TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    sanitized INTEGER NOT NULL CHECK(sanitized = 1)
                 );",
            )
            .map_err(|error| sqlite_error("迁移包脱敏失败", error))?;
        sanitized
            .execute(
                "INSERT INTO cento_transfer_metadata
                 (format_version, app_version, created_at, sanitized)
                 VALUES (?1, ?2, datetime('now'), 1)",
                params![TRANSFER_FORMAT_VERSION, env!("CARGO_PKG_VERSION")],
            )
            .map_err(|error| sqlite_error("写入迁移包标记失败", error))?;
        sanitized
            .execute_batch("VACUUM; PRAGMA journal_mode = DELETE;")
            .map_err(|error| sqlite_error("压缩迁移包失败", error))?;
        read_preview(&sanitized, &temporary)?;
        drop(sanitized);
        replace_file_atomically(&temporary, target)
    })();
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result?;

    let preview = preview_transfer_database(target)?;
    Ok(TransferExportReport {
        file_path: target.to_string_lossy().to_string(),
        preview,
    })
}

pub fn preview_transfer_database(path: &Path) -> Result<TransferPreview, String> {
    if !path.is_file() {
        return Err("迁移包文件不存在".to_string());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| sqlite_error("无法打开迁移包", error))?;
    read_preview(&conn, path)
}

fn read_settings(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut statement = conn
        .prepare("SELECT key, value FROM settings WHERE key <> 'schema_version'")
        .map_err(|error| sqlite_error("读取本机设置失败", error))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| sqlite_error("读取本机设置失败", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("读取本机设置失败", error))?;
    Ok(rows)
}

fn read_cost_rows(conn: &Connection) -> Result<Vec<CostRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT month, model, prompt_cache_hit_tokens,
                    prompt_cache_miss_tokens, completion_tokens
             FROM cost_log",
        )
        .map_err(|error| sqlite_error("读取本机 Token 用量失败", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(CostRow {
                month: row.get(0)?,
                model: row.get(1)?,
                prompt_cache_hit_tokens: row.get(2)?,
                prompt_cache_miss_tokens: row.get(3)?,
                completion_tokens: row.get(4)?,
            })
        })
        .map_err(|error| sqlite_error("读取本机 Token 用量失败", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("读取本机 Token 用量失败", error))?;
    Ok(rows)
}

fn restore_local_state(
    conn: &mut Connection,
    settings: &[(String, String)],
    costs: &[CostRow],
) -> Result<(), String> {
    let transaction = conn
        .transaction()
        .map_err(|error| sqlite_error("开始恢复本机设置失败", error))?;
    for (key, value) in settings {
        transaction
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|error| sqlite_error("恢复本机设置失败", error))?;
    }
    for row in costs {
        transaction
            .execute(
                "INSERT INTO cost_log
                 (month, model, prompt_cache_hit_tokens,
                  prompt_cache_miss_tokens, completion_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(month, model) DO UPDATE SET
                    prompt_cache_hit_tokens = excluded.prompt_cache_hit_tokens,
                    prompt_cache_miss_tokens = excluded.prompt_cache_miss_tokens,
                    completion_tokens = excluded.completion_tokens",
                params![
                    row.month,
                    row.model,
                    row.prompt_cache_hit_tokens,
                    row.prompt_cache_miss_tokens,
                    row.completion_tokens
                ],
            )
            .map_err(|error| sqlite_error("恢复本机 Token 用量失败", error))?;
    }
    transaction
        .commit()
        .map_err(|error| sqlite_error("提交本机设置失败", error))
}

fn import_backup_path(db_path: &Path) -> Result<PathBuf, String> {
    let parent = db_path
        .parent()
        .ok_or_else(|| "当前数据库缺少父目录".to_string())?;
    Ok(parent.join(format!("cento.pre-transfer-import-{}.db", unique_suffix())))
}

pub fn import_transfer_database(
    current: &mut Connection,
    db_path: &Path,
    source_path: &Path,
) -> Result<TransferImportReport, String> {
    let preview = preview_transfer_database(source_path)?;
    let local_settings = read_settings(current)?;
    let local_costs = read_cost_rows(current)?;
    let backup_path = import_backup_path(db_path)?;
    backup_to_path(current, &backup_path)?;

    let apply_result = (|| -> Result<(), String> {
        let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| sqlite_error("打开迁移包失败", error))?;
        copy_database(&source, current)?;
        db_migrations::migrate(current)?;
        restore_local_state(current, &local_settings, &local_costs)?;
        current
            .execute_batch(
                "DROP TABLE IF EXISTS cento_transfer_metadata;
                 PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;",
            )
            .map_err(|error| sqlite_error("完成数据库导入失败", error))?;
        validate_integrity(current)
    })();

    if let Err(error) = apply_result {
        let restore_result = (|| -> Result<(), String> {
            let backup =
                Connection::open_with_flags(&backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(|restore_error| sqlite_error("打开自动备份失败", restore_error))?;
            copy_database(&backup, current)?;
            current
                .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
                .map_err(|restore_error| sqlite_error("恢复数据库模式失败", restore_error))
        })();
        return match restore_result {
            Ok(()) => Err(format!("{}；已自动恢复导入前数据库", error)),
            Err(restore_error) => Err(format!(
                "{}；自动恢复失败：{}。备份位于 {}",
                error,
                restore_error,
                backup_path.display()
            )),
        };
    }

    Ok(TransferImportReport {
        backup_path: backup_path.to_string_lossy().to_string(),
        preview,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_database(entry_title: &str, api_key: &str) -> Connection {
        let conn = Connection::open_in_memory().expect("open sample database");
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE feeds (id INTEGER PRIMARY KEY, title TEXT);
             CREATE TABLE entries (id INTEGER PRIMARY KEY, feed_id INTEGER, title TEXT);
             CREATE TABLE translations (id INTEGER PRIMARY KEY, entry_id INTEGER);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE cost_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
                prompt_cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                UNIQUE(month, model)
             );
             CREATE TABLE reading_notes (id INTEGER PRIMARY KEY, entry_id INTEGER, content TEXT);
             CREATE TABLE pubmed_searches (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE paper_chat_messages (id INTEGER PRIMARY KEY, content TEXT);
             CREATE TABLE entry_pdf_fulltexts (
                entry_id INTEGER PRIMARY KEY, content TEXT NOT NULL, local_path TEXT
             );
             INSERT INTO feeds (id, title) VALUES (1, 'Source');
             INSERT INTO entries (id, feed_id, title) VALUES (1, 1, 'placeholder');
             INSERT INTO settings (key, value) VALUES ('schema_version', '16');
             INSERT INTO settings (key, value) VALUES ('api_key', 'placeholder');
             INSERT INTO cost_log
                (month, model, prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens)
             VALUES ('2026-08', 'model', 1, 2, 3);
             INSERT INTO reading_notes (id, entry_id, content) VALUES (1, 1, 'note');
             INSERT INTO entry_pdf_fulltexts (entry_id, content, local_path)
             VALUES (1, 'full text', '/private/paper.pdf');",
        )
        .expect("seed sample database");
        conn.execute("UPDATE entries SET title = ?1 WHERE id = 1", [entry_title])
            .unwrap();
        conn.execute(
            "UPDATE settings SET value = ?1 WHERE key = 'api_key'",
            [api_key],
        )
        .unwrap();
        conn
    }

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cento-{}-{}.cento-db", name, unique_suffix()))
    }

    #[test]
    fn export_removes_credentials_usage_and_local_pdf_cache() {
        let source = sample_database("shared paper", "secret-value");
        let target = test_path("export");
        let report = export_transfer_database(&source, &target).expect("export transfer package");
        assert_eq!(report.preview.entry_count, 1);

        let exported = Connection::open_with_flags(&target, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open exported package");
        let settings: i64 = exported
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(settings, 1);
        assert_eq!(table_count(&exported, "cost_log").unwrap(), 0);
        assert_eq!(table_count(&exported, "entry_pdf_fulltexts").unwrap(), 0);
        drop(exported);
        let bytes = fs::read(&target).expect("read exported package");
        assert!(!bytes
            .windows(b"secret-value".len())
            .any(|window| window == b"secret-value"));
        let _ = fs::remove_file(target);
    }

    #[test]
    fn preview_rejects_an_unmarked_raw_database() {
        let raw = sample_database("raw paper", "raw-secret");
        let path = test_path("raw");
        backup_to_path(&raw, &path).expect("write raw database");
        let error = preview_transfer_database(&path).expect_err("reject raw database");
        assert!(error.contains("脱敏迁移包"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn import_replaces_research_data_but_preserves_local_settings_and_usage() {
        let sender = sample_database("sender paper", "sender-secret");
        let package = test_path("package");
        export_transfer_database(&sender, &package).expect("export package");

        let mut recipient = sample_database("recipient paper", "recipient-secret");
        let live_path = test_path("live");
        let report =
            import_transfer_database(&mut recipient, &live_path, &package).expect("import package");
        let title: String = recipient
            .query_row("SELECT title FROM entries WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let api_key: String = recipient
            .query_row(
                "SELECT value FROM settings WHERE key = 'api_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let completion_tokens: i64 = recipient
            .query_row("SELECT completion_tokens FROM cost_log", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(title, "sender paper");
        assert_eq!(api_key, "recipient-secret");
        assert_eq!(completion_tokens, 3);
        assert!(Path::new(&report.backup_path).is_file());

        let _ = fs::remove_file(package);
        let _ = fs::remove_file(report.backup_path);
    }
}
