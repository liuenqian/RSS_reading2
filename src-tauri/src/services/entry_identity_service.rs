use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone)]
struct EntryIdentityRow {
    id: i64,
    pmid: Option<String>,
    doi: Option<String>,
}

pub fn normalize_pmid(raw: &str) -> Option<String> {
    let value = raw
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>();
    (!value.is_empty()).then_some(value)
}

pub fn normalize_doi(raw: &str) -> Option<String> {
    let mut value = raw.trim().to_ascii_lowercase();
    for prefix in ["https://doi.org/", "http://doi.org/", "doi:"] {
        if let Some(stripped) = value.strip_prefix(prefix) {
            value = stripped.trim().to_string();
            break;
        }
    }
    let value = value
        .trim_matches(|c: char| matches!(c, '.' | ',' | ';'))
        .split_whitespace()
        .collect::<String>();
    (!value.is_empty()).then_some(value)
}

pub fn resolve_entry_id(
    conn: &Connection,
    pmid: Option<&str>,
    doi: Option<&str>,
) -> Result<Option<i64>, String> {
    let pmid = pmid.and_then(normalize_pmid);
    let doi = doi.and_then(normalize_doi);
    let pmid_entry = lookup_active_identity(conn, "pmid", pmid.as_deref())?;
    let doi_entry = lookup_active_identity(conn, "doi", doi.as_deref())?;

    match (pmid_entry, doi_entry) {
        (Some(entry_id), _) => Ok(Some(entry_id)),
        (None, Some(entry_id)) if pmid.is_some() => {
            let existing_pmid = conn
                .query_row(
                    "SELECT value_normalized FROM entry_identifiers
                     WHERE entry_id = ?1 AND kind = 'pmid' AND status = 'active'",
                    [entry_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| format!("检查 DOI 所属文献失败: {}", e))?;
            if existing_pmid.as_deref() == pmid.as_deref() || existing_pmid.is_none() {
                Ok(Some(entry_id))
            } else {
                Ok(None)
            }
        }
        (None, Some(entry_id)) => Ok(Some(entry_id)),
        (None, None) => Ok(None),
    }
}

pub fn register_entry_identities(
    conn: &Connection,
    entry_id: i64,
    pmid: Option<&str>,
    doi: Option<&str>,
    source: &str,
) -> Result<(), String> {
    if let Some(pmid) = pmid.and_then(normalize_pmid) {
        register_active_identity(conn, entry_id, "pmid", &pmid, source)?;
        conn.execute(
            "UPDATE entries SET pmid_normalized = ?1 WHERE id = ?2",
            params![pmid, entry_id],
        )
        .map_err(|e| format!("保存标准化 PMID 失败: {}", e))?;
    }
    if let Some(doi) = doi.and_then(normalize_doi) {
        let conflicted_ids = lookup_identity_entries(conn, "doi", &doi, "conflicted")?;
        let existing = lookup_active_identity(conn, "doi", Some(&doi))?;
        if let Some(existing_id) = existing.filter(|existing_id| *existing_id != entry_id) {
            mark_doi_conflicted(conn, &doi, &[existing_id, entry_id], source)?;
        } else if !conflicted_ids.is_empty() {
            let mut ids = conflicted_ids;
            ids.push(entry_id);
            mark_doi_conflicted(conn, &doi, &ids, source)?;
        } else {
            register_active_identity(conn, entry_id, "doi", &doi, source)?;
        }
        conn.execute(
            "UPDATE entries SET doi_normalized = ?1 WHERE id = ?2",
            params![doi, entry_id],
        )
        .map_err(|e| format!("保存标准化 DOI 失败: {}", e))?;
    }
    Ok(())
}

fn lookup_identity_entries(
    conn: &Connection,
    kind: &str,
    value: &str,
    status: &str,
) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT entry_id FROM entry_identifiers
             WHERE kind = ?1 AND value_normalized = ?2 AND status = ?3
             ORDER BY entry_id",
        )
        .map_err(|e| format!("查询文献身份失败: {}", e))?;
    let rows = stmt
        .query_map(params![kind, value, status], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("查询文献身份失败: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("查询文献身份失败: {}", e))
}

pub fn canonicalize_existing_entries(conn: &Connection) -> Result<(), String> {
    let mut replacements = HashMap::new();

    merge_duplicate_pmids(conn, &mut replacements)?;
    merge_or_mark_duplicate_dois(conn, &mut replacements)?;
    rewrite_chat_scopes(conn, &replacements)?;
    rebuild_identifier_rows(conn)?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_identifiers_active_unique
         ON entry_identifiers(kind, value_normalized)
         WHERE status = 'active';",
    )
    .map_err(|e| format!("创建文献身份唯一索引失败: {}", e))?;
    Ok(())
}

