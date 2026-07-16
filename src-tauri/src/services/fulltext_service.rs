use reqwest::header::{ACCEPT, CONTENT_TYPE, RANGE};
use reqwest::{Client, Url};
use serde_json::Value;
use std::time::Duration;
use tracing::warn;

const EUROPE_PMC_SEARCH_URL: &str = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const OPENALEX_WORKS_URL: &str = "https://api.openalex.org/works";
const SEMANTIC_SCHOLAR_PAPER_URL: &str = "https://api.semanticscholar.org/graph/v1/paper";
const UNPAYWALL_API_URL: &str = "https://api.unpaywall.org/v2";
const UNPAYWALL_CONTACT_EMAIL: &str = "itsdrchen@users.noreply.github.com";
const SCI_HUB_BASE_URL: &str = "https://www.sci-hub.st/";
const SCI_HUB_LAST_RELIABLE_PUBLICATION_YEAR: i32 = 2020;

pub async fn resolve_pdf_url(
    title: &str,
    doi: Option<&str>,
    pmid: Option<&str>,
    pmcid: Option<&str>,
    publication_year: Option<i32>,
) -> Result<Option<String>, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("RSSReading/1.0 (academic PDF resolver)")
        .build()
        .map_err(|e| format!("创建全文解析客户端失败: {}", e))?;

    if let Some(doi) = doi.filter(|value| !value.trim().is_empty()) {
        match resolve_unpaywall_pdf(&client, doi).await {
            Ok(Some(url)) => {
                if let Some(url) = verify_pdf_candidate(&client, url).await {
                    return Ok(Some(url));
                }
            }
            Ok(None) => {}
            Err(error) => warn!(%error, "Unpaywall 全文解析失败"),
        }
    }

    if let Some(url) = pmcid.and_then(europe_pmc_pdf_url) {
        if let Some(url) = verify_pdf_candidate(&client, url).await {
            return Ok(Some(url));
        }
    }

    match resolve_europe_pmc_pmcid(&client, doi, pmid).await {
        Ok(Some(value)) => {
            if let Some(url) = europe_pmc_pdf_url(&value) {
                if let Some(url) = verify_pdf_candidate(&client, url).await {
                    return Ok(Some(url));
                }
            }
        }
        Ok(None) => {}
        Err(error) => warn!(%error, "Europe PMC 全文解析失败"),
    }

    match resolve_openalex_pdf(&client, doi, title).await {
        Ok(Some(url)) => {
            if let Some(url) = verify_pdf_candidate(&client, url).await {
                return Ok(Some(url));
            }
        }
        Ok(None) => {}
        Err(error) => warn!(%error, "OpenAlex 全文解析失败"),
    }

    if let Some(doi) = doi.filter(|value| !value.trim().is_empty()) {
        match resolve_semantic_scholar_pdf(&client, doi).await {
            Ok(Some(url)) => {
                if let Some(url) = verify_pdf_candidate(&client, url).await {
                    return Ok(Some(url));
                }
            }
            Ok(None) => {}
            Err(error) => warn!(%error, "Semantic Scholar 全文解析失败"),
        }
    }

    let allow_sci_hub = publication_year
        .map(|year| year <= SCI_HUB_LAST_RELIABLE_PUBLICATION_YEAR)
        .unwrap_or(true);
    if allow_sci_hub {
        match resolve_sci_hub_pdf(&client, doi, pmid).await {
            Ok(Some(url)) => {
                if let Some(url) = verify_pdf_candidate(&client, url).await {
                    return Ok(Some(url));
                }
            }
            Ok(None) => {}
            Err(error) => warn!(%error, "Sci-Hub PDF 解析失败"),
        }
    }

    Ok(None)
}

async fn verify_pdf_candidate(client: &Client, url: String) -> Option<String> {
    let mut response = match client
        .get(&url)
        .header(ACCEPT, "application/pdf")
        .header(RANGE, "bytes=0-1023")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            warn!(status = %response.status(), %url, "PDF 候选地址不可访问");
            return None;
        }
        Err(error) => {
            warn!(%error, %url, "PDF 候选地址验证失败");
            return None;
        }
    };

    let content_type_is_pdf = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("application/pdf"));
    if content_type_is_pdf {
        return Some(url);
    }

    match response.chunk().await {
        Ok(Some(chunk)) if contains_pdf_signature(&chunk) => Some(url),
        Ok(_) => {
            warn!(%url, "候选地址未返回 PDF 内容");
            None
        }
        Err(error) => {
            warn!(%error, %url, "读取 PDF 候选响应失败");
            None
        }
    }
}

fn contains_pdf_signature(bytes: &[u8]) -> bool {
    bytes.windows(5).take(1024).any(|window| window == b"%PDF-")
}

