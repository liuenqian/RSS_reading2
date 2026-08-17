use crate::db::DbState;
use crate::models::{
    Entry, EntryIdentifiers, EntryOverviewCounts, OpenAccessPdfDownloadReport,
    OpenAccessPdfDownloadResult, ReadingStats, WordFrequencyResult, WordFrequencyTranslation,
};
use crate::services::{
    article_service, cost_service, entry_service, fulltext_service, settings_service,
    translate_service,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{ipc::Response, AppHandle, State};
use tracing::{info, warn};

const MAX_OPEN_ACCESS_PDF_DOWNLOADS: usize = 20;

#[tauri::command]
pub fn list_entries(state: State<DbState>, feed_id: Option<i64>) -> Result<Vec<Entry>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::list_entries(&conn, feed_id)
}

#[tauri::command]
pub fn get_entry_overview_counts(state: State<DbState>) -> Result<EntryOverviewCounts, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::overview_counts(&conn)
}

#[tauri::command]
pub fn search_entries(
    state: State<DbState>,
    query: String,
    feed_id: Option<i64>,
    pubmed_search_id: Option<i64>,
) -> Result<Vec<Entry>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::search_entries(&conn, &query, feed_id, pubmed_search_id)
}

#[tauri::command]
pub fn analyze_word_frequency(
    state: State<DbState>,
    entry_ids: Vec<i64>,
    limit: Option<usize>,
) -> Result<WordFrequencyResult, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::analyze_word_frequency(&conn, &entry_ids, limit.unwrap_or(100))
}

#[tauri::command]
pub async fn translate_word_frequency_terms(
    state: State<'_, DbState>,
    terms: Vec<String>,
) -> Result<Vec<WordFrequencyTranslation>, String> {
    let mut seen = HashSet::new();
    let terms = terms
        .into_iter()
        .map(|term| term.trim().to_ascii_lowercase())
        .filter(|term| !term.is_empty() && term.len() <= 80 && seen.insert(term.clone()))
        .take(100)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let settings = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        settings_service::get_settings(&conn)
    };
    if settings.api_key.trim().is_empty() {
        return Err("请先在 AI 设置中配置 API Key".to_string());
    }

    let serialized = serde_json::to_string(&terms).map_err(|error| error.to_string())?;
    let output = translate_service::complete_with_prompts(
        &settings,
        "你是生物医学术语翻译助手。把英文关键词准确、简洁地翻译成中文。基因、蛋白、药物缩写和专有符号应保留。只返回 JSON 对象，键必须与输入词完全一致，值为中文译名；不要返回 Markdown 或解释。",
        &format!("翻译以下英文关键词：{}", serialized),
        0.1,
        (terms.len() as i64 * 24).clamp(256, 2000),
    )
    .await?;

    let cleaned = output
        .content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let translations: HashMap<String, String> = serde_json::from_str(cleaned)
        .map_err(|error| format!("关键词翻译结果格式不正确: {}", error))?;
    let translated = terms
        .into_iter()
        .filter_map(|term| {
            let value = translations
                .get(&term)
                .or_else(|| {
                    translations
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case(&term))
                        .map(|(_, value)| value)
                })?
                .trim()
                .to_string();
            (!value.is_empty()).then_some(WordFrequencyTranslation {
                term,
                translated: value,
            })
        })
        .collect::<Vec<_>>();
    if translated.is_empty() {
        return Err("AI 没有返回可用的关键词翻译".to_string());
    }

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &output.usage);
    Ok(translated)
}

#[tauri::command]
pub fn set_entry_read(state: State<DbState>, entry_id: i64, is_read: bool) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::set_entry_read(&conn, entry_id, is_read)
}

#[tauri::command]
pub fn set_entry_screening_status(
    state: State<DbState>,
    entry_id: i64,
    status: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::set_screening_status(&conn, entry_id, &status)
}

#[tauri::command]
pub fn add_entry_tag(
    state: State<DbState>,
    entry_id: i64,
    tag: String,
) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::add_entry_tag(&conn, entry_id, &tag)
}

#[tauri::command]
pub fn remove_entry_tag(
    state: State<DbState>,
    entry_id: i64,
    tag: String,
) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::remove_entry_tag(&conn, entry_id, &tag)
}

#[tauri::command]
pub fn get_reading_stats(state: State<DbState>) -> Result<ReadingStats, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::reading_stats(&conn)
}

