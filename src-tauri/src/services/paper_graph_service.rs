use crate::models::{PaperGraph, PaperGraphEdge, PaperGraphNode};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

const GRAPH_BASE_URL: &str = "https://api.semanticscholar.org/graph/v1";
const RECOMMENDATIONS_BASE_URL: &str = "https://api.semanticscholar.org/recommendations/v1";
const RELATED_LIMIT: usize = 8;
const PAPER_FIELDS: &str = "paperId,title,year,authors,citationCount,url,externalIds,abstract";

pub enum PaperLookup {
    PaperId(String),
    Entry {
        title: String,
        doi: Option<String>,
        pmid: Option<String>,
        pmcid: Option<String>,
    },
}

pub async fn fetch_paper_graph(lookup: PaperLookup) -> Result<PaperGraph, String> {
    let mut headers = HeaderMap::new();
    if let Ok(api_key) = std::env::var("SEMANTIC_SCHOLAR_API_KEY") {
        if let Ok(value) = HeaderValue::from_str(api_key.trim()) {
            if !value.is_empty() {
                headers.insert("x-api-key", value);
            }
        }
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("RSSReading/1.0 (https://github.com/liuenqian/RSS_reading)")
        .default_headers(headers)
        .build()
        .map_err(|e| format!("创建文献图谱客户端失败: {}", e))?;

    let seed_value = resolve_seed(&client, lookup).await?;
    let seed_node = parse_paper_node(&seed_value, "seed")
        .ok_or_else(|| "Semantic Scholar 未返回可识别的种子文献".to_string())?;
    let seed_id = seed_node.paper_id.clone();

    let references = fetch_relation(&client, &seed_id, "references", "citedPaper").await?;
    let citations = fetch_relation(&client, &seed_id, "citations", "citingPaper").await?;
    let recommendations = fetch_recommendations(&client, &seed_id)
        .await
        .unwrap_or_default();

    let mut nodes = HashMap::new();
    nodes.insert(seed_id.clone(), seed_node);
    let mut edges = Vec::new();

    for value in references {
        insert_related_node(&mut nodes, &value, "reference");
        if let Some(target) = paper_id(&value) {
            edges.push(PaperGraphEdge {
                source: seed_id.clone(),
                target,
                relation: "reference".to_string(),
            });
        }
    }
    for value in citations {
        insert_related_node(&mut nodes, &value, "citation");
        if let Some(source) = paper_id(&value) {
            edges.push(PaperGraphEdge {
                source,
                target: seed_id.clone(),
                relation: "citation".to_string(),
            });
        }
    }
    for value in recommendations {
        insert_related_node(&mut nodes, &value, "similar");
        if let Some(target) = paper_id(&value) {
            edges.push(PaperGraphEdge {
                source: seed_id.clone(),
                target,
                relation: "similar".to_string(),
            });
        }
    }

    edges.retain(|edge| edge.source != edge.target);
    edges.sort_by(|left, right| {
        (&left.relation, &left.source, &left.target).cmp(&(
            &right.relation,
            &right.source,
            &right.target,
        ))
    });
    edges.dedup();

    let mut nodes: Vec<_> = nodes.into_values().collect();
    nodes.sort_by(|left, right| {
        let left_seed = left.paper_id == seed_id;
        let right_seed = right.paper_id == seed_id;
        right_seed
            .cmp(&left_seed)
            .then_with(|| {
                left.year
                    .unwrap_or(i64::MAX)
                    .cmp(&right.year.unwrap_or(i64::MAX))
            })
            .then_with(|| right.citation_count.cmp(&left.citation_count))
    });

    Ok(PaperGraph {
        seed_id,
        nodes,
        edges,
    })
}

async fn resolve_seed(client: &Client, lookup: PaperLookup) -> Result<Value, String> {
    match lookup {
        PaperLookup::PaperId(paper_id) => fetch_paper(client, &paper_id).await,
        PaperLookup::Entry {
            title,
            doi,
            pmid,
            pmcid,
        } => {
            let identifier = doi
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!("DOI:{}", normalize_prefixed_id(&value, "doi:")))
                .or_else(|| {
                    pmid.filter(|value| !value.trim().is_empty())
                        .map(|value| format!("PMID:{}", normalize_prefixed_id(&value, "pmid:")))
                })
                .or_else(|| {
                    pmcid
                        .filter(|value| !value.trim().is_empty())
                        .map(|value| format!("PMCID:{}", normalize_prefixed_id(&value, "pmcid:")))
                });

            if let Some(identifier) = identifier {
                match fetch_paper(client, &identifier).await {
                    Ok(value) => return Ok(value),
                    Err(error) if !is_not_found_error(&error) => return Err(error),
                    Err(_) => {}
                }
            }
            search_paper_by_title(client, &title).await
        }
    }
}

async fn fetch_paper(client: &Client, paper_id: &str) -> Result<Value, String> {
    let url = format!("{}/paper/{}", GRAPH_BASE_URL, encode_path_segment(paper_id));
    request_json(client.get(url).query(&[("fields", PAPER_FIELDS)])).await
}

async fn search_paper_by_title(client: &Client, title: &str) -> Result<Value, String> {
    if title.trim().is_empty() {
        return Err("当前文献没有可用于图谱检索的标题或标识符".to_string());
    }
    let url = format!("{}/paper/search", GRAPH_BASE_URL);
    let body = request_json(client.get(url).query(&[
        ("query", title.trim()),
        ("limit", "5"),
        ("fields", PAPER_FIELDS),
    ]))
    .await?;
    let candidates = body["data"]
        .as_array()
        .ok_or_else(|| "Semantic Scholar 搜索结果格式异常".to_string())?;
    let normalized = normalize_title(title);
    candidates
        .iter()
        .find(|candidate| {
            normalize_title(candidate["title"].as_str().unwrap_or_default()) == normalized
        })
        .or_else(|| candidates.first())
        .cloned()
        .ok_or_else(|| "Semantic Scholar 未找到这篇文献".to_string())
}