fn lookup_active_identity(
    conn: &Connection,
    kind: &str,
    value: Option<&str>,
) -> Result<Option<i64>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT entry_id FROM entry_identifiers
         WHERE kind = ?1 AND value_normalized = ?2 AND status = 'active'",
        params![kind, value],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("查询文献身份失败: {}", e))
}

fn register_active_identity(
    conn: &Connection,
    entry_id: i64,
    kind: &str,
    value: &str,
    source: &str,
) -> Result<(), String> {
    if let Some(existing_id) = lookup_active_identity(conn, kind, Some(value))? {
        if existing_id != entry_id {
            return Err(format!(
                "{} {} 已属于 entry {}",
                kind.to_ascii_uppercase(),
                value,
                existing_id
            ));
        }
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO entry_identifiers
            (entry_id, kind, value_normalized, status, source)
         VALUES (?1, ?2, ?3, 'active', ?4)",
        params![entry_id, kind, value, source],
    )
    .map_err(|e| format!("保存文献身份失败: {}", e))?;
    Ok(())
}

fn load_entries(conn: &Connection) -> Result<Vec<EntryIdentityRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, pmid_normalized, doi_normalized FROM entries ORDER BY id")
        .map_err(|e| format!("读取文献身份失败: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(EntryIdentityRow {
                id: row.get(0)?,
                pmid: row.get(1)?,
                doi: row.get(2)?,
            })
        })
        .map_err(|e| format!("读取文献身份失败: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取文献身份失败: {}", e))
}

fn merge_duplicate_pmids(
    conn: &Connection,
    replacements: &mut HashMap<i64, i64>,
) -> Result<(), String> {
    let mut groups: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for entry in load_entries(conn)? {
        if let Some(pmid) = entry.pmid {
            groups.entry(pmid).or_default().push(entry.id);
        }
    }
    for ids in groups.values().filter(|ids| ids.len() > 1) {
        merge_group(conn, ids, replacements)?;
    }
    Ok(())
}

fn merge_or_mark_duplicate_dois(
    conn: &Connection,
    replacements: &mut HashMap<i64, i64>,
) -> Result<(), String> {
    let entries = load_entries(conn)?;
    let by_id = entries
        .iter()
        .map(|entry| (entry.id, entry.clone()))
        .collect::<HashMap<_, _>>();
    let mut groups: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for entry in entries {
        if let Some(doi) = entry.doi {
            groups.entry(doi).or_default().push(entry.id);
        }
    }

    for (doi, ids) in groups.into_iter().filter(|(_, ids)| ids.len() > 1) {
        let distinct_pmids = ids
            .iter()
            .filter_map(|id| by_id.get(id).and_then(|entry| entry.pmid.clone()))
            .collect::<HashSet<_>>();
        if distinct_pmids.len() > 1 {
            mark_doi_conflicted(conn, &doi, &ids, "migration")?;
        } else {
            merge_group(conn, &ids, replacements)?;
        }
    }
    Ok(())
}

fn merge_group(
    conn: &Connection,
    ids: &[i64],
    replacements: &mut HashMap<i64, i64>,
) -> Result<i64, String> {
    let winner = ids
        .iter()
        .copied()
        .max_by_key(|id| (user_content_score(conn, *id).unwrap_or(0), -(*id)))
        .ok_or_else(|| "无法选择规范文献".to_string())?;

    for loser in ids.iter().copied().filter(|id| *id != winner) {
        merge_entry_into(conn, winner, loser)?;
        replacements.insert(loser, winner);
    }
    Ok(winner)
}

