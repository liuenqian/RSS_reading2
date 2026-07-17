use crate::models::{DeepSeekBalance, DeepSeekSettings, TokenUsage};
use crate::services::settings_service;
use reqwest::Client;
use reqwest::StatusCode;
use serde_json::Value;
use std::sync::OnceLock;

fn translation_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn balance_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Output of a single translation call: the translated text plus the token
/// usage reported by DeepSeek. The usage feeds the cost meter; callers that
/// don't care about cost can simply destructure and discard the second field.
pub struct TranslationOutput {
    pub content: String,
    pub usage: TokenUsage,
}

fn parse_openai_usage(v: &Value) -> TokenUsage {
    let usage = &v["usage"];
    let prompt_tokens = usage["prompt_tokens"].as_i64().unwrap_or(0);
    let hit = usage["prompt_cache_hit_tokens"]
        .as_i64()
        .or_else(|| usage["prompt_tokens_details"]["cached_tokens"].as_i64())
        .unwrap_or(0);
    let miss = usage["prompt_cache_miss_tokens"]
        .as_i64()
        .unwrap_or_else(|| prompt_tokens.saturating_sub(hit));
    TokenUsage {
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: miss,
        completion_tokens: usage["completion_tokens"].as_i64().unwrap_or(0),
    }
}

fn parse_anthropic_usage(v: &Value) -> TokenUsage {
    let usage = &v["usage"];
    TokenUsage {
        prompt_cache_hit_tokens: usage["cache_read_input_tokens"].as_i64().unwrap_or(0),
        prompt_cache_miss_tokens: usage["input_tokens"].as_i64().unwrap_or(0)
            + usage["cache_creation_input_tokens"].as_i64().unwrap_or(0),
        completion_tokens: usage["output_tokens"].as_i64().unwrap_or(0),
    }
}

fn parse_gemini_usage(v: &Value) -> TokenUsage {
    let usage = &v["usageMetadata"];
    let prompt = usage["promptTokenCount"].as_i64().unwrap_or(0);
    let cached = usage["cachedContentTokenCount"].as_i64().unwrap_or(0);
    let candidates = usage["candidatesTokenCount"].as_i64().unwrap_or(0);
    let thoughts = usage["thoughtsTokenCount"].as_i64().unwrap_or(0);
    let total = usage["totalTokenCount"].as_i64().unwrap_or(0);
    let output = if total >= prompt {
        total - prompt
    } else {
        candidates + thoughts
    };
    TokenUsage {
        prompt_cache_hit_tokens: cached,
        prompt_cache_miss_tokens: prompt.saturating_sub(cached),
        completion_tokens: output,
    }
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "gemini" => "Google Gemini",
        "openai_compatible" => "OpenAI-compatible",
        _ => "DeepSeek",
    }
}

fn api_error_message(provider: &str, status: StatusCode, response_body: &Value) -> String {
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
        return format!(
            "{} API Key 无效或已过期，请打开设置重新填写并测试连接",
            provider_label(provider)
        );
    }

    if status == StatusCode::TOO_MANY_REQUESTS {
        let detail = error_msg.to_ascii_lowercase();
        if detail.contains("token plan limit exhausted")
            || detail.contains("insufficient quota")
            || detail.contains("quota exceeded")
        {
            return format!(
                "{} AI 额度已用尽，请前往 AI 设置更换可用的 API Key 或服务商",
                provider_label(provider)
            );
        }
        return format!(
            "{} 请求过于频繁，请稍后重试或更换服务商",
            provider_label(provider)
        );
    }

    format!(
        "{} API 错误 ({}): {}",
        provider_label(provider),
        status.as_u16(),
        error_msg
    )
}

fn endpoint(base_url: &str, suffix: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with(suffix) {
        base.to_string()
    } else {
        format!("{}/{}", base, suffix.trim_start_matches('/'))
    }
}

