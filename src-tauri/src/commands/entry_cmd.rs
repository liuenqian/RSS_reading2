use crate::db::DbState;
use crate::models::{Entry, EntryIdentifiers, ReadingStats};
use crate::services::{article_service, entry_service};
use tauri::State;
use tracing::{info, warn};

#[tauri::command]
pub fn list_entries(state: State<DbState>, feed_id: Option<i64>) -> Result<Vec<Entry>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::list_entries(&conn, feed_id)
}

#[tauri::command]
pub fn set_entry_read(state: State<DbState>, entry_id: i64, is_read: bool) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    entry_service::set_entry_read(&conn, entry_id, is_read)
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
    entry_service::generate_flavor_pool(&settings, fetched, read, active_days, peak_hour).await
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
