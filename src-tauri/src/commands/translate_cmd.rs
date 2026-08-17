use crate::db::DbState;
use crate::models::TokenUsage;
use crate::services::{article_service, cost_service, settings_service, translate_service};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const TRANSLATION_EVENT: &str = "translation-progress";

#[derive(Serialize)]
pub struct TranslateEntryResult {
    translated_title: bool,
    translated_summary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationFieldResult {
    translated: bool,
    model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationTextResult {
    text: String,
    model: Option<String>,
}

struct TranslateEntryTask {
    title: String,
    summary: Option<String>,
    title_translation: Option<String>,
    summary_translation: Option<String>,
    settings: crate::models::DeepSeekSettings,
    route: crate::models::TranslationRouteSettings,
}

fn emit_cost_updated(app: &AppHandle, state: &State<'_, DbState>) {
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

fn emit_translation_progress(
    app: &AppHandle,
    kind: &str,
    entry_id: i64,
    field: &str,
    text: Option<&str>,
    error: Option<&str>,
) {
    let _ = app.emit(
        TRANSLATION_EVENT,
        serde_json::json!({
            "kind": kind,
            "entry_id": entry_id,
            "field": field,
            "text": text,
            "error": error,
        }),
    );
}

fn cached_translation_progress_payload(
    entry_id: i64,
    field: &str,
    text: Option<&str>,
) -> Option<serde_json::Value> {
    text.filter(|value| !value.trim().is_empty()).map(|value| {
        serde_json::json!({
            "kind": "done",
            "entry_id": entry_id,
            "field": field,
            "text": value,
            "error": null,
        })
    })
}

fn clear_translation_cache(
    conn: &rusqlite::Connection,
    entry_id: i64,
    field: &str,
) -> Result<(), String> {
    if !matches!(field, "title" | "summary") {
        return Err("不支持的翻译字段".to_string());
    }

    conn.execute(
        "DELETE FROM translations WHERE entry_id = ?1 AND field = ?2",
        rusqlite::params![entry_id, field],
    )
    .map_err(|e| format!("清除翻译缓存失败: {}", e))?;

    Ok(())
}

fn emit_cached_translation_progress(
    app: &AppHandle,
    entry_id: i64,
    field: &str,
    text: Option<&str>,
) -> bool {
    let Some(payload) = cached_translation_progress_payload(entry_id, field, text) else {
        return false;
    };
    let _ = app.emit(TRANSLATION_EVENT, payload);
    true
}

fn emit_summary_fetched(app: &AppHandle, entry_id: i64, summary: &str, source: &str) {
    let _ = app.emit(
        TRANSLATION_EVENT,
        serde_json::json!({
            "kind": "summary_fetched",
            "entry_id": entry_id,
            "summary": summary,
            "source": source,
        }),
    );
}

fn save_translation(
    state: &State<'_, DbState>,
    entry_id: i64,
    field: &str,
    original: &str,
    translated: &str,
    provider: &str,
    model: &str,
    usage: &TokenUsage,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO translations (entry_id, field, original_text, translated_text, model)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![entry_id, field, original, translated, model],
    )
    .map_err(|e| format!("保存翻译失败: {}", e))?;
    let _ = cost_service::record_usage(&conn, provider, model, usage);
    Ok(())
}

fn save_summary(
    state: &State<'_, DbState>,
    entry_id: i64,
    summary: &str,
    source: &str,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE entries SET summary = ?1, summary_source = ?2 WHERE id = ?3",
        rusqlite::params![summary, source, entry_id],
    )
    .map_err(|e| format!("保存摘要失败: {}", e))?;
    Ok(())
}

async fn translate_with_route(
    state: &State<'_, DbState>,
    settings: &crate::models::DeepSeekSettings,
    route: &crate::models::TranslationRouteSettings,
    text: &str,
) -> Result<translate_service::RoutedTranslationOutput, String> {
    let char_count = text.chars().count();
    let google_web_available = if route.google_web_enabled {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        settings_service::google_web_translation_available(&conn, char_count)
    } else {
        false
    };
    let output =
        translate_service::translate_text_with_route(settings, route, google_web_available, text)
            .await?;
    if output.provider == "google_web" {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        settings_service::record_google_web_translation(&conn, char_count)?;
    }
    Ok(output)
}

fn is_chinese_text(s: &str) -> bool {
    let mut cjk = 0usize;
    let mut total = 0usize;
    for c in s.chars() {
        if c.is_whitespace() {
            continue;
        }
        total += 1;
        if matches!(
            c,
            '\u{4E00}'..='\u{9FFF}'
                | '\u{3400}'..='\u{4DBF}'
                | '\u{20000}'..='\u{2A6DF}'
                | '\u{F900}'..='\u{FAFF}'
        ) {
            cjk += 1;
        }
    }
    total > 0 && cjk * 10 >= total * 3
}

fn load_translate_entry_task(
    state: &State<'_, DbState>,
    entry_id: i64,
) -> Result<TranslateEntryTask, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let (settings, route) = settings_service::get_translation_settings(&conn);
    let (title, summary, title_translation, summary_translation) = conn
        .query_row(
            "SELECT e.title,
                    e.summary,
                    (SELECT t.translated_text FROM translations t WHERE t.entry_id = e.id AND t.field = 'title' AND length(trim(t.translated_text)) > 0 LIMIT 1),
                    (SELECT t.translated_text FROM translations t WHERE t.entry_id = e.id AND t.field = 'summary' AND length(trim(t.translated_text)) > 0 LIMIT 1)
             FROM entries e
             WHERE e.id = ?1",
            [entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                ))
            },
        )
        .map_err(|e| format!("读取文章失败: {}", e))?;

    Ok(TranslateEntryTask {
        title,
        summary,
        title_translation,
        summary_translation,
        settings,
        route,
    })
}

