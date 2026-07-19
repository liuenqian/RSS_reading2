use crate::models::PmcGallerySearch;
use crate::services::pmc_gallery_service::{PmcGalleryFigure, PmcGallerySearchResult};
use rusqlite::{params, Connection};

#[derive(Debug, Clone)]
pub struct PmcGallerySearchInput<'a> {
    pub name: &'a str,
    pub mode: &'a str,
    pub question: Option<&'a str>,
    pub author_name: Option<&'a str>,
    pub affiliation: Option<&'a str>,
    pub start_date: Option<&'a str>,
    pub end_date: Option<&'a str>,
    pub query: &'a str,
    pub article_limit: usize,
    pub journal_filter: &'a str,
    pub impact_factor_filter: &'a str,
    pub jcr_quartile_filter: &'a str,
    pub cas_partition_filter: &'a str,
    pub top_filter: &'a str,
}

fn normalize_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

fn normalize_input(
    input: &PmcGallerySearchInput<'_>,
) -> Result<
    (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i64,
        String,
        String,
        String,
        String,
        String,
    ),
    String,
> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("PMC 图库检索名称需为 1–100 个字符".to_string());
    }
    let mode = input.mode.trim();
    if !matches!(mode, "topic" | "author") {
        return Err("PMC 图库检索模式无效".to_string());
    }
    let query = input.query.trim();
    if query.len() < 2 || query.len() > 2000 {
        return Err("PMC 图库检索式需为 2–2000 个字符".to_string());
    }
    if !(1..=20).contains(&input.article_limit) {
        return Err("PMC 图库扫描篇数需在 1–20 之间".to_string());
    }
    let filters = [
        (input.journal_filter, "期刊"),
        (input.impact_factor_filter, "影响因子"),
        (input.jcr_quartile_filter, "JCR 分区"),
        (input.cas_partition_filter, "中科院分区"),
        (input.top_filter, "Top"),
    ];
    for (value, label) in filters {
        if value.trim().is_empty() {
            return Err(format!("PMC 图库{}筛选条件不能为空", label));
        }
    }
    Ok((
        name.to_string(),
        mode.to_string(),
        normalize_text(input.question),
        normalize_text(input.author_name),
        normalize_text(input.affiliation),
        normalize_text(input.start_date),
        normalize_text(input.end_date),
        query.to_string(),
        input.article_limit as i64,
        input.journal_filter.trim().to_string(),
        input.impact_factor_filter.trim().to_string(),
        input.jcr_quartile_filter.trim().to_string(),
        input.cas_partition_filter.trim().to_string(),
        input.top_filter.trim().to_string(),
    ))
}

const SELECT_SQL: &str = "
    SELECT id, name, mode, question, author_name, affiliation, start_date, end_date,
           query, article_limit, journal_filter, impact_factor_filter, jcr_quartile_filter,
           cas_partition_filter, top_filter, created_at, updated_at, last_success_at,
           last_result_count, last_scanned_articles, last_figure_count, last_next_offset, last_has_more
    FROM pmc_gallery_searches";

fn map_search(row: &rusqlite::Row<'_>) -> rusqlite::Result<PmcGallerySearch> {
    Ok(PmcGallerySearch {
        id: row.get(0)?,
        name: row.get(1)?,
        mode: row.get(2)?,
        question: row.get(3)?,
        author_name: row.get(4)?,
        affiliation: row.get(5)?,
        start_date: row.get(6)?,
        end_date: row.get(7)?,
        query: row.get(8)?,
        article_limit: row.get(9)?,
        journal_filter: row.get(10)?,
        impact_factor_filter: row.get(11)?,
        jcr_quartile_filter: row.get(12)?,
        cas_partition_filter: row.get(13)?,
        top_filter: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        last_success_at: row.get(17)?,
        last_result_count: row.get(18)?,
        last_scanned_articles: row.get(19)?,
        last_figure_count: row.get(20)?,
        last_next_offset: row.get(21)?,
        last_has_more: row.get::<_, i64>(22)? != 0,
    })
}

pub fn get_search(conn: &Connection, id: i64) -> Result<PmcGallerySearch, String> {
    conn.query_row(&format!("{} WHERE id = ?1", SELECT_SQL), [id], map_search)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => "PMC 图库检索不存在".to_string(),
            other => format!("读取 PMC 图库检索失败: {}", other),
        })
}