#[tauri::command]
pub fn get_source_reading_stats(
    state: State<DbState>,
    source_kind: String,
    source_id: i64,
) -> Result<ReadingStats, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::source_reading_stats(&conn, &source_kind, source_id)
}

#[tauri::command]
pub async fn generate_stats_flavor_pool(
    state: State<'_, DbState>,
    fetched: i64,
    read: i64,
    active_days: i64,
    peak_hour: i64,
) -> Result<Vec<String>, String> {
    // Pull settings synchronously, drop the lock before the await — DeepSeek
    // calls can take seconds and must not hold the DB mutex.
    let settings = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::services::settings_service::get_settings(&conn)
    };
    let (items, usage) =
        entry_service::generate_flavor_pool(&settings, fetched, read, active_days, peak_hour)
            .await?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let _ = crate::services::cost_service::record_usage(
        &conn,
        &settings.provider,
        &settings.model,
        &usage,
    );
    Ok(items)
}

#[tauri::command]
pub async fn fetch_abstract(
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<Option<String>, String> {
    let (title, cached_summary) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let (title, summary): (String, Option<String>) = conn
            .query_row(
                "SELECT title, summary FROM entries WHERE id = ?1",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("文章不存在: {}", e))?;
        (title, summary)
    };

    if let Some(summary) = cached_summary {
        let metadata = article_service::extract_rss_metadata(Some(&summary));
        if !metadata.is_metadata_only {
            return Ok(Some(summary));
        }
    }

    let abstract_result = article_service::fetch_abstract(&title).await?;

    if let Some(ref result) = abstract_result {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE entries SET summary = ?1, summary_source = ?2 WHERE id = ?3",
            rusqlite::params![&result.text, &result.source, entry_id],
        )
        .map_err(|e| format!("保存 Abstract 失败: {}", e))?;
    }

    Ok(abstract_result.map(|result| result.text))
}

#[tauri::command]
pub async fn fetch_affiliation(
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<Option<String>, String> {
    let (link, guid, title, summary, cached): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT link, guid, title, summary, affiliation FROM entries WHERE id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|e| format!("文章不存在: {}", e))?
    };

    if let Some(text) = cached.as_deref() {
        let cleaned = article_service::dedupe_repeated(text);
        if !cleaned.is_empty() {
            if cleaned != text {
                // Cached value from an older build had the doubled-text bug — repair it in place.
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                let _ = conn.execute(
                    "UPDATE entries SET affiliation = ?1 WHERE id = ?2",
                    rusqlite::params![&cleaned, entry_id],
                );
                info!(entry_id, "affiliation 缓存已去重");
            } else {
                info!(entry_id, "affiliation 命中缓存");
            }
            return Ok(Some(cleaned));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("RSSReading/0.1 (https://github.com/liuenqian/RSS_reading)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let pmid = if let Some(p) = article_service::extract_pmid_from_link(&link) {
        info!(entry_id, pmid = %p, "PMID 来自 link");
        Some(p)
    } else if let Some(p) = article_service::extract_pmid_from_guid(&guid) {
        info!(entry_id, pmid = %p, "PMID 来自 guid");
        Some(p)
    } else if let Some(p) = summary
        .as_deref()
        .and_then(article_service::extract_pmid_from_text)
    {
        info!(entry_id, pmid = %p, "PMID 来自 summary");
        Some(p)
    } else {
        match article_service::find_pubmed_pmid_by_title(&client, &title).await {
            Ok(Some(p)) => {
                info!(entry_id, pmid = %p, "PMID 来自 title 搜索");
                Some(p)
            }
            Ok(None) => {
                warn!(entry_id, %link, %guid, %title, "无法定位 PMID");
                None
            }
            Err(e) => {
                warn!(entry_id, error = %e, "title 搜索 PMID 失败");
                None
            }
        }
    };

    let Some(pmid) = pmid else {
        return Ok(None);
    };

    let affiliation = article_service::fetch_pubmed_first_affiliation(&client, &pmid).await?;

    match affiliation.as_deref() {
        Some(text) => info!(entry_id, pmid = %pmid, chars = text.len(), "affiliation 已获取"),
        None => warn!(entry_id, pmid = %pmid, "PubMed XML 无 Affiliation 节点"),
    }

    if let Some(ref text) = affiliation {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE entries SET affiliation = ?1 WHERE id = ?2",
            rusqlite::params![text, entry_id],
        )
        .map_err(|e| format!("保存 affiliation 失败: {}", e))?;
    }

    Ok(affiliation)
}