async fn translate_title_for_entry(
    app: &AppHandle,
    state: &State<'_, DbState>,
    entry_id: i64,
    task: &TranslateEntryTask,
) -> Result<TranslationFieldResult, String> {
    if emit_cached_translation_progress(app, entry_id, "title", task.title_translation.as_deref())
        || is_chinese_text(&task.title)
    {
        return Ok(TranslationFieldResult {
            translated: false,
            model: None,
        });
    }

    emit_translation_progress(app, "start", entry_id, "title", None, None);
    let output = translate_with_route(state, &task.settings, &task.route, &task.title).await?;
    save_translation(
        state,
        entry_id,
        "title",
        &task.title,
        &output.content,
        &output.provider,
        &output.model,
        &output.usage,
    )?;
    emit_translation_progress(app, "done", entry_id, "title", Some(&output.content), None);
    emit_cost_updated(app, state);
    Ok(TranslationFieldResult {
        translated: true,
        model: Some(output.model),
    })
}

async fn resolve_summary_for_translation(
    app: &AppHandle,
    state: &State<'_, DbState>,
    entry_id: i64,
    task: &TranslateEntryTask,
) -> Result<Option<String>, String> {
    let mut summary_text = task.summary.clone().and_then(|summary| {
        let metadata = article_service::extract_rss_metadata(Some(&summary));
        (!metadata.is_metadata_only).then_some(summary)
    });

    if summary_text.is_none() {
        match article_service::fetch_abstract(&task.title).await {
            Ok(Some(result)) => {
                save_summary(state, entry_id, &result.text, &result.source)?;
                emit_summary_fetched(app, entry_id, &result.text, &result.source);
                summary_text = Some(result.text);
            }
            Ok(None) => {}
            Err(err) => return Err(format!("获取 Abstract 失败: {}", err)),
        }
    }

    Ok(summary_text)
}

async fn translate_summary_for_entry(
    app: &AppHandle,
    state: &State<'_, DbState>,
    entry_id: i64,
    task: &TranslateEntryTask,
) -> Result<TranslationFieldResult, String> {
    if emit_cached_translation_progress(
        app,
        entry_id,
        "summary",
        task.summary_translation.as_deref(),
    ) {
        return Ok(TranslationFieldResult {
            translated: false,
            model: None,
        });
    }

    let Some(summary) = resolve_summary_for_translation(app, state, entry_id, task).await? else {
        return Ok(TranslationFieldResult {
            translated: false,
            model: None,
        });
    };
    if is_chinese_text(&summary) {
        return Ok(TranslationFieldResult {
            translated: false,
            model: None,
        });
    }

    emit_translation_progress(app, "start", entry_id, "summary", None, None);
    let output = translate_with_route(state, &task.settings, &task.route, &summary).await?;
    save_translation(
        state,
        entry_id,
        "summary",
        &summary,
        &output.content,
        &output.provider,
        &output.model,
        &output.usage,
    )?;
    emit_translation_progress(
        app,
        "done",
        entry_id,
        "summary",
        Some(&output.content),
        None,
    );
    emit_cost_updated(app, state);
    Ok(TranslationFieldResult {
        translated: true,
        model: Some(output.model),
    })
}

