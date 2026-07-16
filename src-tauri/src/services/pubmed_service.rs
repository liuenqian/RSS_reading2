// PubMed RSS feed URL builder
//
// PubMed does NOT allow predicting the RSS token client-side — each feed
// gets a server-issued opaque token. The "Create RSS" button on the PubMed
// search page POSTs to `/create-rss-feed-url/` to obtain it.
//
// Flow (mirrors what the PubMed UI does):
//   1. GET `https://pubmed.ncbi.nlm.nih.gov/?term=<query>` → receive
//      csrfmiddlewaretoken (hidden form input) + session cookies.
//   2. POST `https://pubmed.ncbi.nlm.nih.gov/create-rss-feed-url/` with
//      form fields `csrfmiddlewaretoken`, `name`, `limit`, `term`, header
//      `X-CSRFToken`, and the session cookies → receive JSON
//      `{"rss_feed_url": "https://pubmed.ncbi.nlm.nih.gov/rss/search/<token>/?…"}`.

use crate::models::{DeepSeekSettings, TokenUsage};
use crate::services::translate_service;
use reqwest::Client;
use serde::Deserialize;

const PUBMED_BASE: &str = "https://pubmed.ncbi.nlm.nih.gov";
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) RSSReading/0.1";
const ALLOWED_PUBMED_RSS_LIMITS: &[u32] = &[5, 10, 15, 20, 50, 100];

// Per-call client (cookie store must be fresh for each request so we
// don't leak PubMed sessions between unrelated calls).
fn build_client() -> Result<Client, String> {
    Client::builder()
        .cookie_store(true)
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))
}

#[derive(Deserialize)]
struct CreateRssResponse {
    rss_feed_url: Option<String>,
}

/// Build a real PubMed RSS feed URL by asking PubMed's own create-rss
/// endpoint to issue a token. Returns the full feed URL on success.
pub async fn build_rss_url(query: &str, limit: u32) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("检索式不能为空".to_string());
    }
    let limit = normalize_pubmed_rss_limit(limit);

    let client = build_client()?;
    let search_url = format!(
        "{}/?term={}",
        PUBMED_BASE,
        urlencoding::encode_pubmed(query)
    );

    // Step 1: GET search page to obtain CSRF token + session cookies.
    let html = client
        .get(&search_url)
        .send()
        .await
        .map_err(|e| format!("PubMed 搜索页请求失败: {}", e))?
        .error_for_status()
        .map_err(|e| format!("PubMed 搜索页返回错误: {}", e))?
        .text()
        .await
        .map_err(|e| format!("读取搜索页内容失败: {}", e))?;

    let csrf = extract_csrf(&html).ok_or_else(|| {
        "未能从 PubMed 页面提取 CSRF token（PubMed 可能改版了，请反馈）".to_string()
    })?;

    // Step 2: POST to /create-rss-feed-url/ — let the same client carry
    // the cookies from step 1.
    let feed_name = derive_feed_name(query);
    let post_url = format!("{}/create-rss-feed-url/", PUBMED_BASE);
    let form = [
        ("csrfmiddlewaretoken", csrf.as_str()),
        ("name", feed_name.as_str()),
        ("limit", &limit.to_string()),
        ("term", query),
    ];

    let resp = client
        .post(&post_url)
        .header("Referer", &search_url)
        .header("X-CSRFToken", &csrf)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("PubMed RSS 生成请求失败: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 PubMed 响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "PubMed 返回 {}：{}",
            status.as_u16(),
            body.chars().take(200).collect::<String>()
        ));
    }

    let parsed: CreateRssResponse = serde_json::from_str(&body)
        .map_err(|e| format!("PubMed 响应不是 JSON: {} — {}", e, body))?;

    let rss_url = parsed
        .rss_feed_url
        .ok_or_else(|| "PubMed 响应缺少 rss_feed_url 字段".to_string())?;

    enforce_limit_param(&rss_url, limit)
}