fn user_content_score(conn: &Connection, entry_id: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT
            CASE WHEN e.is_read = 1 THEN 100 ELSE 0 END +
            10 * (SELECT COUNT(*) FROM reading_notes WHERE entry_id = e.id) +
            5 * (SELECT COUNT(*) FROM entry_tags WHERE entry_id = e.id) +
            2 * (SELECT COUNT(*) FROM translations WHERE entry_id = e.id)
         FROM entries e WHERE e.id = ?1",
        [entry_id],
        |row| row.get(0),
    )
    .map_err(|e| format!("计算文献内容权重失败: {}", e))
}

fn merge_entry_into(conn: &Connection, winner: i64, loser: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE entries SET
            title = CASE WHEN trim(title) = '' THEN (SELECT title FROM entries WHERE id = ?2) ELSE title END,
            link = CASE WHEN trim(link) = '' THEN (SELECT link FROM entries WHERE id = ?2) ELSE link END,
            summary = COALESCE(NULLIF(summary, ''), (SELECT NULLIF(summary, '') FROM entries WHERE id = ?2)),
            summary_source = COALESCE(NULLIF(summary_source, ''), (SELECT NULLIF(summary_source, '') FROM entries WHERE id = ?2)),
            author = COALESCE(NULLIF(author, ''), (SELECT NULLIF(author, '') FROM entries WHERE id = ?2)),
            published_at = COALESCE(NULLIF(published_at, ''), (SELECT NULLIF(published_at, '') FROM entries WHERE id = ?2)),
            publication_date = COALESCE(NULLIF(publication_date, ''), (SELECT NULLIF(publication_date, '') FROM entries WHERE id = ?2)),
            publication_date_raw = COALESCE(NULLIF(publication_date_raw, ''), (SELECT NULLIF(publication_date_raw, '') FROM entries WHERE id = ?2)),
            publication_date_precision = COALESCE(NULLIF(publication_date_precision, ''), (SELECT NULLIF(publication_date_precision, '') FROM entries WHERE id = ?2)),
            publication_sort_key = COALESCE(publication_sort_key, (SELECT publication_sort_key FROM entries WHERE id = ?2)),
            source = COALESCE(NULLIF(source, ''), (SELECT NULLIF(source, '') FROM entries WHERE id = ?2)),
            pmid = COALESCE(NULLIF(pmid, ''), (SELECT NULLIF(pmid, '') FROM entries WHERE id = ?2)),
            pmcid = COALESCE(NULLIF(pmcid, ''), (SELECT NULLIF(pmcid, '') FROM entries WHERE id = ?2)),
            doi = COALESCE(NULLIF(doi, ''), (SELECT NULLIF(doi, '') FROM entries WHERE id = ?2)),
            pmid_normalized = COALESCE(NULLIF(pmid_normalized, ''), (SELECT NULLIF(pmid_normalized, '') FROM entries WHERE id = ?2)),
            doi_normalized = COALESCE(NULLIF(doi_normalized, ''), (SELECT NULLIF(doi_normalized, '') FROM entries WHERE id = ?2)),
            affiliation = COALESCE(NULLIF(affiliation, ''), (SELECT NULLIF(affiliation, '') FROM entries WHERE id = ?2)),
            has_free_fulltext = COALESCE(has_free_fulltext, (SELECT has_free_fulltext FROM entries WHERE id = ?2)),
            is_read = CASE WHEN is_read = 1 OR (SELECT is_read FROM entries WHERE id = ?2) = 1 THEN 1 ELSE 0 END,
            read_at = CASE
                WHEN read_at IS NULL THEN (SELECT read_at FROM entries WHERE id = ?2)
                WHEN (SELECT read_at FROM entries WHERE id = ?2) IS NULL THEN read_at
                ELSE MIN(read_at, (SELECT read_at FROM entries WHERE id = ?2))
            END
         WHERE id = ?1",
        params![winner, loser],
    )
    .map_err(|e| format!("合并文献元数据失败: {}", e))?;

    let memberships = {
        let mut stmt = conn
            .prepare(
                "SELECT feed_id, guid, first_seen_at, last_seen_at
                 FROM entry_feed_memberships WHERE entry_id = ?1",
            )
            .map_err(|e| format!("读取 RSS 成员关系失败: {}", e))?;
        let rows = stmt
            .query_map([loser], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("读取 RSS 成员关系失败: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取 RSS 成员关系失败: {}", e))?
    };
    for (feed_id, _guid, _first_seen_at, _last_seen_at) in memberships {
        let winner_has_feed = conn
            .query_row(
                "SELECT 1 FROM entry_feed_memberships WHERE entry_id = ?1 AND feed_id = ?2",
                params![winner, feed_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("检查 RSS 成员关系失败: {}", e))?
            .is_some();
        if winner_has_feed {
            conn.execute(
                "DELETE FROM entry_feed_memberships WHERE entry_id = ?1 AND feed_id = ?2",
                params![loser, feed_id],
            )
            .map_err(|e| format!("清理重复 RSS 成员关系失败: {}", e))?;
        } else {
            conn.execute(
                "UPDATE entry_feed_memberships SET entry_id = ?1
                 WHERE entry_id = ?2 AND feed_id = ?3",
                params![winner, loser, feed_id],
            )
            .map_err(|e| format!("迁移 RSS 成员关系失败: {}", e))?;
        }
    }
    conn.execute(
        "DELETE FROM entry_feed_memberships WHERE entry_id = ?1",
        [loser],
    )
    .map_err(|e| format!("清理旧 RSS 成员关系失败: {}", e))?;

    conn.execute(
        "INSERT INTO translations (entry_id, field, original_text, translated_text, model, created_at)
         SELECT ?1, field, original_text, translated_text, model, created_at
         FROM translations WHERE entry_id = ?2
         ON CONFLICT(entry_id, field) DO UPDATE SET
            original_text = CASE WHEN excluded.created_at >= translations.created_at THEN excluded.original_text ELSE translations.original_text END,
            translated_text = CASE WHEN excluded.created_at >= translations.created_at AND length(trim(excluded.translated_text)) > 0 THEN excluded.translated_text ELSE translations.translated_text END,
            model = CASE WHEN excluded.created_at >= translations.created_at THEN excluded.model ELSE translations.model END,
            created_at = MAX(translations.created_at, excluded.created_at)",
        params![winner, loser],
    )
    .map_err(|e| format!("合并翻译失败: {}", e))?;
    conn.execute("DELETE FROM translations WHERE entry_id = ?1", [loser])
        .map_err(|e| format!("清理旧翻译失败: {}", e))?;

    merge_reading_notes(conn, winner, loser)?;

    conn.execute(
        "INSERT OR IGNORE INTO entry_tags (entry_id, tag, created_at)
         SELECT ?1, tag, created_at FROM entry_tags WHERE entry_id = ?2",
        params![winner, loser],
    )
    .map_err(|e| format!("合并标签失败: {}", e))?;
    conn.execute("DELETE FROM entry_tags WHERE entry_id = ?1", [loser])
        .map_err(|e| format!("清理旧标签失败: {}", e))?;

    conn.execute(
        "UPDATE reading_events SET entry_id = ?1 WHERE entry_id = ?2",
        params![winner, loser],
    )
    .map_err(|e| format!("迁移阅读事件失败: {}", e))?;
    conn.execute("DELETE FROM entry_identifiers WHERE entry_id = ?1", [loser])
        .map_err(|e| format!("清理旧身份失败: {}", e))?;
    conn.execute("DELETE FROM entries WHERE id = ?1", [loser])
        .map_err(|e| format!("删除重复文献失败: {}", e))?;
    Ok(())
}

