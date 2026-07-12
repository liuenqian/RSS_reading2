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

struct TranslateEntryTask {
    title: String,
    summary: Option<String>,
    has_title_translation: bool,
    has_summary_translation: bool,
    settings: crate::models::DeepSeekSettings,
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
    let _ = cost_service::record_usage(&conn, model, usage);
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

#[tauri::command]
pub async fn translate_summary(
    app: AppHandle,
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<String, String> {
    let (summary, settings) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let cached: Option<String> = conn
            .query_row(
                "SELECT translated_text FROM translations
                 WHERE entry_id = ?1 AND field = 'summary' AND length(trim(translated_text)) > 0",
                [entry_id],
                |row| row.get(0),
            )
            .ok();
        if let Some(c) = cached {
            return Ok(c);
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
        let settings = settings_service::get_settings(&conn);
        (summary, settings)
    };

    if settings.api_key.is_empty() {
        return Err("请先在设置中配置 API Key".to_string());
    }

    let output = translate_service::translate_text(&settings, &summary).await?;

    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO translations (entry_id, field, original_text, translated_text, model)
             VALUES (?1, 'summary', ?2, ?3, ?4)",
            rusqlite::params![entry_id, &summary, &output.content, &settings.model],
        )
        .map_err(|e| format!("保存摘要翻译失败: {}", e))?;
        let _ = cost_service::record_usage(&conn, &settings.model, &output.usage);
    }
    emit_cost_updated(&app, &state);

    Ok(output.content)
}

#[tauri::command]
pub async fn translate_entry_missing(
    app: AppHandle,
    state: State<'_, DbState>,
    entry_id: i64,
) -> Result<TranslateEntryResult, String> {
    let task = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let settings = settings_service::get_settings(&conn);
        let (title, summary, has_title_translation, has_summary_translation) = conn
            .query_row(
                "SELECT e.title,
                        e.summary,
                        EXISTS(SELECT 1 FROM translations t WHERE t.entry_id = e.id AND t.field = 'title' AND length(trim(t.translated_text)) > 0),
                        EXISTS(SELECT 1 FROM translations t WHERE t.entry_id = e.id AND t.field = 'summary' AND length(trim(t.translated_text)) > 0)
                 FROM entries e
                 WHERE e.id = ?1",
                [entry_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, i64>(2)? != 0,
                        row.get::<_, i64>(3)? != 0,
                    ))
                },
            )
            .map_err(|e| format!("读取文章失败: {}", e))?;
        TranslateEntryTask {
            title,
            summary,
            has_title_translation,
            has_summary_translation,
            settings,
        }
    };

    if task.settings.api_key.is_empty() {
        return Err("请先在设置中配置 API Key".to_string());
    }

    let mut result = TranslateEntryResult {
        translated_title: false,
        translated_summary: false,
    };

    if !task.has_title_translation && !is_chinese_text(&task.title) {
        emit_translation_progress(&app, "start", entry_id, "title", None, None);
        match translate_service::translate_text(&task.settings, &task.title).await {
            Ok(output) => {
                save_translation(
                    &state,
                    entry_id,
                    "title",
                    &task.title,
                    &output.content,
                    &task.settings.model,
                    &output.usage,
                )?;
                emit_translation_progress(
                    &app,
                    "done",
                    entry_id,
                    "title",
                    Some(&output.content),
                    None,
                );
                emit_cost_updated(&app, &state);
                result.translated_title = true;
            }
            Err(err) => {
                emit_translation_progress(&app, "error", entry_id, "title", None, Some(&err));
                return Err(err);
            }
        }
    }

    if !task.has_summary_translation {
        let mut summary_text = task.summary.clone().and_then(|summary| {
            let metadata = article_service::extract_rss_metadata(Some(&summary));
            (!metadata.is_metadata_only).then_some(summary)
        });

        if summary_text.is_none() {
            match article_service::fetch_abstract(&task.title).await {
                Ok(Some(result)) => {
                    save_summary(&state, entry_id, &result.text, &result.source)?;
                    emit_summary_fetched(&app, entry_id, &result.text, &result.source);
                    summary_text = Some(result.text);
                }
                Ok(None) => {}
                Err(err) => return Err(format!("获取 Abstract 失败: {}", err)),
            }
        }

        if let Some(summary) = summary_text {
            if !is_chinese_text(&summary) {
                emit_translation_progress(&app, "start", entry_id, "summary", None, None);
                match translate_service::translate_text(&task.settings, &summary).await {
                    Ok(output) => {
                        save_translation(
                            &state,
                            entry_id,
                            "summary",
                            &summary,
                            &output.content,
                            &task.settings.model,
                            &output.usage,
                        )?;
                        emit_translation_progress(
                            &app,
                            "done",
                            entry_id,
                            "summary",
                            Some(&output.content),
                            None,
                        );
                        emit_cost_updated(&app, &state);
                        result.translated_summary = true;
                    }
                    Err(err) => {
                        emit_translation_progress(
                            &app,
                            "error",
                            entry_id,
                            "summary",
                            None,
                            Some(&err),
                        );
                        return Err(err);
                    }
                }
            }
        }
    }

    Ok(result)
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