fn normalize_pubmed_rss_limit(limit: u32) -> u32 {
    if ALLOWED_PUBMED_RSS_LIMITS.contains(&limit) {
        return limit;
    }
    ALLOWED_PUBMED_RSS_LIMITS
        .iter()
        .copied()
        .min_by_key(|candidate| candidate.abs_diff(limit))
        .unwrap_or(15)
}

fn enforce_limit_param(url: &str, limit: u32) -> Result<String, String> {
    let mut parsed =
        reqwest::Url::parse(url).map_err(|e| format!("PubMed RSS 链接格式异常: {}", e))?;
    let mut pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let limit_value = limit.to_string();
    let mut replaced = false;
    for (key, value) in &mut pairs {
        if key == "limit" {
            *value = limit_value.clone();
            replaced = true;
        }
    }
    if !replaced {
        pairs.push(("limit".to_string(), limit_value));
    }

    parsed
        .query_pairs_mut()
        .clear()
        .extend_pairs(pairs.iter().map(|(k, v)| (&**k, &**v)));
    Ok(parsed.into())
}

// ── Natural language → PubMed query ────────────

// Generous ceiling. PubMed queries are short, but the model may emit a few
// tokens of internal reasoning before the final string, and complex requests
// (5+ journals OR'd together, multiple MeSH groups, date filters) can easily
// push the actual query past 500 tokens. 1500 leaves a safety margin without
// being wasteful.
const NL_QUERY_MAX_TOKENS: u32 = 1500;

const AUTHOR_QUERY_PROMPT: &str = "\
You are a PubMed author-search expert. Convert the supplied author identity and optional \
affiliation, which may be written in Chinese or English natural language, into a valid \
PubMed advanced-search query.

Rules:
- Treat the author input as a person identity, never as a biomedical topic.
- Translate natural-language descriptions and Chinese affiliation names into useful English PubMed terms.
- For a Chinese personal name, use reasonable romanized author-name variants and group alternatives with OR when name order or initials may vary.
- Every author-name alternative must use [Author].
- If an affiliation is supplied, add a focused affiliation clause using [Affiliation] or [Affiliation:~50]. Translate the institution name, but do not invent a different institution.
- Do not add topic, journal, publication-type, or date filters that the user did not supply.
- Do not add a date clause; the application appends the exact selected dates separately.
- Use uppercase AND/OR/NOT and parentheses for grouped alternatives.

Output only one valid PubMed query string. No markdown, explanation, or surrounding code fence.";

