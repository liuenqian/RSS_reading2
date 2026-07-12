// Background translation pipeline.
//
// Replaces the old "click 翻译全部" UX: as soon as entries land in the DB,
// this pipeline picks up everything that's missing a translation and processes
// titles + summaries concurrently. Per-entry progress events are emitted so the
// UI can render spinners and stream translations in as they complete.
//
// Lifecycle:
//   - `spawn(app)` fires a tokio task that runs `run` to completion.
//   - `run` is idempotent: it always queries the DB for what's still missing,
//     so multiple overlapping spawns just no-op or share work without
//     double-translating (the INSERT OR REPLACE is the de-dup point).

use crate::db::DbState;
use crate::models::DeepSeekSettings;
use crate::services::{article_service, cost_service, settings_service, translate_service};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;
use tracing::{info, warn};

const EVENT_NAME: &str = "translation-progress";
/// Lifecycle event for translation as a whole. Frontend uses this to render
/// a persistent banner when something blocks the pipeline (no API key, auth
/// failure). Distinct from `translation-progress`, which is per-entry.
const STATUS_EVENT: &str = "translation-status";
const MAX_CONCURRENT: usize = 3;
const PENDING_LIMIT: usize = 200;

#[derive(Debug)]
struct PendingTask {
    id: i64,
    title: String,
    summary: Option<String>,
    is_read: bool,
    has_title_translation: bool,
    has_summary_translation: bool,
}

/// Fire-and-forget. Safe to call after every fetch + at app startup.
/// Uses Tauri's managed async runtime so this works from both sync and async
/// command contexts (plain `tokio::spawn` would panic from a sync command
/// because there's no current runtime).
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app).await {
            warn!(error = %e, "translation pipeline failed");
        }
    });
}

async fn run(app: AppHandle) -> Result<(), String> {
    let (tasks, settings) = {
        let state = app.state::<DbState>();
        collect_pending(state.inner())?
    };

    if settings.api_key.is_empty() {
        info!("API key 未配置，跳过自动翻译");
        // Surface the reason to the UI so the user sees a clear banner
        // instead of wondering why nothing is being translated.
        if !tasks.is_empty() {
            let _ = app.emit(
                STATUS_EVENT,
                serde_json::json!({
                    "status": "needs_key",
                    "pending": tasks.len(),
                }),
            );
        }
        return Ok(());
    }
    if tasks.is_empty() {
        // Pipeline ran with a configured key and nothing pending — implicitly
        // healthy. Clear any stale banner the UI might still be showing.
        let _ = app.emit(STATUS_EVENT, serde_json::json!({ "status": "ok" }));
        return Ok(());
    }

    info!(count = tasks.len(), "启动自动翻译管线");
    // Optimistic: assume the key works until proven otherwise. process_task
    // will re-emit `auth_failed` if DeepSeek rejects credentials.
    let _ = app.emit(STATUS_EVENT, serde_json::json!({ "status": "ok" }));

    let settings = Arc::new(settings);
    let sem = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut handles = vec![];

    for task in tasks {
        let permit = match sem.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break,
        };
        let app2 = app.clone();
        let settings2 = settings.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = permit;
            process_task(app2, task, &settings2).await;
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    Ok(())
}

