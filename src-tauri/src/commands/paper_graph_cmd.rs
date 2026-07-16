use crate::db::DbState;
use crate::models::PaperGraph;
use crate::services::paper_graph_service;
use tauri::State;

#[tauri::command]
pub async fn get_paper_graph(
    state: State<'_, DbState>,
    entry_id: Option<i64>,
    paper_id: Option<String>,
) -> Result<PaperGraph, String> {
    let lookup = if let Some(raw) = paper_id.filter(|value| !value.trim().is_empty()) {
        paper_graph_service::PaperLookup::PaperId(raw.trim().to_string())
    } else {
        let entry_id = entry_id.ok_or_else(|| "缺少文献标识".to_string())?;
        let (title, doi, pmid, pmcid): (String, Option<String>, Option<String>, Option<String>) = {
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT title, doi, pmid, pmcid FROM entries WHERE id = ?1",
                [entry_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|e| format!("文献不存在: {}", e))?
        };
        paper_graph_service::PaperLookup::Entry {
            title,
            doi,
            pmid,
            pmcid,
        }
    };

    paper_graph_service::fetch_paper_graph(lookup).await
}
