use crate::models::{DeepSeekBalance, DeepSeekSettings, TokenUsage};
use reqwest::StatusCode;
use serde_json::Value;

/// Output of a single translation call: the translated text plus the token
/// usage reported by DeepSeek. The usage feeds the cost meter; callers that
/// don't care about cost can simply destructure and discard the second field.
pub struct TranslationOutput {
    pub content: String,
    pub usage: TokenUsage,
}

fn parse_usage(v: &Value) -> TokenUsage {
    let usage = &v["usage"];
    // DeepSeek's V3+ usage reports cache hit/miss separately. Older or
    // OpenAI-compatible deployments may only return prompt_tokens — we treat
    // those as 100% cache-miss (the conservative billing assumption).
    let hit = usage["prompt_cache_hit_tokens"].as_i64();
    let miss = usage["prompt_cache_miss_tokens"].as_i64();
    let (hit, miss) = match (hit, miss) {
        (Some(h), Some(m)) => (h, m),
        _ => (0, usage["prompt_tokens"].as_i64().unwrap_or(0)),
    };
    TokenUsage {
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: miss,
        completion_tokens: usage["completion_tokens"].as_i64().unwrap_or(0),
    }
}

fn api_error_message(status: StatusCode, response_body: &Value) -> String {
    let error_msg = response_body
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("未知错误");

    let error_type = response_body
        .get("error")
        .and_then(|e| e.get("type"))
        .and_then(|m| m.as_str())
        .unwrap_or("");

    if status == StatusCode::UNAUTHORIZED || error_type.contains("authentication") {
        return "API Key 无效或已过期，请打开设置重新填写 DeepSeek API Key，并先点击“测试连接”确认可用"
            .to_string();
    }

    format!("API 错误 ({}): {}", status.as_u16(), error_msg)
}

pub async fn complete_with_messages(
    settings: &DeepSeekSettings,
    messages: Vec<(String, String)>,
    temperature: f64,
    max_tokens: i64,
) -> Result<TranslationOutput, String> {
    let url = format!(
        "{}/chat/completions",
        settings.base_url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "model": settings.model,
        "messages": messages
            .into_iter()
            .map(|(role, content)| serde_json::json!({
                "role": role,
                "content": content,
            }))
            .collect::<Vec<_>>(),
        "temperature": temperature,
        "max_tokens": max_tokens
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", settings.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let response_body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if !status.is_success() {
        return Err(api_error_message(status, &response_body));
    }

    let content = response_body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("响应格式异常")?
        .trim()
        .to_string();

    if content.is_empty() {
        return Err("API 返回了空结果，请重试或检查模型设置".to_string());
    }

    Ok(TranslationOutput {
        content,
        usage: parse_usage(&response_body),
    })
}

pub async fn complete_with_prompts(
    settings: &DeepSeekSettings,
    system_prompt: &str,
    user_prompt: &str,
    temperature: f64,
    max_tokens: i64,
) -> Result<TranslationOutput, String> {
    complete_with_messages(
        settings,
        vec![
            ("system".to_string(), system_prompt.to_string()),
            ("user".to_string(), user_prompt.to_string()),
        ],
        temperature,
        max_tokens,
    )
    .await
}

pub async fn translate_text(
    settings: &DeepSeekSettings,
    text: &str,
) -> Result<TranslationOutput, String> {
    complete_with_prompts(
        settings,
        &settings.system_prompt,
        &format!("将以下文本翻译成中文：\n\n{}", text),
        0.3,
        1000,
    )
    .await
}

pub async fn test_connection(settings: &DeepSeekSettings) -> Result<bool, String> {
    let url = format!(
        "{}/chat/completions",
        settings.base_url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "model": settings.model,
        "messages": [
            {
                "role": "system",
                "content": "Reply with exactly: ok"
            },
            {
                "role": "user",
                "content": "ping"
            }
        ],
        "max_tokens": 5,
        "temperature": 0.0
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", settings.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    let status = response.status();
    let response_body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if status.is_success() {
        Ok(true)
    } else {
        Err(api_error_message(status, &response_body))
    }
}

/// Query DeepSeek's official balance endpoint (`GET {base}/user/balance`).
/// Returns the parsed `DeepSeekBalance` payload so the UI can show what the
/// vendor actually thinks is left on your account, instead of our local
/// localStorage approximation.
pub async fn fetch_balance(settings: &DeepSeekSettings) -> Result<DeepSeekBalance, String> {
    if settings.api_key.trim().is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    let url = format!("{}/user/balance", settings.base_url.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", settings.api_key))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
        return Err("当前服务不支持余额查询；仅兼容 DeepSeek 官方 /user/balance 接口".to_string());
    }

    let response_body: Value = serde_json::from_str(&response_text).unwrap_or(Value::Null);

    if !status.is_success() {
        if response_body.is_null() {
            let snippet: String = response_text.chars().take(200).collect();
            let detail = if snippet.trim().is_empty() {
                "未知错误".to_string()
            } else {
                snippet
            };
            return Err(format!("API 错误 ({}): {}", status.as_u16(), detail));
        }
        return Err(api_error_message(status, &response_body));
    }

    serde_json::from_str::<DeepSeekBalance>(&response_text)
        .map_err(|e| format!("解析余额数据失败: {}", e))
}
