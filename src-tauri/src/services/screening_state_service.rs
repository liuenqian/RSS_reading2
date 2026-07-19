use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const VALID_SCREENING_STATUSES: &[&str] = &["unreviewed", "keep", "maybe", "exclude"];
const VALID_SCOPE_KINDS: &[&str] = &["pubmed", "feed", "project"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StarredMigrationReport {
    pub migrated: usize,
    pub already_migrated: usize,
    pub unknown: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeedScreeningState {
    pub feed_id: i64,
    pub entry_id: i64,
    pub screening_status: String,
    pub exclusion_reason: Option<String>,
    pub screening_note: Option<String>,
    pub screened_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningTablePreferences {
    pub scope_kind: String,
    pub scope_id: i64,
    pub schema_version: i64,
    pub config_json: String,
    pub updated_at: String,
}

pub fn get_table_preferences(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
) -> Result<Option<ScreeningTablePreferences>, String> {
    validate_scope_kind(scope_kind)?;
    conn.query_row(
        "SELECT scope_kind, scope_id, schema_version, config_json, updated_at
         FROM screening_table_preferences WHERE scope_kind = ?1 AND scope_id = ?2",
        params![scope_kind, scope_id],
        |row| {
            Ok(ScreeningTablePreferences {
                scope_kind: row.get(0)?,
                scope_id: row.get(1)?,
                schema_version: row.get(2)?,
                config_json: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("读取初筛表格配置失败: {error}"))
}

pub fn save_table_preferences(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
    schema_version: i64,
    config_json: &str,
) -> Result<ScreeningTablePreferences, String> {
    validate_scope_kind(scope_kind)?;
    if config_json.trim().is_empty() {
        return Err("初筛表格配置不能为空".to_string());
    }
    serde_json::from_str::<serde_json::Value>(config_json)
        .map_err(|error| format!("初筛表格配置不是有效 JSON: {error}"))?;
    conn.execute(
        "INSERT INTO screening_table_preferences
            (scope_kind, scope_id, schema_version, config_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            config_json = excluded.config_json,
            updated_at = excluded.updated_at",
        params![scope_kind, scope_id, schema_version, config_json],
    )
    .map_err(|error| format!("保存初筛表格配置失败: {error}"))?;
    get_table_preferences(conn, scope_kind, scope_id)
        .and_then(|value| value.ok_or_else(|| "保存后未找到初筛表格配置".to_string()))
}

pub fn list_starred_entry_ids(conn: &Connection) -> Result<Vec<i64>, String> {
    let mut statement = conn
        .prepare("SELECT entry_id FROM entry_user_state WHERE is_starred = 1 ORDER BY entry_id")
        .map_err(|error| format!("读取标星状态失败: {error}"))?;
    let result = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("读取标星状态失败: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取标星状态失败: {error}"));
    result
}

pub fn set_entry_starred(conn: &Connection, entry_id: i64, is_starred: bool) -> Result<(), String> {
    ensure_entry(conn, entry_id)?;
    conn.execute(
        "INSERT INTO entry_user_state (entry_id, is_starred, starred_at, updated_at)
         VALUES (?1, ?2, CASE WHEN ?2 = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
         ON CONFLICT(entry_id) DO UPDATE SET
            is_starred = excluded.is_starred,
            starred_at = excluded.starred_at,
            updated_at = excluded.updated_at",
        params![entry_id, is_starred as i64],
    )
    .map_err(|error| format!("保存标星状态失败: {error}"))?;
    Ok(())
}

pub fn bulk_set_entries_starred(
    conn: &mut Connection,
    entry_ids: &[i64],
    is_starred: bool,
) -> Result<usize, String> {
    let ids = normalized_ids(entry_ids);
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始批量标星事务失败: {error}"))?;
    for entry_id in &ids {
        ensure_entry(&transaction, *entry_id)?;
        transaction
            .execute(
                "INSERT INTO entry_user_state (entry_id, is_starred, starred_at, updated_at)
                 VALUES (?1, ?2, CASE WHEN ?2 = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
                 ON CONFLICT(entry_id) DO UPDATE SET
                    is_starred = excluded.is_starred,
                    starred_at = excluded.starred_at,
                    updated_at = excluded.updated_at",
                params![entry_id, is_starred as i64],
            )
            .map_err(|error| format!("保存批量标星状态失败: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交批量标星事务失败: {error}"))?;
    Ok(ids.len())
}

pub fn migrate_legacy_starred_ids(
    conn: &mut Connection,
    legacy_ids: &[i64],
) -> Result<StarredMigrationReport, String> {
    let ids = normalized_ids(legacy_ids);
    let transaction = conn
        .transaction()
        .map_err(|error| format!("开始标星迁移事务失败: {error}"))?;
    let mut report = StarredMigrationReport {
        migrated: 0,
        already_migrated: 0,
        unknown: 0,
    };

    for entry_id in ids {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM entries WHERE id = ?1)",
                [entry_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("检查标星迁移文章失败: {error}"))?;
        if !exists {
            report.unknown += 1;
            continue;
        }
        let already: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM entry_user_state WHERE entry_id = ?1 AND is_starred = 1)",
                [entry_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("检查已有标星状态失败: {error}"))?;
        if already {
            report.already_migrated += 1;
            continue;
        }
        transaction
            .execute(
                "INSERT INTO entry_user_state (entry_id, is_starred, starred_at, updated_at)
                 VALUES (?1, 1, datetime('now'), datetime('now'))
                 ON CONFLICT(entry_id) DO UPDATE SET
                    is_starred = 1,
                    starred_at = COALESCE(entry_user_state.starred_at, datetime('now')),
                    updated_at = datetime('now')",
                [entry_id],
            )
            .map_err(|error| format!("迁移标星状态失败: {error}"))?;
        report.migrated += 1;
    }

    transaction
        .commit()
        .map_err(|error| format!("提交标星迁移事务失败: {error}"))?;
    Ok(report)
}

pub fn set_feed_screening_state(
    conn: &Connection,
    feed_id: i64,
    entry_id: i64,
    status: &str,
    exclusion_reason: Option<&str>,
    screening_note: Option<&str>,
) -> Result<FeedScreeningState, String> {
    validate_status(status)?;
    ensure_feed_membership(conn, feed_id, entry_id)?;
    conn.execute(
        "INSERT INTO feed_entry_screening_status
            (feed_id, entry_id, screening_status, exclusion_reason, screening_note,
             screened_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))
         ON CONFLICT(feed_id, entry_id) DO UPDATE SET
            screening_status = excluded.screening_status,
            exclusion_reason = excluded.exclusion_reason,
            screening_note = excluded.screening_note,
            screened_at = excluded.screened_at,
            updated_at = excluded.updated_at",
        params![feed_id, entry_id, status, exclusion_reason, screening_note],
    )
    .map_err(|error| format!("保存 RSS 初筛状态失败: {error}"))?;
    get_feed_screening_state(conn, feed_id, entry_id)
}

pub fn get_feed_screening_state(
    conn: &Connection,
    feed_id: i64,
    entry_id: i64,
) -> Result<FeedScreeningState, String> {
    conn.query_row(
        "SELECT feed_id, entry_id, screening_status, exclusion_reason, screening_note,
                screened_at, updated_at
         FROM feed_entry_screening_status
         WHERE feed_id = ?1 AND entry_id = ?2",
        params![feed_id, entry_id],
        |row| {
            Ok(FeedScreeningState {
                feed_id: row.get(0)?,
                entry_id: row.get(1)?,
                screening_status: row.get(2)?,
                exclusion_reason: row.get(3)?,
                screening_note: row.get(4)?,
                screened_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .map_err(|error| format!("读取 RSS 初筛状态失败: {error}"))
}

pub fn list_feed_screening_states(
    conn: &Connection,
    feed_id: i64,
) -> Result<HashMap<i64, FeedScreeningState>, String> {
    let mut statement = conn
        .prepare(
            "SELECT feed_id, entry_id, screening_status, exclusion_reason, screening_note,
                    screened_at, updated_at
             FROM feed_entry_screening_status
             WHERE feed_id = ?1",
        )
        .map_err(|error| format!("读取 RSS 初筛状态失败: {error}"))?;
    let rows = statement
        .query_map([feed_id], |row| {
            Ok(FeedScreeningState {
                feed_id: row.get(0)?,
                entry_id: row.get(1)?,
                screening_status: row.get(2)?,
                exclusion_reason: row.get(3)?,
                screening_note: row.get(4)?,
                screened_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("读取 RSS 初筛状态失败: {error}"))?;
    let mut states = HashMap::new();
    for row in rows {
        let state = row.map_err(|error| format!("读取 RSS 初筛状态失败: {error}"))?;
        states.insert(state.entry_id, state);
    }
    Ok(states)
}

fn ensure_entry(conn: &Connection, entry_id: i64) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE id = ?1)",
            [entry_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查文章失败: {error}"))?;
    if !exists {
        return Err(format!("文章 {} 不存在", entry_id));
    }
    Ok(())
}

fn ensure_feed_membership(conn: &Connection, feed_id: i64, entry_id: i64) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM entry_feed_memberships
                WHERE feed_id = ?1 AND entry_id = ?2
            )",
            params![feed_id, entry_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查 RSS 文章归属失败: {error}"))?;
    if !exists {
        return Err(format!("文章 {} 不属于 RSS 订阅 {}", entry_id, feed_id));
    }
    Ok(())
}

fn validate_status(status: &str) -> Result<(), String> {
    if VALID_SCREENING_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(format!("无效的初筛状态: {status}"))
    }
}

fn validate_scope_kind(scope_kind: &str) -> Result<(), String> {
    if VALID_SCOPE_KINDS.contains(&scope_kind) {
        Ok(())
    } else {
        Err(format!("无效的初筛范围类型: {scope_kind}"))
    }
}

fn normalized_ids(entry_ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    entry_ids
        .iter()
        .copied()
        .filter(|entry_id| seen.insert(*entry_id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entries (id INTEGER PRIMARY KEY);
             CREATE TABLE entry_user_state (
                entry_id INTEGER PRIMARY KEY,
                is_starred INTEGER NOT NULL DEFAULT 0,
                starred_at TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE feeds (id INTEGER PRIMARY KEY);
             CREATE TABLE entry_feed_memberships (
                entry_id INTEGER NOT NULL,
                feed_id INTEGER NOT NULL,
                PRIMARY KEY(entry_id, feed_id)
             );
             CREATE TABLE feed_entry_screening_status (
                feed_id INTEGER NOT NULL,
                entry_id INTEGER NOT NULL,
                screening_status TEXT NOT NULL,
                exclusion_reason TEXT,
                screening_note TEXT,
                screened_at TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(feed_id, entry_id)
             );
             CREATE TABLE screening_table_preferences (
                scope_kind TEXT NOT NULL,
                scope_id INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                config_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(scope_kind, scope_id)
             );
             INSERT INTO entries (id) VALUES (1), (2);
             INSERT INTO feeds (id) VALUES (7);
             INSERT INTO entry_feed_memberships (entry_id, feed_id) VALUES (1, 7);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn legacy_starred_ids_migrate_idempotently_and_ignore_unknown_entries() {
        let mut conn = database();
        let first = migrate_legacy_starred_ids(&mut conn, &[1, 1, 999]).unwrap();
        assert_eq!(first.migrated, 1);
        assert_eq!(first.unknown, 1);
        let second = migrate_legacy_starred_ids(&mut conn, &[1]).unwrap();
        assert_eq!(second.already_migrated, 1);
        assert_eq!(list_starred_entry_ids(&conn).unwrap(), vec![1]);
    }

    #[test]
    fn feed_screening_state_requires_membership_and_preserves_scope() {
        let conn = database();
        let state =
            set_feed_screening_state(&conn, 7, 1, "keep", Some("相关机制"), Some("首轮保留"))
                .unwrap();
        assert_eq!(state.screening_status, "keep");
        assert_eq!(state.exclusion_reason.as_deref(), Some("相关机制"));
        assert!(set_feed_screening_state(&conn, 7, 2, "keep", None, None).is_err());
        assert!(set_feed_screening_state(&conn, 7, 1, "invalid", None, None).is_err());
    }

    #[test]
    fn table_preferences_round_trip_per_scope() {
        let conn = database();
        assert!(get_table_preferences(&conn, "feed", 7).unwrap().is_none());
        let saved = save_table_preferences(&conn, "feed", 7, 1, r#"{"columns":[]}"#).unwrap();
        assert_eq!(saved.scope_kind, "feed");
        assert_eq!(
            get_table_preferences(&conn, "feed", 7)
                .unwrap()
                .unwrap()
                .config_json,
            r#"{"columns":[]}"#
        );
        assert!(get_table_preferences(&conn, "feed", 8).unwrap().is_none());
    }
}