async fn fetch_relation(
    client: &Client,
    seed_id: &str,
    endpoint: &str,
    paper_field: &str,
) -> Result<Vec<Value>, String> {
    let url = format!(
        "{}/paper/{}/{}",
        GRAPH_BASE_URL,
        encode_path_segment(seed_id),
        endpoint
    );
    let body = request_json(client.get(url).query(&[
        ("limit", RELATED_LIMIT.to_string()),
        ("fields", PAPER_FIELDS.to_string()),
    ]))
    .await?;
    Ok(body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get(paper_field).cloned())
        .filter(|item| paper_id(item).is_some())
        .collect())
}

async fn fetch_recommendations(client: &Client, seed_id: &str) -> Result<Vec<Value>, String> {
    let url = format!(
        "{}/papers/forpaper/{}",
        RECOMMENDATIONS_BASE_URL,
        encode_path_segment(seed_id)
    );
    let body = request_json(client.get(url).query(&[
        ("limit", RELATED_LIMIT.to_string()),
        ("fields", PAPER_FIELDS.to_string()),
    ]))
    .await?;
    Ok(body["recommendedPapers"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

async fn request_json(builder: reqwest::RequestBuilder) -> Result<Value, String> {
    let retry = builder.try_clone();
    let mut response = builder
        .send()
        .await
        .map_err(|e| format!("请求 Semantic Scholar 失败: {}", e))?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        if let Some(retry) = retry {
            let wait_seconds = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(2)
                .clamp(1, 4);
            tokio::time::sleep(Duration::from_secs(wait_seconds)).await;
            response = retry
                .send()
                .await
                .map_err(|e| format!("重试 Semantic Scholar 失败: {}", e))?;
        }
    }
    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        return Err("Semantic Scholar 未收录这篇文献".to_string());
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err("Semantic Scholar 请求过于频繁，请稍后重试".to_string());
    }
    if !status.is_success() {
        return Err(format!("Semantic Scholar 返回错误状态 {}", status));
    }
    response
        .json()
        .await
        .map_err(|e| format!("解析 Semantic Scholar 响应失败: {}", e))
}

fn insert_related_node(nodes: &mut HashMap<String, PaperGraphNode>, value: &Value, relation: &str) {
    let Some(mut node) = parse_paper_node(value, relation) else {
        return;
    };
    nodes
        .entry(node.paper_id.clone())
        .and_modify(|existing| {
            if !existing.relations.iter().any(|item| item == relation) {
                existing.relations.push(relation.to_string());
            }
        })
        .or_insert_with(|| {
            node.relations.sort();
            node
        });
}

fn parse_paper_node(value: &Value, relation: &str) -> Option<PaperGraphNode> {
    let paper_id = paper_id(value)?;
    let title = value["title"].as_str()?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let authors = value["authors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|author| author["name"].as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .take(8)
        .map(str::to_string)
        .collect();
    let external_ids = &value["externalIds"];
    Some(PaperGraphNode {
        paper_id,
        title,
        authors,
        year: value["year"].as_i64(),
        citation_count: value["citationCount"].as_i64().unwrap_or(0),
        url: value["url"].as_str().map(str::to_string),
        doi: external_ids["DOI"].as_str().map(str::to_string),
        pmid: external_ids["PubMed"].as_str().map(str::to_string),
        abstract_text: value["abstract"].as_str().map(str::to_string),
        relations: vec![relation.to_string()],
    })
}

fn paper_id(value: &Value) -> Option<String> {
    value["paperId"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_prefixed_id<'a>(value: &'a str, prefix: &str) -> &'a str {
    let trimmed = value.trim();
    if trimmed.len() >= prefix.len() && trimmed[..prefix.len()].eq_ignore_ascii_case(prefix) {
        trimmed[prefix.len()..].trim()
    } else {
        trimmed
    }
}

fn normalize_title(value: &str) -> String {
    value
        .chars()
        .filter(|char| char.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_not_found_error(error: &str) -> bool {
    error.contains("未收录")
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_semantic_scholar_paper() {
        let value = serde_json::json!({
            "paperId": "paper-1",
            "title": "A useful paper",
            "year": 2024,
            "citationCount": 12,
            "authors": [{"name": "A. Author"}, {"name": "B. Author"}],
            "externalIds": {"DOI": "10.1/example", "PubMed": "123"},
            "url": "https://www.semanticscholar.org/paper/paper-1",
            "abstract": "Abstract"
        });
        let node = parse_paper_node(&value, "seed").expect("paper should parse");
        assert_eq!(node.paper_id, "paper-1");
        assert_eq!(node.authors, vec!["A. Author", "B. Author"]);
        assert_eq!(node.doi.as_deref(), Some("10.1/example"));
        assert_eq!(node.relations, vec!["seed"]);
    }

    #[test]
    fn encodes_semantic_scholar_lookup_id_as_one_segment() {
        assert_eq!(
            encode_path_segment("DOI:10.1000/example value"),
            "DOI%3A10.1000%2Fexample%20value"
        );
    }

    #[test]
    fn normalizes_title_for_exact_candidate_matching() {
        assert_eq!(
            normalize_title("Paper: A Study"),
            normalize_title("paper a-study")
        );
    }
}
