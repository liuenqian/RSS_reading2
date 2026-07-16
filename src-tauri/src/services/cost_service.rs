// Token-accurate cost meter.
//
// Provider responses are normalized to `TokenUsage`; monthly totals are kept
// per provider and model. Only providers with a maintained rate card are priced.
//
// Why per-model: deepseek-chat and deepseek-reasoner have different rates, and
// future models will too. Storing model alongside the counts lets us evolve
// the rate card without re-counting historical data.
//
// Why cache hit vs miss: hit tokens are 4× cheaper. Cento sends the same
// long system prompt with every call, so the hit ratio is real money — once
// the prompt is cached, only the article body counts at the miss rate.

use crate::models::{CostBreakdownRow, CostSummary, TokenUsage};
use rusqlite::Connection;
use tracing::info;

/// Per-model rates in **CNY per 1M tokens**. Standard-hours pricing from
/// https://api-docs.deepseek.com/quick_start/pricing — off-peak discounts
/// aren't applied because (a) we'd need to bucket usage by call timestamp
/// and (b) the user can cross-check the vendor-side balance card if the
/// exact yuan figure matters.
struct Rates {
    cache_hit_per_m: f64,
    cache_miss_per_m: f64,
    completion_per_m: f64,
}

fn rates_for(provider: &str, model: &str) -> Option<Rates> {
    if provider != "deepseek" {
        return None;
    }
    let m = model.to_ascii_lowercase();
    Some(if m.contains("reasoner") || m.contains("r1") {
        Rates {
            cache_hit_per_m: 1.0,
            cache_miss_per_m: 4.0,
            completion_per_m: 16.0,
        }
    } else {
        // deepseek-chat (V3) and the legacy v4-flash alias both fall here.
        Rates {
            cache_hit_per_m: 0.5,
            cache_miss_per_m: 2.0,
            completion_per_m: 8.0,
        }
    })
}

fn price(tokens: i64, per_m: f64) -> f64 {
    (tokens as f64) * per_m / 1_000_000.0
}

/// Current month label in UTC (`YYYY-MM`). Matches the old localStorage key
/// scheme so re-rolling to a fresh month happens at the same time as before.
fn current_month() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let (y, m, _) = civil_from_days(days);
    format!("{:04}-{:02}", y, m)
}

// Howard Hinnant's date algorithm — civil_from_days (epoch = 1970-01-01).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
}

/// Add one API call's usage to the current month's running total. Upserts on
/// `(month, model)` so re-translating an article just bumps the counts rather
/// than creating a new row per call.
pub fn record_usage(
    conn: &Connection,
    provider: &str,
    model: &str,
    usage: &TokenUsage,
) -> Result<(), String> {
    let month = current_month();
    let usage_key = format!("{}::{}", provider.trim(), model.trim());
    info!(
        month = %month,
        provider = %provider,
        model = %model,
        hit = usage.prompt_cache_hit_tokens,
        miss = usage.prompt_cache_miss_tokens,
        output = usage.completion_tokens,
        "记录 token 用量"
    );
    conn.execute(
        "INSERT INTO cost_log
           (month, model,
            prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(month, model) DO UPDATE SET
           prompt_cache_hit_tokens  = prompt_cache_hit_tokens  + excluded.prompt_cache_hit_tokens,
           prompt_cache_miss_tokens = prompt_cache_miss_tokens + excluded.prompt_cache_miss_tokens,
           completion_tokens        = completion_tokens        + excluded.completion_tokens",
        rusqlite::params![
            month,
            usage_key,
            usage.prompt_cache_hit_tokens,
            usage.prompt_cache_miss_tokens,
            usage.completion_tokens,
        ],
    )
    .map_err(|e| format!("记录用量失败: {}", e))?;
    Ok(())
}

fn split_usage_key(value: &str) -> (String, String) {
    value
        .split_once("::")
        .map(|(provider, model)| (provider.to_string(), model.to_string()))
        .unwrap_or_else(|| ("deepseek".to_string(), value.to_string()))
}

pub fn current_month_summary(conn: &Connection) -> Result<CostSummary, String> {
    let month = current_month();
    let mut stmt = conn
        .prepare(
            "SELECT model, prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens
             FROM cost_log
             WHERE month = ?1
             ORDER BY model",
        )
        .map_err(|e| format!("查询用量失败: {}", e))?;
    let rows = stmt
        .query_map([&month], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("查询用量失败: {}", e))?;

    let mut breakdown = Vec::new();
    let mut total = 0.0_f64;
    let mut all_priced = true;
    for r in rows.flatten() {
        let (usage_key, hit, miss, comp) = r;
        let (provider, model) = split_usage_key(&usage_key);
        let cny = rates_for(&provider, &model).map(|rates| {
            price(hit, rates.cache_hit_per_m)
                + price(miss, rates.cache_miss_per_m)
                + price(comp, rates.completion_per_m)
        });
        if let Some(value) = cny {
            total += value;
        } else {
            all_priced = false;
        }
        breakdown.push(CostBreakdownRow {
            provider,
            model,
            prompt_cache_hit_tokens: hit,
            prompt_cache_miss_tokens: miss,
            completion_tokens: comp,
            cny,
        });
    }
    Ok(CostSummary {
        month,
        total_cny: all_priced.then_some(total),
        breakdown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_usage_keys_are_deepseek() {
        assert_eq!(
            split_usage_key("deepseek-chat"),
            ("deepseek".to_string(), "deepseek-chat".to_string())
        );
        assert_eq!(
            split_usage_key("anthropic::claude-sonnet-5"),
            ("anthropic".to_string(), "claude-sonnet-5".to_string())
        );
    }
}