fn europe_pmc_pdf_url(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_uppercase();
    let raw_digits = normalized.strip_prefix("PMC").unwrap_or(&normalized);
    let digits: String = raw_digits
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    (!digits.is_empty()).then(|| format!("https://europepmc.org/articles/PMC{}?pdf=render", digits))
}

async fn resolve_unpaywall_pdf(client: &Client, doi: &str) -> Result<Option<String>, String> {
    let mut url = Url::parse(&format!("{}/", UNPAYWALL_API_URL))
        .map_err(|e| format!("Unpaywall URL 无效: {}", e))?;
    url.path_segments_mut()
        .map_err(|_| "Unpaywall URL 无法写入".to_string())?
        .push(doi.trim());
    url.query_pairs_mut()
        .append_pair("email", UNPAYWALL_CONTACT_EMAIL);
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Unpaywall 请求失败: {}", e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析 Unpaywall 响应失败: {}", e))?;
    Ok(parse_unpaywall_pdf(&body))
}

fn parse_unpaywall_pdf(body: &Value) -> Option<String> {
    let mut locations = Vec::new();
    locations.push(body.get("best_oa_location"));
    locations.push(body.get("first_oa_location"));
    if let Some(items) = body.get("oa_locations").and_then(Value::as_array) {
        locations.extend(items.iter().map(Some));
    }
    locations.into_iter().flatten().find_map(|location| {
        location
            .get("url_for_pdf")
            .and_then(Value::as_str)
            .and_then(valid_http_url)
    })
}

