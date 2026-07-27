use crate::models::{PubmedArticleRecord, PubmedRetrievalOptions, PubmedSearchRunResult};
use crate::services::pubmed_search_service;
use csv::StringRecord;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

const MAX_IMPORT_FILE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPubmedImport {
    pub format: String,
    pub records: Vec<PubmedArticleRecord>,
    pub total_count: usize,
    pub with_abstract_count: usize,
    pub duplicate_count: usize,
    pub skipped_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PubmedFileImportPreview {
    pub file_name: String,
    pub suggested_name: String,
    pub format: String,
    pub importable_count: usize,
    pub total_count: usize,
    pub with_abstract_count: usize,
    pub duplicate_count: usize,
    pub skipped_count: usize,
    pub sample_titles: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PubmedFileImportResult {
    pub format: String,
    pub total_count: usize,
    pub with_abstract_count: usize,
    pub duplicate_count: usize,
    pub skipped_count: usize,
    pub run: PubmedSearchRunResult,
}

pub fn preview_file(path: &Path) -> Result<PubmedFileImportPreview, String> {
    let (file_name, parsed) = read_and_parse_file(path)?;
    let suggested_name = suggested_import_name(path);
    let sample_titles = parsed
        .records
        .iter()
        .take(3)
        .map(|record| record.title.clone())
        .collect();
    Ok(PubmedFileImportPreview {
        file_name,
        suggested_name,
        format: parsed.format,
        importable_count: parsed.records.len(),
        total_count: parsed.total_count,
        with_abstract_count: parsed.with_abstract_count,
        duplicate_count: parsed.duplicate_count,
        skipped_count: parsed.skipped_count,
        sample_titles,
    })
}

pub fn import_file(
    conn: &Connection,
    path: &Path,
    name: &str,
) -> Result<PubmedFileImportResult, String> {
    let (_, parsed) = read_and_parse_file(path)?;
    let options = PubmedRetrievalOptions {
        scope: "custom".to_string(),
        limit: Some(parsed.records.len()),
        date_from: None,
        date_to: None,
        sort: "most_recent".to_string(),
    };
    let search = pubmed_search_service::create_search_with_options(
        conn,
        name,
        Some("Cento 本地 PubMed 文件导入"),
        "0[PMID]",
        &options,
    )?;
    let run = match pubmed_search_service::import_records(conn, search.id, &parsed.records) {
        Ok(run) => run,
        Err(error) => {
            let _ = pubmed_search_service::delete_search(conn, search.id);
            return Err(error);
        }
    };
    Ok(PubmedFileImportResult {
        format: parsed.format,
        total_count: parsed.total_count,
        with_abstract_count: parsed.with_abstract_count,
        duplicate_count: parsed.duplicate_count,
        skipped_count: parsed.skipped_count,
        run,
    })
}

fn read_and_parse_file(path: &Path) -> Result<(String, ParsedPubmedImport), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取导入文件失败：{error}"))?;
    if !metadata.is_file() {
        return Err("请选择一个 PubMed 导出文件".to_string());
    }
    if metadata.len() == 0 {
        return Err("PubMed 导出文件为空".to_string());
    }
    if metadata.len() > MAX_IMPORT_FILE_BYTES {
        return Err("PubMed 导出文件超过 256 MB，请拆分后再导入".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别导入文件名".to_string())?
        .to_string();
    let bytes = fs::read(path).map_err(|error| format!("读取导入文件失败：{error}"))?;
    let parsed = parse_import_bytes(&file_name, &bytes)?;
    if parsed.records.is_empty() {
        return Err("文件中没有可导入的有效 PMID 记录".to_string());
    }
    Ok((file_name, parsed))
}

fn suggested_import_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("文献");
    let stem = stem.strip_prefix("pubmed-").unwrap_or(stem).trim();
    let name = format!("PubMed 导入 · {stem}");
    name.chars().take(80).collect()
}

pub(crate) fn parse_import_bytes(
    file_name: &str,
    bytes: &[u8],
) -> Result<ParsedPubmedImport, String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "csv" => parse_pubmed_csv(bytes),
        "nbib" | "txt" => parse_pubmed_nbib(bytes),
        _ => Err("仅支持 PubMed 导出的 .txt、.nbib 或 .csv 文件".to_string()),
    }
}