fn parse_provider_response(
    provider: &str,
    response_body: &Value,
) -> Result<TranslationOutput, String> {
    let (content, usage) = match provider {
        "anthropic" => {
            let content = response_body["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block["type"].as_str() == Some("text"))
                        .filter_map(|block| block["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            (content, parse_anthropic_usage(response_body))
        }
        "gemini" => {
            let content = response_body["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            (content, parse_gemini_usage(response_body))
        }
        _ => (
            response_body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            parse_openai_usage(response_body),
        ),
    };

    let content = content.trim().to_string();
    if content.is_empty() {
        return Err(format!(
            "{} 返回了空结果或不兼容的响应格式",
            provider_label(provider)
        ));
    }
    Ok(TranslationOutput { content, usage })
}

fn capped_max_tokens(requested: i64, configured_limit: i64) -> i64 {
    requested.max(1).min(configured_limit.max(1))
}

pub async fn complete_with_messages(
    settings: &DeepSeekSettings,
    messages: Vec<(String, String)>,
    temperature: f64,
    max_tokens: i64,
) -> Result<TranslationOutput, String> {
    let provider = settings_service::normalize_provider_id(&settings.provider);
    let max_tokens = capped_max_tokens(max_tokens, settings.context_output_tokens);
    if settings.base_url.trim().is_empty() {
        return Err("请填写 Base URL".to_string());
    }
    if settings.model.trim().is_empty() {
        return Err("请填写 Model".to_string());
    }

    let (url, body) = match provider {
        "anthropic" => {
            let mut system_parts = Vec::new();
            let mut api_messages = Vec::new();
            for (role, content) in messages {
                if role == "system" {
                    system_parts.push(content);
                } else {
                    api_messages.push(serde_json::json!({
                        "role": if role == "assistant" { "assistant" } else { "user" },
                        "content": content,
                    }));
                }
            }
            let mut body = serde_json::json!({
                "model": settings.model,
                "messages": api_messages,
                "max_tokens": max_tokens,
            });
            if !system_parts.is_empty() {
                body["system"] = Value::String(system_parts.join("\n\n"));
            }
            (endpoint(&settings.base_url, "messages"), body)
        }
        "gemini" => {
            let mut system_parts = Vec::new();
            let mut contents = Vec::new();
            for (role, content) in messages {
                if role == "system" {
                    system_parts.push(content);
                } else {
                    contents.push(serde_json::json!({
                        "role": if role == "assistant" { "model" } else { "user" },
                        "parts": [{ "text": content }],
                    }));
                }
            }
            let mut body = serde_json::json!({
                "contents": contents,
                "generationConfig": {
                    "temperature": temperature,
                    "maxOutputTokens": max_tokens,
                }
            });
            if !system_parts.is_empty() {
                body["systemInstruction"] = serde_json::json!({
                    "parts": [{ "text": system_parts.join("\n\n") }]
                });
            }
            let model = settings.model.trim().trim_start_matches("models/");
            (
                endpoint(
                    &settings.base_url,
                    &format!("models/{}:generateContent", model),
                ),
                body,
            )
        }
        _ => {
            let mut body = serde_json::json!({
                "model": settings.model,
                "messages": messages
                    .into_iter()
                    .map(|(role, content)| serde_json::json!({
                        "role": role,
                        "content": content,
                    }))
                    .collect::<Vec<_>>(),
            });
            if provider == "openai" {
                body["max_completion_tokens"] = Value::from(max_tokens);
            } else {
                body["max_tokens"] = Value::from(max_tokens);
                body["temperature"] = Value::from(temperature);
            }
            (endpoint(&settings.base_url, "chat/completions"), body)
        }
    };

    let client = translation_client()?;

    let request = client.post(&url).header("Content-Type", "application/json");
    let request = match provider {
        "anthropic" => request
            .header("x-api-key", &settings.api_key)
            .header("anthropic-version", "2023-06-01"),
        "gemini" => request.header("x-goog-api-key", &settings.api_key),
        _ => request.header("Authorization", format!("Bearer {}", settings.api_key)),
    };
    let response = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{} 请求失败: {}", provider_label(provider), e))?;

    let status = response.status();
    let response_body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if !status.is_success() {
        return Err(api_error_message(provider, status, &response_body));
    }
    parse_provider_response(provider, &response_body)
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
    complete_with_messages(
        settings,
        vec![
            ("system".to_string(), "Reply briefly.".to_string()),
            ("user".to_string(), "Reply with exactly: ok".to_string()),
        ],
        0.0,
        64,
    )
    .await?;
    Ok(true)
}

/// Query DeepSeek's official balance endpoint (`GET {base}/user/balance`).
/// Returns the parsed `DeepSeekBalance` payload so the UI can show what the
/// vendor actually thinks is left on your account, instead of our local
/// localStorage approximation.
pub async fn fetch_balance(settings: &DeepSeekSettings) -> Result<DeepSeekBalance, String> {
    if settings_service::normalize_provider_id(&settings.provider) != "deepseek" {
        return Err("当前服务不支持余额查询；仅兼容 DeepSeek 官方 /user/balance 接口".to_string());
    }
    if settings.api_key.trim().is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    let url = format!("{}/user/balance", settings.base_url.trim_end_matches('/'));

    let client = balance_client()?;

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
        return Err(api_error_message("deepseek", status, &response_body));
    }

    serde_json::from_str::<DeepSeekBalance>(&response_text)
        .map_err(|e| format!("解析余额数据失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_compatible_usage() {
        let value = serde_json::json!({
            "choices": [{"message": {"content": "ok"}}],
            "usage": {
                "prompt_tokens": 120,
                "prompt_tokens_details": {"cached_tokens": 20},
                "completion_tokens": 8
            }
        });
        let output = parse_provider_response("openai", &value).unwrap();
        assert_eq!(output.usage.prompt_cache_hit_tokens, 20);
        assert_eq!(output.usage.prompt_cache_miss_tokens, 100);
        assert_eq!(output.usage.completion_tokens, 8);
    }

    #[test]
    fn parses_anthropic_content_and_usage() {
        let value = serde_json::json!({
            "content": [{"type": "text", "text": "hello"}],
            "usage": {
                "input_tokens": 90,
                "cache_creation_input_tokens": 10,
                "cache_read_input_tokens": 30,
                "output_tokens": 7
            }
        });
        let output = parse_provider_response("anthropic", &value).unwrap();
        assert_eq!(output.content, "hello");
        assert_eq!(output.usage.prompt_cache_hit_tokens, 30);
        assert_eq!(output.usage.prompt_cache_miss_tokens, 100);
        assert_eq!(output.usage.completion_tokens, 7);
    }

    #[test]
    fn parses_gemini_content_and_total_usage() {
        let value = serde_json::json!({
            "candidates": [{"content": {"parts": [{"text": "hello"}]}}],
            "usageMetadata": {
                "promptTokenCount": 100,
                "cachedContentTokenCount": 25,
                "candidatesTokenCount": 10,
                "thoughtsTokenCount": 5,
                "totalTokenCount": 115
            }
        });
        let output = parse_provider_response("gemini", &value).unwrap();
        assert_eq!(output.usage.prompt_cache_hit_tokens, 25);
        assert_eq!(output.usage.prompt_cache_miss_tokens, 75);
        assert_eq!(output.usage.completion_tokens, 15);
    }

    #[test]
    fn explains_exhausted_ai_token_plan() {
        let body = serde_json::json!({
            "error": {"message": "token plan limit exhausted"}
        });

        let message = api_error_message("deepseek", StatusCode::TOO_MANY_REQUESTS, &body);

        assert!(message.contains("额度已用尽"));
        assert!(message.contains("AI 设置"));
    }

    #[test]
    fn caps_requested_output_tokens_to_the_configured_context_limit() {
        assert_eq!(capped_max_tokens(32_000, 16_000), 16_000);
        assert_eq!(capped_max_tokens(1_000, 16_000), 1_000);
        assert_eq!(capped_max_tokens(0, 16_000), 1);
    }
}