#[tauri::command]
pub async fn fetch_entry_authors(
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<Option<String>, String> {
    let (link, guid, summary, cached_pmid): (String, String, Option<String>, Option<String>) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT link, guid, summary, pmid FROM entries WHERE id = ?1",
            [entry_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("文章不存在: {}", e))?
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("RSSReading/0.1 (https://github.com/liuenqian/RSS_reading)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let pmid = cached_pmid
        .or_else(|| article_service::extract_pmid_from_link(&link))
        .or_else(|| article_service::extract_pmid_from_guid(&guid))
        .or_else(|| {
            summary
                .as_deref()
                .and_then(article_service::extract_pmid_from_text)
        });
    let Some(pmid) = pmid else {
        return Ok(None);
    };
    let authors = article_service::fetch_pubmed_authors(&client, &pmid).await?;
    if let Some(ref authors) = authors {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE entries SET author = ?1 WHERE id = ?2",
            rusqlite::params![authors, entry_id],
        )
        .map_err(|e| format!("保存作者失败: {}", e))?;
    }
    Ok(authors)
}

#[tauri::command]
pub async fn fetch_entry_identifiers(
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<EntryIdentifiers, String> {
    let (link, guid, summary, cached_pmid, cached_pmcid, cached_doi): (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT link, guid, summary, pmid, pmcid, doi FROM entries WHERE id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|e| format!("文章不存在: {}", e))?
    };

    let mut identifiers = EntryIdentifiers {
        pmid: cached_pmid,
        pmcid: cached_pmcid,
        doi: cached_doi,
    };

    let derived = article_service::extract_entry_identifiers(&link, &guid, summary.as_deref());
    article_service::merge_missing_identifiers(&mut identifiers, derived);

    if identifiers.pmid.is_some() || identifiers.pmcid.is_some() || identifiers.doi.is_some() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent("RSSReading/0.1 (https://github.com/liuenqian/RSS_reading)")
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
        let _ = article_service::enrich_entry_identifiers(&client, &mut identifiers).await;
    }

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE entries
         SET pmid = COALESCE(NULLIF(pmid, ''), ?1),
             pmcid = COALESCE(NULLIF(pmcid, ''), ?2),
             doi = COALESCE(NULLIF(doi, ''), ?3)
         WHERE id = ?4",
        rusqlite::params![
            identifiers.pmid.as_deref(),
            identifiers.pmcid.as_deref(),
            identifiers.doi.as_deref(),
            entry_id
        ],
    )
    .map_err(|e| format!("保存文章标识失败: {}", e))?;

    Ok(identifiers)
}

#[tauri::command]
pub async fn resolve_entry_pdf_url(
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<Option<String>, String> {
    let (title, doi, pmid, pmcid, publication_date, published_at): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT title, doi, pmid, pmcid, publication_date, published_at
             FROM entries WHERE id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|e| format!("文章不存在: {}", e))?
    };

    let publication_year = publication_date
        .as_deref()
        .or(published_at.as_deref())
        .and_then(|value| value.get(..4))
        .and_then(|value| value.parse::<i32>().ok());

    fulltext_service::resolve_pdf_url(
        &title,
        doi.as_deref(),
        pmid.as_deref(),
        pmcid.as_deref(),
        publication_year,
    )
    .await
}

