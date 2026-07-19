use crate::services::screening_scope_service::{
    self, ScreeningRow, ScreeningSelection, ScreeningSort,
};
use calamine::{open_workbook, Data, DataType, Reader, Xlsx};
use rusqlite::{params, Connection};
use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

const FORMAT_CODE: &str = "CENTO_SCREENING_1";
const WRITABLE_FIELDS: &[&str] = &[
    "starred",
    "read",
    "tags",
    "screening_status",
    "exclusion_reason",
    "screening_note",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningXlsxExportReport {
    pub path: String,
    pub article_count: usize,
    pub read_only_columns: usize,
    pub writable_columns: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningFieldConflict {
    pub field: String,
    pub baseline: String,
    pub current: String,
    pub excel: String,
    pub default_resolution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningImportCandidate {
    pub entry_id: i64,
    pub fields: HashMap<String, String>,
    pub conflicts: Vec<ScreeningFieldConflict>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningImportPreview {
    pub candidates: Vec<ScreeningImportCandidate>,
    pub issues: Vec<String>,
    pub article_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreeningImportReport {
    pub updated_entries: usize,
    pub updated_fields: usize,
    pub skipped_fields: usize,
}

pub fn export_xlsx(
    conn: &Connection,
    path: &Path,
    scope_kind: &str,
    scope_id: i64,
    selection: &ScreeningSelection,
    sorts: &[ScreeningSort],
) -> Result<ScreeningXlsxExportReport, String> {
    let ids =
        screening_scope_service::resolve_selection(conn, scope_kind, scope_id, selection, sorts)?;
    let rows = load_rows_for_ids(conn, scope_kind, scope_id, &ids, sorts)?;
    if rows.is_empty() {
        return Err("当前没有可导出的初筛文献".to_string());
    }
    let bytes = render_workbook(scope_kind, scope_id, &rows)?;
    fs::write(path, bytes).map_err(|error| format!("保存初筛 Excel 失败: {error}"))?;
    Ok(ScreeningXlsxExportReport {
        path: path.to_string_lossy().to_string(),
        article_count: rows.len(),
        read_only_columns: 9,
        writable_columns: WRITABLE_FIELDS.len(),
    })
}

pub fn preview_import(
    conn: &Connection,
    path: &Path,
    scope_kind: &str,
    scope_id: i64,
) -> Result<ScreeningImportPreview, String> {
    let workbook: Xlsx<_> =
        open_workbook(path).map_err(|error| format!("读取初筛 Excel 失败: {error}"))?;
    let (headers, rows) = read_screening_sheet(workbook)?;
    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for (index, row) in rows.into_iter().enumerate() {
        let row_number = index + 2;
        if row.iter().all(DataType::is_empty) {
            continue;
        }
        let Some(entry_id) =
            header_value(&headers, &row, "_cento_entry_id").and_then(|value| value.parse().ok())
        else {
            issues.push(format!("第 {row_number} 行缺少有效 Cento ID"));
            continue;
        };
        if !seen.insert(entry_id) {
            issues.push(format!("第 {row_number} 行重复导入文章 {entry_id}"));
            continue;
        }
        if header_value(&headers, &row, "_cento_format").as_deref() != Some(FORMAT_CODE) {
            issues.push(format!("第 {row_number} 行格式码不正确"));
            continue;
        }
        if !belongs_to_scope(conn, scope_kind, scope_id, entry_id)? {
            issues.push(format!("文章 {entry_id} 不属于当前初筛范围"));
            continue;
        }
        let fields = writable_values(&headers, &row);
        let current = current_values(conn, scope_kind, scope_id, entry_id)?;
        let conflicts = fields
            .iter()
            .filter_map(|(field, excel)| {
                let baseline = header_value(&headers, &row, &format!("_cento_baseline_{field}"))
                    .unwrap_or_default();
                let current_value = current.get(field).cloned().unwrap_or_default();
                if baseline != current_value && *excel != current_value {
                    Some(ScreeningFieldConflict {
                        field: field.clone(),
                        baseline,
                        current: current_value,
                        excel: excel.clone(),
                        default_resolution: "cento".to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
        candidates.push(ScreeningImportCandidate {
            entry_id,
            fields,
            conflicts,
            warnings: vec!["阅读笔记列为只读，导入不会覆盖".to_string()],
        });
    }
    Ok(ScreeningImportPreview {
        article_count: candidates.len(),
        candidates,
        issues,
    })
}

pub fn apply_import(
    conn: &mut Connection,
    scope_kind: &str,
    scope_id: i64,
    candidates: &[ScreeningImportCandidate],
    resolutions: &HashMap<String, String>,
) -> Result<ScreeningImportReport, String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("开始导入初筛 Excel 事务失败: {error}"))?;
    let mut updated_entries = 0;
    let mut updated_fields = 0;
    let mut skipped_fields = 0;
    for candidate in candidates {
        if !belongs_to_scope(&tx, scope_kind, scope_id, candidate.entry_id)? {
            return Err(format!("文章 {} 不属于当前初筛范围", candidate.entry_id));
        }
        let current = current_values(&tx, scope_kind, scope_id, candidate.entry_id)?;
        let mut changed = false;
        for (field, excel_value) in &candidate.fields {
            if !WRITABLE_FIELDS.contains(&field.as_str()) {
                skipped_fields += 1;
                continue;
            }
            let resolution_key = format!("{}:{field}", candidate.entry_id);
            let resolution = resolutions
                .get(&resolution_key)
                .map(String::as_str)
                .unwrap_or("cento");
            if resolution == "cento" && candidate.conflicts.iter().any(|item| item.field == *field)
            {
                skipped_fields += 1;
                continue;
            }
            if current.get(field).map(String::as_str) == Some(excel_value.as_str()) {
                continue;
            }
            apply_field(
                &tx,
                scope_kind,
                scope_id,
                candidate.entry_id,
                field,
                excel_value,
            )?;
            updated_fields += 1;
            changed = true;
        }
        if changed {
            updated_entries += 1;
        }
    }
    tx.commit()
        .map_err(|error| format!("提交初筛 Excel 导入失败: {error}"))?;
    Ok(ScreeningImportReport {
        updated_entries,
        updated_fields,
        skipped_fields,
    })
}

fn render_workbook(
    scope_kind: &str,
    scope_id: i64,
    rows: &[ScreeningRow],
) -> Result<Vec<u8>, String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name("初筛表格")
        .map_err(|error| format!("设置初筛工作表失败: {error}"))?;
    let headers = [
        "_cento_entry_id",
        "PMID",
        "标题",
        "摘要",
        "作者",
        "期刊",
        "发表日期",
        "DOI",
        "标星",
        "已读",
        "标签",
        "筛选状态",
        "排除原因",
        "筛选备注",
        "阅读笔记（只读）",
        "_cento_scope_kind",
        "_cento_scope_id",
        "_cento_format",
        "_cento_baseline_starred",
        "_cento_baseline_read",
        "_cento_baseline_tags",
        "_cento_baseline_screening_status",
        "_cento_baseline_exclusion_reason",
        "_cento_baseline_screening_note",
    ];
    let header_format = Format::new().set_bold().set_background_color("#F3F5F7");
    for (column, heading) in headers.iter().enumerate() {
        worksheet
            .write_string_with_format(0, column as u16, *heading, &header_format)
            .map_err(|error| format!("写入初筛表头失败: {error}"))?;
    }
    for (index, row) in rows.iter().enumerate() {
        let excel_row = u32::try_from(index + 1).map_err(|_| "初筛 Excel 行数过多".to_string())?;
        let values = current_values_from_row(row);
        let cells = [
            row.entry_id.to_string(),
            row.pmid.clone().unwrap_or_default(),
            row.title.clone(),
            row.summary.clone().unwrap_or_default(),
            row.authors.clone().unwrap_or_default(),
            row.journal.clone().unwrap_or_default(),
            row.publication_date.clone().unwrap_or_default(),
            row.doi.clone().unwrap_or_default(),
            values["starred"].clone(),
            values["read"].clone(),
            values["tags"].clone(),
            row.screening_status.clone(),
            row.exclusion_reason.clone().unwrap_or_default(),
            row.screening_note.clone().unwrap_or_default(),
            "（只读）".to_string(),
            scope_kind.to_string(),
            scope_id.to_string(),
            FORMAT_CODE.to_string(),
            values["starred"].clone(),
            values["read"].clone(),
            values["tags"].clone(),
            row.screening_status.clone(),
            row.exclusion_reason.clone().unwrap_or_default(),
            row.screening_note.clone().unwrap_or_default(),
        ];
        for (column, value) in cells.iter().enumerate() {
            worksheet
                .write_string(excel_row, column as u16, value)
                .map_err(|error| format!("写入初筛内容失败: {error}"))?;
        }
    }
    worksheet
        .set_freeze_panes(1, 2)
        .map_err(|error| format!("设置初筛冻结窗格失败: {error}"))?;
    worksheet
        .autofilter(0, 0, rows.len() as u32, (headers.len() - 1) as u16)
        .map_err(|error| format!("设置初筛筛选失败: {error}"))?;
    worksheet
        .set_column_hidden(0)
        .map_err(|error| format!("隐藏 Cento ID 失败: {error}"))?;
    for column in 15..headers.len() as u16 {
        worksheet
            .set_column_hidden(column)
            .map_err(|error| format!("隐藏初筛元数据失败: {error}"))?;
    }
    workbook
        .save_to_buffer()
        .map_err(|error| format!("生成初筛 Excel 失败: {error}"))
}

fn load_rows_for_ids(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
    ids: &[i64],
    sorts: &[ScreeningSort],
) -> Result<Vec<ScreeningRow>, String> {
    let mut rows = Vec::new();
    let mut offset = 0;
    let selected = ids.iter().copied().collect::<HashSet<_>>();
    loop {
        let page = screening_scope_service::query_scope(
            conn,
            &screening_scope_service::ScreeningScopeRequest {
                scope_kind: scope_kind.to_string(),
                scope_id,
                offset,
                limit: 500,
                filters: Default::default(),
                sorts: sorts.to_vec(),
            },
        )?;
        let count = page.rows.len();
        rows.extend(
            page.rows
                .into_iter()
                .filter(|row| selected.contains(&row.entry_id)),
        );
        if offset + count >= page.total || count == 0 {
            break;
        }
        offset += count;
    }
    Ok(rows)
}

fn read_screening_sheet<R: std::io::Read + std::io::Seek>(
    mut workbook: Xlsx<R>,
) -> Result<(HashMap<String, usize>, Vec<Vec<Data>>), String> {
    for sheet_name in workbook.sheet_names().to_vec() {
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|error| format!("读取初筛工作表失败: {error}"))?;
        let mut iter = range.rows();
        let Some(header_row) = iter.next() else {
            continue;
        };
        let headers = header_row
            .iter()
            .enumerate()
            .filter_map(|(index, value)| value_string(value).map(|value| (value, index)))
            .collect::<HashMap<_, _>>();
        if headers
            .get("_cento_format")
            .and_then(|index| header_row.get(*index))
            .and_then(value_string)
            .as_deref()
            == Some(FORMAT_CODE)
            || headers.contains_key("_cento_entry_id")
        {
            return Ok((headers, iter.map(|row| row.to_vec()).collect()));
        }
    }
    Err("文件不是 Cento 初筛表格格式".to_string())
}

fn writable_values(headers: &HashMap<String, usize>, row: &[Data]) -> HashMap<String, String> {
    let mappings = [
        ("标星", "starred"),
        ("已读", "read"),
        ("标签", "tags"),
        ("筛选状态", "screening_status"),
        ("排除原因", "exclusion_reason"),
        ("筛选备注", "screening_note"),
    ];
    mappings
        .iter()
        .filter_map(|(header, field)| {
            header_value(headers, row, header).map(|value| ((*field).to_string(), value))
        })
        .collect()
}

fn header_value(headers: &HashMap<String, usize>, row: &[Data], header: &str) -> Option<String> {
    headers
        .get(header)
        .and_then(|index| row.get(*index))
        .and_then(value_string)
}

fn value_string(value: &Data) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    match value {
        Data::Empty => None,
        Data::String(value) => Some(value.trim().to_string()),
        Data::Float(value) => Some(value.to_string()),
        Data::Int(value) => Some(value.to_string()),
        Data::Bool(value) => Some(value.to_string()),
        Data::DateTime(value) => Some(value.to_string()),
        Data::DateTimeIso(value) => Some(value.to_string()),
        Data::DurationIso(value) => Some(value.to_string()),
        Data::Error(value) => Some(format!("{value:?}")),
    }
}

fn current_values_from_row(row: &ScreeningRow) -> HashMap<String, String> {
    let mut values = HashMap::new();
    values.insert(
        "starred".to_string(),
        if row.is_starred { "是" } else { "否" }.to_string(),
    );
    values.insert(
        "read".to_string(),
        if row.is_read { "是" } else { "否" }.to_string(),
    );
    values.insert("tags".to_string(), row.tags.join("; "));
    values
}

fn current_values(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
    entry_id: i64,
) -> Result<HashMap<String, String>, String> {
    let mut offset = 0;
    let row = loop {
        let request = screening_scope_service::ScreeningScopeRequest {
            scope_kind: scope_kind.to_string(),
            scope_id,
            offset,
            limit: 500,
            filters: Default::default(),
            sorts: vec![],
        };
        let page = screening_scope_service::query_scope(conn, &request)?;
        if let Some(row) = page.rows.into_iter().find(|row| row.entry_id == entry_id) {
            break row;
        }
        if offset + 500 >= page.total {
            return Err(format!("文章 {entry_id} 不存在"));
        }
        offset += 500;
    };
    let mut values = current_values_from_row(&row);
    values.insert("screening_status".to_string(), row.screening_status);
    values.insert(
        "exclusion_reason".to_string(),
        row.exclusion_reason.unwrap_or_default(),
    );
    values.insert(
        "screening_note".to_string(),
        row.screening_note.unwrap_or_default(),
    );
    Ok(values)
}

fn belongs_to_scope(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
    entry_id: i64,
) -> Result<bool, String> {
    let (table, column) = match scope_kind {
        "pubmed" => ("pubmed_search_entries", "search_id"),
        "feed" => ("entry_feed_memberships", "feed_id"),
        _ => return Err("暂不支持该初筛范围".to_string()),
    };
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column} = ?1 AND entry_id = ?2)");
    conn.query_row(&sql, params![scope_id, entry_id], |row| row.get(0))
        .map_err(|error| format!("检查初筛范围归属失败: {error}"))
}

fn apply_field(
    conn: &Connection,
    scope_kind: &str,
    scope_id: i64,
    entry_id: i64,
    field: &str,
    value: &str,
) -> Result<(), String> {
    match field {
        "starred" => {
            let is_starred = matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "是" | "yes" | "true" | "1" | "y"
            );
            conn.execute("INSERT INTO entry_user_state (entry_id, is_starred, starred_at, updated_at) VALUES (?1, ?2, CASE WHEN ?2 = 1 THEN datetime('now') ELSE NULL END, datetime('now')) ON CONFLICT(entry_id) DO UPDATE SET is_starred = excluded.is_starred, starred_at = excluded.starred_at, updated_at = excluded.updated_at", params![entry_id, is_starred as i64]).map_err(|error| format!("写入标星失败: {error}"))?;
        }
        "read" => {
            let is_read = matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "是" | "yes" | "true" | "1" | "y"
            );
            conn.execute(
                "UPDATE entries SET is_read = ?1 WHERE id = ?2",
                params![is_read as i64, entry_id],
            )
            .map_err(|error| format!("写入已读状态失败: {error}"))?;
        }
        "tags" => {
            conn.execute("DELETE FROM entry_tags WHERE entry_id = ?1", [entry_id])
                .map_err(|error| format!("更新标签失败: {error}"))?;
            for tag in value
                .split([';', ','])
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
            {
                conn.execute(
                    "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?1, ?2)",
                    params![entry_id, tag],
                )
                .map_err(|error| format!("写入标签失败: {error}"))?;
            }
        }
        "screening_status" | "exclusion_reason" | "screening_note" => {
            let table = match scope_kind {
                "pubmed" => "pubmed_search_entries",
                "feed" => "feed_entry_screening_status",
                _ => return Err("暂不支持该初筛范围".to_string()),
            };
            let (scope_column, status_column) = if scope_kind == "pubmed" {
                ("search_id", "screening_status")
            } else {
                ("feed_id", "screening_status")
            };
            if field == "screening_status" {
                conn.execute(&format!("UPDATE {table} SET screening_status = ?1, updated_at = datetime('now') WHERE {scope_column} = ?2 AND entry_id = ?3"), params![value, scope_id, entry_id]).map_err(|error| format!("写入筛选状态失败: {error}"))?;
            } else {
                let column = if field == "exclusion_reason" {
                    "exclusion_reason"
                } else {
                    "screening_note"
                };
                conn.execute(&format!("UPDATE {table} SET {column} = ?1, updated_at = datetime('now') WHERE {scope_column} = ?2 AND entry_id = ?3"), params![value, scope_id, entry_id]).map_err(|error| format!("写入筛选备注失败: {error}"))?;
            }
            let _ = status_column;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::journal_metrics_service::JournalMetric;
    use std::io::Cursor;

    fn row() -> ScreeningRow {
        ScreeningRow {
            entry_id: 42,
            scope_kind: "feed".to_string(),
            scope_id: 7,
            title: "Original title".to_string(),
            title_translated: None,
            summary: Some("Abstract".to_string()),
            summary_translated: None,
            authors: Some("Author A".to_string()),
            journal: Some("Nature".to_string()),
            publication_date: Some("2025-01-01".to_string()),
            publication_date_raw: Some("2025 Jan 1".to_string()),
            published_at: None,
            first_seen_at: Some("2025-01-02".to_string()),
            pmid: Some("123".to_string()),
            pmcid: None,
            doi: Some("10.1000/test".to_string()),
            affiliation: Some("Example University".to_string()),
            has_free_fulltext: true,
            is_starred: true,
            is_read: false,
            screening_status: "keep".to_string(),
            exclusion_reason: None,
            screening_note: Some("note".to_string()),
            tags: vec!["heart".to_string(), "review".to_string()],
            has_reading_note: true,
            metrics: Some(JournalMetric {
                journal: Some("Nature".to_string()),
                abbr: None,
                impact_factor: Some("50".to_string()),
                q: Some("Q1".to_string()),
                b: Some("B1".to_string()),
                top: Some("1".to_string()),
            }),
            position: 1,
        }
    }

    #[test]
    fn screening_workbook_contains_format_and_hidden_baseline_headers() {
        let bytes = render_workbook("feed", 7, &[row()]).unwrap();
        assert!(bytes.starts_with(b"PK"));
        let mut workbook = Xlsx::new(Cursor::new(bytes)).unwrap();
        let range = workbook.worksheet_range("初筛表格").unwrap();
        let header = range.rows().next().unwrap();
        assert_eq!(value_string(&header[0]).as_deref(), Some("_cento_entry_id"));
        assert_eq!(value_string(&header[17]).as_deref(), Some("_cento_format"));
        assert_eq!(
            value_string(&header[18]).as_deref(),
            Some("_cento_baseline_starred")
        );
        let data = range.rows().nth(1).unwrap();
        assert_eq!(value_string(&data[0]).as_deref(), Some("42"));
        assert_eq!(value_string(&data[17]).as_deref(), Some(FORMAT_CODE));
    }
}