fn parse_pubmed_csv(bytes: &[u8]) -> Result<ParsedPubmedImport, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(bytes);
    let headers = reader
        .headers()
        .map_err(|error| format!("读取 CSV 表头失败：{error}"))?
        .clone();
    let header_indexes = csv_header_indexes(&headers);

    if !header_indexes.contains_key("pmid") {
        return Err("CSV 缺少 PubMed 导出格式必需的 PMID 列".to_string());
    }

    let mut records = Vec::new();
    let mut seen_pmids = HashSet::new();
    let mut duplicate_count = 0;
    let mut skipped_count = 0;
    let mut total_count = 0;

    for row in reader.records() {
        total_count += 1;
        let row = match row {
            Ok(row) => row,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        let pmid = csv_value(&row, &header_indexes, "pmid").unwrap_or_default();
        if !is_valid_pmid(&pmid) {
            skipped_count += 1;
            continue;
        }
        if !seen_pmids.insert(pmid.clone()) {
            duplicate_count += 1;
            continue;
        }

        let title =
            csv_value(&row, &header_indexes, "title").unwrap_or_else(|| "(无标题)".to_string());
        let authors = csv_value(&row, &header_indexes, "authors");
        let journal = csv_value(&row, &header_indexes, "journal/book");
        let publication_date_raw = csv_value(&row, &header_indexes, "publication year");
        let (publication_date, publication_date_precision, publication_sort_key) =
            normalize_publication_date(publication_date_raw.as_deref());
        let pmcid = csv_value(&row, &header_indexes, "pmcid");
        let doi = csv_value(&row, &header_indexes, "doi").and_then(normalize_doi);

        records.push(PubmedArticleRecord {
            pmid,
            pmcid: pmcid.clone(),
            doi,
            title,
            abstract_text: None,
            authors,
            structured_authors: Vec::new(),
            journal,
            affiliation: None,
            publication_date,
            publication_date_raw,
            publication_date_precision,
            publication_sort_key,
            has_free_fulltext: pmcid.is_some(),
        });
    }

    Ok(ParsedPubmedImport {
        format: "csv".to_string(),
        with_abstract_count: 0,
        records,
        total_count,
        duplicate_count,
        skipped_count,
    })
}

fn parse_pubmed_nbib(bytes: &[u8]) -> Result<ParsedPubmedImport, String> {
    let text = std::str::from_utf8(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes))
        .map_err(|_| "NBIB 文件不是有效的 UTF-8 文本".to_string())?;
    let mut raw_records = Vec::new();
    let mut fields: HashMap<String, Vec<String>> = HashMap::new();
    let mut current_tag: Option<String> = None;

    for line in text.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if !fields.is_empty() {
                raw_records.push(std::mem::take(&mut fields));
            }
            current_tag = None;
            continue;
        }

        if line.as_bytes().get(4) == Some(&b'-') {
            let tag = line[..4].trim().to_ascii_uppercase();
            let value = line.get(5..).unwrap_or_default().trim();
            if !tag.is_empty() {
                fields
                    .entry(tag.clone())
                    .or_default()
                    .push(value.to_string());
                current_tag = Some(tag);
            }
            continue;
        }

        if let Some(values) = current_tag.as_ref().and_then(|tag| fields.get_mut(tag)) {
            if let Some(value) = values.last_mut() {
                let continuation = line.trim();
                if !continuation.is_empty() {
                    if !value.is_empty() {
                        value.push(' ');
                    }
                    value.push_str(continuation);
                }
            }
        }
    }

    let total_count = raw_records.len();
    let mut records = Vec::new();
    let mut seen_pmids = HashSet::new();
    let mut duplicate_count = 0;
    let mut skipped_count = 0;

    for fields in raw_records {
        let pmid = first_field(&fields, "PMID").unwrap_or_default();
        if !is_valid_pmid(&pmid) {
            skipped_count += 1;
            continue;
        }
        if !seen_pmids.insert(pmid.clone()) {
            duplicate_count += 1;
            continue;
        }

        let title = first_field(&fields, "TI").unwrap_or_else(|| "(无标题)".to_string());
        let abstract_text = first_field(&fields, "AB");
        let authors = fields
            .get("FAU")
            .or_else(|| fields.get("AU"))
            .map(|values| values.join("; "))
            .and_then(nonempty_owned);
        let journal = first_field(&fields, "JT").or_else(|| first_field(&fields, "TA"));
        let affiliation = fields
            .get("AD")
            .map(|values| values.join("; "))
            .and_then(nonempty_owned);
        let publication_date_raw = first_field(&fields, "DP");
        let (publication_date, publication_date_precision, publication_sort_key) =
            normalize_publication_date(publication_date_raw.as_deref());
        let pmcid = first_field(&fields, "PMC");
        let doi = fields
            .get("AID")
            .into_iter()
            .flatten()
            .chain(fields.get("LID").into_iter().flatten())
            .find_map(|value| {
                value
                    .strip_suffix("[doi]")
                    .map(str::trim)
                    .and_then(|value| normalize_doi(value.to_string()))
            });

        records.push(PubmedArticleRecord {
            pmid,
            pmcid: pmcid.clone(),
            doi,
            title,
            abstract_text,
            authors,
            structured_authors: Vec::new(),
            journal,
            affiliation,
            publication_date,
            publication_date_raw,
            publication_date_precision,
            publication_sort_key,
            has_free_fulltext: pmcid.is_some(),
        });
    }

    let with_abstract_count = records
        .iter()
        .filter(|record| record.abstract_text.is_some())
        .count();
    Ok(ParsedPubmedImport {
        format: "nbib".to_string(),
        records,
        total_count,
        with_abstract_count,
        duplicate_count,
        skipped_count,
    })
}