#[tauri::command]
pub async fn fetch_entry_pdf(state: State<'_, DbState>, entry_id: i64) -> Result<Response, String> {
    let url = resolve_entry_pdf_url(state.clone(), entry_id)
        .await?
        .ok_or_else(|| "未找到可直接读取的全文 PDF".to_string())?;
    let bytes = fulltext_service::fetch_pdf_bytes(&url).await?;
    match pdf_extract::extract_text_from_mem(&bytes) {
        Ok(text) => {
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            if let Err(error) = entry_service::upsert_pdf_fulltext(&conn, entry_id, &url, &text) {
                warn!(%error, entry_id, "PDF 全文索引保存失败");
            }
        }
        Err(error) => warn!(%error, entry_id, "PDF 文字提取失败，继续打开原始 PDF"),
    }
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn get_entry_local_pdf_path(
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<Option<String>, String> {
    get_valid_entry_local_pdf_path(&state, entry_id)
}

#[tauri::command]
pub fn open_entry_local_pdf(
    app: AppHandle,
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<(), String> {
    let path = get_valid_entry_local_pdf_path(&state, entry_id)?
        .ok_or_else(|| "尚未下载该文献的本地 PDF，或文件已被移动".to_string())?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error| format!("无法用本地阅读器打开 PDF: {error}"))
}

fn get_valid_entry_local_pdf_path(
    state: &State<'_, DbState>,
    entry_id: i64,
) -> Result<Option<String>, String> {
    if entry_id <= 0 {
        return Err("文献 ID 不正确".to_string());
    }
    let path = {
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        entry_service::get_pdf_local_path(&conn, entry_id)?
    };
    let Some(path) = path else {
        return Ok(None);
    };
    if Path::new(&path).is_file() {
        return Ok(Some(path));
    }

    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    entry_service::set_pdf_local_path(&conn, entry_id, None)?;
    Ok(None)
}

#[tauri::command]
pub async fn download_open_access_pdfs(
    state: State<'_, DbState>,
    entry_ids: Vec<i64>,
    output_dir: String,
) -> Result<OpenAccessPdfDownloadReport, String> {
    let entry_ids = normalize_open_access_download_ids(entry_ids)?;
    let output_dir = PathBuf::from(output_dir.trim());
    if !output_dir.is_dir() {
        return Err("PDF 保存文件夹不存在".to_string());
    }

    let mut results = Vec::with_capacity(entry_ids.len());
    for entry_id in entry_ids {
        results.push(download_open_access_pdf_for_entry(&state, entry_id, &output_dir).await);
    }
    let downloaded = results
        .iter()
        .filter(|result| result.status == "downloaded")
        .count();
    Ok(OpenAccessPdfDownloadReport {
        total: results.len(),
        downloaded,
        output_dir: output_dir.to_string_lossy().to_string(),
        results,
    })
}

async fn download_open_access_pdf_for_entry(
    state: &State<'_, DbState>,
    entry_id: i64,
    output_dir: &Path,
) -> OpenAccessPdfDownloadResult {
    let entry = {
        let conn = match state.conn.lock() {
            Ok(conn) => conn,
            Err(error) => return open_access_download_failure(entry_id, "", error.to_string()),
        };
        conn.query_row(
            "SELECT title, doi, pmid, pmcid, publication_date, published_at
             FROM entries WHERE id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
    };
    let (title, doi, pmid, pmcid, _publication_date, _published_at) = match entry {
        Ok(entry) => entry,
        Err(_) => return open_access_download_failure(entry_id, "", "文章不存在".to_string()),
    };

    let candidate = match fulltext_service::resolve_open_access_pdf(
        &title,
        doi.as_deref(),
        pmid.as_deref(),
        pmcid.as_deref(),
    )
    .await
    {
        Ok(Some(candidate)) => candidate,
        Ok(None) => {
            return open_access_download_failure(
                entry_id,
                &title,
                "未找到可公开访问的 PDF".to_string(),
            )
        }
        Err(error) => return open_access_download_failure(entry_id, &title, error),
    };

    let bytes = match fulltext_service::fetch_pdf_bytes(&candidate.url).await {
        Ok(bytes) => bytes,
        Err(error) => return open_access_download_failure(entry_id, &title, error),
    };
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let file_path = match write_open_access_pdf(output_dir, &title, entry_id, &bytes) {
        Ok(path) => path,
        Err(error) => return open_access_download_failure(entry_id, &title, error),
    };
    let text = match pdf_extract::extract_text_from_mem(&bytes) {
        Ok(text) => text,
        Err(error) => {
            warn!(%error, entry_id, "PDF 文字提取失败，仍保留已验证的开放 PDF");
            String::new()
        }
    };
    let saved_path = file_path.to_string_lossy().to_string();
    let index_result = {
        let conn = match state.conn.lock() {
            Ok(conn) => conn,
            Err(error) => {
                let _ = std::fs::remove_file(&file_path);
                return open_access_download_failure(entry_id, &title, error.to_string());
            }
        };
        entry_service::upsert_pdf_fulltext(&conn, entry_id, &candidate.url, &text)
            .and_then(|_| entry_service::set_pdf_local_path(&conn, entry_id, Some(&saved_path)))
    };
    if let Err(error) = index_result {
        let _ = std::fs::remove_file(&file_path);
        return open_access_download_failure(entry_id, &title, error);
    }

    OpenAccessPdfDownloadResult {
        entry_id,
        title,
        status: "downloaded".to_string(),
        source: Some(candidate.source),
        source_url: Some(candidate.url),
        file_path: Some(saved_path),
        sha256: Some(sha256),
        error: None,
    }
}

fn normalize_open_access_download_ids(entry_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    let mut seen = HashSet::new();
    let ids = entry_ids
        .into_iter()
        .filter(|entry_id| *entry_id > 0 && seen.insert(*entry_id))
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Err("请至少选择 1 篇文献".to_string());
    }
    if ids.len() > MAX_OPEN_ACCESS_PDF_DOWNLOADS {
        return Err(format!(
            "合法开放获取 PDF 下载单次最多支持 {} 篇文献",
            MAX_OPEN_ACCESS_PDF_DOWNLOADS
        ));
    }
    Ok(ids)
}

fn write_open_access_pdf(
    output_dir: &Path,
    title: &str,
    entry_id: i64,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let stem = safe_open_access_pdf_stem(title, entry_id);
    let path = unique_open_access_pdf_path(output_dir, &stem)?;
    let temporary = path.with_extension("pdf.part");
    std::fs::write(&temporary, bytes).map_err(|error| format!("写入 PDF 临时文件失败: {error}"))?;
    std::fs::rename(&temporary, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("保存 PDF 失败: {error}")
    })?;
    Ok(path)
}

fn safe_open_access_pdf_stem(title: &str, entry_id: i64) -> String {
    let value = title
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    let value = value.trim().trim_matches('.').trim();
    let prefix = if value.is_empty() { "article" } else { value };
    format!(
        "{}-{}",
        prefix.chars().take(100).collect::<String>(),
        entry_id
    )
}

fn unique_open_access_pdf_path(output_dir: &Path, stem: &str) -> Result<PathBuf, String> {
    for suffix in 0..1000 {
        let name = if suffix == 0 {
            format!("{stem}.pdf")
        } else {
            format!("{stem}-{suffix}.pdf")
        };
        let path = output_dir.join(name);
        if !path.exists() {
            return Ok(path);
        }
    }
    Err("同名 PDF 文件过多，无法创建新文件".to_string())
}

fn open_access_download_failure(
    entry_id: i64,
    title: &str,
    error: String,
) -> OpenAccessPdfDownloadResult {
    OpenAccessPdfDownloadResult {
        entry_id,
        title: title.to_string(),
        status: "unavailable".to_string(),
        source: None,
        source_url: None,
        file_path: None,
        sha256: None,
        error: Some(error),
    }
}

#[tauri::command]
pub async fn ensure_free_fulltext_status(
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<bool, String> {
    let (link, guid, title, summary, cached): (
        String,
        String,
        String,
        Option<String>,
        Option<i64>,
    ) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT link, guid, title, summary, has_free_fulltext FROM entries WHERE id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|e| format!("文章不存在: {}", e))?
    };

    if let Some(value) = cached {
        return Ok(value != 0);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("RSSReading/0.1 (https://github.com/liuenqian/RSS_reading)")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let pmid = if let Some(p) = article_service::extract_pmid_from_link(&link) {
        Some(p)
    } else if let Some(p) = article_service::extract_pmid_from_guid(&guid) {
        Some(p)
    } else if let Some(p) = summary
        .as_deref()
        .and_then(article_service::extract_pmid_from_text)
    {
        Some(p)
    } else {
        article_service::find_pubmed_pmid_by_title(&client, &title).await?
    };

    let has_free_fulltext = if let Some(pmid) = pmid {
        article_service::fetch_pmc_fulltext_by_pmid(&pmid)
            .await?
            .is_some()
    } else {
        false
    };

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE entries SET has_free_fulltext = ?1 WHERE id = ?2",
        rusqlite::params![if has_free_fulltext { 1 } else { 0 }, entry_id],
    )
    .map_err(|e| format!("保存免费全文状态失败: {}", e))?;

    Ok(has_free_fulltext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_access_download_ids_are_positive_unique_and_bounded() {
        assert_eq!(
            normalize_open_access_download_ids(vec![3, 3, -1, 8]).unwrap(),
            vec![3, 8]
        );
        assert!(normalize_open_access_download_ids(Vec::new()).is_err());
        assert!(normalize_open_access_download_ids((1..=21).collect()).is_err());
    }

    #[test]
    fn open_access_pdf_filename_is_safe_and_keeps_entry_id() {
        assert_eq!(safe_open_access_pdf_stem("A/B: test", 42), "A-B- test-42");
        assert_eq!(safe_open_access_pdf_stem("...", 7), "article-7");
    }
}
