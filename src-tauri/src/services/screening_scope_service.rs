use crate::services::journal_metrics_service::{self, JournalMetric};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

const MAX_PAGE_SIZE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningFilters {
    #[serde(default)]
    pub entry_ids: Vec<i64>,
    pub query: Option<String>,
    pub screening_status: Option<String>,
    pub starred: Option<bool>,
    pub read: Option<bool>,
    pub published_from: Option<String>,
    pub published_to: Option<String>,
    pub min_impact_factor: Option<f64>,
    #[serde(default)]
    pub q: Vec<String>,
    #[serde(default)]
    pub b: Vec<String>,
    pub top: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub has_reading_note: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningSort {
    pub field: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningScopeRequest {
    pub scope_kind: String,
    pub scope_id: i64,
    pub offset: usize,
    pub limit: usize,
    #[serde(default)]
    pub filters: ScreeningFilters,
    #[serde(default)]
    pub sorts: Vec<ScreeningSort>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningRow {
    pub entry_id: i64,
    pub scope_kind: String,
    pub scope_id: i64,
    pub title: String,
    pub title_translated: Option<String>,
    pub summary: Option<String>,
    pub summary_translated: Option<String>,
    pub authors: Option<String>,
    pub journal: Option<String>,
    pub publication_date: Option<String>,
    pub publication_date_raw: Option<String>,
    pub published_at: Option<String>,
    pub first_seen_at: Option<String>,
    pub pmid: Option<String>,
    pub pmcid: Option<String>,
    pub doi: Option<String>,
    pub affiliation: Option<String>,
    pub has_free_fulltext: bool,
    pub is_starred: bool,
    pub is_read: bool,
    pub screening_status: String,
    pub exclusion_reason: Option<String>,
    pub screening_note: Option<String>,
    pub tags: Vec<String>,
    pub has_reading_note: bool,
    pub metrics: Option<JournalMetric>,
    pub position: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningPage {
    pub total: usize,
    pub offset: usize,
    pub rows: Vec<ScreeningRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ScreeningSelection {
    Explicit {
        entry_ids: Vec<i64>,
    },
    AllFiltered {
        #[serde(default)]
        filters: ScreeningFilters,
        #[serde(default)]
        excluded_entry_ids: Vec<i64>,
    },
}

pub fn query_scope(
    conn: &Connection,
    request: &ScreeningScopeRequest,
) -> Result<ScreeningPage, String> {
    validate_scope_kind(&request.scope_kind)?;
    let mut rows = load_scope_rows(conn, &request.scope_kind, request.scope_id)?;
    rows.retain(|row| matches_filters(row, &request.filters));
    sort_rows(&mut rows, &request.sorts);

    let total = rows.len();
    let offset = request.offset.min(total);
    let limit = request.limit.clamp(1, MAX_PAGE_SIZE);
    let page_rows = rows
        .into_iter()
        .enumerate()
        .skip(offset)
        .take(limit)
        .map(|(index, mut row)| {
            row.position = index + 1;
            row
        })
        .collect();
    Ok(ScreeningPage {
        total,
        offset,
        rows: page_rows,
    })
}

pub fn resolve_selection(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
    selection: &ScreeningSelection,
    sorts: &[ScreeningSort],
) -> Result<Vec<i64>, String> {
    validate_scope_kind(scope_kind)?;
    match selection {
        ScreeningSelection::Explicit { entry_ids } => {
            let scoped_ids = load_scope_rows(conn, scope_kind, scope_id)?
                .into_iter()
                .map(|row| row.entry_id)
                .collect::<std::collections::HashSet<_>>();
            let mut ids = entry_ids.clone();
            ids.sort_unstable();
            ids.dedup();
            if let Some(entry_id) = ids.iter().find(|entry_id| !scoped_ids.contains(entry_id)) {
                return Err(format!("文章 {} 不属于当前初筛范围", entry_id));
            }
            Ok(ids)
        }
        ScreeningSelection::AllFiltered {
            filters,
            excluded_entry_ids,
        } => {
            let mut rows = load_scope_rows(conn, scope_kind, scope_id)?;
            rows.retain(|row| matches_filters(row, filters));
            sort_rows(&mut rows, sorts);
            let excluded = excluded_entry_ids
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>();
            Ok(rows
                .into_iter()
                .filter(|row| !excluded.contains(&row.entry_id))
                .map(|row| row.entry_id)
                .collect())
        }
    }
}

fn load_scope_rows(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
) -> Result<Vec<ScreeningRow>, String> {
    let (scope_join, scope_filter, status_expr, reason_expr, note_expr, first_seen_expr) =
        match scope_kind {
            "pubmed" => (
                "JOIN pubmed_search_entries scope ON scope.entry_id = e.id",
                "scope.search_id = ?1 AND scope.is_current_match = 1",
                "scope.screening_status",
                "scope.exclusion_reason",
                "scope.screening_note",
                "scope.first_seen_at",
            ),
            "feed" => (
                "JOIN entry_feed_memberships scope ON scope.entry_id = e.id
                 LEFT JOIN feed_entry_screening_status feed_state
                   ON feed_state.feed_id = scope.feed_id AND feed_state.entry_id = e.id",
                "scope.feed_id = ?1",
                "COALESCE(feed_state.screening_status, 'unreviewed')",
                "feed_state.exclusion_reason",
                "feed_state.screening_note",
                "scope.first_seen_at",
            ),
            _ => return Err("暂不支持该初筛范围".to_string()),
        };

    let sql = format!(
        "SELECT e.id, e.title, tt.translated_text, e.summary, ts.translated_text,
                e.author, e.source, e.publication_date, e.published_at, {first_seen_expr},
                e.pmid, e.pmcid, e.doi, COALESCE(user_state.is_starred, 0), e.is_read,
                {status_expr}, {reason_expr}, {note_expr},
                EXISTS(SELECT 1 FROM reading_notes rn WHERE rn.entry_id = e.id),
                (SELECT GROUP_CONCAT(tag, char(31)) FROM (
                    SELECT tag FROM entry_tags et WHERE et.entry_id = e.id
                    ORDER BY lower(tag), tag
                )), e.publication_date_raw, e.affiliation,
                COALESCE(e.has_free_fulltext, 0)
         FROM entries e
         {scope_join}
         LEFT JOIN translations tt ON tt.entry_id = e.id
             AND tt.field = 'title' AND length(trim(tt.translated_text)) > 0
         LEFT JOIN translations ts ON ts.entry_id = e.id
             AND ts.field = 'summary' AND length(trim(ts.translated_text)) > 0
         LEFT JOIN entry_user_state user_state ON user_state.entry_id = e.id
         WHERE {scope_filter}
         ORDER BY e.id",
    );
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("读取初筛范围失败: {error}"))?;
    let rows = statement
        .query_map([scope_id], |row| {
            let journal: Option<String> = row.get(6)?;
            let tags = row
                .get::<_, Option<String>>(19)?
                .unwrap_or_default()
                .split('\u{1f}')
                .filter(|tag| !tag.trim().is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>();
            Ok(ScreeningRow {
                entry_id: row.get(0)?,
                scope_kind: scope_kind.to_string(),
                scope_id,
                title: row.get(1)?,
                title_translated: row.get(2)?,
                summary: row.get(3)?,
                summary_translated: row.get(4)?,
                authors: row.get(5)?,
                journal: journal.clone(),
                publication_date: row.get(7)?,
                publication_date_raw: row.get(20)?,
                published_at: row.get(8)?,
                first_seen_at: row.get(9)?,
                pmid: row.get(10)?,
                pmcid: row.get(11)?,
                doi: row.get(12)?,
                affiliation: row.get(21)?,
                has_free_fulltext: row.get::<_, i64>(22)? != 0,
                is_starred: row.get::<_, i64>(13)? != 0,
                is_read: row.get::<_, i64>(14)? != 0,
                screening_status: row.get(15)?,
                exclusion_reason: row.get(16)?,
                screening_note: row.get(17)?,
                has_reading_note: row.get(18)?,
                tags,
                metrics: journal.as_deref().and_then(journal_metrics_service::lookup),
                position: 0,
            })
        })
        .map_err(|error| format!("读取初筛范围失败: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("读取初筛范围失败: {error}")))
        .collect()
}

fn matches_filters(row: &ScreeningRow, filters: &ScreeningFilters) -> bool {
    if !filters.entry_ids.is_empty() && !filters.entry_ids.contains(&row.entry_id) {
        return false;
    }
    if let Some(query) = filters
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let tags = row.tags.join(" ");
        let haystack = format!(
            "{} {} {} {} {} {} {} {} {} {} {}",
            row.title,
            row.title_translated.as_deref().unwrap_or_default(),
            row.summary.as_deref().unwrap_or_default(),
            row.summary_translated.as_deref().unwrap_or_default(),
            row.authors.as_deref().unwrap_or_default(),
            row.journal.as_deref().unwrap_or_default(),
            row.pmid.as_deref().unwrap_or_default(),
            row.pmcid.as_deref().unwrap_or_default(),
            row.doi.as_deref().unwrap_or_default(),
            row.affiliation.as_deref().unwrap_or_default(),
            tags,
        )
        .to_ascii_lowercase();
        if !haystack.contains(&query.to_ascii_lowercase()) {
            return false;
        }
    }
    if let Some(status) = filters
        .screening_status
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if row.screening_status != status {
            return false;
        }
    }
    if let Some(starred) = filters.starred {
        if row.is_starred != starred {
            return false;
        }
    }
    if let Some(read) = filters.read {
        if row.is_read != read {
            return false;
        }
    }
    if let Some(from) = filters
        .published_from
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if row.publication_date.as_deref().unwrap_or_default() < from {
            return false;
        }
    }
    if let Some(to) = filters
        .published_to
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if row.publication_date.as_deref().unwrap_or_default() > to {
            return false;
        }
    }
    if let Some(min_if) = filters.min_impact_factor {
        if impact_factor(row).is_none_or(|value| value < min_if) {
            return false;
        }
    }
    if !filters.q.is_empty()
        && !filters
            .q
            .iter()
            .any(|value| Some(value) == row.metrics.as_ref().and_then(|metric| metric.q.as_ref()))
    {
        return false;
    }
    if !filters.b.is_empty()
        && !filters
            .b
            .iter()
            .any(|value| Some(value) == row.metrics.as_ref().and_then(|metric| metric.b.as_ref()))
    {
        return false;
    }
    if let Some(top) = filters.top {
        if metric_top(row) != Some(top) {
            return false;
        }
    }
    if !filters.tags.is_empty()
        && !filters
            .tags
            .iter()
            .all(|tag| row.tags.iter().any(|item| item.eq_ignore_ascii_case(tag)))
    {
        return false;
    }
    if let Some(has_note) = filters.has_reading_note {
        if row.has_reading_note != has_note {
            return false;
        }
    }
    true
}

fn sort_rows(rows: &mut [ScreeningRow], sorts: &[ScreeningSort]) {
    let default_sort = [ScreeningSort {
        field: "publication".to_string(),
        direction: "desc".to_string(),
    }];
    let sorts = if sorts.is_empty() {
        default_sort.as_slice()
    } else {
        &sorts[..sorts.len().min(3)]
    };
    rows.sort_by(|left, right| {
        for sort in sorts {
            let order = compare_field(left, right, &sort.field);
            if order != Ordering::Equal {
                return if sort.direction.eq_ignore_ascii_case("asc") {
                    order
                } else {
                    order.reverse()
                };
            }
        }
        left.entry_id.cmp(&right.entry_id)
    });
}

fn compare_field(left: &ScreeningRow, right: &ScreeningRow, field: &str) -> Ordering {
    match field {
        "publication" => compare_optional_text(
            left.publication_date.as_deref(),
            right.publication_date.as_deref(),
        ),
        "added" => compare_optional_text(
            left.first_seen_at.as_deref(),
            right.first_seen_at.as_deref(),
        ),
        "if" => compare_optional_number(impact_factor(left), impact_factor(right)),
        "q" => compare_optional_integer(
            partition(
                left.metrics.as_ref().and_then(|metric| metric.q.as_deref()),
                'Q',
            ),
            partition(
                right
                    .metrics
                    .as_ref()
                    .and_then(|metric| metric.q.as_deref()),
                'Q',
            ),
        ),
        "b" => compare_optional_integer(
            partition(
                left.metrics.as_ref().and_then(|metric| metric.b.as_deref()),
                'B',
            ),
            partition(
                right
                    .metrics
                    .as_ref()
                    .and_then(|metric| metric.b.as_deref()),
                'B',
            ),
        ),
        "top" => compare_optional_bool(metric_top(left), metric_top(right)),
        "starred" => left.is_starred.cmp(&right.is_starred),
        "read" => left.is_read.cmp(&right.is_read),
        "status" => left.screening_status.cmp(&right.screening_status),
        "authors" => left.authors.cmp(&right.authors),
        "journal" => left.journal.cmp(&right.journal),
        _ => left
            .title
            .to_ascii_lowercase()
            .cmp(&right.title.to_ascii_lowercase()),
    }
}

fn compare_optional_text(left: Option<&str>, right: Option<&str>) -> Ordering {
    match (
        left.filter(|value| !value.is_empty()),
        right.filter(|value| !value.is_empty()),
    ) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => left.cmp(right),
    }
}

fn compare_optional_number(left: Option<f64>, right: Option<f64>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => left.partial_cmp(&right).unwrap_or(Ordering::Equal),
    }
}

fn compare_optional_integer(left: Option<i64>, right: Option<i64>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => left.cmp(&right),
    }
}