#[cfg(test)]
fn build_author_query(
    author_name: &str,
    affiliation: Option<&str>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<String, String> {
    let author_name = normalize_author_query_value(author_name, "作者姓名")?;
    let mut clauses = vec![format!("{}[Author]", escape_pubmed_phrase(&author_name))];

    if let Some(affiliation) = normalize_optional_query_value(affiliation, "机构")? {
        clauses.push(format!(
            "\"{}\"[Affiliation:~50]",
            escape_pubmed_phrase(&affiliation)
        ));
    }

    let start_date = normalize_optional_date(start_date, "起始日期")?;
    let end_date = normalize_optional_date(end_date, "结束日期")?;
    if start_date.is_some() || end_date.is_some() {
        let start = start_date.as_deref().unwrap_or("1000/01/01");
        let end = end_date.as_deref().unwrap_or("3000/12/31");
        if start > end {
            return Err("起始日期不能晚于结束日期".to_string());
        }
        clauses.push(format!("{}:{}[Date - Publication]", start, end));
    }

    Ok(clauses.join(" AND "))
}

fn build_author_ai_request(author_name: &str, affiliation: Option<&str>) -> Result<String, String> {
    let author_name = normalize_author_query_value(author_name, "作者姓名或描述")?;
    let affiliation = normalize_optional_query_value(affiliation, "机构描述")?;
    Ok(format!(
        "作者姓名或自然语言描述：{}\n机构描述：{}",
        author_name,
        affiliation.as_deref().unwrap_or("未提供")
    ))
}

fn build_author_date_clause(
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<Option<String>, String> {
    let start_date = normalize_optional_date(start_date, "起始日期")?;
    let end_date = normalize_optional_date(end_date, "结束日期")?;
    if start_date.is_none() && end_date.is_none() {
        return Ok(None);
    }

    let start = start_date.as_deref().unwrap_or("1000/01/01");
    let end = end_date.as_deref().unwrap_or("3000/12/31");
    if start > end {
        return Err("起始日期不能晚于结束日期".to_string());
    }
    Ok(Some(format!("{}:{}[Date - Publication]", start, end)))
}

pub async fn natural_language_to_author_query(
    settings: &DeepSeekSettings,
    author_name: &str,
    affiliation: Option<&str>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<(String, TokenUsage), String> {
    let request = build_author_ai_request(author_name, affiliation)?;
    let date_clause = build_author_date_clause(start_date, end_date)?;
    let output = translate_service::complete_with_prompts(
        settings,
        AUTHOR_QUERY_PROMPT,
        &request,
        0.1,
        i64::from(NL_QUERY_MAX_TOKENS),
    )
    .await?;

    let author_query = validate_query_syntax(&output.content)
        .map_err(|error| format!("AI 生成的作者检索式不完整：{}。请重新生成", error))?;
    let query = match date_clause {
        Some(date_clause) => format!("({}) AND {}", author_query, date_clause),
        None => author_query,
    };
    let query = validate_query_syntax(&query)?;
    Ok((query, output.usage))
}

fn normalize_author_query_value(value: &str, label: &str) -> Result<String, String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return Err(format!("{}不能为空", label));
    }
    if value.chars().count() > 200 {
        return Err(format!("{}过长", label));
    }
    Ok(value)
}

fn normalize_optional_query_value(
    value: Option<&str>,
    label: &str,
) -> Result<Option<String>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| normalize_author_query_value(value, label))
        .transpose()
}

fn normalize_optional_date(value: Option<&str>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let parts = value.split('-').collect::<Vec<_>>();
    let year = parts.first().and_then(|part| part.parse::<u32>().ok());
    let month = parts.get(1).and_then(|part| part.parse::<u32>().ok());
    let day = parts.get(2).and_then(|part| part.parse::<u32>().ok());
    let valid = parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts
            .iter()
            .all(|part| part.chars().all(|c| c.is_ascii_digit()))
        && month.is_some_and(|month| (1..=12).contains(&month))
        && day.is_some_and(|day| {
            let month = month.unwrap_or_default();
            let year = year.unwrap_or_default();
            let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            let days_in_month = match month {
                2 if leap_year => 29,
                2 => 28,
                4 | 6 | 9 | 11 => 30,
                _ => 31,
            };
            (1..=days_in_month).contains(&day)
        });
    if !valid {
        return Err(format!("{}格式无效", label));
    }
    Ok(Some(parts.join("/")))
}

#[cfg(test)]
fn escape_pubmed_phrase(value: &str) -> String {
    value.replace('"', "")
}

const NL_TO_PUBMED_PROMPT: &str = "\
You are a PubMed search expert. Convert a researcher's natural-language request \
(which may be a single complete sentence in Chinese or English, not just keywords) \
into a valid PubMed advanced-search query string.

