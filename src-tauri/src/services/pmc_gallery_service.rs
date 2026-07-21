use crate::services::journal_metrics_service;
use reqwest::{Client, Url};
use roxmltree::Node;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::Duration;

const ESEARCH_URL: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const PMC_S3_ORIGIN: &str = "https://pmc-oa-opendata.s3.amazonaws.com";
const MAX_ARTICLE_LIMIT: usize = 20;
const MAX_FIGURES: usize = 120;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PmcGalleryFigure {
    pub pmcid: String,
    pub article_title: String,
    pub article_url: String,
    pub label: String,
    pub caption: String,
    pub image_url: String,
    pub license: String,
    pub figure_kind: String,
    pub journal: String,
    pub publication_year: Option<i32>,
    pub impact_factor: Option<String>,
    pub jcr_quartile: Option<String>,
    pub cas_partition: Option<String>,
    pub is_top: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PmcGallerySearchResult {
    pub query: String,
    pub total_articles: usize,
    pub scanned_articles: usize,
    pub skipped_articles: usize,
    pub filtered_articles: usize,
    pub next_offset: usize,
    pub has_more: bool,
    pub figures: Vec<PmcGalleryFigure>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PmcGalleryJournalOption {
    pub name: String,
    pub abbreviation: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PmcGalleryJournalOptionsResult {
    pub total_articles: usize,
    pub sampled_articles: usize,
    pub journals: Vec<PmcGalleryJournalOption>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PmcGalleryPreviewEntry {
    pub pmcid: String,
    pub pmid: Option<String>,
    pub title: String,
    pub journal: String,
    pub authors: String,
    pub publication_date: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PmcGalleryPreviewResult {
    pub query: String,
    pub total_count: usize,
    pub open_access_count: usize,
    pub entries: Vec<PmcGalleryPreviewEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PmcGalleryMetricFilters {
    pub journal: Option<String>,
    pub impact_factor: Option<String>,
    pub jcr_quartile: Option<String>,
    pub cas_partition: Option<String>,
    pub top: Option<String>,
}

#[derive(Debug, Clone)]
struct ArticleMetadata {
    pmcid: String,
    title: String,
    license: String,
    media_urls: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArticleQuality {
    id: String,
    journal: String,
    publication_year: Option<i32>,
    impact_factor: Option<String>,
    jcr_quartile: Option<String>,
    cas_partition: Option<String>,
    is_top: Option<bool>,
}

pub async fn search_gallery(
    query: &str,
    article_limit: usize,
    article_offset: usize,
    metric_filters: &PmcGalleryMetricFilters,
) -> Result<PmcGallerySearchResult, String> {
    let query = normalize_query(query)?;
    let article_limit = article_limit.clamp(1, MAX_ARTICLE_LIMIT);
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("RSSReading/1.1 (PMC Open Access gallery)")
        .build()
        .map_err(|error| format!("创建 PMC 图库客户端失败: {}", error))?;
    let search_term = format!("({}) AND open_access[filter]", query);
    let article_limit_string = article_limit.to_string();
    let article_offset_string = article_offset.to_string();
    let response = client
        .get(ESEARCH_URL)
        .query(&[
            ("db", "pmc"),
            ("term", search_term.as_str()),
            ("retmax", article_limit_string.as_str()),
            ("retstart", article_offset_string.as_str()),
            ("retmode", "json"),
            ("sort", "relevance"),
        ])
        .send()
        .await
        .map_err(|error| format!("请求 PMC 图库检索失败: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("PMC 图库检索返回 HTTP {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 PMC 图库检索结果失败: {}", error))?;
    let total_articles = payload
        .pointer("/esearchresult/count")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let ids = payload
        .pointer("/esearchresult/idlist")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let returned_articles = ids.len();
    let (mut articles, filtered_articles) =
        filter_ids_by_metrics(&client, ids, metric_filters).await?;
    articles.sort_by(compare_article_quality);

    let mut figures = Vec::new();
    let mut scanned_articles = 0;
    let mut skipped_articles = 0;
    let mut first_error = None;
    for article in articles {
        match fetch_article_figures(&client, &article).await {
            Ok(mut article_figures) => {
                scanned_articles += 1;
                figures.append(&mut article_figures);
                if figures.len() >= MAX_FIGURES {
                    figures.truncate(MAX_FIGURES);
                }
            }
            Err(error) => {
                skipped_articles += 1;
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    if scanned_articles == 0 && skipped_articles > 0 {
        return Err(format!(
            "找到匹配文献，但无法读取 PMC 图像包：{}",
            first_error.unwrap_or_else(|| "未知错误".to_string())
        ));
    }
    let next_offset = article_offset.saturating_add(returned_articles);

    Ok(PmcGallerySearchResult {
        query,
        total_articles,
        scanned_articles,
        skipped_articles,
        filtered_articles,
        next_offset,
        has_more: next_offset < total_articles,
        figures,
    })
}

pub async fn list_journal_options(
    query: &str,
    sample_limit: usize,
) -> Result<PmcGalleryJournalOptionsResult, String> {
    let query = normalize_query(query)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("RSSReading/1.1 (PMC journal facets)")
        .build()
        .map_err(|error| format!("创建 PMC 期刊统计客户端失败: {}", error))?;
    let search_term = format!("({}) AND open_access[filter]", query);
    let sample_limit = sample_limit.clamp(20, 500);
    let sample_limit_string = sample_limit.to_string();
    let response = client
        .get(ESEARCH_URL)
        .query(&[
            ("db", "pmc"),
            ("term", search_term.as_str()),
            ("retmax", sample_limit_string.as_str()),
            ("retmode", "json"),
            ("sort", "relevance"),
        ])
        .send()
        .await
        .map_err(|error| format!("请求 PMC 期刊候选失败: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("PMC 期刊候选返回 HTTP {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 PMC 期刊候选失败: {}", error))?;
    let total_articles = payload
        .pointer("/esearchresult/count")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let ids = payload
        .pointer("/esearchresult/idlist")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mut journal_counts: HashMap<String, (String, String, usize)> = HashMap::new();
    for chunk in ids.chunks(100) {
        let id_list = chunk.join(",");
        let response = client
            .get(ESUMMARY_URL)
            .query(&[("db", "pmc"), ("id", id_list.as_str()), ("retmode", "json")])
            .send()
            .await
            .map_err(|error| format!("请求 PMC 期刊摘要失败: {}", error))?;
        if !response.status().is_success() {
            return Err(format!("PMC 期刊摘要返回 HTTP {}", response.status()));
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|error| format!("解析 PMC 期刊摘要失败: {}", error))?;
        let Some(result) = payload.get("result").and_then(Value::as_object) else {
            continue;
        };
        for id in chunk {
            let Some(summary) = result.get(id) else {
                continue;
            };
            let name = summary
                .get("fulljournalname")
                .and_then(Value::as_str)
                .or_else(|| summary.get("source").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(name) = name else {
                continue;
            };
            let abbreviation = summary
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let entry = journal_counts
                .entry(name.to_lowercase())
                .or_insert_with(|| (name.to_string(), abbreviation.to_string(), 0));
            entry.2 += 1;
        }
    }
    let mut journals = journal_counts
        .into_values()
        .map(|(name, abbreviation, count)| PmcGalleryJournalOption {
            name,
            abbreviation,
            count,
        })
        .collect::<Vec<_>>();
    journals.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(PmcGalleryJournalOptionsResult {
        total_articles,
        sampled_articles: ids.len(),
        journals,
    })
}

pub async fn preview_gallery(
    query: &str,
    sample_limit: usize,
) -> Result<PmcGalleryPreviewResult, String> {
    let query = normalize_query(query)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("RSSReading/1.1 (PMC gallery preview)")
        .build()
        .map_err(|error| format!("创建 PMC 预览客户端失败: {}", error))?;
    let search_term = format!("({})", query);
    let open_access_search_term = format!("({}) AND open_access[filter]", query);
    let sample_limit_string = sample_limit.clamp(1, 20).to_string();
    let (response, open_access_response) = tokio::try_join!(
        client
            .get(ESEARCH_URL)
            .query(&[
                ("db", "pmc"),
                ("term", search_term.as_str()),
                ("retmax", sample_limit_string.as_str()),
                ("retmode", "json"),
                ("sort", "relevance"),
            ])
            .send(),
        client
            .get(ESEARCH_URL)
            .query(&[
                ("db", "pmc"),
                ("term", open_access_search_term.as_str()),
                ("retmax", "0"),
                ("retmode", "json"),
            ])
            .send(),
    )
    .map_err(|error| format!("请求 PMC 预览失败: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("PMC 预览返回 HTTP {}", response.status()));
    }
    if !open_access_response.status().is_success() {
        return Err(format!(
            "PMC 开放文献计数返回 HTTP {}",
            open_access_response.status()
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 PMC 预览失败: {}", error))?;
    let open_access_payload: Value = open_access_response
        .json()
        .await
        .map_err(|error| format!("解析 PMC 开放文献计数失败: {}", error))?;
    let total_count = payload
        .pointer("/esearchresult/count")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let open_access_count = open_access_payload
        .pointer("/esearchresult/count")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let ids = payload
        .pointer("/esearchresult/idlist")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(PmcGalleryPreviewResult {
            query,
            total_count,
            open_access_count,
            entries: Vec::new(),
        });
    }
    let id_list = ids.join(",");
    let response = client
        .get(ESUMMARY_URL)
        .query(&[("db", "pmc"), ("id", id_list.as_str()), ("retmode", "json")])
        .send()
        .await
        .map_err(|error| format!("请求 PMC 预览摘要失败: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("PMC 预览摘要返回 HTTP {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 PMC 预览摘要失败: {}", error))?;
    let result = payload
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(|| "PMC 预览摘要缺少 result".to_string())?;
    let entries = ids
        .iter()
        .filter_map(|id| {
            let summary = result.get(id)?;
            let article_ids = summary.get("articleids").and_then(Value::as_array);
            let identifier = |kind: &str| {
                article_ids
                    .into_iter()
                    .flatten()
                    .find(|item| item.get("idtype").and_then(Value::as_str) == Some(kind))
                    .and_then(|item| item.get("value"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            };
            let authors = summary
                .get("authors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|author| author.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ");
            Some(PmcGalleryPreviewEntry {
                pmcid: identifier("pmcid").unwrap_or_else(|| format!("PMC{}", id)),
                pmid: identifier("pmid"),
                title: summary
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("题名待确认")
                    .to_string(),
                journal: summary
                    .get("fulljournalname")
                    .and_then(Value::as_str)
                    .or_else(|| summary.get("source").and_then(Value::as_str))
                    .unwrap_or("期刊待确认")
                    .to_string(),
                authors,
                publication_date: summary
                    .get("pubdate")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect();
    Ok(PmcGalleryPreviewResult {
        query,
        total_count,
        open_access_count,
        entries,
    })
}

async fn filter_ids_by_metrics(
    client: &Client,
    ids: Vec<String>,
    filters: &PmcGalleryMetricFilters,
) -> Result<(Vec<ArticleQuality>, usize), String> {
    if ids.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let id_list = ids.join(",");
    let response = client
        .get(ESUMMARY_URL)
        .query(&[("db", "pmc"), ("id", id_list.as_str()), ("retmode", "json")])
        .send()
        .await
        .map_err(|error| format!("请求 PMC 期刊信息失败: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("PMC 期刊信息返回 HTTP {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析 PMC 期刊信息失败: {}", error))?;
    let result = payload
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(|| "PMC 期刊信息缺少 result".to_string())?;

    let mut kept = Vec::new();
    let mut filtered = 0;
    for id in ids {
        let summary = result.get(&id);
        let metric = summary.and_then(|item| {
            item.get("fulljournalname")
                .and_then(Value::as_str)
                .and_then(journal_metrics_service::lookup)
                .or_else(|| {
                    item.get("source")
                        .and_then(Value::as_str)
                        .and_then(journal_metrics_service::lookup)
                })
        });
        if matches_journal_filter(summary, filters)
            && matches_metric_filters(metric.as_ref(), filters)
        {
            kept.push(article_quality(id, summary, metric.as_ref()));
        } else {
            filtered += 1;
        }
    }
    Ok((kept, filtered))
}

fn article_quality(
    id: String,
    summary: Option<&Value>,
    metric: Option<&journal_metrics_service::JournalMetric>,
) -> ArticleQuality {
    let journal = summary
        .and_then(|item| item.get("fulljournalname").and_then(Value::as_str))
        .or_else(|| summary.and_then(|item| item.get("source").and_then(Value::as_str)))
        .unwrap_or_default()
        .trim()
        .to_string();
    let publication_year = summary
        .and_then(|item| item.get("pubdate").and_then(Value::as_str))
        .and_then(parse_publication_year);
    ArticleQuality {
        id,
        journal,
        publication_year,
        impact_factor: visible_metric(metric.and_then(|item| item.impact_factor.as_deref()))
            .map(ToOwned::to_owned),
        jcr_quartile: visible_metric(metric.and_then(|item| item.q.as_deref()))
            .map(ToOwned::to_owned),
        cas_partition: visible_metric(metric.and_then(|item| item.b.as_deref()))
            .map(ToOwned::to_owned),
        is_top: metric
            .and_then(|item| item.top.as_deref())
            .and_then(|value| match value {
                "1" => Some(true),
                "0" => Some(false),
                _ => None,
            }),
    }
}

fn compare_article_quality(left: &ArticleQuality, right: &ArticleQuality) -> Ordering {
    right
        .is_top
        .unwrap_or(false)
        .cmp(&left.is_top.unwrap_or(false))
        .then_with(|| {
            partition_rank(right.cas_partition.as_deref(), 'B')
                .cmp(&partition_rank(left.cas_partition.as_deref(), 'B'))
        })
        .then_with(|| {
            partition_rank(right.jcr_quartile.as_deref(), 'Q')
                .cmp(&partition_rank(left.jcr_quartile.as_deref(), 'Q'))
        })
        .then_with(|| {
            metric_sort_value(right.impact_factor.as_deref())
                .total_cmp(&metric_sort_value(left.impact_factor.as_deref()))
        })
        .then_with(|| right.publication_year.cmp(&left.publication_year))
}

fn partition_rank(value: Option<&str>, prefix: char) -> u8 {
    value
        .and_then(|value| value.strip_prefix(prefix))
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|value| (1..=4).contains(value))
        .map(|value| 5 - value)
        .unwrap_or(0)
}

fn metric_sort_value(value: Option<&str>) -> f64 {
    value.and_then(parse_metric_number).unwrap_or(-1.0)
}

fn parse_publication_year(value: &str) -> Option<i32> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| part.len() == 4)
        .and_then(|part| part.parse::<i32>().ok())
        .filter(|year| (1800..=2200).contains(year))
}

fn matches_journal_filter(summary: Option<&Value>, filters: &PmcGalleryMetricFilters) -> bool {
    let needle = filters
        .journal
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"));
    let Some(needle) = needle else {
        return true;
    };
    let needle = needle.to_lowercase();
    ["fulljournalname", "source"]
        .into_iter()
        .filter_map(|field| summary?.get(field)?.as_str())
        .any(|value| value.to_lowercase().contains(&needle))
}

fn matches_metric_filters(
    metric: Option<&journal_metrics_service::JournalMetric>,
    filters: &PmcGalleryMetricFilters,
) -> bool {
    let impact_factor = metric
        .and_then(|item| item.impact_factor.as_deref())
        .and_then(parse_metric_number);
    let q = visible_metric(metric.and_then(|item| item.q.as_deref()));
    let b = visible_metric(metric.and_then(|item| item.b.as_deref()));
    let top = metric
        .and_then(|item| item.top.as_deref())
        .filter(|value| matches!(*value, "0" | "1"));

    match filters.impact_factor.as_deref().unwrap_or("all") {
        "ge5" if impact_factor.is_none_or(|value| value < 5.0) => return false,
        "ge10" if impact_factor.is_none_or(|value| value < 10.0) => return false,
        "ge20" if impact_factor.is_none_or(|value| value < 20.0) => return false,
        "na" if impact_factor.is_some() => return false,
        _ => {}
    }
    match filters.jcr_quartile.as_deref().unwrap_or("all") {
        "na" if q.is_some() => return false,
        "na" => {}
        expected if expected != "all" && q != Some(expected) => return false,
        _ => {}
    }
    match filters.cas_partition.as_deref().unwrap_or("all") {
        "na" if b.is_some() => return false,
        "na" => {}
        expected if expected != "all" && b != Some(expected) => return false,
        _ => {}
    }
    match filters.top.as_deref().unwrap_or("all") {
        "top" if top != Some("1") => return false,
        "non-top" if top != Some("0") => return false,
        "na" if top.is_some() => return false,
        _ => {}
    }
    true
}

fn parse_metric_number(value: &str) -> Option<f64> {
    let number = value
        .trim()
        .trim_start_matches('<')
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    number.parse::<f64>().ok()
}

fn visible_metric(value: Option<&str>) -> Option<&str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("N/A"))
}

fn normalize_query(query: &str) -> Result<String, String> {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    let length = query.chars().count();
    if length < 2 {
        return Err("请输入至少 2 个字符的 PMC 图库检索词".to_string());
    }
    if length > 300 {
        return Err("PMC 图库检索词不能超过 300 个字符".to_string());
    }
    Ok(query)
}

async fn fetch_article_figures(
    client: &Client,
    article: &ArticleQuality,
) -> Result<Vec<PmcGalleryFigure>, String> {
    let pmcid = format!("PMC{}", article.id.trim_start_matches("PMC"));
    let prefix = resolve_latest_version_prefix(client, &pmcid).await?;
    let version_name = prefix.trim_end_matches('/');
    let metadata_url = s3_object_url(&format!("{prefix}{version_name}.json"))?;
    let xml_url = s3_object_url(&format!("{prefix}{version_name}.xml"))?;
    let (metadata_response, xml_response) =
        tokio::try_join!(client.get(metadata_url).send(), client.get(xml_url).send(),)
            .map_err(|error| format!("请求 {} 图库文件失败: {}", pmcid, error))?;
    if !metadata_response.status().is_success() || !xml_response.status().is_success() {
        return Err(format!("{} 图库文件尚不可用", pmcid));
    }
    let metadata_payload: Value = metadata_response
        .json()
        .await
        .map_err(|error| format!("解析 {} 图库元数据失败: {}", pmcid, error))?;
    let xml = xml_response
        .text()
        .await
        .map_err(|error| format!("读取 {} JATS XML 失败: {}", pmcid, error))?;
    let metadata = parse_article_metadata(&metadata_payload)?;
    let mut figures = parse_article_figures(&xml, &metadata)?;
    for figure in &mut figures {
        figure.journal.clone_from(&article.journal);
        figure.publication_year = article.publication_year;
        figure.impact_factor.clone_from(&article.impact_factor);
        figure.jcr_quartile.clone_from(&article.jcr_quartile);
        figure.cas_partition.clone_from(&article.cas_partition);
        figure.is_top = article.is_top;
    }
    Ok(figures)
}

async fn resolve_latest_version_prefix(client: &Client, pmcid: &str) -> Result<String, String> {
    let prefix_query = format!("{}.", pmcid);
    let response = client
        .get(PMC_S3_ORIGIN)
        .query(&[
            ("list-type", "2"),
            ("prefix", prefix_query.as_str()),
            ("delimiter", "/"),
        ])
        .send()
        .await
        .map_err(|error| format!("查询 {} PMC 版本失败: {}", pmcid, error))?;
    if !response.status().is_success() {
        return Err(format!(
            "查询 {} PMC 版本返回 HTTP {}",
            pmcid,
            response.status()
        ));
    }
    let xml = response
        .text()
        .await
        .map_err(|error| format!("读取 {} PMC 版本失败: {}", pmcid, error))?;
    parse_latest_version_prefix(&xml, pmcid)
}

fn parse_latest_version_prefix(xml: &str, pmcid: &str) -> Result<String, String> {
    let document = roxmltree::Document::parse(xml)
        .map_err(|error| format!("解析 {} PMC 版本失败: {}", pmcid, error))?;
    document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "Prefix")
        .filter_map(|node| node.text())
        .filter_map(|prefix| {
            let version = prefix
                .trim_end_matches('/')
                .strip_prefix(&format!("{}.", pmcid))?
                .parse::<u32>()
                .ok()?;
            Some((version, prefix.to_string()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, prefix)| prefix)
        .ok_or_else(|| format!("{} 暂无可检索的 PMC 图库文件", pmcid))
}

fn parse_article_metadata(payload: &Value) -> Result<ArticleMetadata, String> {
    let pmcid = payload
        .get("pmcid")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "PMC 图库元数据缺少 PMCID".to_string())?
        .to_string();
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("未命名 PMC 文献")
        .trim()
        .to_string();
    let license = payload
        .get("license_code")
        .and_then(Value::as_str)
        .unwrap_or("OA")
        .trim()
        .to_string();
    let media_urls = payload
        .get("media_urls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|url| {
            let key = url.strip_prefix("s3://pmc-oa-opendata/")?;
            let key = key.split('?').next()?;
            let filename = key.rsplit('/').next()?.to_string();
            Some((filename, s3_object_url(key).ok()?))
        })
        .collect::<HashMap<_, _>>();
    Ok(ArticleMetadata {
        pmcid,
        title,
        license,
        media_urls,
    })
}

fn parse_article_figures(
    xml: &str,
    metadata: &ArticleMetadata,
) -> Result<Vec<PmcGalleryFigure>, String> {
    let options = roxmltree::ParsingOptions {
        allow_dtd: true,
        nodes_limit: 500_000,
    };
    let document = roxmltree::Document::parse_with_options(xml, options)
        .map_err(|error| format!("解析 {} JATS XML 失败: {}", metadata.pmcid, error))?;
    let article_url = format!("https://pmc.ncbi.nlm.nih.gov/articles/{}/", metadata.pmcid);
    let mut figures = Vec::new();
    for figure in document
        .descendants()
        .filter(|node| node.has_tag_name("fig"))
    {
        let label = figure
            .children()
            .find(|node| node.has_tag_name("label"))
            .map(node_text)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "图".to_string());
        let caption = figure
            .children()
            .find(|node| node.has_tag_name("caption"))
            .map(node_text)
            .unwrap_or_default();
        let kind_text = format!(
            "{} {} {}",
            figure.attribute("fig-type").unwrap_or_default(),
            figure.attribute("content-type").unwrap_or_default(),
            format!("{} {}", label, caption)
        )
        .to_lowercase();
        let figure_kind = if [
            "graphical abstract",
            "visual abstract",
            "graphical summary",
            "toc graphic",
            "schematic summary",
            "schematic overview",
            "summary graphic",
            "scheme",
        ]
        .iter()
        .any(|needle| kind_text.contains(needle))
        {
            "graphical_abstract"
        } else {
            "figure"
        };
        for graphic in figure
            .descendants()
            .filter(|node| node.has_tag_name("graphic"))
        {
            let Some(href) = graphic
                .attributes()
                .find(|attribute| attribute.name() == "href")
                .map(|attribute| attribute.value())
            else {
                continue;
            };
            let Some(filename) = href.rsplit('/').next() else {
                continue;
            };
            let Some(image_url) = metadata.media_urls.get(filename) else {
                continue;
            };
            figures.push(PmcGalleryFigure {
                pmcid: metadata.pmcid.clone(),
                article_title: metadata.title.clone(),
                article_url: article_url.clone(),
                label: label.clone(),
                caption: caption.clone(),
                image_url: image_url.clone(),
                license: metadata.license.clone(),
                figure_kind: figure_kind.to_string(),
                journal: String::new(),
                publication_year: None,
                impact_factor: None,
                jcr_quartile: None,
                cas_partition: None,
                is_top: None,
            });
        }
    }
    Ok(figures)
}

fn node_text(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|descendant| descendant.is_text())
        .filter_map(|descendant| descendant.text())
        .flat_map(str::split_whitespace)
        .collect::<Vec<_>>()
        .join(" ")
}

fn s3_object_url(key: &str) -> Result<String, String> {
    let mut url = Url::parse(PMC_S3_ORIGIN).map_err(|error| error.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "PMC S3 地址无效".to_string())?;
        segments.pop_if_empty();
        for segment in key.split('/').filter(|segment| !segment.is_empty()) {
            segments.push(segment);
        }
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_latest_pmc_article_version() {
        let xml = r#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CommonPrefixes><Prefix>PMC123.1/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>PMC123.3/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>PMC123.2/</Prefix></CommonPrefixes></ListBucketResult>"#;
        assert_eq!(
            parse_latest_version_prefix(xml, "PMC123").unwrap(),
            "PMC123.3/"
        );
    }

    #[test]
    fn extracts_graphical_abstract_and_regular_figures() {
        let payload: Value = serde_json::from_str(
            r#"{
              "pmcid":"PMC123",
              "title":"Cardiac repair",
              "license_code":"CC BY",
              "media_urls":[
                "s3://pmc-oa-opendata/PMC123.1/ga.jpg?md5=one",
                "s3://pmc-oa-opendata/PMC123.1/f1.png?md5=two"
                ,"s3://pmc-oa-opendata/PMC123.1/scheme.jpg?md5=three"
              ]
            }"#,
        )
        .unwrap();
        let metadata = parse_article_metadata(&payload).unwrap();
        let xml = r#"<article xmlns:xlink="http://www.w3.org/1999/xlink"><body>
          <fig id="ga" fig-type="graphical abstract"><label>Graphical Abstract</label><caption><p>Study overview.</p></caption><graphic xlink:href="ga.jpg"/></fig>
          <fig id="f1"><label>Figure 1</label><caption><p>Cell survival result.</p></caption><graphic xlink:href="f1.png"/></fig>
          <fig id="scheme" fig-type="scheme"><label>Scheme 1</label><caption><p>Schematic summary of the therapeutic effects.</p></caption><graphic xlink:href="scheme.jpg"/></fig>
        </body></article>"#;

        let figures = parse_article_figures(xml, &metadata).unwrap();
        assert_eq!(figures.len(), 3);
        assert_eq!(figures[0].figure_kind, "graphical_abstract");
        assert_eq!(figures[0].caption, "Study overview.");
        assert_eq!(figures[1].figure_kind, "figure");
        assert_eq!(figures[1].license, "CC BY");
        assert!(figures[1].image_url.ends_with("/PMC123.1/f1.png"));
        assert_eq!(figures[2].figure_kind, "graphical_abstract");
    }

    #[test]
    fn applies_metric_filters_before_fetching_figures() {
        let metric = journal_metrics_service::JournalMetric {
            journal: Some("Example Journal".to_string()),
            abbr: Some("Example J".to_string()),
            impact_factor: Some("12.5".to_string()),
            q: Some("Q1".to_string()),
            b: Some("B2".to_string()),
            top: Some("1".to_string()),
        };
        let matching = PmcGalleryMetricFilters {
            journal: None,
            impact_factor: Some("ge10".to_string()),
            jcr_quartile: Some("Q1".to_string()),
            cas_partition: Some("B2".to_string()),
            top: Some("top".to_string()),
        };
        assert!(matches_metric_filters(Some(&metric), &matching));

        let low_if = PmcGalleryMetricFilters {
            impact_factor: Some("ge20".to_string()),
            ..matching.clone()
        };
        assert!(!matches_metric_filters(Some(&metric), &low_if));

        let missing = PmcGalleryMetricFilters {
            journal: None,
            impact_factor: Some("na".to_string()),
            jcr_quartile: Some("na".to_string()),
            cas_partition: Some("na".to_string()),
            top: Some("na".to_string()),
        };
        assert!(matches_metric_filters(None, &missing));
        assert!(!matches_metric_filters(Some(&metric), &missing));
    }

    #[test]
    fn sorts_top_partition_if_and_year_before_fetching_figures() {
        let mut articles = vec![
            ArticleQuality {
                id: "low".to_string(),
                journal: "Low".to_string(),
                publication_year: Some(2026),
                impact_factor: Some("18.0".to_string()),
                jcr_quartile: Some("Q1".to_string()),
                cas_partition: Some("B1".to_string()),
                is_top: Some(false),
            },
            ArticleQuality {
                id: "top".to_string(),
                journal: "Top".to_string(),
                publication_year: Some(2024),
                impact_factor: Some("8.0".to_string()),
                jcr_quartile: Some("Q1".to_string()),
                cas_partition: Some("B1".to_string()),
                is_top: Some(true),
            },
            ArticleQuality {
                id: "q2".to_string(),
                journal: "Q2".to_string(),
                publication_year: Some(2026),
                impact_factor: Some("30.0".to_string()),
                jcr_quartile: Some("Q2".to_string()),
                cas_partition: Some("B2".to_string()),
                is_top: Some(false),
            },
        ];
        articles.sort_by(compare_article_quality);
        assert_eq!(
            articles
                .iter()
                .map(|article| article.id.as_str())
                .collect::<Vec<_>>(),
            vec!["top", "low", "q2"]
        );
    }

    #[test]
    fn matches_journal_name_or_abbreviation_before_fetching_figures() {
        let summary: Value = serde_json::from_str(
            r#"{"fulljournalname":"Journal of Cardiovascular Research","source":"J Cardiovasc Res"}"#,
        )
        .unwrap();
        let mut filters = PmcGalleryMetricFilters {
            journal: Some("cardiovascular research".to_string()),
            ..Default::default()
        };
        assert!(matches_journal_filter(Some(&summary), &filters));
        filters.journal = Some("J Cardiovasc Res".to_string());
        assert!(matches_journal_filter(Some(&summary), &filters));
        filters.journal = Some("Nature".to_string());
        assert!(!matches_journal_filter(Some(&summary), &filters));
    }

    #[tokio::test]
    #[ignore = "requires live NCBI and PMC Open Data access"]
    async fn searches_live_pmc_gallery() {
        let result = search_gallery(
            "myocardial infarction[Title/Abstract]",
            8,
            0,
            &PmcGalleryMetricFilters::default(),
        )
        .await
        .unwrap();
        assert!(result.scanned_articles > 0);
        assert!(!result.figures.is_empty());
        assert!(result.next_offset > 0);
        assert!(result.has_more);

        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .unwrap();
        let filters = PmcGalleryMetricFilters {
            journal: None,
            impact_factor: Some("all".to_string()),
            jcr_quartile: Some("Q2".to_string()),
            cas_partition: Some("B3".to_string()),
            top: Some("non-top".to_string()),
        };
        let (kept, filtered) =
            filter_ids_by_metrics(&client, vec!["4376775".to_string()], &filters)
                .await
                .unwrap();
        assert_eq!(
            kept.iter()
                .map(|article| article.id.as_str())
                .collect::<Vec<_>>(),
            vec!["4376775"]
        );
        assert_eq!(filtered, 0);
    }
}