fn compare_optional_bool(left: Option<bool>, right: Option<bool>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => left.cmp(&right),
    }
}

fn impact_factor(row: &ScreeningRow) -> Option<f64> {
    row.metrics
        .as_ref()
        .and_then(|metric| metric.impact_factor.as_deref())
        .and_then(|value| value.trim().parse::<f64>().ok())
}

fn partition(value: Option<&str>, prefix: char) -> Option<i64> {
    value
        .and_then(|value| {
            value
                .trim()
                .to_ascii_uppercase()
                .strip_prefix(prefix)
                .map(str::to_string)
        })
        .and_then(|value| value.parse::<i64>().ok())
}

fn metric_top(row: &ScreeningRow) -> Option<bool> {
    row.metrics
        .as_ref()
        .and_then(|metric| match metric.top.as_deref() {
            Some("1") => Some(true),
            Some("0") => Some(false),
            _ => None,
        })
}

fn validate_scope_kind(scope_kind: &str) -> Result<(), String> {
    if matches!(scope_kind, "pubmed" | "feed") {
        Ok(())
    } else {
        Err("暂不支持该初筛范围".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entries (
                id INTEGER PRIMARY KEY, title TEXT NOT NULL, summary TEXT,
                author TEXT, source TEXT, publication_date TEXT, published_at TEXT,
                publication_date_raw TEXT, pmid TEXT, pmcid TEXT, doi TEXT,
                affiliation TEXT, has_free_fulltext INTEGER,
                is_read INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE feeds (id INTEGER PRIMARY KEY);
             CREATE TABLE entry_feed_memberships (
                entry_id INTEGER NOT NULL, feed_id INTEGER NOT NULL,
                first_seen_at TEXT NOT NULL, PRIMARY KEY(entry_id, feed_id)
             );
             CREATE TABLE feed_entry_screening_status (
                feed_id INTEGER NOT NULL, entry_id INTEGER NOT NULL,
                screening_status TEXT NOT NULL, exclusion_reason TEXT,
                screening_note TEXT, screened_at TEXT, updated_at TEXT NOT NULL,
                PRIMARY KEY(feed_id, entry_id)
             );
             CREATE TABLE pubmed_search_entries (
                search_id INTEGER NOT NULL, entry_id INTEGER NOT NULL,
                screening_status TEXT NOT NULL, exclusion_reason TEXT,
                screening_note TEXT, first_seen_at TEXT, is_current_match INTEGER,
                PRIMARY KEY(search_id, entry_id)
             );
             CREATE TABLE translations (entry_id INTEGER, field TEXT, translated_text TEXT);
             CREATE TABLE entry_user_state (entry_id INTEGER PRIMARY KEY, is_starred INTEGER);
             CREATE TABLE reading_notes (entry_id INTEGER);
             CREATE TABLE entry_tags (entry_id INTEGER, tag TEXT);
             INSERT INTO feeds (id) VALUES (7);
             INSERT INTO entries (id, title, summary, source, publication_date, is_read)
                VALUES (1, 'Alpha', 'heart failure', 'Nature Medicine', '2025-01-01', 0),
                       (2, 'Beta', 'immune response', 'Nature Medicine', '2024-01-01', 1);
             INSERT INTO entry_feed_memberships (entry_id, feed_id, first_seen_at) VALUES
                (1, 7, '2025-01-02'), (2, 7, '2025-01-03');
             INSERT INTO feed_entry_screening_status
                (feed_id, entry_id, screening_status, updated_at) VALUES
                (7, 1, 'keep', '2025-01-02'), (7, 2, 'exclude', '2025-01-03');
             INSERT INTO entry_user_state (entry_id, is_starred) VALUES (1, 1);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn queries_complete_feed_scope_and_applies_filters_before_paging() {
        let conn = database();
        let page = query_scope(
            &conn,
            &ScreeningScopeRequest {
                scope_kind: "feed".to_string(),
                scope_id: 7,
                offset: 0,
                limit: 1,
                filters: ScreeningFilters {
                    screening_status: Some("keep".to_string()),
                    starred: Some(true),
                    ..Default::default()
                },
                sorts: vec![ScreeningSort {
                    field: "publication".to_string(),
                    direction: "desc".to_string(),
                }],
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].entry_id, 1);
        assert_eq!(page.rows[0].position, 1);
    }

    #[test]
    fn resolves_all_filtered_selection_across_unloaded_pages() {
        let conn = database();
        let ids = resolve_selection(
            &conn,
            "feed",
            7,
            &ScreeningSelection::AllFiltered {
                filters: ScreeningFilters {
                    screening_status: Some("keep".to_string()),
                    ..Default::default()
                },
                excluded_entry_ids: vec![],
            },
            &[],
        )
        .unwrap();
        assert_eq!(ids, vec![1]);
    }

    #[test]
    fn entry_id_filter_limits_window_to_checked_articles() {
        let conn = database();
        let page = query_scope(
            &conn,
            &ScreeningScopeRequest {
                scope_kind: "feed".to_string(),
                scope_id: 7,
                offset: 0,
                limit: 500,
                filters: ScreeningFilters {
                    entry_ids: vec![2],
                    ..Default::default()
                },
                sorts: vec![],
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.rows[0].entry_id, 2);
    }

    #[test]
    fn explicit_selection_is_deduplicated_without_scope_query() {
        let conn = database();
        let ids = resolve_selection(
            &conn,
            "feed",
            7,
            &ScreeningSelection::Explicit {
                entry_ids: vec![2, 2, 1],
            },
            &[],
        )
        .unwrap();
        assert_eq!(ids, vec![1, 2]);
    }

    #[test]
    fn filters_accept_omitted_array_fields_from_frontend_requests() {
        let filters: ScreeningFilters = serde_json::from_value(serde_json::json!({
            "screeningStatus": "keep"
        }))
        .unwrap();
        assert!(filters.q.is_empty());
        assert!(filters.b.is_empty());
        assert!(filters.tags.is_empty());
        assert!(filters.entry_ids.is_empty());
    }
}