Understand intent before translating:
- Identify the core topic(s), target journal(s), publication type(s), and time window from the sentence as a whole.
- Map informal Chinese terms to their standard English biomedical vocabulary (e.g. 巨噬细胞 → macrophage, 铁死亡 → ferroptosis, 肿瘤微环境 → tumor microenvironment, 单细胞测序 → single-cell sequencing).
- Map journal aliases to PubMed-recognized titles: Nature/自然 → Nature; Science/科学 → Science; Cell/细胞 → Cell; NEJM → \"N Engl J Med\"; Lancet/柳叶刀 → Lancet; JAMA → JAMA; Nat Med → \"Nat Med\"; etc. Group multiple journals with OR inside parentheses.
- Interpret time hints: 最新/近期/recent → \"last 1 years\"[dp]; 近 N 年 → \"last N years\"[dp]; 近 N 天 → \"last N days\"[dp]. If a time hint is implied but not explicit (e.g. 最新), default to \"last 2 years\"[dp].

Syntax rules:
- Field tags: [Title], [Title/Abstract], [Author], [Journal], [Publication Type], [MeSH Terms], [dp]
- Booleans uppercase: AND, OR, NOT
- Parentheses for grouping; quotes around multi-word phrases and journal abbreviations.
- Topic terms default to [Title/Abstract] when no field is given, with [MeSH Terms] OR'd in for well-known concepts.
- Clinical trials: \"clinical trial\"[Publication Type] OR \"randomized controlled trial\"[Publication Type]
- Reviews: \"review\"[Publication Type] OR \"systematic review\"[Publication Type] OR \"meta-analysis\"[Publication Type]
- Journal filter form: (\"Nature\"[Journal] OR \"Science\"[Journal] OR \"Cell\"[Journal])

Example:
Input: 帮我检索发表在 nature、science、cell 上的关于巨噬细胞以及铁死亡相关的最新的文章
Output: (\"Nature\"[Journal] OR \"Science\"[Journal] OR \"Cell\"[Journal]) AND ((macrophage[Title/Abstract] OR macrophages[MeSH Terms]) AND (ferroptosis[Title/Abstract] OR ferroptosis[MeSH Terms])) AND \"last 2 years\"[dp]

Output format:
- Return ONLY the PubMed query string on a single line. No markdown, no explanation, no surrounding quotes.
- If the request is ambiguous, make your best guess and still return a query.";

pub async fn natural_language_to_query(
    settings: &DeepSeekSettings,
    text: &str,
) -> Result<(String, TokenUsage), String> {
    let output = translate_service::complete_with_prompts(
        settings,
        NL_TO_PUBMED_PROMPT,
        text,
        0.1,
        i64::from(NL_QUERY_MAX_TOKENS),
    )
    .await?;
    Ok((output.content, output.usage))
}

pub fn validate_query_syntax(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("PubMed 检索式不能为空".to_string());
    }
    if query.chars().count() > 8_000 {
        return Err("PubMed 检索式过长".to_string());
    }

    let mut in_quote = false;
    let mut escaped = false;
    let mut parentheses = 0_i32;
    let mut brackets = 0_i32;

    for ch in query.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_quote = !in_quote;
            continue;
        }
        if in_quote {
            continue;
        }
        match ch {
            '(' => parentheses += 1,
            ')' => {
                parentheses -= 1;
                if parentheses < 0 {
                    return Err("PubMed 检索式存在未配对的右括号".to_string());
                }
            }
            '[' => brackets += 1,
            ']' => {
                brackets -= 1;
                if brackets < 0 {
                    return Err("PubMed 检索式存在未配对的右方括号".to_string());
                }
            }
            _ => {}
        }
    }

    if in_quote {
        return Err("PubMed 检索式存在未闭合的引号".to_string());
    }
    if parentheses != 0 {
        return Err("PubMed 检索式存在未闭合的圆括号".to_string());
    }
    if brackets != 0 {
        return Err("PubMed 检索式存在未闭合的字段标签，例如 [MeSH Terms]".to_string());
    }
    if query
        .split_whitespace()
        .last()
        .is_some_and(|word| matches!(word.to_ascii_uppercase().as_str(), "AND" | "OR" | "NOT"))
    {
        return Err("PubMed 检索式不能以 AND、OR 或 NOT 结尾".to_string());
    }

    Ok(query.to_string())
}