#[tauri::command]
pub async fn translate_summary(
    app: AppHandle,
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<TranslationTextResult, String> {
    let (summary, settings, route) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let cached: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT translated_text, model FROM translations
                 WHERE entry_id = ?1 AND field = 'summary' AND length(trim(translated_text)) > 0",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((text, model)) = cached {
            return Ok(TranslationTextResult { text, model });
        }
        let s: Option<String> = conn
            .query_row(
                "SELECT summary FROM entries WHERE id = ?1",
                [entry_id],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        let summary = s.ok_or("该文章没有摘要")?;
        let metadata = crate::services::article_service::extract_rss_metadata(Some(&summary));
        if metadata.is_metadata_only {
            return Err("该文章尚未获取到真正的 Abstract".to_string());
        }
        let (settings, route) = settings_service::get_translation_settings(&conn);
        (summary, settings, route)
    };

    let output = translate_with_route(&state, &settings, &route, &summary).await?;

    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO translations (entry_id, field, original_text, translated_text, model)
             VALUES (?1, 'summary', ?2, ?3, ?4)",
            rusqlite::params![entry_id, &summary, &output.content, &output.model],
        )
        .map_err(|e| format!("保存摘要翻译失败: {}", e))?;
        let _ = cost_service::record_usage(&conn, &output.provider, &output.model, &output.usage);
    }
    emit_cost_updated(&app, &state);

    Ok(TranslationTextResult {
        text: output.content,
        model: Some(output.model),
    })
}

#[tauri::command]
pub async fn translate_entry_missing(
    app: AppHandle,
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<TranslateEntryResult, String> {
    let task = load_translate_entry_task(&state, entry_id)?;

    let mut result = TranslateEntryResult {
        translated_title: false,
        translated_summary: false,
    };

    match translate_title_for_entry(&app, &state, entry_id, &task).await {
        Ok(translated) => result.translated_title = translated.translated,
        Err(err) => {
            emit_translation_progress(&app, "error", entry_id, "title", None, Some(&err));
            return Err(err);
        }
    }

    match translate_summary_for_entry(&app, &state, entry_id, &task).await {
        Ok(translated) => result.translated_summary = translated.translated,
        Err(err) => {
            emit_translation_progress(&app, "error", entry_id, "summary", None, Some(&err));
            return Err(err);
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn translate_entry_title(
    app: AppHandle,
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<TranslationFieldResult, String> {
    let task = load_translate_entry_task(&state, entry_id)?;
    match translate_title_for_entry(&app, &state, entry_id, &task).await {
        Ok(translated) => Ok(translated),
        Err(err) => {
            emit_translation_progress(&app, "error", entry_id, "title", None, Some(&err));
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn translate_entry_summary(
    app: AppHandle,
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<TranslationFieldResult, String> {
    let task = load_translate_entry_task(&state, entry_id)?;
    match translate_summary_for_entry(&app, &state, entry_id, &task).await {
        Ok(translated) => Ok(translated),
        Err(err) => {
            emit_translation_progress(&app, "error", entry_id, "summary", None, Some(&err));
            Err(err)
        }
    }
}

#[tauri::command]
pub fn clear_entry_translation(
    state: State<'_, DbState>,
    entry_id: i64,
    field: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    clear_translation_cache(&conn, entry_id, &field)
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    // Delegate to tauri-plugin-opener — it knows how to talk to the right
    // shell on every platform (`open` on macOS, `start` on Windows,
    // `xdg-open` on Linux). Beats hand-spawning a shell-specific binary.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("无法打开链接: {}", e))
}

/// Return the current month's aggregated token usage + computed CNY. Drives
/// the bottom-left cost meter. The frontend calls this on startup and the
/// pipeline emits `cost-updated` with the same payload after each successful
/// translation, so the meter stays live without polling.
#[tauri::command]
pub fn get_cost_summary(state: State<'_, DbState>) -> Result<crate::models::CostSummary, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    cost_service::current_month_summary(&conn)
}

#[cfg(test)]
mod tests {
    use super::{cached_translation_progress_payload, clear_translation_cache};
    use rusqlite::Connection;

    #[test]
    fn cached_translation_emits_done_payload_with_text() {
        let payload = cached_translation_progress_payload(42, "title", Some("缓存中文标题"))
            .expect("cached translation should produce a progress event");

        assert_eq!(payload["kind"], "done");
        assert_eq!(payload["entry_id"], 42);
        assert_eq!(payload["field"], "title");
        assert_eq!(payload["text"], "缓存中文标题");
        assert!(cached_translation_progress_payload(42, "title", None).is_none());
    }

    #[test]
    fn clear_translation_cache_only_removes_the_requested_supported_field() {
        let conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "CREATE TABLE translations (
                entry_id INTEGER NOT NULL,
                field TEXT NOT NULL,
                translated_text TEXT
            );
            INSERT INTO translations (entry_id, field, translated_text)
            VALUES (7, 'title', '标题译文'), (7, 'summary', '摘要译文');",
        )
        .expect("translation test data");

        clear_translation_cache(&conn, 7, "summary").expect("clear summary cache");

        let title_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM translations WHERE entry_id = 7 AND field = 'title'",
                [],
                |row| row.get(0),
            )
            .expect("title count");
        let summary_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM translations WHERE entry_id = 7 AND field = 'summary'",
                [],
                |row| row.get(0),
            )
            .expect("summary count");

        assert_eq!(title_count, 1);
        assert_eq!(summary_count, 0);
        assert!(clear_translation_cache(&conn, 7, "unknown").is_err());
    }
}