fn collect_pending(state: &DbState) -> Result<(Vec<PendingTask>, DeepSeekSettings), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let settings = settings_service::get_settings(&conn);

    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.title, e.summary, e.is_read,
                    EXISTS(SELECT 1 FROM translations t WHERE t.entry_id = e.id AND t.field = 'title'   AND length(trim(t.translated_text)) > 0),
                    EXISTS(SELECT 1 FROM translations t WHERE t.entry_id = e.id AND t.field = 'summary' AND length(trim(t.translated_text)) > 0)
             FROM entries e
             ORDER BY e.published_at DESC, e.fetched_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("查询待翻译失败: {}", e))?;

    let rows = stmt
        .query_map([PENDING_LIMIT as i64], |row| {
            Ok(PendingTask {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                is_read: row.get::<_, i64>(3)? != 0,
                has_title_translation: row.get::<_, i64>(4)? != 0,
                has_summary_translation: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| format!("查询失败: {}", e))?;

    let mut tasks = vec![];
    for r in rows.flatten() {
        // Title always gets translated if missing. A title that's already
        // predominantly Chinese is a strong signal the source language matches
        // the translation target, so we skip silently.
        let needs_title = !r.has_title_translation && !is_chinese_text(&r.title);
        let summary_text_is_real = r
            .summary
            .as_deref()
            .map(|s| !article_service::extract_rss_metadata(Some(s)).is_metadata_only)
            .unwrap_or(false);
        let summary_already_chinese = r.summary.as_deref().map(is_chinese_text).unwrap_or(false);
        // Once the user opens an article it becomes read immediately. Still
        // allow missing titles to catch up, but avoid spending extra tokens or
        // PubMed bandwidth on summaries for articles the user already moved past.
        let needs_summary_translation = !r.has_summary_translation
            && !r.is_read
            && !summary_already_chinese
            && (summary_text_is_real || !r.is_read);
        if needs_title || needs_summary_translation {
            tasks.push(r);
        }
    }

    Ok((tasks, settings))
}

/// Source-language guard for the translation pipeline. We translate to Chinese,
/// so a string that's already predominantly CJK is wasted tokens and visual
/// noise. Counts CJK ideographs against non-whitespace characters; ≥30% is the
/// threshold so mixed Chinese-English content (common in bilingual feeds) is
/// still treated as Chinese.
fn is_chinese_text(s: &str) -> bool {
    let mut cjk = 0usize;
    let mut total = 0usize;
    for c in s.chars() {
        if c.is_whitespace() {
            continue;
        }
        total += 1;
        if matches!(c,
            '\u{4E00}'..='\u{9FFF}'      // CJK Unified Ideographs
            | '\u{3400}'..='\u{4DBF}'    // Extension A
            | '\u{20000}'..='\u{2A6DF}'  // Extension B
            | '\u{F900}'..='\u{FAFF}'    // Compatibility Ideographs
        ) {
            cjk += 1;
        }
    }
    total > 0 && cjk * 10 >= total * 3
}

/// Heuristic: the translate_service formats 401/auth errors with a leading
/// "API Key 无效" phrase. Catch that string so the UI can show a clear
/// "please configure your API key" banner instead of just a per-entry error
/// pill that's easy to miss.
fn is_auth_error(msg: &str) -> bool {
    msg.contains("API Key 无效") || msg.contains("API Key 未配置")
}

fn maybe_emit_auth_failure(app: &AppHandle, msg: &str) {
    if is_auth_error(msg) {
        let _ = app.emit(
            STATUS_EVENT,
            serde_json::json!({
                "status": "auth_failed",
                "message": msg,
            }),
        );
    }
}

async fn process_task(app: AppHandle, task: PendingTask, settings: &DeepSeekSettings) {
    // ── Title ──
    if !task.has_title_translation {
        emit(&app, "start", task.id, "title", None, None);
        match translate_service::translate_text(settings, &task.title).await {
            Ok(out) => {
                let saved = {
                    let state = app.state::<DbState>();
                    let res = save_translation(
                        state.inner(),
                        task.id,
                        "title",
                        &task.title,
                        &out.content,
                        &settings.model,
                    );
                    if res.is_ok() {
                        if let Ok(conn) = state.conn.lock() {
                            let _ = cost_service::record_usage(&conn, &settings.model, &out.usage);
                        }
                    }
                    res
                };
                match saved {
                    Ok(()) => {
                        emit(&app, "done", task.id, "title", Some(&out.content), None);
                        emit_cost_updated(&app);
                    }
                    Err(e) => emit(&app, "error", task.id, "title", None, Some(&e)),
                }
            }
            Err(e) => {
                maybe_emit_auth_failure(&app, &e);
                emit(&app, "error", task.id, "title", None, Some(&e));
            }
        }
    }

    // ── Summary ──
    if task.has_summary_translation {
        return;
    }

    // Determine the summary text. Prefer existing summary if it's real
    // (not just RSS metadata stub); otherwise try to auto-fetch for unread.
    let mut summary_text: Option<String> = task.summary.clone().and_then(|s| {
        let m = article_service::extract_rss_metadata(Some(&s));
        (!m.is_metadata_only).then_some(s)
    });

    if summary_text.is_none() && !task.is_read {
        match article_service::fetch_abstract(&task.title).await {
            Ok(Some(result)) => {
                let saved = {
                    let state = app.state::<DbState>();
                    save_summary(state.inner(), task.id, &result.text, &result.source)
                };
                if let Err(e) = saved {
                    emit(&app, "error", task.id, "summary", None, Some(&e));
                    return;
                }
                emit_summary_fetched(&app, task.id, &result.text, &result.source);
                summary_text = Some(result.text);
            }
            Ok(None) => return,
            Err(e) => {
                warn!(entry_id = task.id, error = %e, "abstract 获取失败");
                return;
            }
        }
    }

    let Some(summary) = summary_text else {
        return;
    };

    // Last-mile guard: an abstract fetched mid-pipeline (PubMed, etc.) may
    // itself be Chinese. Skip silently — collect_pending can't see it.
    if is_chinese_text(&summary) {
        return;
    }

    emit(&app, "start", task.id, "summary", None, None);
    match translate_service::translate_text(settings, &summary).await {
        Ok(out) => {
            let saved = {
                let state = app.state::<DbState>();
                let res = save_translation(
                    state.inner(),
                    task.id,
                    "summary",
                    &summary,
                    &out.content,
                    &settings.model,
                );
                if res.is_ok() {
                    if let Ok(conn) = state.conn.lock() {
                        let _ = cost_service::record_usage(&conn, &settings.model, &out.usage);
                    }
                }
                res
            };
            match saved {
                Ok(()) => {
                    emit(&app, "done", task.id, "summary", Some(&out.content), None);
                    emit_cost_updated(&app);
                }
                Err(e) => emit(&app, "error", task.id, "summary", None, Some(&e)),
            }
        }
        Err(e) => {
            maybe_emit_auth_failure(&app, &e);
            emit(&app, "error", task.id, "summary", None, Some(&e));
        }
    }
}

fn emit_cost_updated(app: &AppHandle) {
    let state = app.state::<DbState>();
    let summary = {
        let Ok(conn) = state.conn.lock() else {
            return;
        };
        match cost_service::current_month_summary(&conn) {
            Ok(s) => s,
            Err(_) => return,
        }
    };
    let _ = app.emit("cost-updated", &summary);
}

fn save_translation(
    state: &DbState,
    entry_id: i64,
    field: &str,
    original: &str,
    translated: &str,
    model: &str,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO translations (entry_id, field, original_text, translated_text, model)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![entry_id, field, original, translated, model],
    )
    .map_err(|e| format!("保存翻译失败: {}", e))?;
    Ok(())
}

fn save_summary(state: &DbState, entry_id: i64, summary: &str, source: &str) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE entries SET summary = ?1, summary_source = ?2 WHERE id = ?3",
        rusqlite::params![summary, source, entry_id],
    )
    .map_err(|e| format!("保存摘要失败: {}", e))?;
    Ok(())
}

fn emit(
    app: &AppHandle,
    kind: &str,
    entry_id: i64,
    field: &str,
    text: Option<&str>,
    error: Option<&str>,
) {
    let _ = app.emit(
        EVENT_NAME,
        serde_json::json!({
            "kind": kind,
            "entry_id": entry_id,
            "field": field,
            "text": text,
            "error": error,
        }),
    );
}

fn emit_summary_fetched(app: &AppHandle, entry_id: i64, summary: &str, source: &str) {
    let _ = app.emit(
        EVENT_NAME,
        serde_json::json!({
            "kind": "summary_fetched",
            "entry_id": entry_id,
            "summary": summary,
            "source": source,
        }),
    );
}