/// Extract the `csrfmiddlewaretoken` hidden input value from PubMed's HTML.
fn extract_csrf(html: &str) -> Option<String> {
    // Looks like: name="csrfmiddlewaretoken" value="XXX"
    let needle = "name=\"csrfmiddlewaretoken\"";
    let idx = html.find(needle)?;
    let tail = &html[idx..];
    let value_start = tail.find("value=\"")? + "value=\"".len();
    let after_value = &tail[value_start..];
    let value_end = after_value.find('"')?;
    Some(after_value[..value_end].to_string())
}

/// Derive a feed name from the query when the user didn't supply one.
/// PubMed limits the name to 200 chars and disallows `" & = < > /`.
fn derive_feed_name(query: &str) -> String {
    let cleaned: String = query
        .chars()
        .map(|c| match c {
            '"' | '&' | '=' | '<' | '>' | '/' => ' ',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.len() > 200 {
        trimmed.chars().take(200).collect()
    } else {
        trimmed.to_string()
    }
}

// Minimal URL-encoding helper — we don't pull a new crate for this.
mod urlencoding {
    pub fn encode_pubmed(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char);
                }
                b' ' => out.push('+'),
                _ => out.push_str(&format!("%{:02X}", b)),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_author_ai_request, build_author_date_clause, build_author_query,
        validate_query_syntax,
    };

    #[test]
    fn builds_author_query_without_optional_filters() {
        assert_eq!(
            build_author_query("  Jia   Guo ", None, None, None).unwrap(),
            "Jia Guo[Author]"
        );
    }

    #[test]
    fn builds_author_query_with_affiliation_and_open_end_date() {
        assert_eq!(
            build_author_query(
                "Guo Jia",
                Some("Peking University First Hospital"),
                Some("2020-01-01"),
                None,
            )
            .unwrap(),
            "Guo Jia[Author] AND \"Peking University First Hospital\"[Affiliation:~50] AND 2020/01/01:3000/12/31[Date - Publication]"
        );
    }

    #[test]
    fn builds_author_query_with_closed_date_range() {
        assert_eq!(
            build_author_query("Smith JA", Some("  "), None, Some("2025-12-31")).unwrap(),
            "Smith JA[Author] AND 1000/01/01:2025/12/31[Date - Publication]"
        );
    }

    #[test]
    fn rejects_invalid_author_and_dates() {
        assert!(build_author_query(" ", None, None, None).is_err());
        assert!(build_author_query("Smith JA", None, Some("2025-02-29"), None).is_err());
        assert!(
            build_author_query("Smith JA", None, Some("2025-01-02"), Some("2025-01-01"),).is_err()
        );
    }

    #[test]
    fn accepts_chinese_natural_language_author_requests() {
        let request = build_author_ai_request(
            "北京安贞医院的梁瑞政医生",
            Some("首都医科大学附属北京安贞医院"),
        )
        .unwrap();
        assert!(request.contains("梁瑞政"));
        assert!(request.contains("首都医科大学附属北京安贞医院"));
        assert_eq!(
            build_author_date_clause(Some("2020-01-02"), Some("2025-12-31")).unwrap(),
            Some("2020/01/02:2025/12/31[Date - Publication]".to_string())
        );
    }

    #[test]
    fn rejects_truncated_pubmed_queries() {
        let valid =
            r#"("ischemic cardiomyopathy"[Title/Abstract]) AND "Single-Cell Analysis"[MeSH Terms]"#;
        assert_eq!(validate_query_syntax(valid).unwrap(), valid);

        for invalid in [
            r#""Single-Cell Analysis"[Me"#,
            r#"("ischemic cardiomyopathy"[Title/Abstract]"#,
            r#""ischemic cardiomyopathy[Title/Abstract]"#,
            "ischemic cardiomyopathy AND",
        ] {
            assert!(
                validate_query_syntax(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }
}
