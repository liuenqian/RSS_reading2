use crate::db::DbState;
use crate::models::{
    Entry, EntryIdentifiers, ReadingStats, WordFrequencyResult, WordFrequencyTranslation,
};
use crate::services::{
    article_service, cost_service, entry_service, fulltext_service, settings_service,
    translate_service,
};
use std::collections::{HashMap, HashSet};
use tauri::{ipc::Response, State};
use tracing::{info, warn};

#[tauri::command]
pub fn list_entries(state: State<DbState>, feed_id: Option<i64>) -> Result<Vec<Entry>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::list_entries(&conn, feed_id)
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