pub fn list_searches(conn: &Connection) -> Result<Vec<PmcGallerySearch>, String> {
    let mut statement = conn
        .prepare(&format!("{} ORDER BY updated_at DESC, id DESC", SELECT_SQL))
        .map_err(|error| format!("查询 PMC 图库检索失败: {}", error))?;
    let rows = statement
        .query_map([], map_search)
        .map_err(|error| format!("查询 PMC 图库检索失败: {}", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("查询 PMC 图库检索失败: {}", error))
}

pub fn create_search(
    conn: &Connection,
    input: &PmcGallerySearchInput<'_>,
) -> Result<PmcGallerySearch, String> {
    let values = normalize_input(input)?;
    conn.execute(
        "INSERT INTO pmc_gallery_searches
         (name, mode, question, author_name, affiliation, start_date, end_date, query,
          article_limit, journal_filter, impact_factor_filter, jcr_quartile_filter, cas_partition_filter, top_filter)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![values.0, values.1, values.2, values.3, values.4, values.5, values.6, values.7, values.8, values.9, values.10, values.11, values.12, values.13],
    )
    .map_err(|error| format!("创建 PMC 图库检索失败: {}", error))?;
    get_search(conn, conn.last_insert_rowid())
}

pub fn update_search(
    conn: &Connection,
    id: i64,
    input: &PmcGallerySearchInput<'_>,
) -> Result<PmcGallerySearch, String> {
    let values = normalize_input(input)?;
    let changed = conn
        .execute(
            "UPDATE pmc_gallery_searches SET
             name = ?1, mode = ?2, question = ?3, author_name = ?4, affiliation = ?5,
             start_date = ?6, end_date = ?7, query = ?8, article_limit = ?9,
             journal_filter = ?10, impact_factor_filter = ?11, jcr_quartile_filter = ?12,
             cas_partition_filter = ?13, top_filter = ?14, updated_at = datetime('now')
             WHERE id = ?15",
            params![
                values.0, values.1, values.2, values.3, values.4, values.5, values.6, values.7,
                values.8, values.9, values.10, values.11, values.12, values.13, id
            ],
        )
        .map_err(|error| format!("更新 PMC 图库检索失败: {}", error))?;
    if changed == 0 {
        return Err("PMC 图库检索不存在".to_string());
    }
    get_search(conn, id)
}

pub fn rename_search(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("PMC 图库检索名称需为 1–100 个字符".to_string());
    }
    let changed = conn
        .execute(
            "UPDATE pmc_gallery_searches SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![name, id],
        )
        .map_err(|error| format!("重命名 PMC 图库检索失败: {}", error))?;
    (changed > 0)
        .then_some(())
        .ok_or_else(|| "PMC 图库检索不存在".to_string())
}

pub fn delete_search(conn: &Connection, id: i64) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM pmc_gallery_searches WHERE id = ?1", [id])
        .map_err(|error| format!("删除 PMC 图库检索失败: {}", error))?;
    (changed > 0)
        .then_some(())
        .ok_or_else(|| "PMC 图库检索不存在".to_string())
}

pub fn cache_result(
    conn: &mut Connection,
    id: i64,
    result: &PmcGallerySearchResult,
    replace: bool,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|error| format!("开始保存 PMC 图库缓存失败: {}", error))?;
    if replace {
        tx.execute("DELETE FROM pmc_gallery_figures WHERE search_id = ?1", [id])
            .map_err(|error| format!("清理 PMC 图库缓存失败: {}", error))?;
    }
    let position_base = if replace {
        0
    } else {
        tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM pmc_gallery_figures WHERE search_id = ?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("读取 PMC 图库缓存位置失败: {}", error))?
    };
    for (position, figure) in result.figures.iter().enumerate() {
        tx.execute(
            "INSERT INTO pmc_gallery_figures
             (search_id, pmcid, article_title, article_url, label, caption, image_url, license, figure_kind, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(search_id, image_url) DO UPDATE SET
             pmcid = excluded.pmcid, article_title = excluded.article_title,
             article_url = excluded.article_url, label = excluded.label,
             caption = excluded.caption, license = excluded.license,
             figure_kind = excluded.figure_kind, position = excluded.position",
            params![id, figure.pmcid, figure.article_title, figure.article_url, figure.label, figure.caption, figure.image_url, figure.license, figure.figure_kind, position_base + position as i64],
        )
        .map_err(|error| format!("保存 PMC 图库图片链接失败: {}", error))?;
    }
    let previous_scanned = if replace {
        0
    } else {
        tx.query_row(
            "SELECT last_scanned_articles FROM pmc_gallery_searches WHERE id = ?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("读取 PMC 图库分页状态失败: {}", error))?
    };
    let figure_count = tx
        .query_row(
            "SELECT COUNT(*) FROM pmc_gallery_figures WHERE search_id = ?1",
            [id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("统计 PMC 图库缓存失败: {}", error))?;
    tx.execute(
        "UPDATE pmc_gallery_searches SET last_success_at = datetime('now'),
         last_result_count = ?1, last_scanned_articles = ?2, last_figure_count = ?3,
         last_next_offset = ?4, last_has_more = ?5, updated_at = datetime('now') WHERE id = ?6",
        params![
            result.total_articles as i64,
            previous_scanned + result.scanned_articles as i64,
            figure_count,
            result.next_offset as i64,
            result.has_more as i64,
            id
        ],
    )
    .map_err(|error| format!("保存 PMC 图库检索统计失败: {}", error))?;
    tx.commit()
        .map_err(|error| format!("提交 PMC 图库缓存失败: {}", error))
}

pub fn load_cached_result(conn: &Connection, id: i64) -> Result<PmcGallerySearchResult, String> {
    let search = get_search(conn, id)?;
    let mut statement = conn
        .prepare("SELECT pmcid, article_title, article_url, label, caption, image_url, license, figure_kind FROM pmc_gallery_figures WHERE search_id = ?1 ORDER BY position, id")
        .map_err(|error| format!("查询 PMC 图库缓存失败: {}", error))?;
    let figures = statement
        .query_map([id], |row| {
            Ok(PmcGalleryFigure {
                pmcid: row.get(0)?,
                article_title: row.get(1)?,
                article_url: row.get(2)?,
                label: row.get(3)?,
                caption: row.get(4)?,
                image_url: row.get(5)?,
                license: row.get(6)?,
                figure_kind: row.get(7)?,
            })
        })
        .map_err(|error| format!("查询 PMC 图库缓存失败: {}", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取 PMC 图库缓存失败: {}", error))?;
    Ok(PmcGallerySearchResult {
        query: search.query,
        total_articles: search.last_result_count.max(0) as usize,
        scanned_articles: search.last_scanned_articles.max(0) as usize,
        skipped_articles: 0,
        filtered_articles: 0,
        next_offset: search.last_next_offset.max(0) as usize,
        has_more: search.last_has_more,
        figures,
    })
}