fn csv_header_indexes(headers: &StringRecord) -> HashMap<String, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            (
                header
                    .trim_start_matches('\u{feff}')
                    .trim()
                    .to_ascii_lowercase(),
                index,
            )
        })
        .collect()
}

fn csv_value(
    row: &StringRecord,
    header_indexes: &HashMap<String, usize>,
    header: &str,
) -> Option<String> {
    header_indexes
        .get(header)
        .and_then(|index| row.get(*index))
        .map(str::trim)
        .map(str::to_string)
        .and_then(nonempty_owned)
}

fn first_field(fields: &HashMap<String, Vec<String>>, tag: &str) -> Option<String> {
    fields
        .get(tag)
        .and_then(|values| values.first())
        .cloned()
        .and_then(nonempty_owned)
}

fn nonempty_owned(value: String) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.trim().to_string())
}

fn is_valid_pmid(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn normalize_doi(value: String) -> Option<String> {
    let value = value.trim();
    let value = value
        .strip_prefix("https://doi.org/")
        .or_else(|| value.strip_prefix("http://doi.org/"))
        .or_else(|| value.strip_prefix("doi:"))
        .unwrap_or(value)
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn normalize_publication_date(raw: Option<&str>) -> (Option<String>, Option<String>, Option<i64>) {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return (None, None, None);
    };
    let parts: Vec<&str> = raw.split_whitespace().collect();
    let Some(year) = parts
        .first()
        .and_then(|part| part.get(..4))
        .and_then(|part| part.parse::<i64>().ok())
        .filter(|year| (1000..=9999).contains(year))
    else {
        return (Some(raw.to_string()), None, None);
    };
    let month = parts.get(1).and_then(|part| month_number(part));
    let day = parts
        .get(2)
        .and_then(|part| {
            part.trim_matches(|ch: char| !ch.is_ascii_digit())
                .parse::<i64>()
                .ok()
        })
        .filter(|day| (1..=31).contains(day));

    match (month, day) {
        (Some(month), Some(day)) => (
            Some(format!("{year:04}-{month:02}-{day:02}")),
            Some("day".to_string()),
            Some(year * 10_000 + month * 100 + day),
        ),
        (Some(month), None) => (
            Some(format!("{year:04}-{month:02}")),
            Some("month".to_string()),
            Some(year * 10_000 + month * 100),
        ),
        _ => (
            Some(format!("{year:04}")),
            Some("year".to_string()),
            Some(year * 10_000),
        ),
    }
}

fn month_number(value: &str) -> Option<i64> {
    let abbreviation = value.get(..3)?.to_ascii_lowercase();
    match abbreviation.as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "aug" => Some(8),
        "sep" => Some(9),
        "oct" => Some(10),
        "nov" => Some(11),
        "dec" => Some(12),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_official_pubmed_csv_without_requiring_abstracts() {
        let csv = concat!(
            "PMID,Title,Authors,Citation,First Author,Journal/Book,Publication Year,Create Date,PMCID,NIHMS ID,DOI\n",
            "12345,\"A title, with comma\",\"Li Q, Smith A\",Citation,Li Q,Journal A,2026,2026/07/20,PMC123,,10.1000/test\n",
        );

        let parsed = parse_import_bytes("records.csv", csv.as_bytes()).unwrap();

        assert_eq!(parsed.format, "csv");
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.with_abstract_count, 0);
        assert_eq!(parsed.records[0].pmid, "12345");
        assert_eq!(parsed.records[0].title, "A title, with comma");
        assert_eq!(parsed.records[0].authors.as_deref(), Some("Li Q, Smith A"));
        assert_eq!(parsed.records[0].journal.as_deref(), Some("Journal A"));
        assert_eq!(parsed.records[0].publication_date.as_deref(), Some("2026"));
        assert_eq!(parsed.records[0].pmcid.as_deref(), Some("PMC123"));
        assert_eq!(parsed.records[0].doi.as_deref(), Some("10.1000/test"));
        assert!(parsed.records[0].abstract_text.is_none());
    }

    #[test]
    fn parses_multiline_pubmed_nbib_records() {
        let nbib = b"PMID- 67890\n\
TI  - First title line\n\
      continued title\n\
AB  - First abstract line.\n\
      Second abstract line.\n\
FAU - Smith, Alice\n\
FAU - Li, Bob\n\
JT  - Journal B\n\
DP  - 2025 Jul 12\n\
PMC - PMC456\n\
AID - 10.2000/example [doi]\n\n";

        let parsed = parse_import_bytes("records.nbib", nbib).unwrap();

        assert_eq!(parsed.format, "nbib");
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.with_abstract_count, 1);
        assert_eq!(parsed.records[0].title, "First title line continued title");
        assert_eq!(
            parsed.records[0].abstract_text.as_deref(),
            Some("First abstract line. Second abstract line."),
        );
        assert_eq!(
            parsed.records[0].authors.as_deref(),
            Some("Smith, Alice; Li, Bob")
        );
        assert_eq!(parsed.records[0].journal.as_deref(), Some("Journal B"));
        assert_eq!(
            parsed.records[0].publication_date.as_deref(),
            Some("2025-07-12")
        );
        assert_eq!(parsed.records[0].pmcid.as_deref(), Some("PMC456"));
        assert_eq!(parsed.records[0].doi.as_deref(), Some("10.2000/example"));
    }

    #[test]
    fn accepts_pubmed_text_export_extension() {
        let parsed =
            parse_import_bytes("pubmed-records.txt", b"PMID- 67890\nTI  - Text export\n\n")
                .unwrap();

        assert_eq!(parsed.format, "nbib");
        assert_eq!(parsed.records.len(), 1);
    }

    #[test]
    fn accepts_csv_with_utf8_bom() {
        let csv = b"\xEF\xBB\xBFPMID,Title\n12345,BOM title\n";
        let parsed = parse_import_bytes("records.csv", csv).unwrap();

        assert_eq!(parsed.records[0].pmid, "12345");
        assert_eq!(parsed.records[0].title, "BOM title");
    }

    #[test]
    fn deduplicates_imported_pmids_and_reports_skipped_rows() {
        let csv = concat!(
            "PMID,Title,Authors,Citation,First Author,Journal/Book,Publication Year,Create Date,PMCID,NIHMS ID,DOI\n",
            "12345,First title,Author,Citation,Author,Journal,2026,2026/07/20,,,\n",
            "12345,Duplicate title,Author,Citation,Author,Journal,2026,2026/07/20,,,\n",
            ",Missing PMID,Author,Citation,Author,Journal,2026,2026/07/20,,,\n",
        );

        let parsed = parse_import_bytes("records.csv", csv.as_bytes()).unwrap();

        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.duplicate_count, 1);
        assert_eq!(parsed.skipped_count, 1);
    }
}
