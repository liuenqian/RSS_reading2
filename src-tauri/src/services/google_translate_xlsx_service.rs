use calamine::{open_workbook, Data, DataType, Reader, Xlsx};
use rusqlite::{params, Connection, OptionalExtension};
use rust_xlsxwriter::Workbook;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
#[cfg(test)]
use std::io::Cursor;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

pub const FORMAT_CODE: &str = "CENTO_GT_1";
pub const DEFAULT_MAX_WORKBOOK_BYTES: usize = 9 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleTranslateXlsxRow {
    pub entry_id: i64,
    pub field: String,
    pub original_hash: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleTranslateXlsxIssue {
    pub row: usize,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParsedGoogleTranslateXlsx {
    pub rows: Vec<GoogleTranslateXlsxRow>,
    pub issues: Vec<GoogleTranslateXlsxIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleTranslateImportIssue {
    pub path: String,
    pub row: usize,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleTranslateImportCandidate {
    pub entry_id: i64,
    pub field: String,
    pub original_hash: String,
    pub translated_text: String,
    pub existing_translation: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleTranslateImportPreview {
    pub candidates: Vec<GoogleTranslateImportCandidate>,
    pub issues: Vec<GoogleTranslateImportIssue>,
    pub file_count: usize,
    pub overwrite_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppliedGoogleTranslation {
    pub entry_id: i64,
    pub field: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleTranslateImportReport {
    pub applied: Vec<AppliedGoogleTranslation>,
    pub skipped_existing: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleTranslateExportReport {
    pub file_paths: Vec<String>,
    pub article_count: usize,
    pub row_count: usize,
    pub title_count: usize,
    pub summary_count: usize,
    pub skipped_translated: usize,
    pub missing_summaries: usize,
}

pub fn original_text_hash(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn render_workbook(rows: &[GoogleTranslateXlsxRow]) -> Result<Vec<u8>, String> {
    if rows.is_empty() {
        return Err("没有可导出的翻译内容".to_string());
    }

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet
        .set_name("Cento Translate")
        .map_err(|error| format!("设置 Google 翻译工作表失败: {error}"))?;

    for (column, heading) in ["Cento ID", "Field", "Source Hash", "Text", "Format"]
        .iter()
        .enumerate()
    {
        worksheet
            .write_string(0, column as u16, *heading)
            .map_err(|error| format!("写入 Google 翻译表头失败: {error}"))?;
    }

    for (index, item) in rows.iter().enumerate() {
        let row = u32::try_from(index + 1).map_err(|_| "Google 翻译导出行数过多".to_string())?;
        worksheet
            .write_number(row, 0, item.entry_id as f64)
            .and_then(|sheet| sheet.write_string(row, 1, field_code(&item.field)?))
            .and_then(|sheet| sheet.write_string(row, 2, &item.original_hash))
            .and_then(|sheet| sheet.write_string(row, 3, &item.text))
            .and_then(|sheet| sheet.write_string(row, 4, FORMAT_CODE))
            .map_err(|error| format!("写入 Google 翻译内容失败: {error}"))?;
    }

    worksheet
        .set_column_width(0, 14)
        .and_then(|sheet| sheet.set_column_width(1, 10))
        .and_then(|sheet| sheet.set_column_width(2, 20))
        .and_then(|sheet| sheet.set_column_width(3, 80))
        .and_then(|sheet| sheet.set_column_width(4, 16))
        .map_err(|error| format!("设置 Google 翻译列宽失败: {error}"))?;

    workbook
        .save_to_buffer()
        .map_err(|error| format!("生成 Google 翻译 Excel 失败: {error}"))
}

pub fn render_workbook_chunks(
    rows: &[GoogleTranslateXlsxRow],
    max_bytes: usize,
) -> Result<Vec<Vec<u8>>, String> {
    if max_bytes == 0 {
        return Err("Google 翻译文件大小上限必须大于 0".to_string());
    }
    let mut chunks = Vec::new();
    render_chunk(rows, max_bytes, &mut chunks)?;
    Ok(chunks)
}

pub fn write_workbook_chunks(
    base_path: &Path,
    rows: &[GoogleTranslateXlsxRow],
) -> Result<Vec<PathBuf>, String> {
    let chunks = render_workbook_chunks(rows, DEFAULT_MAX_WORKBOOK_BYTES)?;
    let paths = output_paths(base_path, chunks.len())?;
    let temporary_paths = paths
        .iter()
        .enumerate()
        .map(|(index, path)| temporary_path(path, index))
        .collect::<Result<Vec<_>, _>>()?;

    for (temporary, bytes) in temporary_paths.iter().zip(&chunks) {
        if let Err(error) = fs::write(temporary, bytes) {
            cleanup_files(&temporary_paths);
            return Err(format!("写入 Google 翻译临时文件失败: {error}"));
        }
    }

    let mut published = Vec::new();
    for (temporary, final_path) in temporary_paths.iter().zip(&paths) {
        if final_path.exists() {
            fs::remove_file(final_path)
                .map_err(|error| format!("替换已有 Google 翻译文件失败: {error}"))?;
        }
        if let Err(error) = fs::rename(temporary, final_path) {
            cleanup_files(&temporary_paths);
            cleanup_files(&published);
            return Err(format!("保存 Google 翻译文件失败: {error}"));
        }
        published.push(final_path.clone());
    }
    Ok(paths)
}

fn render_chunk(
    rows: &[GoogleTranslateXlsxRow],
    max_bytes: usize,
    chunks: &mut Vec<Vec<u8>>,
) -> Result<(), String> {
    let workbook = render_workbook(rows)?;
    if workbook.len() <= max_bytes {
        chunks.push(workbook);
        return Ok(());
    }
    if rows.len() == 1 {
        return Err("单条标题或摘要超过 Google 翻译文件大小限制".to_string());
    }
    let midpoint = rows.len() / 2;
    render_chunk(&rows[..midpoint], max_bytes, chunks)?;
    render_chunk(&rows[midpoint..], max_bytes, chunks)
}

fn output_paths(base_path: &Path, count: usize) -> Result<Vec<PathBuf>, String> {
    if count == 0 {
        return Err("没有生成 Google 翻译文件".to_string());
    }
    if count == 1 {
        return Ok(vec![base_path.to_path_buf()]);
    }
    let parent = base_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = base_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Google 翻译文件名不正确".to_string())?;
    Ok((1..=count)
        .map(|index| parent.join(format!("{stem}-part-{index:02}.xlsx")))
        .collect())
}

fn temporary_path(path: &Path, index: usize) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Google 翻译文件名不正确".to_string())?;
    Ok(path.with_file_name(format!(".{name}.cento-tmp-{index}")))
}

fn cleanup_files(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

pub fn parse_workbook(path: &Path) -> Result<ParsedGoogleTranslateXlsx, String> {
    let workbook: Xlsx<_> =
        open_workbook(path).map_err(|error| format!("读取 Google 翻译 Excel 失败: {error}"))?;
    parse_xlsx(workbook)
}

pub fn preview_import(
    conn: &Connection,
    paths: &[PathBuf],
) -> Result<GoogleTranslateImportPreview, String> {
    if paths.is_empty() {
        return Err("请选择 Google 翻译后的 XLSX 文件".to_string());
    }

    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let path_label = path.to_string_lossy().to_string();
        let parsed = match parse_workbook(path) {
            Ok(parsed) => parsed,
            Err(error) => {
                issues.push(GoogleTranslateImportIssue {
                    path: path_label,
                    row: 0,
                    code: "invalid_file".to_string(),
                    message: error,
                });
                continue;
            }
        };
        issues.extend(
            parsed
                .issues
                .into_iter()
                .map(|issue| GoogleTranslateImportIssue {
                    path: path_label.clone(),
                    row: issue.row,
                    code: issue.code,
                    message: issue.message,
                }),
        );

        for row in parsed.rows {
            if !seen.insert((row.entry_id, row.field.clone())) {
                issues.push(GoogleTranslateImportIssue {
                    path: path_label.clone(),
                    row: 0,
                    code: "duplicate_across_files".to_string(),
                    message: format!(
                        "文献 {} 的{}在多个文件中重复",
                        row.entry_id,
                        field_label(&row.field)
                    ),
                });
                continue;
            }
            match validate_candidate(conn, row) {
                Ok(candidate) => candidates.push(candidate),
                Err((code, message)) => issues.push(GoogleTranslateImportIssue {
                    path: path_label.clone(),
                    row: 0,
                    code,
                    message,
                }),
            }
        }
    }
    let overwrite_count = candidates
        .iter()
        .filter(|candidate| candidate.existing_translation)
        .count();
    Ok(GoogleTranslateImportPreview {
        candidates,
        issues,
        file_count: paths.len(),
        overwrite_count,
    })
}

pub fn apply_import(
    conn: &mut Connection,
    candidates: &[GoogleTranslateImportCandidate],
    overwrite: bool,
) -> Result<GoogleTranslateImportReport, String> {
    if candidates.is_empty() {
        return Err("没有可导入的 Google 译文".to_string());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut applied = Vec::new();
    let mut skipped_existing = 0;
    let mut seen = HashSet::new();

    for candidate in candidates {
        if !seen.insert((candidate.entry_id, candidate.field.clone())) {
            return Err(format!(
                "文献 {} 的{}重复",
                candidate.entry_id,
                field_label(&candidate.field)
            ));
        }
        let row = GoogleTranslateXlsxRow {
            entry_id: candidate.entry_id,
            field: candidate.field.clone(),
            original_hash: candidate.original_hash.clone(),
            text: candidate.translated_text.clone(),
        };
        let validated = validate_candidate(&tx, row).map_err(|(_, message)| message)?;
        if validated.existing_translation && !overwrite {
            skipped_existing += 1;
            continue;
        }
        let original = original_text(&tx, candidate.entry_id, &candidate.field)?;
        tx.execute(
            "INSERT INTO translations (entry_id, field, original_text, translated_text, model)
             VALUES (?1, ?2, ?3, ?4, 'google-translate-web-document')
             ON CONFLICT(entry_id, field) DO UPDATE SET
               original_text = excluded.original_text,
               translated_text = excluded.translated_text,
               model = excluded.model,
               created_at = datetime('now')",
            params![
                candidate.entry_id,
                candidate.field,
                original,
                candidate.translated_text.trim()
            ],
        )
        .map_err(|error| format!("保存 Google 译文失败: {error}"))?;
        applied.push(AppliedGoogleTranslation {
            entry_id: candidate.entry_id,
            field: candidate.field.clone(),
            text: candidate.translated_text.trim().to_string(),
        });
    }

    tx.commit()
        .map_err(|error| format!("提交 Google 译文失败: {error}"))?;
    Ok(GoogleTranslateImportReport {
        applied,
        skipped_existing,
    })
}

#[cfg(test)]
fn parse_workbook_bytes(bytes: Vec<u8>) -> Result<ParsedGoogleTranslateXlsx, String> {
    let workbook = Xlsx::new(Cursor::new(bytes))
        .map_err(|error| format!("读取 Google 翻译 Excel 失败: {error}"))?;
    parse_xlsx(workbook)
}

fn parse_xlsx<R: Read + Seek>(mut workbook: Xlsx<R>) -> Result<ParsedGoogleTranslateXlsx, String> {
    let sheet_names = workbook.sheet_names().to_vec();
    for sheet_name in sheet_names {
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|error| format!("读取工作表失败: {error}"))?;
        if !range
            .rows()
            .skip(1)
            .any(|row| cell_string(row.get(4)).as_deref() == Some(FORMAT_CODE))
        {
            continue;
        }
        return parse_range(range.rows());
    }
    Err("文件不是 Cento Google 翻译 XLSX 格式".to_string())
}

fn parse_range<'a>(
    rows: impl Iterator<Item = &'a [Data]>,
) -> Result<ParsedGoogleTranslateXlsx, String> {
    let mut parsed = Vec::new();
    let mut issues = Vec::new();
    let mut seen = HashSet::new();

    for (index, row) in rows.skip(1).enumerate() {
        let row_number = index + 2;
        if row.iter().all(|cell| cell.is_empty()) {
            continue;
        }
        if cell_string(row.get(4)).as_deref() != Some(FORMAT_CODE) {
            issues.push(issue(row_number, "invalid_format", "格式代码不正确"));
            continue;
        }
        let Some(entry_id) = cell_i64(row.first()) else {
            issues.push(issue(row_number, "invalid_entry_id", "文章 ID 不正确"));
            continue;
        };
        let Some(field) = cell_string(row.get(1)).and_then(|value| field_name(&value)) else {
            issues.push(issue(row_number, "invalid_field", "字段代码必须是 T 或 S"));
            continue;
        };
        let original_hash = cell_string(row.get(2)).unwrap_or_default();
        if original_hash.trim().is_empty() {
            issues.push(issue(row_number, "missing_hash", "缺少原文指纹"));
            continue;
        }
        let text = cell_string(row.get(3)).unwrap_or_default();
        if text.trim().is_empty() {
            issues.push(issue(row_number, "empty_translation", "译文为空"));
            continue;
        }
        if !seen.insert((entry_id, field.clone())) {
            issues.push(issue(row_number, "duplicate", "文章与字段重复"));
            continue;
        }
        parsed.push(GoogleTranslateXlsxRow {
            entry_id,
            field,
            original_hash,
            text: text.trim().to_string(),
        });
    }

    Ok(ParsedGoogleTranslateXlsx {
        rows: parsed,
        issues,
    })
}

fn validate_candidate(
    conn: &Connection,
    row: GoogleTranslateXlsxRow,
) -> Result<GoogleTranslateImportCandidate, (String, String)> {
    let original = original_text(conn, row.entry_id, &row.field)
        .map_err(|message| ("unknown_entry".to_string(), message))?;
    if original_text_hash(&original) != row.original_hash {
        return Err((
            "source_changed".to_string(),
            format!(
                "文献 {} 的{}原文已变化，请重新导出",
                row.entry_id,
                field_label(&row.field)
            ),
        ));
    }
    let existing_translation = conn
        .query_row(
            "SELECT translated_text FROM translations WHERE entry_id = ?1 AND field = ?2 AND length(trim(translated_text)) > 0",
            params![row.entry_id, row.field],
            |db_row| db_row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| ("database_error".to_string(), error.to_string()))?
        .is_some();
    let mut warnings = Vec::new();
    if row.text.trim() == original.trim() {
        warnings.push("same_as_source".to_string());
    }
    if !contains_chinese(&row.text) {
        warnings.push("no_chinese".to_string());
    }
    Ok(GoogleTranslateImportCandidate {
        entry_id: row.entry_id,
        field: row.field,
        original_hash: row.original_hash,
        translated_text: row.text.trim().to_string(),
        existing_translation,
        warnings,
    })
}

fn original_text(conn: &Connection, entry_id: i64, field: &str) -> Result<String, String> {
    let column = match field {
        "title" => "title",
        "summary" => "summary",
        _ => return Err("Google 翻译字段必须是 title 或 summary".to_string()),
    };
    let sql = format!("SELECT {column} FROM entries WHERE id = ?1");
    let value = conn
        .query_row(&sql, [entry_id], |row| row.get::<_, Option<String>>(0))
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .ok_or_else(|| format!("文献 {entry_id} 不存在或没有{}", field_label(field)))?;
    if value.trim().is_empty() {
        return Err(format!("文献 {entry_id} 没有{}", field_label(field)));
    }
    Ok(value)
}

fn contains_chinese(text: &str) -> bool {
    text.chars().any(|character| {
        matches!(character, '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}')
    })
}

fn field_label(field: &str) -> &'static str {
    if field == "title" {
        "标题"
    } else {
        "摘要"
    }
}

fn field_code(field: &str) -> Result<&'static str, rust_xlsxwriter::XlsxError> {
    match field {
        "title" => Ok("T"),
        "summary" => Ok("S"),
        _ => Err(rust_xlsxwriter::XlsxError::ParameterError(
            "Google 翻译字段必须是 title 或 summary".to_string(),
        )),
    }
}

fn field_name(code: &str) -> Option<String> {
    match code.trim().to_ascii_uppercase().as_str() {
        "T" => Some("title".to_string()),
        "S" => Some("summary".to_string()),
        _ => None,
    }
}

fn cell_string(cell: Option<&Data>) -> Option<String> {
    cell.and_then(DataType::as_string)
}

fn cell_i64(cell: Option<&Data>) -> Option<i64> {
    cell.and_then(DataType::as_i64)
}

fn issue(row: usize, code: &str, message: &str) -> GoogleTranslateXlsxIssue {
    GoogleTranslateXlsxIssue {
        row,
        code: code.to_string(),
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                summary TEXT
            );
            CREATE TABLE translations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id INTEGER NOT NULL,
                field TEXT NOT NULL,
                original_text TEXT NOT NULL,
                translated_text TEXT NOT NULL,
                model TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(entry_id, field)
            );
            CREATE TABLE cost_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month TEXT NOT NULL,
                model TEXT NOT NULL
            );
            INSERT INTO entries (id, title, summary)
            VALUES (1, 'English title', 'English abstract');
            ",
        )
        .unwrap();
        conn
    }

    fn temporary_xlsx(name: &str, rows: &[GoogleTranslateXlsxRow]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cento-google-translate-{}-{name}.xlsx",
            std::process::id()
        ));
        fs::write(&path, render_workbook(rows).unwrap()).unwrap();
        path
    }

    fn row(entry_id: i64, field: &str, text: &str) -> GoogleTranslateXlsxRow {
        GoogleTranslateXlsxRow {
            entry_id,
            field: field.to_string(),
            original_hash: original_text_hash(text),
            text: text.to_string(),
        }
    }

    #[test]
    fn google_translate_xlsx_round_trips_rows() {
        let rows = vec![
            row(11, "title", "A medical title"),
            row(11, "summary", "A medical abstract"),
            row(12, "title", "Another title"),
        ];
        let parsed = parse_workbook_bytes(render_workbook(&rows).unwrap()).unwrap();
        assert_eq!(parsed.rows, rows);
        assert!(parsed.issues.is_empty());
    }

    #[test]
    fn google_translate_xlsx_splits_without_losing_rows() {
        let rows = (1..=16)
            .map(|entry_id| {
                let text = "medical text ".repeat(250);
                row(entry_id, "summary", text.trim_end())
            })
            .collect::<Vec<_>>();
        let single_row_size = render_workbook(&rows[..1]).unwrap().len();
        let full_size = render_workbook(&rows).unwrap().len();
        assert!(full_size > single_row_size);
        let chunks =
            render_workbook_chunks(&rows, single_row_size + (full_size - single_row_size) / 2)
                .unwrap();
        assert!(chunks.len() >= 2);
        let parsed_rows = chunks
            .into_iter()
            .flat_map(|chunk| parse_workbook_bytes(chunk).unwrap().rows)
            .collect::<Vec<_>>();
        assert_eq!(parsed_rows, rows);
    }

    #[test]
    fn google_translate_xlsx_rejects_unknown_fields() {
        let error = render_workbook(&[row(1, "authors", "An Author")]).unwrap_err();
        assert!(error.contains("title 或 summary"));
    }

    #[test]
    fn google_translate_hash_is_stable_and_text_sensitive() {
        assert_eq!(original_text_hash("same"), original_text_hash("same"));
        assert_ne!(original_text_hash("same"), original_text_hash("different"));
    }

    #[test]
    fn google_translate_import_previews_and_applies_without_cost_usage() {
        let mut conn = import_db();
        conn.execute(
            "INSERT INTO translations (entry_id, field, original_text, translated_text, model)
             VALUES (1, 'title', 'English title', '旧标题', 'old-model')",
            [],
        )
        .unwrap();
        let rows = vec![
            GoogleTranslateXlsxRow {
                entry_id: 1,
                field: "title".to_string(),
                original_hash: original_text_hash("English title"),
                text: "新的中文标题".to_string(),
            },
            GoogleTranslateXlsxRow {
                entry_id: 1,
                field: "summary".to_string(),
                original_hash: original_text_hash("English abstract"),
                text: "新的中文摘要".to_string(),
            },
        ];
        let path = temporary_xlsx("apply", &rows);
        let preview = preview_import(&conn, std::slice::from_ref(&path)).unwrap();
        assert_eq!(preview.candidates.len(), 2);
        assert_eq!(preview.overwrite_count, 1);
        assert!(preview.issues.is_empty());

        let report = apply_import(&mut conn, &preview.candidates, false).unwrap();
        assert_eq!(report.applied.len(), 1);
        assert_eq!(report.skipped_existing, 1);
        let title: String = conn
            .query_row(
                "SELECT translated_text FROM translations WHERE entry_id = 1 AND field = 'title'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "旧标题");

        let report = apply_import(&mut conn, &preview.candidates, true).unwrap();
        assert_eq!(report.applied.len(), 2);
        let title: String = conn
            .query_row(
                "SELECT translated_text FROM translations WHERE entry_id = 1 AND field = 'title'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "新的中文标题");
        let cost_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM cost_log", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cost_rows, 0);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn google_translate_import_rejects_changed_source_text() {
        let conn = import_db();
        let path = temporary_xlsx(
            "changed-source",
            &[GoogleTranslateXlsxRow {
                entry_id: 1,
                field: "title".to_string(),
                original_hash: original_text_hash("Old title"),
                text: "中文标题".to_string(),
            }],
        );
        let preview = preview_import(&conn, std::slice::from_ref(&path)).unwrap();
        assert!(preview.candidates.is_empty());
        assert_eq!(preview.issues[0].code, "source_changed");
        let _ = fs::remove_file(path);
    }
}