async fn resolve_europe_pmc_pmcid(
    client: &Client,
    doi: Option<&str>,
    pmid: Option<&str>,
) -> Result<Option<String>, String> {
    let query = if let Some(value) = pmid.filter(|value| !value.trim().is_empty()) {
        format!("EXT_ID:{} AND SRC:MED", value.trim())
    } else if let Some(value) = doi.filter(|value| !value.trim().is_empty()) {
        format!("DOI:\"{}\"", value.trim())
    } else {
        return Ok(None);
    };

    let response = client
        .get(EUROPE_PMC_SEARCH_URL)
        .query(&[
            ("query", query.as_str()),
            ("format", "json"),
            ("pageSize", "3"),
        ])
        .send()
        .await
        .map_err(|e| format!("Europe PMC 请求失败: {}", e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析 Europe PMC 响应失败: {}", e))?;
    Ok(body
        .pointer("/resultList/result")
        .and_then(Value::as_array)
        .and_then(|results| {
            results.iter().find_map(|result| {
                result
                    .get("pmcid")
                    .and_then(Value::as_str)
                    .filter(|value| europe_pmc_pdf_url(value).is_some())
                    .map(ToOwned::to_owned)
            })
        }))
}

async fn resolve_openalex_pdf(
    client: &Client,
    doi: Option<&str>,
    title: &str,
) -> Result<Option<String>, String> {
    if let Some(doi) = doi.filter(|value| !value.trim().is_empty()) {
        let url = format!("{}/https://doi.org/{}", OPENALEX_WORKS_URL, doi.trim());
        if let Some(body) = fetch_json(client, &url).await? {
            if let Some(pdf_url) = parse_openalex_pdf(&body) {
                return Ok(Some(pdf_url));
            }
        }
    }

    if title.trim().is_empty() {
        return Ok(None);
    }
    let response = client
        .get(OPENALEX_WORKS_URL)
        .query(&[("search", title.trim()), ("per-page", "5")])
        .send()
        .await
        .map_err(|e| format!("OpenAlex 标题检索失败: {}", e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析 OpenAlex 标题检索响应失败: {}", e))?;
    Ok(body
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| {
            results.iter().find_map(|work| {
                let candidate_title = work.get("title").and_then(Value::as_str)?;
                titles_match(candidate_title, title)
                    .then(|| parse_openalex_pdf(work))
                    .flatten()
            })
        }))
}

fn parse_openalex_pdf(body: &Value) -> Option<String> {
    let mut locations = Vec::new();
    locations.push(body.get("best_oa_location"));
    locations.push(body.get("primary_location"));
    if let Some(items) = body.get("locations").and_then(Value::as_array) {
        locations.extend(items.iter().map(Some));
    }
    locations.into_iter().flatten().find_map(|location| {
        location
            .get("pdf_url")
            .and_then(Value::as_str)
            .and_then(valid_http_url)
    })
}

async fn resolve_semantic_scholar_pdf(
    client: &Client,
    doi: &str,
) -> Result<Option<String>, String> {
    let mut url = Url::parse(&format!("{}/", SEMANTIC_SCHOLAR_PAPER_URL))
        .map_err(|e| format!("Semantic Scholar URL 无效: {}", e))?;
    url.path_segments_mut()
        .map_err(|_| "Semantic Scholar URL 无法写入".to_string())?
        .push(&format!("DOI:{}", doi.trim()));
    url.query_pairs_mut().append_pair("fields", "openAccessPdf");
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Semantic Scholar 请求失败: {}", e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析 Semantic Scholar 响应失败: {}", e))?;
    Ok(body
        .pointer("/openAccessPdf/url")
        .and_then(Value::as_str)
        .and_then(valid_http_url))
}

async fn resolve_sci_hub_pdf(
    client: &Client,
    doi: Option<&str>,
    pmid: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(pmid) = pmid.filter(|value| !value.trim().is_empty()) {
        let response = client
            .post(SCI_HUB_BASE_URL)
            .json(&serde_json::json!({
                "sci-hub-plugin-check": true,
                "request": pmid.trim()
            }))
            .send()
            .await
            .map_err(|e| format!("Sci-Hub PMID 请求失败: {}", e))?;
        if response.status().is_success() {
            let body = response
                .text()
                .await
                .map_err(|e| format!("读取 Sci-Hub PMID 响应失败: {}", e))?;
            if let Some(url) = parse_sci_hub_pdf(&body, SCI_HUB_BASE_URL) {
                return Ok(Some(url));
            }
        }
    }

    let Some(doi) = doi.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let page_url = format!("{}{}", SCI_HUB_BASE_URL, doi.trim());
    let response = client
        .get(page_url)
        .send()
        .await
        .map_err(|e| format!("Sci-Hub DOI 请求失败: {}", e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 Sci-Hub DOI 响应失败: {}", e))?;
    Ok(parse_sci_hub_pdf(&body, SCI_HUB_BASE_URL))
}

fn parse_sci_hub_pdf(html: &str, base_url: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(relative_start) = lower[offset..].find("<embed") {
        let start = offset + relative_start;
        let end = lower[start..].find('>').map(|index| start + index)?;
        let tag = &html[start..=end];
        let tag_lower = &lower[start..=end];
        offset = end + 1;
        if !tag_lower.contains("application/pdf") && !tag_lower.contains("id=\"pdf\"") {
            continue;
        }
        let source_start = tag_lower.find("src=\"")? + "src=\"".len();
        let source_end = tag_lower[source_start..].find('"')? + source_start;
        let raw_url = tag[source_start..source_end].trim();
        if raw_url.is_empty() {
            continue;
        }
        let absolute = if raw_url.starts_with("//") {
            format!("https:{}", raw_url)
        } else {
            Url::parse(base_url).ok()?.join(raw_url).ok()?.to_string()
        };
        let mut url = Url::parse(&absolute).ok()?;
        url.set_fragment(None);
        return valid_http_url(url.as_str());
    }
    None
}

async fn fetch_json(client: &Client, url: &str) -> Result<Option<Value>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("开放全文请求失败: {}", e))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    response
        .json()
        .await
        .map(Some)
        .map_err(|e| format!("解析开放全文响应失败: {}", e))
}

fn valid_http_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

fn titles_match(left: &str, right: &str) -> bool {
    normalize_title(left) == normalize_title(right)
}

fn normalize_title(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_europe_pmc_pdf_url() {
        assert_eq!(
            europe_pmc_pdf_url("PMC12345").as_deref(),
            Some("https://europepmc.org/articles/PMC12345?pdf=render")
        );
        assert_eq!(europe_pmc_pdf_url("missing"), None);
    }

    #[test]
    fn selects_first_valid_openalex_pdf() {
        let body = json!({
            "best_oa_location": {"pdf_url": null},
            "primary_location": {"pdf_url": "https://example.test/paper.pdf"},
            "locations": [{"pdf_url": "javascript:alert(1)"}]
        });
        assert_eq!(
            parse_openalex_pdf(&body).as_deref(),
            Some("https://example.test/paper.pdf")
        );
    }

    #[test]
    fn selects_first_valid_unpaywall_pdf() {
        let body = json!({
            "best_oa_location": {"url_for_pdf": "https://example.test/open.pdf"},
            "first_oa_location": {"url_for_pdf": "https://example.test/other.pdf"}
        });
        assert_eq!(
            parse_unpaywall_pdf(&body).as_deref(),
            Some("https://example.test/open.pdf")
        );
    }

    #[test]
    fn parses_sci_hub_embed_pdf() {
        let html = r#"<embed type="application/pdf" src="//cdn.example.test/paper.pdf#view=FitH" id="pdf">"#;
        assert_eq!(
            parse_sci_hub_pdf(html, SCI_HUB_BASE_URL).as_deref(),
            Some("https://cdn.example.test/paper.pdf")
        );
    }

    #[test]
    fn compares_titles_without_whitespace_or_case_noise() {
        assert!(titles_match("A  Useful Paper", "a useful paper"));
        assert!(!titles_match("A Useful Paper", "Another Paper"));
    }

    #[test]
    fn recognizes_pdf_signature_near_start() {
        assert!(contains_pdf_signature(b"\n%PDF-1.7\n"));
        assert!(!contains_pdf_signature(b"<html>login</html>"));
    }
}