fn merge_reading_notes(conn: &Connection, winner: i64, loser: i64) -> Result<(), String> {
    let notes = {
        let mut stmt = conn
            .prepare(
                "SELECT id, profile_id, profile_name, content, generated_at
                 FROM reading_notes WHERE entry_id = ?1 ORDER BY generated_at, id",
            )
            .map_err(|e| format!("读取重复文献笔记失败: {}", e))?;
        let rows = stmt
            .query_map([loser], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("读取重复文献笔记失败: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取重复文献笔记失败: {}", e))?
    };

    for (note_id, profile_id, profile_name, content, generated_at) in notes {
        let existing = conn
            .query_row(
                "SELECT id, content FROM reading_notes WHERE entry_id = ?1 AND profile_id = ?2",
                params![winner, profile_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| format!("检查重复阅读笔记失败: {}", e))?;
        if let Some((existing_id, existing_content)) = existing {
            let merged = format!(
                "{}\n\n---\n\n## 迁移自重复文献（{}）\n\n{}",
                existing_content.trim_end(),
                generated_at,
                content.trim()
            );
            conn.execute(
                "UPDATE reading_notes SET content = ?1 WHERE id = ?2",
                params![merged, existing_id],
            )
            .map_err(|e| format!("合并阅读笔记失败: {}", e))?;
            conn.execute("DELETE FROM reading_notes WHERE id = ?1", [note_id])
                .map_err(|e| format!("清理重复阅读笔记失败: {}", e))?;
        } else {
            conn.execute(
                "UPDATE reading_notes SET entry_id = ?1, profile_name = ?2 WHERE id = ?3",
                params![winner, profile_name, note_id],
            )
            .map_err(|e| format!("迁移阅读笔记失败: {}", e))?;
        }
    }
    Ok(())
}

fn rewrite_chat_scopes(conn: &Connection, replacements: &HashMap<i64, i64>) -> Result<(), String> {
    if replacements.is_empty() {
        return Ok(());
    }
    let sessions = {
        let mut stmt = conn
            .prepare(
                "SELECT scope_key, entry_ids_json, created_at, updated_at
                 FROM paper_chat_sessions ORDER BY created_at, scope_key",
            )
            .map_err(|e| format!("读取文献对话范围失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("读取文献对话范围失败: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取文献对话范围失败: {}", e))?
    };

    for (old_key, ids_json, created_at, updated_at) in sessions {
        let mut ids = serde_json::from_str::<Vec<i64>>(&ids_json)
            .map_err(|e| format!("解析文献对话范围失败: {}", e))?;
        for id in &mut ids {
            *id = resolve_replacement(*id, replacements);
        }
        ids.sort_unstable();
        ids.dedup();
        let new_ids_json =
            serde_json::to_string(&ids).map_err(|e| format!("保存文献对话范围失败: {}", e))?;
        let prefix = old_key
            .split_once("|entries:")
            .map(|(prefix, _)| prefix)
            .unwrap_or("profile:default");
        let new_key = format!(
            "{}|entries:{}",
            prefix,
            ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
        );
        if new_key == old_key {
            continue;
        }

        conn.execute(
            "INSERT INTO paper_chat_sessions
                (scope_key, entry_ids_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope_key) DO UPDATE SET
                entry_ids_json = excluded.entry_ids_json,
                created_at = MIN(paper_chat_sessions.created_at, excluded.created_at),
                updated_at = MAX(paper_chat_sessions.updated_at, excluded.updated_at)",
            params![new_key, new_ids_json, created_at, updated_at],
        )
        .map_err(|e| format!("合并文献对话范围失败: {}", e))?;
        conn.execute(
            "UPDATE paper_chat_messages SET scope_key = ?1 WHERE scope_key = ?2",
            params![new_key, old_key],
        )
        .map_err(|e| format!("迁移文献对话消息失败: {}", e))?;
        conn.execute(
            "DELETE FROM paper_chat_sessions WHERE scope_key = ?1",
            [old_key],
        )
        .map_err(|e| format!("清理旧文献对话范围失败: {}", e))?;
    }
    Ok(())
}

fn resolve_replacement(mut id: i64, replacements: &HashMap<i64, i64>) -> i64 {
    let mut visited = HashSet::new();
    while let Some(next) = replacements.get(&id).copied() {
        if !visited.insert(id) {
            break;
        }
        id = next;
    }
    id
}

fn rebuild_identifier_rows(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM entry_identifiers", [])
        .map_err(|e| format!("重建文献身份失败: {}", e))?;

    let entries = load_entries(conn)?;
    let mut doi_groups: HashMap<String, Vec<EntryIdentityRow>> = HashMap::new();
    for entry in &entries {
        if let Some(doi) = entry.doi.as_ref() {
            doi_groups
                .entry(doi.clone())
                .or_default()
                .push(entry.clone());
        }
    }

    for entry in &entries {
        if let Some(pmid) = entry.pmid.as_deref() {
            register_active_identity(conn, entry.id, "pmid", pmid, "migration")?;
        }
        if let Some(doi) = entry.doi.as_deref() {
            let conflicting = doi_groups
                .get(doi)
                .map(|group| {
                    group
                        .iter()
                        .filter_map(|item| item.pmid.as_ref())
                        .collect::<HashSet<_>>()
                        .len()
                        > 1
                })
                .unwrap_or(false);
            let status = if conflicting { "conflicted" } else { "active" };
            conn.execute(
                "INSERT INTO entry_identifiers
                    (entry_id, kind, value_normalized, status, source)
                 VALUES (?1, 'doi', ?2, ?3, 'migration')",
                params![entry.id, doi, status],
            )
            .map_err(|e| format!("重建 DOI 身份失败: {}", e))?;
        }
    }
    Ok(())
}

fn mark_doi_conflicted(
    conn: &Connection,
    doi: &str,
    entry_ids: &[i64],
    source: &str,
) -> Result<(), String> {
    let mut ids = entry_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    conn.execute(
        "UPDATE entry_identifiers
         SET status = 'conflicted'
         WHERE kind = 'doi' AND value_normalized = ?1",
        [doi],
    )
    .map_err(|e| format!("标记 DOI 冲突失败: {}", e))?;
    for entry_id in &ids {
        conn.execute(
            "INSERT INTO entry_identifiers
                (entry_id, kind, value_normalized, status, source)
             VALUES (?1, 'doi', ?2, 'conflicted', ?3)
             ON CONFLICT(entry_id, kind, value_normalized) DO UPDATE SET
                status = 'conflicted', source = excluded.source",
            params![entry_id, doi, source],
        )
        .map_err(|e| format!("保存冲突 DOI 身份失败: {}", e))?;
    }
    let ids_json = serde_json::to_string(&ids).map_err(|e| format!("记录 DOI 冲突失败: {}", e))?;
    conn.execute(
        "INSERT INTO entry_identity_conflicts (kind, value, entry_ids_json, source)
         VALUES ('doi', ?1, ?2, ?3)",
        params![doi, ids_json, source],
    )
    .map_err(|e| format!("记录 DOI 冲突失败: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE feeds (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT);
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY, feed_id INTEGER, guid TEXT NOT NULL,
                title TEXT NOT NULL, link TEXT NOT NULL, summary TEXT,
                summary_source TEXT, author TEXT, published_at TEXT,
                publication_date TEXT, publication_date_raw TEXT,
                publication_date_precision TEXT, publication_sort_key INTEGER,
                source TEXT, pmid TEXT, pmcid TEXT, doi TEXT,
                pmid_normalized TEXT, doi_normalized TEXT, affiliation TEXT,
                has_free_fulltext INTEGER, fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
                is_read INTEGER NOT NULL DEFAULT 0, read_at TEXT
            );
            CREATE TABLE translations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL,
                field TEXT NOT NULL, original_text TEXT NOT NULL,
                translated_text TEXT NOT NULL, model TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(entry_id, field)
            );
            CREATE TABLE reading_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL,
                profile_id TEXT NOT NULL, profile_name TEXT NOT NULL, content TEXT NOT NULL,
                generated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(entry_id, profile_id)
            );
            CREATE TABLE entry_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL,
                tag TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE UNIQUE INDEX idx_entry_tags_entry_tag_nocase
                ON entry_tags(entry_id, lower(tag));
            CREATE TABLE reading_events (
                id INTEGER PRIMARY KEY, kind TEXT NOT NULL, feed_id INTEGER,
                feed_title_snapshot TEXT, entry_id INTEGER, occurred_at TEXT
            );
            CREATE TABLE paper_chat_sessions (
                scope_key TEXT PRIMARY KEY, entry_ids_json TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE paper_chat_messages (
                id INTEGER PRIMARY KEY, scope_key TEXT NOT NULL,
                role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
                FOREIGN KEY(scope_key) REFERENCES paper_chat_sessions(scope_key) ON DELETE CASCADE
            );
            CREATE TABLE entry_feed_memberships (
                entry_id INTEGER NOT NULL, feed_id INTEGER NOT NULL, guid TEXT NOT NULL,
                first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
                PRIMARY KEY(entry_id, feed_id), UNIQUE(feed_id, guid)
            );
            CREATE TABLE entry_identifiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL,
                kind TEXT NOT NULL, value_normalized TEXT NOT NULL,
                status TEXT NOT NULL, source TEXT, created_at TEXT DEFAULT (datetime('now')),
                UNIQUE(entry_id, kind, value_normalized)
            );
            CREATE TABLE entry_identity_conflicts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL,
                entry_ids_json TEXT NOT NULL, source TEXT, created_at TEXT DEFAULT (datetime('now'))
            );
            INSERT INTO feeds VALUES (1, 'https://a.test', 'A');
            INSERT INTO feeds VALUES (2, 'https://b.test', 'B');
            ",
        )
        .unwrap();
        conn
    }

    fn insert_entry(conn: &Connection, id: i64, feed_id: i64, pmid: &str, doi: &str) {
        conn.execute(
            "INSERT INTO entries
                (id, feed_id, guid, title, link, pmid, doi, pmid_normalized, doi_normalized)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?7)",
            params![
                id,
                feed_id,
                format!("g{}", id),
                format!("Paper {}", id),
                format!("https://p/{}", id),
                pmid,
                doi
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entry_feed_memberships VALUES (?1, ?2, ?3, '2026-01-01', '2026-01-01')",
            params![id, feed_id, format!("g{}", id)],
        )
        .unwrap();
    }

    #[test]
    fn normalizes_identifiers() {
        assert_eq!(normalize_pmid("PMID: 42-19").as_deref(), Some("4219"));
        assert_eq!(
            normalize_doi(" https://doi.org/10.1000/ABC. ").as_deref(),
            Some("10.1000/abc")
        );
    }

    #[test]
    fn merges_duplicate_pmid_and_preserves_user_content() {
        let conn = setup();
        insert_entry(&conn, 10, 1, "123", "10.1/a");
        insert_entry(&conn, 20, 2, "123", "10.1/a");
        conn.execute(
            "INSERT INTO reading_notes (entry_id, profile_id, profile_name, content)
             VALUES (10, 'p', '模板', 'winner note'), (20, 'p', '模板', 'loser note')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entry_tags (entry_id, tag) VALUES (10, 'A'), (20, 'B')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO paper_chat_sessions VALUES ('profile:default|entries:10,20', '[10,20]', '2026-01-01', '2026-01-02');
             INSERT INTO paper_chat_messages VALUES (1, 'profile:default|entries:10,20', 'user', 'question', '2026-01-01');",
            [],
        )
        .unwrap();

        canonicalize_existing_entries(&conn).unwrap();

        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entry_feed_memberships", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        let note: String = conn
            .query_row("SELECT content FROM reading_notes", [], |r| r.get(0))
            .unwrap();
        assert!(note.contains("winner note"));
        assert!(note.contains("loser note"));
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entry_tags", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        let scope: String = conn
            .query_row("SELECT scope_key FROM paper_chat_sessions", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(scope.ends_with("entries:10") || scope.ends_with("entries:20"));
    }

    #[test]
    fn preserves_distinct_pmids_when_doi_conflicts() {
        let conn = setup();
        insert_entry(&conn, 10, 1, "111", "10.1/shared");
        insert_entry(&conn, 20, 2, "222", "10.1/shared");

        canonicalize_existing_entries(&conn).unwrap();

        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM entry_identifiers WHERE kind = 'doi' AND status = 'conflicted'", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM entry_identity_conflicts", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            1
        );
        assert_eq!(
            resolve_entry_id(&conn, None, Some("10.1/shared")).unwrap(),
            None
        );
    }
}
