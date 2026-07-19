use crate::db::DbState;
use crate::models::{
    DeepSeekSettings, KeptPubmedEntry, PubmedArticleRecord, PubmedAuthorRecord, PubmedExportMetric,
    PubmedPreviewAssessment, PubmedPreviewEntryAssessment, PubmedRetrievalOptions,
    PubmedScreeningSuggestion, PubmedSearch, PubmedSearchEntry, PubmedSearchMembershipLabel,
    PubmedSearchPage, PubmedSearchPreview, PubmedSearchProgress, PubmedSearchRunResult, TokenUsage,
};
use crate::services::{
    article_service, entry_identity_service, google_translate_xlsx_service, pubmed_service,
    reading_service, translate_service,
};
use roxmltree::{Document, Node, ParsingOptions};
use rusqlite::{params, Connection, OptionalExtension};
use rust_xlsxwriter::Workbook;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;
use tracing::warn;

const ESEARCH_URL: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH_URL: &str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const USER_AGENT: &str = "Cento/1.0 (PubMed literature manager)";
const REQUEST_INTERVAL: Duration = Duration::from_millis(350);
const PREVIEW_LIMIT: usize = 100;
const PREVIEW_SAMPLE_POPULATION_LIMIT: usize = 10_000;
const ASSESSMENT_BATCH_SIZE: usize = 20;
const ASSESSMENT_MAX_CONCURRENT: usize = 3;
const FETCH_BATCH_SIZE: usize = 100;
const SEARCH_PAGE_SIZE: usize = 1_000;
const PUBMED_MAX_RESULT_WINDOW: usize = 10_000;
const PROGRESS_EVENT: &str = "pubmed-search-progress";

static LAST_REQUEST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

pub async fn preview_query(
    query: &str,
    options: &PubmedRetrievalOptions,
) -> Result<PubmedSearchPreview, String> {
    let query = normalize_query(query)?;
    let options = normalize_retrieval_options(options)?;
    let client = pubmed_client()?;
    let page = search_page_with_options(
        &client,
        &query,
        0,
        PREVIEW_SAMPLE_POPULATION_LIMIT,
        true,
        &options,
    )
    .await?;
    let sampled_pmids = systematic_sample(&page.pmids, PREVIEW_LIMIT);
    let entries = fetch_records(&client, &sampled_pmids).await?;
    Ok(PubmedSearchPreview {
        query,
        total_count: page.total_count,
        pmids: sampled_pmids,
        entries,
    })
}

fn systematic_sample<T: Clone>(population: &[T], limit: usize) -> Vec<T> {
    if population.len() <= limit {
        return population.to_vec();
    }
    (0..limit)
        .map(|index| {
            let population_index = ((2 * index + 1) * population.len()) / (2 * limit);
            population[population_index.min(population.len() - 1)].clone()
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct RawPreviewAssessment {
    summary: String,
    #[serde(default)]
    suggested_query: Option<String>,
    #[serde(default)]
    entries: Vec<PubmedPreviewEntryAssessment>,
}

#[derive(Debug, Deserialize)]
struct RawQualitySynthesis {
    summary: String,
    recall_risk: String,
    recall_assessment: String,
    #[serde(default)]
    coverage_gaps: Vec<String>,
    #[serde(default)]
    suggested_query: Option<String>,
}

pub async fn assess_preview(
    settings: &DeepSeekSettings,
    question: &str,
    query: &str,
    entries: &[PubmedArticleRecord],
) -> Result<(PubmedPreviewAssessment, TokenUsage), String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("请先填写研究问题，再进行 AI 初判".to_string());
    }
    if question.chars().count() > 2_000 {
        return Err("研究问题不能超过 2000 个字符".to_string());
    }
    let query = normalize_query(query)?;
    if entries.is_empty() {
        return Err("没有可供 AI 初判的 PubMed 预览样本".to_string());
    }
    if entries.len() > PREVIEW_LIMIT {
        return Err(format!("AI 初判最多支持 {} 篇预览样本", PREVIEW_LIMIT));
    }

    let semaphore = Arc::new(Semaphore::new(ASSESSMENT_MAX_CONCURRENT));
    let mut tasks = JoinSet::new();
    for (batch_index, batch) in entries.chunks(ASSESSMENT_BATCH_SIZE).enumerate() {
        let semaphore = semaphore.clone();
        let settings = settings.clone();
        let question = question.to_string();
        let query = query.clone();
        let batch = batch.to_vec();
        tasks.spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| "AI 评估并发控制已关闭".to_string())?;
            let (assessment, usage) =
                assess_preview_batch(&settings, &question, &query, &batch).await?;
            Ok::<_, String>((batch_index, assessment, usage))
        });
    }

    let mut batches = Vec::new();
    while let Some(result) = tasks.join_next().await {
        let batch = result.map_err(|error| format!("AI 评估任务异常结束: {}", error))??;
        batches.push(batch);
    }
    batches.sort_by_key(|(index, _, _)| *index);

    let mut usage = TokenUsage::default();
    let mut assessment_by_pmid = HashMap::new();
    for (_, assessment, batch_usage) in &batches {
        add_token_usage(&mut usage, batch_usage);
        for item in &assessment.entries {
            assessment_by_pmid.insert(item.pmid.clone(), item.clone());
        }
    }
    let assessments = entries
        .iter()
        .map(|entry| {
            assessment_by_pmid
                .remove(&entry.pmid)
                .unwrap_or_else(|| PubmedPreviewEntryAssessment {
                    pmid: entry.pmid.clone(),
                    status: "maybe".to_string(),
                    reason: "AI 未返回该样本的明确判断".to_string(),
                })
        })
        .collect::<Vec<_>>();

    let relevant_count = assessments
        .iter()
        .filter(|item| item.status == "relevant")
        .count();
    let maybe_count = assessments
        .iter()
        .filter(|item| item.status == "maybe")
        .count();
    let irrelevant_count = assessments.len() - relevant_count - maybe_count;
    let batch_summaries = batches
        .iter()
        .map(|(_, assessment, _)| assessment)
        .collect::<Vec<_>>();
    let (quality, synthesis_usage) = match synthesize_quality_assessment(
        settings,
        question,
        &query,
        entries.len(),
        relevant_count,
        maybe_count,
        irrelevant_count,
        &batch_summaries,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => (
            fallback_quality_synthesis(
                entries.len(),
                relevant_count,
                maybe_count,
                irrelevant_count,
                &batch_summaries,
            ),
            TokenUsage::default(),
        ),
    };
    add_token_usage(&mut usage, &synthesis_usage);

    let abstract_count = entries
        .iter()
        .filter(|entry| {
            entry
                .abstract_text
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
        })
        .count();
    let (precision_low, precision_high) = wilson_interval(relevant_count, entries.len());
    let precision = relevant_count as f64 / entries.len() as f64;
    let verdict = derive_quality_verdict(relevant_count, irrelevant_count, entries.len());
    let suggested_query = quality.suggested_query.and_then(|candidate| {
        let candidate = candidate.trim();
        if candidate.is_empty() || candidate == query {
            return None;
        }
        normalize_query(candidate).ok()
    });

    Ok((
        PubmedPreviewAssessment {
            verdict: verdict.to_string(),
            summary: quality.summary.trim().chars().take(300).collect(),
            sample_size: entries.len(),
            abstract_count,
            relevant_count,
            maybe_count,
            irrelevant_count,
            precision_percent: round_one(precision * 100.0),
            precision_low_percent: round_one(precision_low * 100.0),
            precision_high_percent: round_one(precision_high * 100.0),
            recall_risk: normalize_recall_risk(&quality.recall_risk),
            recall_assessment: format!(
                "真实查全率无法仅由命中样本计算。{}",
                quality
                    .recall_assessment
                    .trim()
                    .chars()
                    .take(240)
                    .collect::<String>()
            ),
            coverage_gaps: quality
                .coverage_gaps
                .into_iter()
                .filter_map(|gap| {
                    let gap = gap.trim().chars().take(100).collect::<String>();
                    (!gap.is_empty()).then_some(gap)
                })
                .take(6)
                .collect(),
            suggested_query,
            entries: assessments,
        },
        usage,
    ))
}

pub async fn assess_author_preview(
    settings: &DeepSeekSettings,
    author_name: &str,
    affiliation: Option<&str>,
    query: &str,
    entries: &[PubmedArticleRecord],
) -> Result<(PubmedPreviewAssessment, TokenUsage), String> {
    let author_name = author_name.trim();
    if author_name.is_empty() {
        return Err("请先填写作者姓名，再进行 AI 作者评估".to_string());
    }
    if author_name.chars().count() > 200 {
        return Err("作者姓名不能超过 200 个字符".to_string());
    }
    let affiliation = affiliation.map(str::trim).filter(|value| !value.is_empty());
    let query = normalize_query(query)?;
    if entries.is_empty() {
        return Err("没有可供 AI 作者评估的 PubMed 预览样本".to_string());
    }
    if entries.len() > PREVIEW_LIMIT {
        return Err(format!("AI 作者评估最多支持 {} 篇预览样本", PREVIEW_LIMIT));
    }

    let mut assessments_by_pmid = HashMap::new();
    let mut usage = TokenUsage::default();
    let mut batch_summaries = Vec::new();
    let mut suggested_query = None;
    for batch in entries.chunks(ASSESSMENT_BATCH_SIZE) {
        let (assessment, batch_usage) =
            assess_author_preview_batch(settings, author_name, affiliation, &query, batch).await?;
        add_token_usage(&mut usage, &batch_usage);
        batch_summaries.push(assessment.summary.clone());
        if suggested_query.is_none() {
            suggested_query = assessment.suggested_query.clone();
        }
        for item in assessment.entries {
            assessments_by_pmid.insert(item.pmid.clone(), item);
        }
    }

    let assessments = entries
        .iter()
        .map(|entry| {
            assessments_by_pmid.remove(&entry.pmid).unwrap_or_else(|| {
                PubmedPreviewEntryAssessment {
                    pmid: entry.pmid.clone(),
                    status: "maybe".to_string(),
                    reason: "AI 未返回该样本的明确作者判断".to_string(),
                }
            })
        })
        .collect::<Vec<_>>();
    let relevant_count = assessments
        .iter()
        .filter(|item| item.status == "relevant")
        .count();
    let maybe_count = assessments
        .iter()
        .filter(|item| item.status == "maybe")
        .count();
    let irrelevant_count = assessments.len() - relevant_count - maybe_count;
    let total = assessments.len();
    let precision = relevant_count as f64 / total as f64;
    let (precision_low, precision_high) = wilson_interval(relevant_count, total);
    let suggested_query = suggested_query.and_then(|candidate| {
        let candidate = candidate.trim();
        if candidate.is_empty() || candidate == query {
            None
        } else {
            normalize_query(candidate).ok()
        }
    });
    let author_field_count = entries
        .iter()
        .filter(|entry| {
            entry
                .authors
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
        })
        .count();
    let affiliation_label = affiliation.unwrap_or("未提供参考机构");
    let summary = format!(
        "目标作者“{}”{}：抽样 {} 篇中，确认或高度可能属于目标作者 {} 篇，需要人工确认 {} 篇，判为同名作者 {} 篇。AI 已综合姓名变体、单位、共同作者、研究方向和发表时间；逐篇理由保留具体证据。",
        author_name,
        if affiliation.is_some() {
            format!("（机构：{}）", affiliation_label)
        } else {
            String::new()
        },
        total,
        relevant_count,
        maybe_count,
        irrelevant_count,
    );
    let batch_note = batch_summaries
        .into_iter()
        .filter(|summary| !summary.trim().is_empty())
        .take(2)
        .collect::<Vec<_>>()
        .join("；");
    let recall_assessment = format!(
        "真实查全率不能由当前命中样本直接计算。作者可能存在姓名变体、历史单位和研究方向变化；建议用 1–3 篇确认文献补充作者指纹后重新聚类。{}",
        batch_note.chars().take(100).collect::<String>()
    );

    Ok((
        PubmedPreviewAssessment {
            verdict: derive_quality_verdict(relevant_count, irrelevant_count, total).to_string(),
            summary,
            sample_size: total,
            abstract_count: author_field_count,
            relevant_count,
            maybe_count,
            irrelevant_count,
            precision_percent: round_one(precision * 100.0),
            precision_low_percent: round_one(precision_low * 100.0),
            precision_high_percent: round_one(precision_high * 100.0),
            recall_risk: "moderate".to_string(),
            recall_assessment,
            coverage_gaps: vec![
                "姓名可能存在不同罗马化、连字符或首字母写法".to_string(),
                "机构可能存在中英文名、简称、缩写、旧称或不同译法".to_string(),
                "作者可能经历机构变更，院系或附属医院写法也会变化".to_string(),
                "当前记录未必提供 ORCID 或逐位作者对应的单位".to_string(),
            ],
            suggested_query,
            entries: assessments,
        },
        usage,
    ))
}

fn build_author_assessment_context(
    author_name: &str,
    affiliation: Option<&str>,
    query: &str,
    entries: &[PubmedArticleRecord],
) -> String {
    let mut context = format!(
        "目标作者：{}\n参考机构：{}\n当前检索式：{}\n\n请先把候选文献按可能的作者身份聚类，再逐篇判断归属。不要逐篇孤立判断。\n\n证据优先级与规则：\n1. 明确提供的 ORCID 是最强证据；当前记录未单独提供 ORCID 时不得编造，ORCID 缺失也不能作为排除依据。\n2. 优先核对目标作者本人对应的单位；Affiliation 字段可能不完整、可能汇总多位作者单位，不能把任意共同作者的单位当作目标作者单位。\n3. 综合姓名全称、缩写、首字母、拼写和罗马化变体。\n4. 机构名称需要归一化比较：识别中文/英文全称、简称、缩写、不同翻译或罗马化、历史名称和单位更名，以及院系、实验室、附属医院、上级机构之间的隶属关系。例如 Soochow University 与 Suzhou University 可能指同一机构，不能仅因原始字符串不同就判为不同机构。参考机构不是每篇文献都必须出现。\n5. 重复出现的共同作者网络是重要身份线索。\n6. 题名和摘要中的研究方向、疾病与技术仅作为连续性的辅助证据，不能单独证明作者身份。\n7. 结合发表年份判断单位、共同作者和研究方向变化在时间上是否合理。\n8. 信息缺失或证据冲突时必须进入“需要确认”，不得强行确认或排除。\n",
        author_name,
        affiliation.unwrap_or("未提供，仅按其他身份线索评估"),
        query,
    );

    for (index, entry) in entries.iter().enumerate() {
        let abstract_text = entry.abstract_text.as_deref().unwrap_or("暂无摘要");
        let abstract_text = abstract_text.chars().take(1_000).collect::<String>();
        context.push_str(&format!(
            "\n[{}] PMID={}\nAuthors：{}\nAffiliation：{}\n发表日期：{}\n期刊：{}\n题名：{}\n摘要：{}\n",
            index + 1,
            entry.pmid,
            entry.authors.as_deref().unwrap_or("暂无作者字段"),
            entry.affiliation.as_deref().unwrap_or("暂无机构字段"),
            entry
                .publication_date
                .as_deref()
                .or(entry.publication_date_raw.as_deref())
                .unwrap_or("未知"),
            entry.journal.as_deref().unwrap_or("未知"),
            entry.title,
            abstract_text,
        ));
    }

    context.push_str(
        "\n四档判定与现有状态映射：\n- relevant：确认作者或高度可能。理由必须以“确认作者：”或“高度可能：”开头；确认作者需要强身份信息，高度可能需要至少两类相互独立且一致的证据。\n- maybe：需要确认。理由以“需要确认：”开头，说明缺失或冲突的证据。\n- irrelevant：同名作者。理由以“同名作者：”开头，说明相互冲突的单位、共同作者群、研究方向或时间线；不能仅因单位缺失或研究方向不同就排除。\n\nsummary 应概括识别出的可能身份组，并尽量写出各组的文献数、主要单位、常见共同作者和研究方向。suggested_query 以查全为优先，只补充可靠姓名变体；不要默认加入机构硬过滤。\n只返回 JSON：{\"summary\":\"中文总体判断，不超过180字\",\"suggested_query\":\"完整可运行的 PubMed 作者检索式；无需修改则为 null\",\"entries\":[{\"pmid\":\"...\",\"status\":\"relevant|maybe|irrelevant\",\"reason\":\"中文理由，不超过60字\"}]}。必须覆盖每个 PMID，不得编造输入中没有的信息。",
    );
    context
}

async fn assess_author_preview_batch(
    settings: &DeepSeekSettings,
    author_name: &str,
    affiliation: Option<&str>,
    query: &str,
    entries: &[PubmedArticleRecord],
) -> Result<(PubmedPreviewAssessment, TokenUsage), String> {
    let context = build_author_assessment_context(author_name, affiliation, query, entries);
    let output = translate_service::complete_with_messages(
        settings,
        vec![
            (
                "system".to_string(),
                "你是一名 PubMed 作者身份消歧专家。你会把候选文献聚类为可能的作者身份，按 ORCID、目标作者单位、姓名变体、历史单位、共同作者网络、研究方向和发表时间的证据组合判断。研究主题只能作为辅助证据。不得编造输入中没有的身份信息。".to_string(),
            ),
            ("user".to_string(), context),
        ],
        0.1,
        4_000,
    )
    .await?;
    let assessment = parse_preview_assessment(&output.content, query, entries)?;
    Ok((assessment, output.usage))
}

async fn assess_preview_batch(
    settings: &DeepSeekSettings,
    question: &str,
    query: &str,
    entries: &[PubmedArticleRecord],
) -> Result<(PubmedPreviewAssessment, TokenUsage), String> {
    let mut context = format!(
        "研究问题：\n{}\n\n当前 PubMed 检索式：\n{}\n\n请判断以下预览样本是否真正同时满足研究问题中的核心对象、疾病/场景和研究方法。仅出现宽泛关键词但缺少核心对象或方法时，应判为 irrelevant；摘要不足以确认时判为 maybe。\n",
        question, query
    );
    for (index, entry) in entries.iter().enumerate() {
        let abstract_text = entry.abstract_text.as_deref().unwrap_or("暂无摘要");
        let abstract_text = abstract_text.chars().take(1_800).collect::<String>();
        context.push_str(&format!(
            "\n[{}] PMID={}\n标题：{}\n期刊：{}\n摘要：{}\n",
            index + 1,
            entry.pmid,
            entry.title,
            entry.journal.as_deref().unwrap_or("未知"),
            abstract_text,
        ));
    }
    context.push_str(
        "\n只返回 JSON 对象，不要 Markdown。格式严格为：{\"summary\":\"中文总体判断，不超过200字\",\"suggested_query\":\"完整且可直接用于 PubMed 的改进检索式，若无需修改则为 null\",\"entries\":[{\"pmid\":\"...\",\"status\":\"relevant|maybe|irrelevant\",\"reason\":\"中文理由，不超过60字\"}]}。必须覆盖每个 PMID。建议检索式必须闭合全部引号、圆括号和字段标签。",
    );

    let output = translate_service::complete_with_messages(
        settings,
        vec![
            (
                "system".to_string(),
                "你是一名精通系统综述方法学与医学信息检索评估的信息检索专家，熟悉查准率与查全率在现实检索中的可行评估方式。你的任务是逐篇判断抽样结果是否符合研究问题；不得编造文献内容，也不得从命中样本虚构真实查全率。".to_string(),
            ),
            ("user".to_string(), context),
        ],
        0.1,
        4_800,
    )
    .await?;

    let assessment = parse_preview_assessment(&output.content, &query, entries)?;
    Ok((assessment, output.usage))
}

async fn synthesize_quality_assessment(
    settings: &DeepSeekSettings,
    question: &str,
    query: &str,
    sample_size: usize,
    relevant_count: usize,
    maybe_count: usize,
    irrelevant_count: usize,
    batches: &[&PubmedPreviewAssessment],
) -> Result<(RawQualitySynthesis, TokenUsage), String> {
    let batch_notes = batches
        .iter()
        .enumerate()
        .map(|(index, batch)| {
            format!(
                "批次{}：{}；建议式：{}",
                index + 1,
                batch.summary,
                batch.suggested_query.as_deref().unwrap_or("无")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let context = format!(
        "研究问题：\n{question}\n\n当前 PubMed 检索式：\n{query}\n\n抽样结果：共 {sample_size} 篇；relevant={relevant_count}，maybe={maybe_count}，irrelevant={irrelevant_count}。\n\n分批判断摘要：\n{batch_notes}\n\n请综合判断检索式的主题覆盖风险和主要缺口。真实查全率不能从命中样本直接计算，不得输出查全率百分比。只返回 JSON：{{\"summary\":\"总体质量判断，不超过300字\",\"recall_risk\":\"low|moderate|high\",\"recall_assessment\":\"查全风险依据及需要用已知核心文献验证的建议，不超过240字\",\"coverage_gaps\":[\"最多6项具体缺口\"],\"suggested_query\":\"完整可运行的 PubMed 改进检索式；无需修改则为 null\"}}。"
    );
    let output = translate_service::complete_with_messages(
        settings,
        vec![
            (
                "system".to_string(),
                "你是一名精通系统综述方法学与医学信息检索评估的信息检索专家。查准率可由命中结果抽样估计；没有独立已知相关文献集时，查全率只能做风险评估，不能伪造数值。优先保证检索敏感性，同时指出可改善精度的修改。".to_string(),
            ),
            ("user".to_string(), context),
        ],
        0.1,
        2_400,
    )
    .await?;
    let cleaned = output
        .content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed = serde_json::from_str(cleaned)
        .map_err(|error| format!("AI 质量评估结果不是有效 JSON: {}", error))?;
    Ok((parsed, output.usage))
}

fn add_token_usage(total: &mut TokenUsage, usage: &TokenUsage) {
    total.prompt_cache_hit_tokens += usage.prompt_cache_hit_tokens;
    total.prompt_cache_miss_tokens += usage.prompt_cache_miss_tokens;
    total.completion_tokens += usage.completion_tokens;
}

fn fallback_quality_synthesis(
    sample_size: usize,
    relevant_count: usize,
    maybe_count: usize,
    irrelevant_count: usize,
    batches: &[&PubmedPreviewAssessment],
) -> RawQualitySynthesis {
    RawQualitySynthesis {
        summary: format!(
            "已完成 {} 篇抽样判断：符合 {} 篇，待确认 {} 篇，不符合 {} 篇。AI 综合建议格式异常，请结合逐篇理由人工复核。",
            sample_size, relevant_count, maybe_count, irrelevant_count
        ),
        recall_risk: "moderate".to_string(),
        recall_assessment: "请用已知核心文献、相近系统综述纳入研究或补充检索结果检验漏检情况。"
            .to_string(),
        coverage_gaps: Vec::new(),
        suggested_query: batches
            .iter()
            .find_map(|assessment| assessment.suggested_query.clone()),
    }
}

fn derive_quality_verdict(relevant: usize, irrelevant: usize, total: usize) -> &'static str {
    if relevant * 100 >= total * 70 && irrelevant * 100 <= total * 20 {
        "good"
    } else if irrelevant * 100 >= total * 50 {
        "poor"
    } else {
        "refine"
    }
}

fn normalize_recall_risk(risk: &str) -> String {
    match risk.trim().to_ascii_lowercase().as_str() {
        "low" => "low",
        "high" => "high",
        _ => "moderate",
    }
    .to_string()
}

fn wilson_interval(successes: usize, total: usize) -> (f64, f64) {
    if total == 0 {
        return (0.0, 0.0);
    }
    let z = 1.959_963_984_540_054_f64;
    let n = total as f64;
    let proportion = successes as f64 / n;
    let denominator = 1.0 + z * z / n;
    let center = (proportion + z * z / (2.0 * n)) / denominator;
    let margin =
        z * ((proportion * (1.0 - proportion) / n + z * z / (4.0 * n * n)).sqrt()) / denominator;
    ((center - margin).max(0.0), (center + margin).min(1.0))
}

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn parse_preview_assessment(
    raw: &str,
    current_query: &str,
    entries: &[PubmedArticleRecord],
) -> Result<PubmedPreviewAssessment, String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: RawPreviewAssessment =
        serde_json::from_str(cleaned).map_err(|e| format!("AI 初判结果不是有效 JSON: {}", e))?;

    let allowed = entries
        .iter()
        .map(|entry| entry.pmid.as_str())
        .collect::<HashSet<_>>();
    let mut by_pmid = HashMap::new();
    for mut item in parsed.entries {
        if !allowed.contains(item.pmid.as_str()) || by_pmid.contains_key(&item.pmid) {
            continue;
        }
        if !matches!(item.status.as_str(), "relevant" | "maybe" | "irrelevant") {
            item.status = "maybe".to_string();
        }
        item.reason = item.reason.trim().chars().take(60).collect();
        by_pmid.insert(item.pmid.clone(), item);
    }
    if by_pmid.is_empty() {
        return Err("AI 未返回可匹配到预览样本的判断".to_string());
    }

    let assessments = entries
        .iter()
        .map(|entry| {
            by_pmid
                .remove(&entry.pmid)
                .unwrap_or_else(|| PubmedPreviewEntryAssessment {
                    pmid: entry.pmid.clone(),
                    status: "maybe".to_string(),
                    reason: "AI 未返回该样本的明确判断".to_string(),
                })
        })
        .collect::<Vec<_>>();
    let relevant_count = assessments
        .iter()
        .filter(|item| item.status == "relevant")
        .count();
    let maybe_count = assessments
        .iter()
        .filter(|item| item.status == "maybe")
        .count();
    let irrelevant_count = assessments.len() - relevant_count - maybe_count;
    let total = assessments.len();
    let verdict = derive_quality_verdict(relevant_count, irrelevant_count, total);
    let summary = parsed.summary.trim().chars().take(240).collect::<String>();
    if summary.is_empty() {
        return Err("AI 初判缺少总体判断".to_string());
    }
    let suggested_query = parsed.suggested_query.and_then(|query| {
        let query = query.trim();
        if query.is_empty() || query == current_query {
            return None;
        }
        normalize_query(query).ok()
    });
    let abstract_count = entries
        .iter()
        .filter(|entry| {
            entry
                .abstract_text
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
        })
        .count();
    let precision = relevant_count as f64 / total as f64;
    let (precision_low, precision_high) = wilson_interval(relevant_count, total);

    Ok(PubmedPreviewAssessment {
        verdict: verdict.to_string(),
        summary,
        sample_size: total,
        abstract_count,
        relevant_count,
        maybe_count,
        irrelevant_count,
        precision_percent: round_one(precision * 100.0),
        precision_low_percent: round_one(precision_low * 100.0),
        precision_high_percent: round_one(precision_high * 100.0),
        recall_risk: "moderate".to_string(),
        recall_assessment: "真实查全率无法仅由命中样本计算。".to_string(),
        coverage_gaps: Vec::new(),
        suggested_query,
        entries: assessments,
    })
}

pub fn pubmed_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("创建 PubMed 客户端失败: {}", e))
}

async fn search_page_with_options(
    client: &reqwest::Client,
    query: &str,
    retstart: usize,
    retmax: usize,
    use_history: bool,
    options: &PubmedRetrievalOptions,
) -> Result<PubmedSearchPage, String> {
    let query = normalize_query(query)?;
    throttle().await;
    let request =
        build_search_request_with_options(client, &query, retstart, retmax, use_history, options)?;
    let response = client
        .execute(request)
        .await
        .map_err(|e| format_reqwest_error("请求 PubMed ESearch 失败", &e))?;
    if !response.status().is_success() {
        return Err(format!("PubMed ESearch 返回 HTTP {}", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("解析 PubMed ESearch 响应失败: {}", e))?;
    parse_search_response(&body)
}

#[cfg(test)]
fn build_search_request(
    client: &reqwest::Client,
    query: &str,
    retstart: usize,
    retmax: usize,
    use_history: bool,
) -> Result<reqwest::Request, String> {
    build_search_request_with_options(
        client,
        query,
        retstart,
        retmax,
        use_history,
        &PubmedRetrievalOptions::default(),
    )
}

fn build_search_request_with_options(
    client: &reqwest::Client,
    query: &str,
    retstart: usize,
    retmax: usize,
    use_history: bool,
    options: &PubmedRetrievalOptions,
) -> Result<reqwest::Request, String> {
    let mut form = vec![
        ("db".to_string(), "pubmed".to_string()),
        ("term".to_string(), query.to_string()),
        ("retmode".to_string(), "json".to_string()),
        ("retstart".to_string(), retstart.to_string()),
        ("retmax".to_string(), retmax.to_string()),
        (
            "usehistory".to_string(),
            if use_history { "y" } else { "n" }.to_string(),
        ),
        (
            "sort".to_string(),
            pubmed_sort_parameter(&options.sort)?.to_string(),
        ),
    ];
    if let (Some(from), Some(to)) = (&options.date_from, &options.date_to) {
        form.extend([
            ("datetype".to_string(), "pdat".to_string()),
            ("mindate".to_string(), from.replace('-', "/")),
            ("maxdate".to_string(), to.replace('-', "/")),
        ]);
    }
    client
        .post(ESEARCH_URL)
        .form(&form)
        .build()
        .map_err(|e| format_reqwest_error("构建 PubMed ESearch 请求失败", &e))
}

fn pubmed_sort_parameter(sort: &str) -> Result<&'static str, String> {
    match sort {
        "relevance" => Ok("relevance"),
        "most_recent" => Ok("date_desc"),
        "publication_date" => Ok("pub_date"),
        "first_author" => Ok("Author"),
        "journal" => Ok("JournalName"),
        other => Err(format!("无效的 PubMed 排序方式: {}", other)),
    }
}

fn format_reqwest_error(context: &str, error: &reqwest::Error) -> String {
    let mut message = format!("{}: {}", context, error);
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        message.push_str(&format!("; {}", cause));
        source = cause.source();
    }
    message
}

pub async fn fetch_records(
    client: &reqwest::Client,
    pmids: &[String],
) -> Result<Vec<PubmedArticleRecord>, String> {
    if pmids.is_empty() {
        return Ok(Vec::new());
    }
    throttle().await;
    let ids = pmids.join(",");
    let response = client
        .get(EFETCH_URL)
        .query(&[("db", "pubmed"), ("id", ids.as_str()), ("retmode", "xml")])
        .send()
        .await
        .map_err(|e| format_reqwest_error("请求 PubMed EFetch 失败", &e))?;
    if !response.status().is_success() {
        return Err(format!("PubMed EFetch 返回 HTTP {}", response.status()));
    }
    let xml = response
        .text()
        .await
        .map_err(|e| format!("读取 PubMed EFetch 响应失败: {}", e))?;
    parse_pubmed_records(&xml)
}

pub fn create_search(
    conn: &Connection,
    name: &str,
    question: Option<&str>,
    query: &str,
) -> Result<PubmedSearch, String> {
    create_search_with_options(
        conn,
        name,
        question,
        query,
        &PubmedRetrievalOptions::default(),
    )
}

pub fn create_search_with_options(
    conn: &Connection,
    name: &str,
    question: Option<&str>,
    query: &str,
    options: &PubmedRetrievalOptions,
) -> Result<PubmedSearch, String> {
    let name = normalize_name(name)?;
    let query = normalize_query(query)?;
    let question = normalize_optional(question);
    let options = normalize_retrieval_options(options)?;
    conn.execute(
        "INSERT INTO pubmed_searches
            (name, question, query, retrieval_scope, retrieval_limit,
             retrieval_date_from, retrieval_date_to, retrieval_sort)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            name,
            question,
            query,
            options.scope,
            options.limit.map(|value| value as i64),
            options.date_from,
            options.date_to,
            options.sort,
        ],
    )
    .map_err(|e| format!("创建 PubMed 检索失败: {}", e))?;
    get_search(conn, conn.last_insert_rowid())
}

pub fn list_searches(conn: &Connection) -> Result<Vec<PubmedSearch>, String> {
    repair_initial_partial_snapshots(conn)?;
    let mut stmt = conn
        .prepare(&search_select_sql(
            "",
            "ORDER BY s.created_at DESC, s.id DESC",
        ))
        .map_err(|e| format!("查询 PubMed 检索失败: {}", e))?;
    let rows = stmt
        .query_map([], map_search)
        .map_err(|e| format!("查询 PubMed 检索失败: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("查询 PubMed 检索失败: {}", e))
}

pub fn get_search(conn: &Connection, id: i64) -> Result<PubmedSearch, String> {
    repair_initial_partial_snapshots(conn)?;
    conn.query_row(&search_select_sql("WHERE s.id = ?1", ""), [id], map_search)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => "PubMed 检索不存在".to_string(),
            other => format!("读取 PubMed 检索失败: {}", other),
        })
}

pub fn clone_search(conn: &Connection, id: i64, name: &str) -> Result<PubmedSearch, String> {
    let source = get_search(conn, id)?;
    create_search_with_options(
        conn,
        name,
        source.question.as_deref(),
        &source.query,
        &retrieval_options_from_search(&source),
    )
}

pub fn rename_search(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = normalize_name(name)?;
    let changed = conn
        .execute(
            "UPDATE pubmed_searches SET name = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|e| format!("重命名 PubMed 检索失败: {}", e))?;
    (changed > 0)
        .then_some(())
        .ok_or_else(|| "PubMed 检索不存在".to_string())
}

#[cfg(test)]
pub fn update_search(
    conn: &Connection,
    id: i64,
    name: &str,
    question: Option<&str>,
    query: &str,
) -> Result<PubmedSearch, String> {
    let current = get_search(conn, id)?;
    update_search_with_options(
        conn,
        id,
        name,
        question,
        query,
        &retrieval_options_from_search(&current),
    )
}

pub fn update_search_with_options(
    conn: &Connection,
    id: i64,
    name: &str,
    question: Option<&str>,
    query: &str,
    options: &PubmedRetrievalOptions,
) -> Result<PubmedSearch, String> {
    let name = normalize_name(name)?;
    let query = normalize_query(query)?;
    let question = question.map(str::trim).filter(|value| !value.is_empty());
    let options = normalize_retrieval_options(options)?;
    let changed = conn
        .execute(
            "UPDATE pubmed_searches SET
                name = ?1, question = ?2, query = ?3, retrieval_scope = ?4,
                retrieval_limit = ?5, retrieval_date_from = ?6,
                retrieval_date_to = ?7, retrieval_sort = ?8
             WHERE id = ?9",
            params![
                name,
                question,
                query,
                options.scope,
                options.limit.map(|value| value as i64),
                options.date_from,
                options.date_to,
                options.sort,
                id,
            ],
        )
        .map_err(|e| format!("更新 PubMed 检索失败: {}", e))?;
    if changed == 0 {
        return Err("PubMed 检索不存在".to_string());
    }
    get_search(conn, id)
}

pub fn delete_search(conn: &Connection, id: i64) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM pubmed_searches WHERE id = ?1", [id])
        .map_err(|e| format!("删除 PubMed 检索失败: {}", e))?;
    (changed > 0)
        .then_some(())
        .ok_or_else(|| "PubMed 检索不存在".to_string())
}

pub fn search_id_for_run(conn: &Connection, run_id: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT search_id FROM pubmed_search_runs WHERE id = ?1",
        [run_id],
        |row| row.get(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "PubMed 运行记录不存在".to_string(),
        other => format!("读取 PubMed 运行记录失败: {}", other),
    })
}

pub fn cancel_run(state: &DbState, run_id: i64) -> Result<(), String> {
    let cancellations = state
        .pubmed_run_cancellations
        .lock()
        .map_err(|e| e.to_string())?;
    let flag = cancellations
        .get(&run_id)
        .ok_or_else(|| "该 PubMed 运行当前不在执行".to_string())?;
    flag.store(true, Ordering::SeqCst);
    Ok(())
}

pub async fn run_search(
    app: &AppHandle,
    state: &DbState,
    search_id: i64,
    resume_run_id: Option<i64>,
) -> Result<PubmedSearchRunResult, String> {
    let (run_id, search, resume_pmids) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        if let Some(run_id) = resume_run_id {
            let (run_id, pmids) = prepare_resume(&conn, search_id, run_id)?;
            (run_id, get_search(&conn, search_id)?, Some(pmids))
        } else {
            let search = get_search(&conn, search_id)?;
            let run_id = begin_run(&conn, search_id)?;
            (run_id, search, None)
        }
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    register_run(state, search_id, run_id, cancel_flag.clone())?;

    let outcome = run_search_inner(
        app,
        state,
        search_id,
        run_id,
        &search,
        resume_pmids,
        &cancel_flag,
    )
    .await;

    if let Ok(mut cancellations) = state.pubmed_run_cancellations.lock() {
        cancellations.remove(&run_id);
    }
    outcome
}

async fn run_search_inner(
    app: &AppHandle,
    state: &DbState,
    search_id: i64,
    run_id: i64,
    search: &PubmedSearch,
    resume_pmids: Option<Vec<String>>,
    cancel_flag: &AtomicBool,
) -> Result<PubmedSearchRunResult, String> {
    let client = pubmed_client()?;
    let pmids = if let Some(pmids) = resume_pmids {
        pmids
    } else {
        match collect_search_pmids(&client, search, cancel_flag).await {
            Ok(pmids) => {
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                snapshot_run_items(&conn, run_id, &pmids)?;
                reuse_local_run_items(&conn, search_id, run_id, &pmids)?
            }
            Err(error) => {
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                finalize_run_error(&conn, run_id, "failed", &error)?;
                return Ok(run_result(&conn, run_id, Some(error))?);
            }
        }
    };

    let initial_result = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        run_result(&conn, run_id, None)?
    };
    emit_progress(
        app,
        run_id,
        search_id,
        initial_result.added_count + initial_result.reused_count + initial_result.failed_count,
        initial_result.matched_count,
        initial_result.added_count,
        initial_result.reused_count,
        initial_result.failed_count,
        None,
        "running",
    );

    for chunk in pmids.chunks(FETCH_BATCH_SIZE) {
        if cancel_flag.load(Ordering::SeqCst) {
            let conn = state.conn.lock().map_err(|e| e.to_string())?;
            finalize_run_error(&conn, run_id, "cancelled", "用户取消")?;
            let result = run_result(&conn, run_id, Some("用户取消".to_string()))?;
            emit_result_progress(app, &result);
            return Ok(result);
        }

        match fetch_records(&client, chunk).await {
            Ok(records) => {
                let conn = state.conn.lock().map_err(|e| e.to_string())?;
                persist_pubmed_records(&conn, search_id, run_id, chunk, records)?;
            }
            Err(batch_error) => {
                warn!(
                    search_id,
                    run_id,
                    pmids = chunk.len(),
                    error = %batch_error,
                    "PubMed 批量获取失败，降级为逐篇获取"
                );
                for pmid in chunk {
                    if cancel_flag.load(Ordering::SeqCst) {
                        let conn = state.conn.lock().map_err(|e| e.to_string())?;
                        finalize_run_error(&conn, run_id, "cancelled", "用户取消")?;
                        let result = run_result(&conn, run_id, Some("用户取消".to_string()))?;
                        emit_result_progress(app, &result);
                        return Ok(result);
                    }
                    match fetch_records(&client, std::slice::from_ref(pmid)).await {
                        Ok(records) => {
                            let conn = state.conn.lock().map_err(|e| e.to_string())?;
                            persist_pubmed_records(
                                &conn,
                                search_id,
                                run_id,
                                std::slice::from_ref(pmid),
                                records,
                            )?;
                        }
                        Err(error) => {
                            let conn = state.conn.lock().map_err(|e| e.to_string())?;
                            mark_run_item_failed(
                                &conn,
                                run_id,
                                pmid,
                                &format!("批量获取失败: {batch_error}; 单篇重试失败: {error}"),
                            )?;
                        }
                    }
                }
            }
        }
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let result = run_result(&conn, run_id, None)?;
        let processed = result.added_count + result.reused_count + result.failed_count;
        emit_progress(
            app,
            run_id,
            search_id,
            processed,
            result.matched_count,
            result.added_count,
            result.reused_count,
            result.failed_count,
            chunk.last().cloned(),
            "running",
        );
    }

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let failed = count_run_status(&conn, run_id, "failed")?;
    if failed == 0 {
        complete_run(&conn, search_id, run_id)?;
    } else {
        finalize_partial_run(&conn, search_id, run_id, "部分 PMID 获取失败，可继续重试")?;
    }
    let result = run_result(&conn, run_id, None)?;
    emit_result_progress(app, &result);
    Ok(result)
}

async fn collect_search_pmids(
    client: &reqwest::Client,
    search: &PubmedSearch,
    cancel_flag: &AtomicBool,
) -> Result<Vec<String>, String> {
    let options = normalize_retrieval_options(&retrieval_options_from_search(search))?;
    match options.scope.as_str() {
        "top" => {
            let limit = options.limit.unwrap_or(PUBMED_MAX_RESULT_WINDOW);
            collect_direct_pmids(client, &search.query, &options, limit, cancel_flag).await
        }
        "custom" => {
            let limit = options.limit.ok_or_else(|| "请输入抓取数量".to_string())?;
            if limit <= PUBMED_MAX_RESULT_WINDOW {
                collect_direct_pmids(client, &search.query, &options, limit, cancel_flag).await
            } else {
                collect_partitioned_pmids(client, &search.query, &options, Some(limit), cancel_flag)
                    .await
            }
        }
        "all" | "date_range" => {
            let first = search_page_with_options(
                client,
                &search.query,
                0,
                SEARCH_PAGE_SIZE,
                true,
                &options,
            )
            .await?;
            if first.total_count <= PUBMED_MAX_RESULT_WINDOW {
                collect_direct_pmids_from_first(client, &search.query, &options, first, cancel_flag)
                    .await
            } else {
                collect_partitioned_pmids(client, &search.query, &options, None, cancel_flag).await
            }
        }
        _ => Err(format!("无效的 PubMed 抓取范围: {}", options.scope)),
    }
}

async fn collect_direct_pmids(
    client: &reqwest::Client,
    query: &str,
    options: &PubmedRetrievalOptions,
    limit: usize,
    cancel_flag: &AtomicBool,
) -> Result<Vec<String>, String> {
    let mut limited_options = options.clone();
    limited_options.limit = Some(limit);
    let first = search_page_with_options(
        client,
        query,
        0,
        SEARCH_PAGE_SIZE.min(limit.max(1)),
        true,
        &limited_options,
    )
    .await?;
    let mut pmids =
        collect_direct_pmids_from_first(client, query, &limited_options, first, cancel_flag)
            .await?;
    pmids.truncate(limit);
    Ok(pmids)
}

async fn collect_direct_pmids_from_first(
    client: &reqwest::Client,
    query: &str,
    options: &PubmedRetrievalOptions,
    first: PubmedSearchPage,
    cancel_flag: &AtomicBool,
) -> Result<Vec<String>, String> {
    let requested = options
        .limit
        .unwrap_or(first.total_count)
        .min(first.total_count)
        .min(PUBMED_MAX_RESULT_WINDOW);
    let mut pmids = first.pmids;
    pmids.truncate(requested);
    while pmids.len() < requested {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("用户取消".to_string());
        }
        let remaining = requested - pmids.len();
        let page = search_page_with_options(
            client,
            query,
            pmids.len(),
            SEARCH_PAGE_SIZE.min(remaining),
            false,
            options,
        )
        .await?;
        if page.pmids.is_empty() {
            break;
        }
        pmids.extend(page.pmids);
    }
    let mut seen = HashSet::new();
    pmids.retain(|pmid| seen.insert(pmid.clone()));
    Ok(pmids)
}

async fn collect_partitioned_pmids(
    client: &reqwest::Client,
    query: &str,
    options: &PubmedRetrievalOptions,
    desired_limit: Option<usize>,
    cancel_flag: &AtomicBool,
) -> Result<Vec<String>, String> {
    let from = options
        .date_from
        .as_deref()
        .map(parse_iso_date)
        .transpose()?
        .unwrap_or(DateBound::new(1000, 1, 1)?);
    let to = options
        .date_to
        .as_deref()
        .map(parse_iso_date)
        .transpose()?
        .unwrap_or(DateBound::new(2100, 12, 31)?);
    let newest_first = matches!(options.sort.as_str(), "most_recent" | "publication_date");
    let mut windows = VecDeque::from([(from, to)]);
    let mut pmids = Vec::new();

    while let Some((window_from, window_to)) = windows.pop_front() {
        if desired_limit.is_some_and(|limit| pmids.len() >= limit) {
            break;
        }
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("用户取消".to_string());
        }
        let mut window_options = options.clone();
        window_options.limit = None;
        window_options.date_from = Some(window_from.to_iso());
        window_options.date_to = Some(window_to.to_iso());
        let count_page =
            search_page_with_options(client, query, 0, 0, false, &window_options).await?;
        if count_page.total_count == 0 {
            continue;
        }
        if count_page.total_count > PUBMED_MAX_RESULT_WINDOW {
            let (older, newer) = split_date_window(window_from, window_to).ok_or_else(|| {
                format!(
                    "{} 当日命中超过 10,000 篇，无法继续自动拆分",
                    window_from.to_iso()
                )
            })?;
            if newest_first {
                windows.push_front(older);
                windows.push_front(newer);
            } else {
                windows.push_front(newer);
                windows.push_front(older);
            }
            continue;
        }
        let remaining = desired_limit
            .map(|limit| limit.saturating_sub(pmids.len()))
            .unwrap_or(count_page.total_count);
        pmids.extend(
            collect_direct_pmids(
                client,
                query,
                &window_options,
                count_page.total_count.min(remaining),
                cancel_flag,
            )
            .await?,
        );
    }

    let mut seen = HashSet::new();
    pmids.retain(|pmid| seen.insert(pmid.clone()));
    if let Some(limit) = desired_limit {
        pmids.truncate(limit);
    }
    Ok(pmids)
}

fn begin_run(conn: &Connection, search_id: i64) -> Result<i64, String> {
    let running = conn
        .query_row(
            "SELECT id FROM pubmed_search_runs WHERE search_id = ?1 AND status = 'running' LIMIT 1",
            [search_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("检查 PubMed 运行状态失败: {}", e))?;
    if running.is_some() {
        return Err("该检索已有正在执行的更新".to_string());
    }
    conn.execute(
        "INSERT INTO pubmed_search_runs (search_id, status) VALUES (?1, 'running')",
        [search_id],
    )
    .map_err(|e| format!("创建 PubMed 运行失败: {}", e))?;
    conn.execute(
        "UPDATE pubmed_searches SET last_attempt_at = datetime('now') WHERE id = ?1",
        [search_id],
    )
    .map_err(|e| format!("更新检索时间失败: {}", e))?;
    Ok(conn.last_insert_rowid())
}

fn prepare_resume(
    conn: &Connection,
    search_id: i64,
    run_id: i64,
) -> Result<(i64, Vec<String>), String> {
    let actual_search_id = search_id_for_run(conn, run_id)?;
    if actual_search_id != search_id {
        return Err("运行记录不属于该检索".to_string());
    }
    let status: String = conn
        .query_row(
            "SELECT status FROM pubmed_search_runs WHERE id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取 PubMed 运行状态失败: {}", e))?;
    if !matches!(status.as_str(), "partial" | "failed" | "cancelled") {
        return Err("只有未完成的 PubMed 运行可以恢复".to_string());
    }
    conn.execute(
        "UPDATE pubmed_search_runs
         SET status = 'running', completed_at = NULL, error_message = NULL
         WHERE id = ?1",
        [run_id],
    )
    .map_err(|e| format!("恢复 PubMed 运行失败: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT pmid FROM pubmed_search_run_items
             WHERE run_id = ?1 AND status IN ('pending', 'failed') ORDER BY rank",
        )
        .map_err(|e| format!("读取待恢复 PMID 失败: {}", e))?;
    let pmids = stmt
        .query_map([run_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("读取待恢复 PMID 失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取待恢复 PMID 失败: {}", e))?;
    Ok((run_id, pmids))
}

fn register_run(
    state: &DbState,
    search_id: i64,
    run_id: i64,
    flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let other_run = conn
        .query_row(
            "SELECT id FROM pubmed_search_runs
             WHERE search_id = ?1 AND status = 'running' AND id != ?2 LIMIT 1",
            params![search_id, run_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("检查并发 PubMed 运行失败: {}", e))?;
    drop(conn);
    if other_run.is_some() {
        return Err("该检索已有正在执行的更新".to_string());
    }
    state
        .pubmed_run_cancellations
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id, flag);
    Ok(())
}

fn snapshot_run_items(conn: &Connection, run_id: i64, pmids: &[String]) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始保存 PMID 快照失败: {}", e))?;
    tx.execute(
        "DELETE FROM pubmed_search_run_items WHERE run_id = ?1",
        [run_id],
    )
    .map_err(|e| format!("清理 PMID 快照失败: {}", e))?;
    for (rank, pmid) in pmids.iter().enumerate() {
        tx.execute(
            "INSERT INTO pubmed_search_run_items (run_id, pmid, rank) VALUES (?1, ?2, ?3)",
            params![run_id, pmid, rank as i64 + 1],
        )
        .map_err(|e| format!("保存 PMID 快照失败: {}", e))?;
    }
    tx.execute(
        "UPDATE pubmed_search_runs SET matched_count = ?1 WHERE id = ?2",
        params![pmids.len() as i64, run_id],
    )
    .map_err(|e| format!("保存命中数量失败: {}", e))?;
    tx.commit()
        .map_err(|e| format!("提交 PMID 快照失败: {}", e))
}

fn reuse_local_run_items(
    conn: &Connection,
    search_id: i64,
    run_id: i64,
    pmids: &[String],
) -> Result<Vec<String>, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始复用本地 PubMed 文献失败: {}", e))?;
    let mut new_pmids = Vec::new();

    for pmid in pmids {
        let Some(entry_id) = entry_identity_service::resolve_entry_id(&tx, Some(pmid), None)?
        else {
            new_pmids.push(pmid.clone());
            continue;
        };
        let rank = tx
            .query_row(
                "SELECT rank FROM pubmed_search_run_items WHERE run_id = ?1 AND pmid = ?2",
                params![run_id, pmid],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("读取 PubMed rank 失败: {}", e))?;
        let existing_membership = tx
            .query_row(
                "SELECT 1 FROM pubmed_search_entries WHERE search_id = ?1 AND entry_id = ?2",
                params![search_id, entry_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("查询 PubMed 批次归属失败: {}", e))?
            .is_some();

        if existing_membership {
            tx.execute(
                "UPDATE pubmed_search_entries
                 SET last_seen_at = datetime('now')
                 WHERE search_id = ?1 AND entry_id = ?2",
                params![search_id, entry_id],
            )
            .map_err(|e| format!("更新 PubMed 批次归属失败: {}", e))?;
        } else {
            tx.execute(
                "INSERT INTO pubmed_search_entries
                    (search_id, entry_id, first_seen_run_id, is_current_match, pubmed_rank)
                 VALUES (?1, ?2, ?3, 0, ?4)",
                params![search_id, entry_id, run_id, rank],
            )
            .map_err(|e| format!("复用本地 PubMed 文献失败: {}", e))?;
        }
        tx.execute(
            "UPDATE pubmed_search_run_items
             SET status = ?1, entry_id = ?2, error_message = NULL
             WHERE run_id = ?3 AND pmid = ?4",
            params![
                if existing_membership {
                    "reused"
                } else {
                    "fetched"
                },
                entry_id,
                run_id,
                pmid
            ],
        )
        .map_err(|e| format!("更新 PubMed 运行项失败: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("提交本地 PubMed 复用失败: {}", e))?;
    Ok(new_pmids)
}

fn persist_pubmed_records(
    conn: &Connection,
    search_id: i64,
    run_id: i64,
    pmids: &[String],
    records: Vec<PubmedArticleRecord>,
) -> Result<(), String> {
    let by_pmid = records
        .into_iter()
        .map(|record| (record.pmid.clone(), record))
        .collect::<HashMap<_, _>>();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始 PubMed 批次事务失败: {}", e))?;
    for pmid in pmids {
        if let Some(record) = by_pmid.get(pmid) {
            match upsert_search_record(&tx, search_id, run_id, record) {
                Ok((entry_id, added)) => {
                    tx.execute(
                        "UPDATE pubmed_search_run_items
                         SET status = ?1, entry_id = ?2, error_message = NULL
                         WHERE run_id = ?3 AND pmid = ?4",
                        params![
                            if added { "fetched" } else { "reused" },
                            entry_id,
                            run_id,
                            pmid
                        ],
                    )
                    .map_err(|e| format!("更新 PubMed 运行项失败: {}", e))?;
                }
                Err(error) => mark_run_item_failed(&tx, run_id, pmid, &error)?,
            }
        } else {
            mark_run_item_failed(&tx, run_id, pmid, "EFetch 未返回该 PMID")?;
        }
    }
    tx.commit()
        .map_err(|e| format!("提交 PubMed 批次失败: {}", e))
}

fn upsert_search_record(
    conn: &Connection,
    search_id: i64,
    run_id: i64,
    record: &PubmedArticleRecord,
) -> Result<(i64, bool), String> {
    let existing =
        entry_identity_service::resolve_entry_id(conn, Some(&record.pmid), record.doi.as_deref())?;
    let entry_id = if let Some(entry_id) = existing {
        conn.execute(
            "UPDATE entries SET
                title = CASE WHEN trim(title) = '' OR title = '(无标题)' THEN ?1 ELSE title END,
                link = CASE WHEN trim(link) = '' THEN ?2 ELSE link END,
                summary = COALESCE(NULLIF(summary, ''), ?3),
                summary_source = CASE WHEN (summary IS NULL OR trim(summary) = '') AND ?3 IS NOT NULL THEN 'pubmed' ELSE summary_source END,
                author = COALESCE(NULLIF(?4, ''), author),
                published_at = COALESCE(NULLIF(published_at, ''), ?5),
                publication_date = COALESCE(NULLIF(publication_date, ''), ?5),
                publication_date_raw = COALESCE(NULLIF(publication_date_raw, ''), ?6),
                publication_date_precision = COALESCE(NULLIF(publication_date_precision, ''), ?7),
                publication_sort_key = COALESCE(publication_sort_key, ?8),
                source = COALESCE(NULLIF(source, ''), ?9),
                pmid = COALESCE(NULLIF(pmid, ''), ?10),
                pmcid = COALESCE(NULLIF(pmcid, ''), ?11),
                doi = COALESCE(NULLIF(doi, ''), ?12),
                affiliation = COALESCE(NULLIF(affiliation, ''), ?13),
                has_free_fulltext = CASE WHEN ?14 = 1 THEN 1 ELSE COALESCE(has_free_fulltext, 0) END
             WHERE id = ?15",
            params![
                record.title,
                format!("https://pubmed.ncbi.nlm.nih.gov/{}/", record.pmid),
                record.abstract_text,
                record.authors,
                record.publication_date,
                record.publication_date_raw,
                record.publication_date_precision,
                record.publication_sort_key,
                record.journal,
                record.pmid,
                record.pmcid,
                record.doi,
                record.affiliation,
                record.has_free_fulltext as i64,
                entry_id,
            ],
        )
        .map_err(|e| format!("更新 PubMed 文献失败: {}", e))?;
        entry_id
    } else {
        conn.execute(
            "INSERT INTO entries (
                feed_id, guid, title, link, summary, summary_source, author, published_at,
                publication_date, publication_date_raw, publication_date_precision,
                publication_sort_key, source, pmid, pmcid, doi, affiliation, has_free_fulltext
             ) VALUES (
                NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
             )",
            params![
                format!("pubmed:{}", record.pmid),
                record.title,
                format!("https://pubmed.ncbi.nlm.nih.gov/{}/", record.pmid),
                record.abstract_text,
                record.abstract_text.as_ref().map(|_| "pubmed"),
                record.authors,
                record.publication_date,
                record.publication_date_raw,
                record.publication_date_precision,
                record.publication_sort_key,
                record.journal,
                record.pmid,
                record.pmcid,
                record.doi,
                record.affiliation,
                record.has_free_fulltext as i64,
            ],
        )
        .map_err(|e| format!("保存 PubMed 文献失败: {}", e))?;
        conn.last_insert_rowid()
    };
    entry_identity_service::register_entry_identities(
        conn,
        entry_id,
        Some(&record.pmid),
        record.doi.as_deref(),
        "pubmed",
    )?;
    replace_structured_authors(conn, entry_id, &record.structured_authors)?;

    let existing_membership = conn
        .query_row(
            "SELECT 1 FROM pubmed_search_entries WHERE search_id = ?1 AND entry_id = ?2",
            params![search_id, entry_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("查询 PubMed 批次归属失败: {}", e))?
        .is_some();
    if existing_membership {
        conn.execute(
            "UPDATE pubmed_search_entries SET last_seen_at = datetime('now')
             WHERE search_id = ?1 AND entry_id = ?2",
            params![search_id, entry_id],
        )
        .map_err(|e| format!("更新 PubMed 批次归属失败: {}", e))?;
    } else {
        let rank = conn
            .query_row(
                "SELECT rank FROM pubmed_search_run_items WHERE run_id = ?1 AND pmid = ?2",
                params![run_id, record.pmid],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("读取 PubMed rank 失败: {}", e))?;
        conn.execute(
            "INSERT INTO pubmed_search_entries
                (search_id, entry_id, first_seen_run_id, is_current_match, pubmed_rank)
             VALUES (?1, ?2, ?3, 0, ?4)",
            params![search_id, entry_id, run_id, rank],
        )
        .map_err(|e| format!("保存 PubMed 批次归属失败: {}", e))?;
    }
    Ok((entry_id, !existing_membership))
}

fn replace_structured_authors(
    conn: &Connection,
    entry_id: i64,
    authors: &[PubmedAuthorRecord],
) -> Result<(), String> {
    if authors.is_empty() {
        return Ok(());
    }
    if authors
        .iter()
        .any(|author| author.display_name.trim().is_empty())
    {
        return Err("PubMed 作者姓名不能为空".to_string());
    }
    if authors
        .iter()
        .flat_map(|author| author.affiliations.iter())
        .any(|affiliation| affiliation.trim().is_empty())
    {
        return Err("PubMed 作者单位不能为空".to_string());
    }

    conn.execute_batch("SAVEPOINT replace_pubmed_structured_authors;")
        .map_err(|e| format!("开始保存 PubMed 作者结构失败: {}", e))?;
    let result = (|| -> Result<(), String> {
        conn.execute(
            "DELETE FROM pubmed_entry_authors WHERE entry_id = ?1",
            [entry_id],
        )
        .map_err(|e| format!("清理旧 PubMed 作者结构失败: {}", e))?;
        for author in authors {
            conn.execute(
                "INSERT INTO pubmed_entry_authors (
                    entry_id, author_order, last_name, fore_name, initials,
                    collective_name, display_name, orcid
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    entry_id,
                    author.author_order as i64,
                    author.last_name.as_deref(),
                    author.fore_name.as_deref(),
                    author.initials.as_deref(),
                    author.collective_name.as_deref(),
                    author.display_name.as_str(),
                    author.orcid.as_deref(),
                ],
            )
            .map_err(|e| format!("保存 PubMed 作者失败: {}", e))?;
            let entry_author_id = conn.last_insert_rowid();
            for (index, affiliation) in author.affiliations.iter().enumerate() {
                conn.execute(
                    "INSERT INTO pubmed_entry_author_affiliations (
                        entry_author_id, affiliation_order, raw_text
                     ) VALUES (?1, ?2, ?3)",
                    params![entry_author_id, index as i64 + 1, affiliation],
                )
                .map_err(|e| format!("保存 PubMed 作者单位失败: {}", e))?;
            }
        }
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("RELEASE SAVEPOINT replace_pubmed_structured_authors;")
            .map_err(|e| format!("提交 PubMed 作者结构失败: {}", e)),
        Err(error) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT replace_pubmed_structured_authors;
                 RELEASE SAVEPOINT replace_pubmed_structured_authors;",
            );
            Err(error)
        }
    }
}

fn complete_run(conn: &Connection, search_id: i64, run_id: i64) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始完成 PubMed 运行事务失败: {}", e))?;
    publish_run_snapshot(&tx, search_id, run_id)?;
    let (added, reused): (i64, i64) = tx
        .query_row(
            "SELECT
                SUM(CASE WHEN status = 'fetched' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'reused' THEN 1 ELSE 0 END)
             FROM pubmed_search_run_items WHERE run_id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                ))
            },
        )
        .map_err(|e| format!("统计 PubMed 运行失败: {}", e))?;
    tx.execute(
        "UPDATE pubmed_search_runs SET
            status = 'completed', completed_at = datetime('now'),
            added_count = ?1, reused_count = ?2, failed_count = 0, error_message = NULL
         WHERE id = ?3",
        params![added, reused, run_id],
    )
    .map_err(|e| format!("完成 PubMed 运行失败: {}", e))?;
    tx.execute(
        "UPDATE pubmed_searches SET
            last_success_at = datetime('now'),
            last_result_count = (SELECT matched_count FROM pubmed_search_runs WHERE id = ?2)
         WHERE id = ?1",
        params![search_id, run_id],
    )
    .map_err(|e| format!("更新 PubMed 检索成功时间失败: {}", e))?;
    tx.commit()
        .map_err(|e| format!("提交 PubMed 完成事务失败: {}", e))
}

fn publish_run_snapshot(conn: &Connection, search_id: i64, run_id: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO pubmed_search_entries
            (search_id, entry_id, first_seen_run_id, is_current_match, pubmed_rank)
         SELECT ?1, item.entry_id, ?2, 0, item.rank
         FROM pubmed_search_run_items item
         WHERE item.run_id = ?2 AND item.entry_id IS NOT NULL",
        params![search_id, run_id],
    )
    .map_err(|e| format!("补全 PubMed 批次归属失败: {}", e))?;
    conn.execute(
        "UPDATE pubmed_search_entries SET is_current_match = 0 WHERE search_id = ?1",
        [search_id],
    )
    .map_err(|e| format!("重置 PubMed 当前匹配失败: {}", e))?;
    conn.execute(
        "UPDATE pubmed_search_entries
         SET is_current_match = 1,
             pubmed_rank = (
                SELECT item.rank FROM pubmed_search_run_items item
                WHERE item.run_id = ?2 AND item.entry_id = pubmed_search_entries.entry_id
             )
         WHERE search_id = ?1 AND entry_id IN (
             SELECT entry_id FROM pubmed_search_run_items WHERE run_id = ?2 AND entry_id IS NOT NULL
         )",
        params![search_id, run_id],
    )
    .map_err(|e| format!("提交 PubMed 当前匹配失败: {}", e))?;
    Ok(())
}

fn publish_partial_run_successes(
    conn: &Connection,
    search_id: i64,
    run_id: i64,
    replace_current_snapshot: bool,
) -> Result<i64, String> {
    if replace_current_snapshot {
        publish_run_snapshot(conn, search_id, run_id)?;
    } else {
        conn.execute(
            "INSERT OR IGNORE INTO pubmed_search_entries
                (search_id, entry_id, first_seen_run_id, is_current_match, pubmed_rank)
             SELECT ?1, item.entry_id, ?2, 1, item.rank
             FROM pubmed_search_run_items item
             WHERE item.run_id = ?2 AND item.entry_id IS NOT NULL",
            params![search_id, run_id],
        )
        .map_err(|e| format!("补全 PubMed 部分成功归属失败: {}", e))?;
        conn.execute(
            "UPDATE pubmed_search_entries
             SET is_current_match = 1,
                 last_seen_at = datetime('now'),
                 pubmed_rank = (
                    SELECT item.rank FROM pubmed_search_run_items item
                    WHERE item.run_id = ?2 AND item.entry_id = pubmed_search_entries.entry_id
                 )
             WHERE search_id = ?1 AND entry_id IN (
                 SELECT entry_id FROM pubmed_search_run_items
                 WHERE run_id = ?2 AND entry_id IS NOT NULL
             )",
            params![search_id, run_id],
        )
        .map_err(|e| format!("发布 PubMed 部分成功结果失败: {}", e))?;
    }
    conn.query_row(
        "SELECT COUNT(*) FROM pubmed_search_entries
         WHERE search_id = ?1 AND is_current_match = 1",
        [search_id],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| format!("统计 PubMed 当前结果失败: {}", e))
}

fn finalize_partial_run(
    conn: &Connection,
    search_id: i64,
    run_id: i64,
    message: &str,
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始提交 PubMed 部分结果事务失败: {}", e))?;
    let has_successful_snapshot: bool = tx
        .query_row(
            "SELECT last_success_at IS NOT NULL FROM pubmed_searches WHERE id = ?1",
            [search_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取 PubMed 检索状态失败: {}", e))?;
    let (added, reused, failed) = run_item_counts(&tx, run_id)?;
    if added + reused > 0 {
        let visible_count =
            publish_partial_run_successes(&tx, search_id, run_id, !has_successful_snapshot)?;
        tx.execute(
            "UPDATE pubmed_searches SET
                last_success_at = datetime('now'), last_result_count = ?2
             WHERE id = ?1",
            params![search_id, visible_count],
        )
        .map_err(|e| format!("更新 PubMed 可用结果失败: {}", e))?;
    }
    tx.execute(
        "UPDATE pubmed_search_runs SET
            status = 'partial', completed_at = datetime('now'), added_count = ?1,
            reused_count = ?2, failed_count = ?3, error_message = ?4
         WHERE id = ?5",
        params![added, reused, failed, message, run_id],
    )
    .map_err(|e| format!("保存 PubMed 部分运行结果失败: {}", e))?;
    tx.commit()
        .map_err(|e| format!("提交 PubMed 部分结果事务失败: {}", e))
}

fn finalize_run_error(
    conn: &Connection,
    run_id: i64,
    status: &str,
    message: &str,
) -> Result<(), String> {
    let (added, reused, failed) = run_item_counts(conn, run_id)?;
    conn.execute(
        "UPDATE pubmed_search_runs SET
            status = ?1, completed_at = datetime('now'), added_count = ?2,
            reused_count = ?3, failed_count = ?4, error_message = ?5
         WHERE id = ?6",
        params![status, added, reused, failed, message, run_id],
    )
    .map_err(|e| format!("保存 PubMed 运行结果失败: {}", e))?;
    Ok(())
}

fn mark_run_item_failed(
    conn: &Connection,
    run_id: i64,
    pmid: &str,
    error: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE pubmed_search_run_items
         SET status = 'failed', error_message = ?1 WHERE run_id = ?2 AND pmid = ?3",
        params![error, run_id, pmid],
    )
    .map_err(|e| format!("记录 PMID 失败状态失败: {}", e))?;
    Ok(())
}

fn count_run_status(conn: &Connection, run_id: i64, status: &str) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM pubmed_search_run_items WHERE run_id = ?1 AND status = ?2",
        params![run_id, status],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as usize)
    .map_err(|e| format!("统计 PubMed 运行状态失败: {}", e))
}

fn run_item_counts(conn: &Connection, run_id: i64) -> Result<(i64, i64, i64), String> {
    conn.query_row(
        "SELECT
            SUM(CASE WHEN status = 'fetched' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'reused' THEN 1 ELSE 0 END),
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
         FROM pubmed_search_run_items WHERE run_id = ?1",
        [run_id],
        |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        },
    )
    .map_err(|e| format!("统计 PubMed 运行项失败: {}", e))
}

fn run_result(
    conn: &Connection,
    run_id: i64,
    error_override: Option<String>,
) -> Result<PubmedSearchRunResult, String> {
    let (added, reused, failed) = run_item_counts(conn, run_id)?;
    conn.query_row(
        "SELECT search_id, status, matched_count, error_message
         FROM pubmed_search_runs WHERE id = ?1",
        [run_id],
        |row| {
            Ok(PubmedSearchRunResult {
                run_id,
                search_id: row.get(0)?,
                status: row.get(1)?,
                matched_count: row.get::<_, i64>(2)? as usize,
                added_count: added as usize,
                reused_count: reused as usize,
                failed_count: failed as usize,
                error_message: error_override.or(row.get(3)?),
            })
        },
    )
    .map_err(|e| format!("读取 PubMed 运行结果失败: {}", e))
}

pub fn list_search_entries(
    conn: &Connection,
    search_id: i64,
) -> Result<Vec<PubmedSearchEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, pse.search_id, pse.screening_status, pse.first_seen_at, pse.last_seen_at,
                    pse.is_current_match, pse.pubmed_rank, e.title,
                    tt.translated_text, e.summary, ts.translated_text, e.author, e.source,
                    e.publication_date, e.publication_date_raw, e.publication_date_precision,
                    e.publication_sort_key, e.published_at, e.pmid, e.pmcid, e.doi, e.affiliation,
                    COALESCE(e.has_free_fulltext, 0), e.is_read, e.read_at,
                    EXISTS(SELECT 1 FROM reading_notes rn WHERE rn.entry_id = e.id),
                    (SELECT GROUP_CONCAT(tag, char(31)) FROM (
                        SELECT tag FROM entry_tags et WHERE et.entry_id = e.id ORDER BY lower(tag), tag
                    ))
             FROM pubmed_search_entries pse
             JOIN entries e ON e.id = pse.entry_id
             LEFT JOIN translations tt ON tt.entry_id = e.id AND tt.field = 'title' AND length(trim(tt.translated_text)) > 0
             LEFT JOIN translations ts ON ts.entry_id = e.id AND ts.field = 'summary' AND length(trim(ts.translated_text)) > 0
             WHERE pse.search_id = ?1 AND pse.is_current_match = 1
             ORDER BY e.publication_sort_key IS NULL, e.publication_sort_key DESC,
                      e.published_at DESC, pse.pubmed_rank ASC, e.id DESC",
        )
        .map_err(|e| format!("查询 PubMed 批次文献失败: {}", e))?;
    let rows = stmt
        .query_map([search_id], |row| {
            Ok(PubmedSearchEntry {
                entry_id: row.get(0)?,
                search_id: row.get(1)?,
                screening_status: row.get(2)?,
                first_seen_at: row.get(3)?,
                last_seen_at: row.get(4)?,
                is_current_match: row.get::<_, i64>(5)? != 0,
                pubmed_rank: row.get(6)?,
                title: row.get(7)?,
                title_translated: row.get(8)?,
                summary: row.get(9)?,
                summary_translated: row.get(10)?,
                authors: row.get(11)?,
                structured_authors: Vec::new(),
                journal: row.get(12)?,
                publication_date: row.get(13)?,
                publication_date_raw: row.get(14)?,
                publication_date_precision: row.get(15)?,
                publication_sort_key: row.get(16)?,
                published_at: row.get(17)?,
                pmid: row.get(18)?,
                pmcid: row.get(19)?,
                doi: row.get(20)?,
                affiliation: row.get(21)?,
                has_free_fulltext: row.get::<_, i64>(22)? != 0,
                is_read: row.get::<_, i64>(23)? != 0,
                read_at: row.get(24)?,
                has_reading_note: row.get::<_, i64>(25)? != 0,
                tags: parse_tag_list(row.get::<_, Option<String>>(26)?.as_deref()),
            })
        })
        .map_err(|e| format!("查询 PubMed 批次文献失败: {}", e))?;
    let mut entries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("查询 PubMed 批次文献失败: {}", e))?;
    load_search_entry_structured_authors(conn, search_id, &mut entries)?;
    Ok(entries)
}

fn load_search_entry_structured_authors(
    conn: &Connection,
    search_id: i64,
    entries: &mut [PubmedSearchEntry],
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT author.entry_id, author.author_order, author.last_name, author.fore_name,
                    author.initials, author.collective_name, author.display_name, author.orcid,
                    affiliation.raw_text
             FROM pubmed_entry_authors author
             JOIN pubmed_search_entries search_entry ON search_entry.entry_id = author.entry_id
             LEFT JOIN pubmed_entry_author_affiliations affiliation
                    ON affiliation.entry_author_id = author.id
             WHERE search_entry.search_id = ?1 AND search_entry.is_current_match = 1
             ORDER BY author.entry_id, author.author_order, affiliation.affiliation_order",
        )
        .map_err(|e| format!("准备读取结构化作者失败: {}", e))?;
    let rows = stmt
        .query_map([search_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)? as usize,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|e| format!("读取结构化作者失败: {}", e))?;
    let mut by_entry: HashMap<i64, Vec<PubmedAuthorRecord>> = HashMap::new();
    for row in rows {
        let (entry_id, author_order, last_name, fore_name, initials, collective_name, display_name, orcid, affiliation) =
            row.map_err(|e| format!("解析结构化作者失败: {}", e))?;
        let authors = by_entry.entry(entry_id).or_default();
        if authors.last().is_none_or(|author| author.author_order != author_order) {
            authors.push(PubmedAuthorRecord {
                author_order,
                last_name,
                fore_name,
                initials,
                collective_name,
                display_name,
                orcid,
                affiliations: Vec::new(),
            });
        }
        if let Some(affiliation) = affiliation.filter(|value| !value.trim().is_empty()) {
            if let Some(author) = authors.last_mut() {
                author.affiliations.push(affiliation);
            }
        }
    }
    for entry in entries {
        entry.structured_authors = by_entry.remove(&entry.entry_id).unwrap_or_default();
    }
    Ok(())
}

fn parse_tag_list(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split('\u{1f}')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub fn set_screening_status(
    conn: &Connection,
    search_id: i64,
    entry_ids: &[i64],
    status: &str,
) -> Result<Vec<PubmedSearchEntry>, String> {
    validate_screening_status(status)?;
    let entry_ids = entry_ids.iter().copied().collect::<HashSet<_>>();
    if entry_ids.is_empty() {
        return Err("请至少选择一篇文献".to_string());
    }
    if entry_ids.len() > 500 {
        return Err("单次最多筛选 500 篇文献".to_string());
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始筛选事务失败: {}", e))?;
    for entry_id in &entry_ids {
        let exists = tx
            .query_row(
                "SELECT 1 FROM pubmed_search_entries WHERE search_id = ?1 AND entry_id = ?2",
                params![search_id, entry_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| format!("验证批次文献失败: {}", e))?
            .is_some();
        if !exists {
            return Err(format!("文献 {} 不属于当前检索批次", entry_id));
        }
    }
    for entry_id in &entry_ids {
        tx.execute(
            "UPDATE pubmed_search_entries
             SET screening_status = ?1,
                 screened_at = CASE WHEN ?1 = 'unreviewed' THEN NULL ELSE datetime('now') END
             WHERE search_id = ?2 AND entry_id = ?3",
            params![status, search_id, entry_id],
        )
        .map_err(|e| format!("更新筛选状态失败: {}", e))?;
    }
    tx.commit().map_err(|e| format!("提交筛选失败: {}", e))?;

    let mut entries = list_search_entries(conn, search_id)?;
    entries.retain(|entry| entry_ids.contains(&entry.entry_id));
    Ok(entries)
}

pub fn get_author_identity_state(
    conn: &Connection,
    search_id: i64,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT state_json FROM pubmed_author_identity_states WHERE search_id = ?1",
        [search_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取作者身份状态失败: {}", e))
}

pub fn save_author_identity_state(
    conn: &Connection,
    search_id: i64,
    state_json: &str,
) -> Result<(), String> {
    if state_json.len() > 512 * 1024 {
        return Err("作者身份状态不能超过 512 KB".to_string());
    }
    let parsed: Value = serde_json::from_str(state_json)
        .map_err(|e| format!("作者身份状态不是有效 JSON: {}", e))?;
    if !parsed.is_object() {
        return Err("作者身份状态必须是 JSON 对象".to_string());
    }
    let search_exists = conn
        .query_row(
            "SELECT 1 FROM pubmed_searches WHERE id = ?1",
            [search_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("验证作者检索失败: {}", e))?
        .is_some();
    if !search_exists {
        return Err("作者检索不存在".to_string());
    }
    conn.execute(
        "INSERT INTO pubmed_author_identity_states
            (search_id, schema_version, state_json, updated_at)
         VALUES (?1, 1, ?2, datetime('now'))
         ON CONFLICT(search_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            state_json = excluded.state_json,
            updated_at = excluded.updated_at",
        params![search_id, state_json],
    )
    .map_err(|e| format!("保存作者身份状态失败: {}", e))?;
    Ok(())
}

pub fn apply_screening_suggestions(
    conn: &Connection,
    search_id: i64,
    suggestions: &[PubmedScreeningSuggestion],
) -> Result<Vec<PubmedSearchEntry>, String> {
    if suggestions.is_empty() {
        return Err("没有可应用的筛选建议".to_string());
    }
    let mut seen = HashSet::new();
    for suggestion in suggestions {
        if !seen.insert(suggestion.entry_id) {
            return Err(format!("文献 {} 出现重复建议", suggestion.entry_id));
        }
        validate_screening_status(&suggestion.status)?;
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开始应用 AI 建议事务失败: {}", e))?;
    for suggestion in suggestions {
        let changed = tx
            .execute(
                "UPDATE pubmed_search_entries
                 SET screening_status = ?1,
                     screened_at = CASE WHEN ?1 = 'unreviewed' THEN NULL ELSE datetime('now') END
                 WHERE search_id = ?2 AND entry_id = ?3",
                params![suggestion.status, search_id, suggestion.entry_id],
            )
            .map_err(|e| format!("应用 AI 筛选建议失败: {}", e))?;
        if changed == 0 {
            return Err(format!("文献 {} 不属于当前检索批次", suggestion.entry_id));
        }
    }
    tx.commit()
        .map_err(|e| format!("提交 AI 筛选建议失败: {}", e))?;
    let ids = suggestions
        .iter()
        .map(|suggestion| suggestion.entry_id)
        .collect::<HashSet<_>>();
    let mut entries = list_search_entries(conn, search_id)?;
    entries.retain(|entry| ids.contains(&entry.entry_id));
    Ok(entries)
}

pub fn list_kept_entries(conn: &Connection) -> Result<Vec<KeptPubmedEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT pse.entry_id, pse.search_id, s.name, pse.screening_status
             FROM pubmed_search_entries pse
             JOIN pubmed_searches s ON s.id = pse.search_id
             WHERE pse.entry_id IN (
                 SELECT DISTINCT entry_id FROM pubmed_search_entries WHERE screening_status = 'keep'
             )
             ORDER BY pse.entry_id, lower(s.name), s.id",
        )
        .map_err(|e| format!("查询保留文献批次失败: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                PubmedSearchMembershipLabel {
                    search_id: row.get(1)?,
                    search_name: row.get(2)?,
                    screening_status: row.get(3)?,
                },
            ))
        })
        .map_err(|e| format!("查询保留文献批次失败: {}", e))?;
    let mut memberships: HashMap<i64, Vec<PubmedSearchMembershipLabel>> = HashMap::new();
    for row in rows {
        let (entry_id, label) = row.map_err(|e| format!("读取保留文献批次失败: {}", e))?;
        memberships.entry(entry_id).or_default().push(label);
    }

    let mut kept = Vec::with_capacity(memberships.len());
    for (entry_id, labels) in memberships {
        let preferred = labels
            .iter()
            .find(|label| label.screening_status == "keep")
            .ok_or_else(|| "保留文献缺少保留批次".to_string())?;
        let entry = list_search_entries(conn, preferred.search_id)?
            .into_iter()
            .find(|entry| entry.entry_id == entry_id)
            .ok_or_else(|| format!("无法读取保留文献 {}", entry_id))?;
        kept.push(KeptPubmedEntry {
            entry,
            searches: labels,
        });
    }
    kept.sort_by(|left, right| {
        right
            .entry
            .publication_sort_key
            .cmp(&left.entry.publication_sort_key)
            .then_with(|| right.entry.first_seen_at.cmp(&left.entry.first_seen_at))
    });
    Ok(kept)
}

pub fn export_entries(
    conn: &Connection,
    path: &Path,
    format: &str,
    search_id: Option<i64>,
    entry_ids: &[i64],
    fields: &[String],
    metrics: &[PubmedExportMetric],
) -> Result<usize, String> {
    if entry_ids.is_empty() {
        return Err("没有可导出的文献".to_string());
    }
    if fields.is_empty() {
        return Err("请至少选择一个导出字段".to_string());
    }
    for field in fields {
        export_field_label(field)?;
    }

    let ordered = selected_export_entries(conn, search_id, entry_ids)?;

    let metric_by_id = metrics
        .iter()
        .map(|metric| (metric.entry_id, metric))
        .collect::<HashMap<_, _>>();
    let mut notes_by_id = HashMap::new();
    if fields.iter().any(|field| field == "reading_notes") {
        for entry in &ordered {
            let notes = reading_service::list_reading_notes(conn, entry.entry_id)?;
            let content = notes
                .into_iter()
                .map(|note| format!("【{}】\n{}", note.profile_name, note.content))
                .collect::<Vec<_>>()
                .join("\n\n");
            notes_by_id.insert(entry.entry_id, content);
        }
    }
    match format.trim().to_ascii_lowercase().as_str() {
        "csv" => fs::write(
            path,
            render_export_csv(&ordered, fields, &metric_by_id, &notes_by_id)?,
        ),
        "xlsx" => fs::write(
            path,
            render_export_xlsx(&ordered, fields, &metric_by_id, &notes_by_id)?,
        ),
        "txt" => fs::write(
            path,
            render_export_txt(&ordered, fields, &metric_by_id, &notes_by_id)?,
        ),
        other => return Err(format!("不支持的导出格式: {}", other)),
    }
    .map_err(|e| format!("写入导出文件失败: {}", e))?;
    Ok(ordered.len())
}

pub fn export_google_translate_entries(
    conn: &Connection,
    path: &Path,
    search_id: Option<i64>,
    entry_ids: &[i64],
    include_title: bool,
    include_summary: bool,
    only_untranslated: bool,
) -> Result<google_translate_xlsx_service::GoogleTranslateExportReport, String> {
    if !include_title && !include_summary {
        return Err("请至少选择标题或摘要".to_string());
    }
    let entries = selected_export_entries(conn, search_id, entry_ids)?;
    let mut rows = Vec::new();
    let mut title_count = 0;
    let mut summary_count = 0;
    let mut skipped_translated = 0;
    let mut missing_summaries = 0;

    for entry in &entries {
        if include_title {
            if only_untranslated
                && entry
                    .title_translated
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
            {
                skipped_translated += 1;
            } else if !entry.title.trim().is_empty() {
                rows.push(google_translate_xlsx_service::GoogleTranslateXlsxRow {
                    entry_id: entry.entry_id,
                    field: "title".to_string(),
                    original_hash: google_translate_xlsx_service::original_text_hash(&entry.title),
                    text: entry.title.clone(),
                });
                title_count += 1;
            }
        }
        if include_summary {
            if only_untranslated
                && entry
                    .summary_translated
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
            {
                skipped_translated += 1;
                continue;
            }
            let summary = entry.summary.as_deref().filter(|value| {
                !value.trim().is_empty()
                    && !article_service::extract_rss_metadata(Some(value)).is_metadata_only
            });
            if let Some(summary) = summary {
                rows.push(google_translate_xlsx_service::GoogleTranslateXlsxRow {
                    entry_id: entry.entry_id,
                    field: "summary".to_string(),
                    original_hash: google_translate_xlsx_service::original_text_hash(summary),
                    text: summary.to_string(),
                });
                summary_count += 1;
            } else {
                missing_summaries += 1;
            }
        }
    }
    let paths = google_translate_xlsx_service::write_workbook_chunks(path, &rows)?;
    Ok(google_translate_xlsx_service::GoogleTranslateExportReport {
        file_paths: paths
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        article_count: entries.len(),
        row_count: rows.len(),
        title_count,
        summary_count,
        skipped_translated,
        missing_summaries,
    })
}

fn selected_export_entries(
    conn: &Connection,
    search_id: Option<i64>,
    entry_ids: &[i64],
) -> Result<Vec<PubmedSearchEntry>, String> {
    if entry_ids.is_empty() {
        return Err("没有可导出的文献".to_string());
    }
    let available = match search_id {
        Some(search_id) => list_search_entries(conn, search_id)?,
        None => list_kept_entries(conn)?
            .into_iter()
            .map(|item| item.entry)
            .collect(),
    };
    let mut by_id = available
        .into_iter()
        .map(|entry| (entry.entry_id, entry))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::with_capacity(entry_ids.len());
    let mut seen = HashSet::new();
    for entry_id in entry_ids {
        if !seen.insert(*entry_id) {
            continue;
        }
        let entry = by_id
            .remove(entry_id)
            .ok_or_else(|| format!("文献 {} 不属于当前导出范围", entry_id))?;
        ordered.push(entry);
    }
    Ok(ordered)
}

fn render_export_csv(
    entries: &[PubmedSearchEntry],
    fields: &[String],
    metrics: &HashMap<i64, &PubmedExportMetric>,
    notes: &HashMap<i64, String>,
) -> Result<String, String> {
    let mut rows = Vec::with_capacity(entries.len() + 1);
    rows.push(
        fields
            .iter()
            .map(|field| export_field_label(field).map(csv_cell))
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
    );

    for (index, entry) in entries.iter().enumerate() {
        let metric = metrics.get(&entry.entry_id).copied();
        let values = fields
            .iter()
            .map(|field| export_field_value(field, index, entry, metric, notes))
            .collect::<Result<Vec<_>, _>>()?;
        rows.push(
            values
                .iter()
                .map(|value| csv_cell(value))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    Ok(format!("\u{feff}{}\r\n", rows.join("\r\n")))
}

fn render_export_xlsx(
    entries: &[PubmedSearchEntry],
    fields: &[String],
    metrics: &HashMap<i64, &PubmedExportMetric>,
    notes: &HashMap<i64, String>,
) -> Result<Vec<u8>, String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();

    for (column_index, field) in fields.iter().enumerate() {
        let column = u16::try_from(column_index).map_err(|_| "Excel 导出字段过多".to_string())?;
        worksheet
            .write_string(0, column, xlsx_export_field_label(field)?)
            .map_err(|e| format!("写入 Excel 表头失败: {}", e))?;
    }

    for (entry_index, entry) in entries.iter().enumerate() {
        let row = u32::try_from(entry_index + 1).map_err(|_| "Excel 导出行数过多".to_string())?;
        let metric = metrics.get(&entry.entry_id).copied();
        for (column_index, field) in fields.iter().enumerate() {
            let column =
                u16::try_from(column_index).map_err(|_| "Excel 导出字段过多".to_string())?;
            let value = xlsx_export_field_value(field, entry_index, entry, metric, notes)?;
            worksheet
                .write_string(row, column, &value)
                .map_err(|e| format!("写入 Excel 内容失败: {}", e))?;
        }
    }

    workbook
        .save_to_buffer()
        .map_err(|e| format!("生成 Excel 文件失败: {}", e))
}

fn xlsx_export_field_label(field: &str) -> Result<&'static str, String> {
    match field {
        "title" => Ok("Title"),
        "summary" => Ok("Abstract"),
        "authors" => Ok("Authors"),
        "journal" => Ok("Journal.Book"),
        "publication_date" => Ok("Publication.Year"),
        "pmid" => Ok("PMID"),
        "doi" => Ok("DOI"),
        "impact_factor" => Ok("IF"),
        "jcr_quartile" => Ok("Q"),
        "cas_partition" => Ok("B"),
        _ => export_field_label(field),
    }
}

fn xlsx_export_field_value(
    field: &str,
    index: usize,
    entry: &PubmedSearchEntry,
    metric: Option<&PubmedExportMetric>,
    notes: &HashMap<i64, String>,
) -> Result<String, String> {
    if field == "publication_date" {
        let date = entry.publication_date.as_deref().unwrap_or_default();
        return Ok(date.chars().take(4).collect());
    }
    export_field_value(field, index, entry, metric, notes)
}

fn render_export_txt(
    entries: &[PubmedSearchEntry],
    selected_fields: &[String],
    metrics: &HashMap<i64, &PubmedExportMetric>,
    notes: &HashMap<i64, String>,
) -> Result<String, String> {
    let blocks = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let metric = metrics.get(&entry.entry_id).copied();
            let mut fields = selected_fields
                .iter()
                .map(|field| {
                    Ok((
                        export_field_code(field)?,
                        export_field_value(field, index, entry, metric, notes)?,
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            fields.retain(|(_, value)| !value.trim().is_empty());
            Ok(fields
                .into_iter()
                .map(|(label, value)| format!("{}- {}", label, clean_txt_value(&value)))
                .collect::<Vec<_>>()
                .join("\n"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(blocks.join("\n\n") + "\n")
}

fn export_field_label(field: &str) -> Result<&'static str, String> {
    match field {
        "number" => Ok("编号"),
        "screening_status" => Ok("筛选状态"),
        "title_translated" => Ok("标题中文"),
        "title" => Ok("标题英文"),
        "summary_translated" => Ok("摘要中文"),
        "summary" => Ok("摘要英文"),
        "authors" => Ok("作者"),
        "journal" => Ok("期刊"),
        "publication_date" => Ok("发表日期"),
        "publication_date_raw" => Ok("发表日期原文"),
        "first_seen_at" => Ok("加入批次时间"),
        "pmid" => Ok("PMID"),
        "pmcid" => Ok("PMCID"),
        "doi" => Ok("DOI"),
        "affiliation" => Ok("作者单位"),
        "has_free_fulltext" => Ok("免费全文"),
        "is_read" => Ok("已读"),
        "tags" => Ok("标签"),
        "impact_factor" => Ok("影响因子"),
        "jcr_quartile" => Ok("JCR分区"),
        "cas_partition" => Ok("中科院分区"),
        "is_top" => Ok("Top期刊"),
        "reading_notes" => Ok("阅读笔记"),
        other => Err(format!("不支持的导出字段: {}", other)),
    }
}

fn export_field_code(field: &str) -> Result<&'static str, String> {
    match field {
        "number" => Ok("NO  "),
        "screening_status" => Ok("STS "),
        "title_translated" => Ok("TT  "),
        "title" => Ok("TI  "),
        "summary_translated" => Ok("ABZH"),
        "summary" => Ok("AB  "),
        "authors" => Ok("FAU "),
        "journal" => Ok("JT  "),
        "publication_date" => Ok("DP  "),
        "publication_date_raw" => Ok("DPR "),
        "first_seen_at" => Ok("FST "),
        "pmid" => Ok("PMID"),
        "pmcid" => Ok("PMC "),
        "doi" => Ok("AID "),
        "affiliation" => Ok("AD  "),
        "has_free_fulltext" => Ok("FREE"),
        "is_read" => Ok("READ"),
        "tags" => Ok("TAG "),
        "impact_factor" => Ok("IF  "),
        "jcr_quartile" => Ok("JCR "),
        "cas_partition" => Ok("CAS "),
        "is_top" => Ok("TOP "),
        "reading_notes" => Ok("NOTE"),
        other => Err(format!("不支持的导出字段: {}", other)),
    }
}

fn export_field_value(
    field: &str,
    index: usize,
    entry: &PubmedSearchEntry,
    metric: Option<&PubmedExportMetric>,
    notes: &HashMap<i64, String>,
) -> Result<String, String> {
    let value = match field {
        "number" => (index + 1).to_string(),
        "screening_status" => screening_status_label(&entry.screening_status).to_string(),
        "title_translated" => entry.title_translated.clone().unwrap_or_default(),
        "title" => entry.title.clone(),
        "summary_translated" => entry.summary_translated.clone().unwrap_or_default(),
        "summary" => entry.summary.clone().unwrap_or_default(),
        "authors" => entry.authors.clone().unwrap_or_default(),
        "journal" => entry.journal.clone().unwrap_or_default(),
        "publication_date" => entry.publication_date.clone().unwrap_or_default(),
        "publication_date_raw" => entry.publication_date_raw.clone().unwrap_or_default(),
        "first_seen_at" => entry.first_seen_at.clone(),
        "pmid" => entry.pmid.clone().unwrap_or_default(),
        "pmcid" => entry.pmcid.clone().unwrap_or_default(),
        "doi" => entry.doi.clone().unwrap_or_default(),
        "affiliation" => entry.affiliation.clone().unwrap_or_default(),
        "has_free_fulltext" => if entry.has_free_fulltext {
            "是"
        } else {
            "否"
        }
        .to_string(),
        "is_read" => if entry.is_read { "是" } else { "否" }.to_string(),
        "tags" => entry.tags.join("; "),
        "impact_factor" => metric
            .and_then(|item| item.impact_factor.clone())
            .unwrap_or_default(),
        "jcr_quartile" => metric
            .and_then(|item| item.jcr_quartile.clone())
            .unwrap_or_default(),
        "cas_partition" => metric
            .and_then(|item| item.cas_partition.clone())
            .unwrap_or_default(),
        "is_top" => metric
            .and_then(|item| item.is_top)
            .map(|value| if value { "是" } else { "否" }.to_string())
            .unwrap_or_default(),
        "reading_notes" => notes.get(&entry.entry_id).cloned().unwrap_or_default(),
        other => return Err(format!("不支持的导出字段: {}", other)),
    };
    Ok(value)
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn clean_txt_value(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn screening_status_label(status: &str) -> &str {
    match status {
        "keep" => "保留",
        "maybe" => "待定",
        "exclude" => "排除",
        _ => "未筛选",
    }
}

pub fn validate_screening_status(status: &str) -> Result<(), String> {
    if matches!(status, "unreviewed" | "keep" | "maybe" | "exclude") {
        Ok(())
    } else {
        Err(format!("无效的筛选状态: {}", status))
    }
}

fn search_select_sql(filter: &str, order: &str) -> String {
    format!(
        "SELECT s.id, s.name, s.question, s.query, s.retrieval_scope,
                s.retrieval_limit, s.retrieval_date_from, s.retrieval_date_to,
                s.retrieval_sort, s.created_at, s.last_attempt_at,
                s.last_success_at, s.last_result_count,
                COALESCE((SELECT r.added_count FROM pubmed_search_runs r
                          WHERE r.search_id = s.id AND r.status = 'completed'
                          ORDER BY r.id DESC LIMIT 1), 0),
                COUNT(pse.entry_id),
                SUM(CASE WHEN pse.screening_status = 'unreviewed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN pse.screening_status = 'keep' THEN 1 ELSE 0 END),
                SUM(CASE WHEN pse.screening_status = 'maybe' THEN 1 ELSE 0 END),
                SUM(CASE WHEN pse.screening_status = 'exclude' THEN 1 ELSE 0 END)
         FROM pubmed_searches s
         LEFT JOIN pubmed_search_entries pse
                ON pse.search_id = s.id AND pse.is_current_match = 1
         {filter}
         GROUP BY s.id {order}"
    )
}

fn repair_initial_partial_snapshots(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, r.id
             FROM pubmed_searches s
             JOIN pubmed_search_runs r ON r.search_id = s.id
             WHERE s.last_success_at IS NULL
               AND r.status = 'partial'
               AND r.id = (
                   SELECT latest.id FROM pubmed_search_runs latest
                   WHERE latest.search_id = s.id
                   ORDER BY latest.id DESC LIMIT 1
               )
               AND EXISTS (
                   SELECT 1 FROM pubmed_search_run_items item
                   WHERE item.run_id = r.id AND item.entry_id IS NOT NULL
               )",
        )
        .map_err(|e| format!("检查 PubMed 历史部分结果失败: {}", e))?;
    let candidates = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| format!("读取 PubMed 历史部分结果失败: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 PubMed 历史部分结果失败: {}", e))?;
    drop(stmt);

    for (search_id, run_id) in candidates {
        finalize_partial_run(conn, search_id, run_id, "部分 PMID 获取失败，可继续重试")?;
    }
    Ok(())
}

fn map_search(row: &rusqlite::Row<'_>) -> rusqlite::Result<PubmedSearch> {
    Ok(PubmedSearch {
        id: row.get(0)?,
        name: row.get(1)?,
        question: row.get(2)?,
        query: row.get(3)?,
        retrieval_scope: row.get(4)?,
        retrieval_limit: row.get(5)?,
        retrieval_date_from: row.get(6)?,
        retrieval_date_to: row.get(7)?,
        retrieval_sort: row.get(8)?,
        created_at: row.get(9)?,
        last_attempt_at: row.get(10)?,
        last_success_at: row.get(11)?,
        last_result_count: row.get(12)?,
        last_added_count: row.get(13)?,
        total_entries: row.get(14)?,
        unreviewed_count: row.get::<_, Option<i64>>(15)?.unwrap_or(0),
        keep_count: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
        maybe_count: row.get::<_, Option<i64>>(17)?.unwrap_or(0),
        exclude_count: row.get::<_, Option<i64>>(18)?.unwrap_or(0),
    })
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    run_id: i64,
    search_id: i64,
    processed: usize,
    total: usize,
    added: usize,
    reused: usize,
    failed: usize,
    current_pmid: Option<String>,
    status: &str,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        PubmedSearchProgress {
            run_id,
            search_id,
            processed,
            total,
            added,
            reused,
            failed,
            current_pmid,
            status: status.to_string(),
        },
    );
}

fn emit_result_progress(app: &AppHandle, result: &PubmedSearchRunResult) {
    emit_progress(
        app,
        result.run_id,
        result.search_id,
        result.added_count + result.reused_count + result.failed_count,
        result.matched_count,
        result.added_count,
        result.reused_count,
        result.failed_count,
        None,
        &result.status,
    );
}

fn normalize_name(name: &str) -> Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("检索名称不能为空".to_string());
    }
    if name.chars().count() > 80 {
        return Err("检索名称不能超过 80 个字符".to_string());
    }
    Ok(name)
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub fn parse_search_response(body: &Value) -> Result<PubmedSearchPage, String> {
    let result = body
        .get("esearchresult")
        .ok_or_else(|| "PubMed ESearch 响应缺少 esearchresult".to_string())?;
    if let Some(error) = result.get("ERROR").and_then(Value::as_str) {
        return Err(format!("PubMed 检索式错误: {}", error));
    }
    let total_count = result
        .get("count")
        .and_then(Value::as_str)
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|e| format!("解析 PubMed 结果数量失败: {}", e))?;
    let pmids = result
        .get("idlist")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(PubmedSearchPage {
        total_count,
        pmids,
        web_env: result
            .get("webenv")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        query_key: result
            .get("querykey")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
    })
}

pub fn parse_pubmed_records(xml: &str) -> Result<Vec<PubmedArticleRecord>, String> {
    let options = ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    };
    let document = Document::parse_with_options(xml, options)
        .map_err(|e| format!("解析 PubMed XML 失败: {}", e))?;
    document
        .descendants()
        .filter(|node| node.has_tag_name("PubmedArticle"))
        .map(parse_article)
        .collect()
}

fn parse_article(article: Node<'_, '_>) -> Result<PubmedArticleRecord, String> {
    let pmid = descendant_text(article, "PMID")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "PubMed 记录缺少 PMID".to_string())?;
    let title = descendant_text(article, "ArticleTitle")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "(无标题)".to_string());
    let abstract_parts = article
        .descendants()
        .filter(|node| node.has_tag_name("AbstractText"))
        .filter_map(|node| {
            let text = node_text(node);
            if text.is_empty() {
                None
            } else if let Some(label) = node.attribute("Label").filter(|label| !label.is_empty()) {
                Some(format!("{}: {}", label, text))
            } else {
                Some(text)
            }
        })
        .collect::<Vec<_>>();
    let abstract_text = (!abstract_parts.is_empty()).then(|| abstract_parts.join("\n\n"));
    let structured_authors = parse_authors(article);
    let authors = (!structured_authors.is_empty()).then(|| {
        structured_authors
            .iter()
            .map(|author| author.display_name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    });
    let journal =
        descendant_text(article, "Title").or_else(|| descendant_text(article, "ISOAbbreviation"));
    let affiliation = descendant_text(article, "Affiliation");
    let doi = article_id(article, "doi");
    let pmcid = article_id(article, "pmc").map(|value| value.to_ascii_uppercase());
    let date = parse_publication_date(article);

    Ok(PubmedArticleRecord {
        pmid,
        pmcid: pmcid.clone(),
        doi,
        title,
        abstract_text,
        authors,
        structured_authors,
        journal,
        affiliation,
        publication_date: date.iso,
        publication_date_raw: date.raw,
        publication_date_precision: date.precision,
        publication_sort_key: date.sort_key,
        has_free_fulltext: pmcid.is_some(),
    })
}

#[derive(Default)]
struct ParsedDate {
    iso: Option<String>,
    raw: Option<String>,
    precision: Option<String>,
    sort_key: Option<i64>,
}

fn parse_publication_date(article: Node<'_, '_>) -> ParsedDate {
    let date_node = article
        .descendants()
        .find(|node| node.has_tag_name("ArticleDate"))
        .or_else(|| {
            article
                .descendants()
                .find(|node| node.has_tag_name("PubDate"))
        });
    let Some(date_node) = date_node else {
        return ParsedDate::default();
    };
    let year = direct_child_text(date_node, "Year").and_then(|value| value.parse::<i32>().ok());
    let month_raw = direct_child_text(date_node, "Month");
    let month = month_raw.as_deref().and_then(parse_month);
    let day = direct_child_text(date_node, "Day").and_then(|value| value.parse::<u32>().ok());
    let medline = direct_child_text(date_node, "MedlineDate");

    if let Some(year) = year {
        let raw = [
            Some(year.to_string()),
            month_raw.clone(),
            day.map(|value| value.to_string()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        if let Some(season_month) = month_raw.as_deref().and_then(parse_season_month) {
            return ParsedDate {
                iso: Some(format!("{year:04}")),
                raw: Some(raw),
                precision: Some("season".to_string()),
                sort_key: Some(year as i64 * 10_000 + season_month as i64 * 100),
            };
        }
        return match (month, day) {
            (Some(month), Some(day)) => ParsedDate {
                iso: Some(format!("{year:04}-{month:02}-{day:02}")),
                raw: Some(raw),
                precision: Some("day".to_string()),
                sort_key: Some(year as i64 * 10_000 + month as i64 * 100 + day as i64),
            },
            (Some(month), None) => ParsedDate {
                iso: Some(format!("{year:04}-{month:02}")),
                raw: Some(raw),
                precision: Some("month".to_string()),
                sort_key: Some(year as i64 * 10_000 + month as i64 * 100),
            },
            _ => ParsedDate {
                iso: Some(format!("{year:04}")),
                raw: Some(raw),
                precision: Some("year".to_string()),
                sort_key: Some(year as i64 * 10_000),
            },
        };
    }

    if let Some(raw) = medline {
        let year = raw
            .split(|c: char| !c.is_ascii_digit())
            .find(|part| part.len() == 4)
            .and_then(|part| part.parse::<i32>().ok());
        return ParsedDate {
            iso: year.map(|value| format!("{value:04}")),
            raw: Some(raw),
            precision: Some("medline".to_string()),
            sort_key: year.map(|value| value as i64 * 10_000),
        };
    }
    ParsedDate::default()
}

fn parse_month(raw: &str) -> Option<u32> {
    let normalized = raw.trim().to_ascii_lowercase();
    normalized
        .parse::<u32>()
        .ok()
        .filter(|value| (1..=12).contains(value))
        .or_else(|| {
            [
                "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            ]
            .iter()
            .position(|month| normalized.starts_with(month))
            .map(|index| index as u32 + 1)
            .or_else(|| parse_season_month(&normalized))
        })
}

fn parse_season_month(raw: &str) -> Option<u32> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "winter" => Some(1),
        "spring" => Some(4),
        "summer" => Some(7),
        "fall" | "autumn" => Some(10),
        _ => None,
    }
}

fn parse_authors(article: Node<'_, '_>) -> Vec<PubmedAuthorRecord> {
    article
        .descendants()
        .filter(|node| node.has_tag_name("Author"))
        .enumerate()
        .filter_map(|(index, author)| {
            let collective = direct_child_text(author, "CollectiveName");
            let last_name = direct_child_text(author, "LastName");
            let fore_name = direct_child_text(author, "ForeName");
            let initials = direct_child_text(author, "Initials");
            let display_name = if let Some(collective) = collective.as_deref() {
                collective.to_string()
            } else {
                let given_name = fore_name.as_deref().or(initials.as_deref()).unwrap_or("");
                format!("{} {}", given_name, last_name.as_deref().unwrap_or(""))
                    .trim()
                    .to_string()
            };
            if display_name.is_empty() {
                return None;
            }
            let orcid = author
                .children()
                .find(|child| {
                    child.has_tag_name("Identifier")
                        && child
                            .attribute("Source")
                            .is_some_and(|source| source.eq_ignore_ascii_case("ORCID"))
                })
                .map(node_text)
                .and_then(normalize_orcid);
            let affiliations = author
                .children()
                .filter(|child| child.has_tag_name("AffiliationInfo"))
                .filter_map(|info| descendant_text(info, "Affiliation"))
                .collect();
            Some(PubmedAuthorRecord {
                author_order: index + 1,
                last_name,
                fore_name,
                initials,
                collective_name: collective,
                display_name,
                orcid,
                affiliations,
            })
        })
        .collect()
}

fn normalize_orcid(value: String) -> Option<String> {
    let value = value
        .trim()
        .trim_start_matches("https://orcid.org/")
        .trim_start_matches("http://orcid.org/")
        .trim()
        .to_string();
    (!value.is_empty()).then_some(value)
}

fn article_id(article: Node<'_, '_>, kind: &str) -> Option<String> {
    article
        .descendants()
        .find(|node| {
            node.has_tag_name("ArticleId")
                && node
                    .attribute("IdType")
                    .is_some_and(|value| value.eq_ignore_ascii_case(kind))
        })
        .map(node_text)
        .filter(|value| !value.is_empty())
}

fn descendant_text(node: Node<'_, '_>, name: &str) -> Option<String> {
    node.descendants()
        .find(|child| child.has_tag_name(name))
        .map(node_text)
        .filter(|value| !value.is_empty())
}

fn direct_child_text(node: Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|child| child.has_tag_name(name))
        .map(node_text)
        .filter(|value| !value.is_empty())
}

fn node_text(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|child| child.is_text())
        .filter_map(|child| child.text())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn retrieval_options_from_search(search: &PubmedSearch) -> PubmedRetrievalOptions {
    PubmedRetrievalOptions {
        scope: search.retrieval_scope.clone(),
        limit: search
            .retrieval_limit
            .and_then(|value| usize::try_from(value).ok()),
        date_from: search.retrieval_date_from.clone(),
        date_to: search.retrieval_date_to.clone(),
        sort: search.retrieval_sort.clone(),
    }
}

fn normalize_retrieval_options(
    options: &PubmedRetrievalOptions,
) -> Result<PubmedRetrievalOptions, String> {
    pubmed_sort_parameter(&options.sort)?;
    let mut normalized = options.clone();
    normalized.date_from = normalize_optional(options.date_from.as_deref());
    normalized.date_to = normalize_optional(options.date_to.as_deref());
    match normalized.scope.as_str() {
        "all" => {
            normalized.limit = None;
            normalized.date_from = None;
            normalized.date_to = None;
        }
        "top" => {
            normalized.limit = Some(PUBMED_MAX_RESULT_WINDOW);
            normalized.date_from = None;
            normalized.date_to = None;
        }
        "custom" => {
            let limit = normalized
                .limit
                .ok_or_else(|| "请输入抓取数量".to_string())?;
            if limit == 0 || i64::try_from(limit).is_err() {
                return Err("自定义抓取数量必须是正整数".to_string());
            }
            match (
                normalized.date_from.as_deref(),
                normalized.date_to.as_deref(),
            ) {
                (None, None) => {}
                (Some(from), Some(to)) => {
                    if parse_iso_date(from)? > parse_iso_date(to)? {
                        return Err("开始日期不能晚于结束日期".to_string());
                    }
                }
                _ => return Err("请选择完整的开始和结束日期".to_string()),
            }
        }
        "date_range" => {
            normalized.limit = None;
            let from = normalized
                .date_from
                .as_deref()
                .ok_or_else(|| "请选择开始日期".to_string())?;
            let to = normalized
                .date_to
                .as_deref()
                .ok_or_else(|| "请选择结束日期".to_string())?;
            if parse_iso_date(from)? > parse_iso_date(to)? {
                return Err("开始日期不能晚于结束日期".to_string());
            }
        }
        other => return Err(format!("无效的 PubMed 抓取范围: {}", other)),
    }
    Ok(normalized)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct DateBound {
    year: i32,
    month: u32,
    day: u32,
}

impl DateBound {
    fn new(year: i32, month: u32, day: u32) -> Result<Self, String> {
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return Err(format!("无效日期: {year:04}-{month:02}-{day:02}"));
        }
        Ok(Self { year, month, day })
    }

    fn to_iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

fn parse_iso_date(value: &str) -> Result<DateBound, String> {
    let parts = value
        .split('-')
        .map(str::parse::<i32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| format!("无效日期: {}", value))?;
    if parts.len() != 3 || parts[1] < 0 || parts[2] < 0 {
        return Err(format!("无效日期: {}", value));
    }
    DateBound::new(parts[0], parts[1] as u32, parts[2] as u32)
}

fn split_date_window(
    from: DateBound,
    to: DateBound,
) -> Option<((DateBound, DateBound), (DateBound, DateBound))> {
    if from.year < to.year {
        let middle_year = from.year + (to.year - from.year) / 2;
        return Some((
            (from, DateBound::new(middle_year, 12, 31).ok()?),
            (DateBound::new(middle_year + 1, 1, 1).ok()?, to),
        ));
    }
    if from.month < to.month {
        let middle_month = from.month + (to.month - from.month) / 2;
        return Some((
            (
                from,
                DateBound::new(
                    from.year,
                    middle_month,
                    days_in_month(from.year, middle_month),
                )
                .ok()?,
            ),
            (DateBound::new(from.year, middle_month + 1, 1).ok()?, to),
        ));
    }
    if from.day < to.day {
        let middle_day = from.day + (to.day - from.day) / 2;
        return Some((
            (
                from,
                DateBound::new(from.year, from.month, middle_day).ok()?,
            ),
            (
                DateBound::new(from.year, from.month, middle_day + 1).ok()?,
                to,
            ),
        ));
    }
    None
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => 31,
    }
}

fn normalize_query(query: &str) -> Result<String, String> {
    pubmed_service::validate_query_syntax(query)
}

async fn throttle() {
    let mutex = LAST_REQUEST.get_or_init(|| Mutex::new(None));
    let mut last = mutex.lock().await;
    if let Some(previous) = *last {
        let elapsed = previous.elapsed();
        if elapsed < REQUEST_INTERVAL {
            tokio::time::sleep(REQUEST_INTERVAL - elapsed).await;
        }
    }
    *last = Some(Instant::now());
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0"?>
    <!DOCTYPE PubmedArticleSet>
    <PubmedArticleSet>
      <PubmedArticle>
        <MedlineCitation>
          <PMID>42863012</PMID>
          <Article>
            <Journal><JournalIssue><PubDate><Year>2026</Year><Month>Jul</Month></PubDate></JournalIssue><Title>Nature Medicine</Title></Journal>
            <ArticleTitle>Immune <i>reprogramming</i> in sepsis</ArticleTitle>
            <Abstract><AbstractText Label="BACKGROUND">First part.</AbstractText><AbstractText>Second part.</AbstractText></Abstract>
            <AuthorList>
              <Author><LastName>Li</LastName><ForeName>Qian</ForeName><Initials>Q</Initials><AffiliationInfo><Affiliation>Institute A</Affiliation></AffiliationInfo></Author>
              <Author>
                <LastName>Smith</LastName><ForeName>Alice Beth</ForeName><Initials>AB</Initials>
                <Identifier Source="ORCID">https://orcid.org/0000-0002-1825-0097</Identifier>
                <AffiliationInfo><Affiliation>Institute B</Affiliation></AffiliationInfo>
                <AffiliationInfo><Affiliation>Hospital C</Affiliation></AffiliationInfo>
              </Author>
            </AuthorList>
          </Article>
        </MedlineCitation>
        <PubmedData><ArticleIdList><ArticleId IdType="pubmed">42863012</ArticleId><ArticleId IdType="doi">10.1000/Test</ArticleId><ArticleId IdType="pmc">PMC123</ArticleId></ArticleIdList></PubmedData>
      </PubmedArticle>
      <PubmedArticle>
        <MedlineCitation><PMID>42862018</PMID><Article><Journal><JournalIssue><PubDate><MedlineDate>2025 Winter</MedlineDate></PubDate></JournalIssue><ISOAbbreviation>J Clin Invest</ISOAbbreviation></Journal><ArticleTitle>No abstract paper</ArticleTitle></Article></MedlineCitation>
      </PubmedArticle>
    </PubmedArticleSet>"#;

    fn search_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open database");
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT, feed_id INTEGER, guid TEXT NOT NULL,
                title TEXT NOT NULL, link TEXT NOT NULL, summary TEXT, summary_source TEXT,
                author TEXT, published_at TEXT, publication_date TEXT,
                publication_date_raw TEXT, publication_date_precision TEXT,
                publication_sort_key INTEGER, source TEXT, pmid TEXT, pmcid TEXT, doi TEXT,
                pmid_normalized TEXT, doi_normalized TEXT, affiliation TEXT,
                has_free_fulltext INTEGER, fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
                is_read INTEGER NOT NULL DEFAULT 0, read_at TEXT
            );
            CREATE TABLE translations (
                entry_id INTEGER NOT NULL, field TEXT NOT NULL, translated_text TEXT,
                UNIQUE(entry_id, field)
            );
            CREATE TABLE reading_notes (entry_id INTEGER NOT NULL);
            CREATE TABLE entry_tags (entry_id INTEGER NOT NULL, tag TEXT NOT NULL);
            CREATE TABLE entry_identifiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                kind TEXT NOT NULL, value_normalized TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active', source TEXT,
                UNIQUE(entry_id, kind, value_normalized)
            );
            CREATE UNIQUE INDEX idx_entry_identifiers_active_unique
                ON entry_identifiers(kind, value_normalized) WHERE status = 'active';
            CREATE TABLE entry_identity_conflicts (
                id INTEGER PRIMARY KEY, kind TEXT, value TEXT, entry_ids_json TEXT,
                source TEXT, created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE pubmed_searches (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, question TEXT,
                query TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_attempt_at TEXT, last_success_at TEXT, last_result_count INTEGER NOT NULL DEFAULT 0,
                retrieval_scope TEXT NOT NULL DEFAULT 'all', retrieval_limit INTEGER,
                retrieval_date_from TEXT, retrieval_date_to TEXT,
                retrieval_sort TEXT NOT NULL DEFAULT 'most_recent'
            );
            CREATE TABLE pubmed_search_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                search_id INTEGER NOT NULL REFERENCES pubmed_searches(id) ON DELETE CASCADE,
                started_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT,
                status TEXT NOT NULL, matched_count INTEGER NOT NULL DEFAULT 0,
                added_count INTEGER NOT NULL DEFAULT 0, reused_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0, error_message TEXT
            );
            CREATE TABLE pubmed_search_entries (
                search_id INTEGER NOT NULL REFERENCES pubmed_searches(id) ON DELETE CASCADE,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                screening_status TEXT NOT NULL DEFAULT 'unreviewed',
                first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                first_seen_run_id INTEGER, screened_at TEXT,
                is_current_match INTEGER NOT NULL DEFAULT 1, pubmed_rank INTEGER,
                PRIMARY KEY(search_id, entry_id)
            );
            CREATE TABLE pubmed_search_run_items (
                run_id INTEGER NOT NULL REFERENCES pubmed_search_runs(id) ON DELETE CASCADE,
                pmid TEXT NOT NULL, rank INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                entry_id INTEGER, error_message TEXT, PRIMARY KEY(run_id, pmid)
            );
            CREATE TABLE pubmed_author_identity_states (
                search_id INTEGER PRIMARY KEY REFERENCES pubmed_searches(id) ON DELETE CASCADE,
                schema_version INTEGER NOT NULL DEFAULT 1,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE pubmed_entry_authors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                author_order INTEGER NOT NULL,
                last_name TEXT, fore_name TEXT, initials TEXT, collective_name TEXT,
                display_name TEXT NOT NULL, orcid TEXT,
                UNIQUE(entry_id, author_order)
            );
            CREATE TABLE pubmed_entry_author_affiliations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_author_id INTEGER NOT NULL
                    REFERENCES pubmed_entry_authors(id) ON DELETE CASCADE,
                affiliation_order INTEGER NOT NULL,
                raw_text TEXT NOT NULL,
                UNIQUE(entry_author_id, affiliation_order)
            );
            ",
        )
        .expect("create schema");
        conn
    }

    fn record(pmid: &str, title: &str) -> PubmedArticleRecord {
        PubmedArticleRecord {
            pmid: pmid.to_string(),
            pmcid: None,
            doi: Some(format!("10.1000/{}", pmid)),
            title: title.to_string(),
            abstract_text: Some("Abstract".to_string()),
            authors: Some("Author A".to_string()),
            structured_authors: Vec::new(),
            journal: Some("Journal".to_string()),
            affiliation: None,
            publication_date: Some("2026-07".to_string()),
            publication_date_raw: Some("2026 Jul".to_string()),
            publication_date_precision: Some("month".to_string()),
            publication_sort_key: Some(20260700),
            has_free_fulltext: false,
        }
    }

    #[test]
    fn author_assessment_uses_identity_clustering_evidence() {
        let mut candidate = record("123", "Cardiac imaging after infarction");
        candidate.authors = Some("Ji-Song Ji; Wei Zhang".to_string());
        candidate.affiliation = Some("Lishui Central Hospital".to_string());
        candidate.abstract_text = Some("Cardiac imaging research".to_string());
        candidate.publication_date = Some("2024-05".to_string());

        let context = build_author_assessment_context(
            "Jisong Ji",
            Some("Lishui Central Hospital"),
            "Ji J[Author]",
            &[candidate],
        );

        assert!(context.contains("先把候选文献按可能的作者身份聚类"));
        assert!(context.contains("ORCID 缺失也不能作为排除依据"));
        assert!(context.contains("目标作者本人对应的单位"));
        assert!(context.contains("共同作者网络"));
        assert!(context.contains("研究方向"));
        assert!(context.contains("发表年份"));
        assert!(context.contains("确认作者或高度可能"));
        assert!(context.contains("需要确认"));
        assert!(context.contains("同名作者"));
        assert!(context.contains("Cardiac imaging research"));
        assert!(!context.contains("不得作为作者归属依据"));
    }

    #[test]
    fn persists_author_identity_state_for_a_search() {
        let conn = search_db();
        let search = create_search(&conn, "【作者 | Ji Jiansong】", None, "Ji J[Author]")
            .expect("create author search");
        let state = r#"{"seedIds":[1,2],"confirmedIds":[3],"decisions":{"group-a":"confirmed"}}"#;

        save_author_identity_state(&conn, search.id, state).expect("save identity state");
        assert_eq!(
            get_author_identity_state(&conn, search.id)
                .expect("read identity state")
                .as_deref(),
            Some(state)
        );
        assert!(save_author_identity_state(&conn, search.id, "[]").is_err());
        assert!(save_author_identity_state(&conn, search.id, "not-json").is_err());
    }

    #[test]
    fn persists_structured_authors_without_duplicates() {
        let conn = search_db();
        let search = create_search(&conn, "Author", None, "Smith AB[Author]").unwrap();
        let run_id = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run_id, &["123".to_string()]).unwrap();
        let mut article = record("123", "Structured authors");
        article.structured_authors = vec![
            PubmedAuthorRecord {
                author_order: 1,
                last_name: Some("Li".to_string()),
                fore_name: Some("Qian".to_string()),
                initials: Some("Q".to_string()),
                collective_name: None,
                display_name: "Qian Li".to_string(),
                orcid: None,
                affiliations: vec!["Institute A".to_string()],
            },
            PubmedAuthorRecord {
                author_order: 2,
                last_name: Some("Smith".to_string()),
                fore_name: Some("Alice Beth".to_string()),
                initials: Some("AB".to_string()),
                collective_name: None,
                display_name: "Alice Beth Smith".to_string(),
                orcid: Some("0000-0002-1825-0097".to_string()),
                affiliations: vec!["Institute B".to_string(), "Hospital C".to_string()],
            },
        ];

        let (entry_id, _) = finish_item(&conn, run_id, search.id, &article);
        upsert_search_record(&conn, search.id, run_id, &article).unwrap();

        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM pubmed_entry_authors WHERE entry_id = ?1",
                [entry_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*)
                 FROM pubmed_entry_author_affiliations affiliation
                 JOIN pubmed_entry_authors author ON author.id = affiliation.entry_author_id
                 WHERE author.entry_id = ?1 AND author.author_order = 2",
                [entry_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            2
        );
        complete_run(&conn, search.id, run_id).unwrap();
        let entries = list_search_entries(&conn, search.id).unwrap();
        assert_eq!(entries[0].structured_authors.len(), 2);
        assert_eq!(entries[0].structured_authors[0].author_order, 1);
        assert_eq!(
            entries[0].structured_authors[1].orcid.as_deref(),
            Some("0000-0002-1825-0097")
        );
        assert_eq!(
            entries[0].structured_authors[1].affiliations,
            vec!["Institute B", "Hospital C"]
        );
    }

    fn finish_item(
        conn: &Connection,
        run_id: i64,
        search_id: i64,
        record: &PubmedArticleRecord,
    ) -> (i64, bool) {
        let (entry_id, added) =
            upsert_search_record(conn, search_id, run_id, record).expect("upsert record");
        conn.execute(
            "UPDATE pubmed_search_run_items SET status = ?1, entry_id = ?2
             WHERE run_id = ?3 AND pmid = ?4",
            params![
                if added { "fetched" } else { "reused" },
                entry_id,
                run_id,
                record.pmid
            ],
        )
        .unwrap();
        (entry_id, added)
    }

    #[test]
    fn builds_esearch_as_post_for_long_queries() {
        let client = pubmed_client().expect("build client");
        let query = "ischemic cardiomyopathy[Title/Abstract] OR ".repeat(100);
        let request = build_search_request(&client, &query, 0, 20, true).expect("build request");

        assert_eq!(request.method(), reqwest::Method::POST);
        assert!(request.url().query().is_none());
        let body = request
            .body()
            .and_then(reqwest::Body::as_bytes)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .expect("form body");
        assert!(body.contains("term="));
        assert!(body.contains("retmax=20"));
        assert!(body.len() > query.len());
    }

    #[test]
    fn esearch_request_includes_sort_and_publication_date_range() {
        let client = pubmed_client().expect("build client");
        let options = PubmedRetrievalOptions {
            scope: "date_range".to_string(),
            limit: None,
            date_from: Some("2020-01-02".to_string()),
            date_to: Some("2026-07-15".to_string()),
            sort: "publication_date".to_string(),
        };
        let request =
            build_search_request_with_options(&client, "ischemia", 0, 1000, true, &options)
                .expect("build request");
        let body = request
            .body()
            .and_then(reqwest::Body::as_bytes)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .expect("form body");
        assert!(body.contains("sort=pub_date"));
        assert!(body.contains("datetype=pdat"));
        assert!(body.contains("mindate=2020%2F01%2F02"));
        assert!(body.contains("maxdate=2026%2F07%2F15"));
    }

    #[test]
    fn validates_retrieval_options_and_date_splitting() {
        let custom = PubmedRetrievalOptions {
            scope: "custom".to_string(),
            limit: Some(10_001),
            date_from: Some("2020-01-01".to_string()),
            date_to: Some("2026-07-16".to_string()),
            sort: "most_recent".to_string(),
        };
        let normalized_custom = normalize_retrieval_options(&custom).unwrap();
        assert_eq!(normalized_custom.limit, Some(10_001));
        assert_eq!(normalized_custom.date_from.as_deref(), Some("2020-01-01"));

        let empty_custom = PubmedRetrievalOptions {
            limit: Some(0),
            ..custom.clone()
        };
        assert!(normalize_retrieval_options(&empty_custom).is_err());

        let incomplete_custom_range = PubmedRetrievalOptions {
            date_to: None,
            ..custom.clone()
        };
        assert!(normalize_retrieval_options(&incomplete_custom_range).is_err());

        let from = DateBound::new(2020, 1, 1).unwrap();
        let to = DateBound::new(2026, 12, 31).unwrap();
        let (older, newer) = split_date_window(from, to).expect("split years");
        assert_eq!(older.0, from);
        assert_eq!(older.1, DateBound::new(2023, 12, 31).unwrap());
        assert_eq!(newer.0, DateBound::new(2024, 1, 1).unwrap());
        assert_eq!(newer.1, to);
    }

    #[test]
    fn persists_and_clones_retrieval_options() {
        let conn = search_db();
        let options = PubmedRetrievalOptions {
            scope: "date_range".to_string(),
            limit: None,
            date_from: Some("2020-01-01".to_string()),
            date_to: Some("2026-07-15".to_string()),
            sort: "relevance".to_string(),
        };
        let search = create_search_with_options(&conn, "Range", None, "ischemia", &options)
            .expect("create search");
        assert_eq!(search.retrieval_scope, "date_range");
        assert_eq!(search.retrieval_date_from.as_deref(), Some("2020-01-01"));
        assert_eq!(search.retrieval_sort, "relevance");

        let cloned = clone_search(&conn, search.id, "Range copy").expect("clone search");
        assert_eq!(cloned.retrieval_scope, search.retrieval_scope);
        assert_eq!(cloned.retrieval_date_to, search.retrieval_date_to);
        assert_eq!(cloned.retrieval_sort, search.retrieval_sort);
    }

    #[test]
    fn parses_search_response_with_history() {
        let body = serde_json::json!({"esearchresult": {
            "count": "42", "idlist": ["1", "2"], "webenv": "env", "querykey": "1"
        }});
        let page = parse_search_response(&body).expect("parse search");
        assert_eq!(page.total_count, 42);
        assert_eq!(page.pmids, vec!["1", "2"]);
        assert_eq!(page.web_env.as_deref(), Some("env"));
    }

    #[test]
    fn parses_pubmed_xml_metadata_and_partial_dates() {
        let records = parse_pubmed_records(XML).expect("parse records");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].title, "Immune reprogramming in sepsis");
        assert_eq!(
            records[0].abstract_text.as_deref(),
            Some("BACKGROUND: First part.\n\nSecond part.")
        );
        assert_eq!(
            records[0].authors.as_deref(),
            Some("Qian Li, Alice Beth Smith")
        );
        assert_eq!(records[0].structured_authors.len(), 2);
        assert_eq!(records[0].structured_authors[0].author_order, 1);
        assert_eq!(
            records[0].structured_authors[0].affiliations,
            vec!["Institute A"]
        );
        assert_eq!(records[0].structured_authors[1].author_order, 2);
        assert_eq!(
            records[0].structured_authors[1].orcid.as_deref(),
            Some("0000-0002-1825-0097")
        );
        assert_eq!(
            records[0].structured_authors[1].affiliations,
            vec!["Institute B", "Hospital C"]
        );
        assert_eq!(records[0].publication_date.as_deref(), Some("2026-07"));
        assert_eq!(
            records[0].publication_date_precision.as_deref(),
            Some("month")
        );
        assert_eq!(records[0].publication_sort_key, Some(20260700));
        assert!(records[0].has_free_fulltext);
        assert_eq!(records[1].publication_date.as_deref(), Some("2025"));
        assert_eq!(
            records[1].publication_date_precision.as_deref(),
            Some("medline")
        );
        assert!(records[1].abstract_text.is_none());
    }

    #[test]
    fn parses_day_year_and_season_precision() {
        let options = ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        };
        for (xml, expected_iso, precision, sort_key) in [
            (
                "<PubDate><Year>2026</Year><Month>3</Month><Day>9</Day></PubDate>",
                "2026-03-09",
                "day",
                20260309,
            ),
            (
                "<PubDate><Year>2024</Year></PubDate>",
                "2024",
                "year",
                20240000,
            ),
            (
                "<PubDate><Year>2023</Year><Month>Fall</Month></PubDate>",
                "2023",
                "season",
                20231000,
            ),
        ] {
            let doc = Document::parse_with_options(xml, options).unwrap();
            let parsed = parse_publication_date(doc.root_element());
            assert_eq!(parsed.iso.as_deref(), Some(expected_iso));
            assert_eq!(parsed.precision.as_deref(), Some(precision));
            assert_eq!(parsed.sort_key, Some(sort_key));
        }
    }

    #[test]
    fn update_adds_new_entries_and_preserves_screening_status() {
        let conn = search_db();
        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        let first_run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, first_run, &["1".to_string()]).unwrap();
        let (first_entry, added) = finish_item(&conn, first_run, search.id, &record("1", "One"));
        assert!(added);
        complete_run(&conn, search.id, first_run).unwrap();
        conn.execute(
            "UPDATE pubmed_search_entries SET screening_status = 'keep'
             WHERE search_id = ?1 AND entry_id = ?2",
            params![search.id, first_entry],
        )
        .unwrap();

        let second_run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, second_run, &["1".to_string(), "2".to_string()]).unwrap();
        assert_eq!(
            reuse_local_run_items(
                &conn,
                search.id,
                second_run,
                &["1".to_string(), "2".to_string()],
            )
            .unwrap(),
            vec!["2".to_string()]
        );
        assert!(finish_item(&conn, second_run, search.id, &record("2", "Two")).1);
        complete_run(&conn, search.id, second_run).unwrap();

        let entries = list_search_entries(&conn, search.id).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.entry_id == first_entry)
                .unwrap()
                .screening_status,
            "keep"
        );
        let result = run_result(&conn, second_run, None).unwrap();
        assert_eq!(result.added_count, 1);
        assert_eq!(result.reused_count, 1);
    }

    #[test]
    fn update_with_no_new_pmids_reuses_local_entries_without_fetch_work() {
        let conn = search_db();
        let search = create_search(&conn, "Author", None, "author[au]").unwrap();
        let first_run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, first_run, &["1".to_string()]).unwrap();
        finish_item(&conn, first_run, search.id, &record("1", "One"));
        complete_run(&conn, search.id, first_run).unwrap();

        let second_run = begin_run(&conn, search.id).unwrap();
        let pmids = vec!["1".to_string()];
        snapshot_run_items(&conn, second_run, &pmids).unwrap();
        assert!(reuse_local_run_items(&conn, search.id, second_run, &pmids)
            .unwrap()
            .is_empty());
        complete_run(&conn, search.id, second_run).unwrap();

        let result = run_result(&conn, second_run, None).unwrap();
        assert_eq!(result.matched_count, 1);
        assert_eq!(result.added_count, 0);
        assert_eq!(result.reused_count, 1);
    }

    #[test]
    fn editing_query_preserves_existing_entries_and_screening() {
        let conn = search_db();
        let search = create_search(&conn, "Old", Some("old question"), "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run, &["1".to_string()]).unwrap();
        let (entry_id, _) = finish_item(&conn, run, search.id, &record("1", "One"));
        complete_run(&conn, search.id, run).unwrap();
        set_screening_status(&conn, search.id, &[entry_id], "keep").unwrap();

        let updated = update_search(
            &conn,
            search.id,
            "New",
            Some("new question"),
            "sepsis AND immune",
        )
        .unwrap();
        assert_eq!(updated.name, "New");
        assert_eq!(updated.query, "sepsis AND immune");
        let entries = list_search_entries(&conn, search.id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].screening_status, "keep");
    }

    #[test]
    fn export_renderers_use_only_selected_fields_and_include_notes() {
        let conn = search_db();
        let search = create_search(&conn, "Export", None, "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run, &["1".to_string()]).unwrap();
        let (entry_id, _) = finish_item(&conn, run, search.id, &record("1", "English title"));
        complete_run(&conn, search.id, run).unwrap();
        let entries = list_search_entries(&conn, search.id).unwrap();
        let metrics = HashMap::new();
        let notes = HashMap::from([(entry_id, "【快速笔记】\n核心结论".to_string())]);
        let fields = vec![
            "title".to_string(),
            "reading_notes".to_string(),
            "pmid".to_string(),
        ];

        let csv = render_export_csv(&entries, &fields, &metrics, &notes).unwrap();
        assert!(csv.contains("\"标题英文\",\"阅读笔记\",\"PMID\""));
        assert!(csv.contains("核心结论"));
        assert!(!csv.contains("摘要英文"));

        let txt = render_export_txt(&entries, &fields, &metrics, &notes).unwrap();
        assert!(txt.contains("TI  - English title"));
        assert!(txt.contains("NOTE- 【快速笔记】 核心结论"));
        assert!(!txt.contains("AB  -"));
    }

    #[test]
    fn xlsx_export_uses_pubmed_downloader_columns_and_keeps_extra_fields() {
        let conn = search_db();
        let search = create_search(&conn, "Export", None, "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run, &["1".to_string()]).unwrap();
        finish_item(&conn, run, search.id, &record("1", "English title"));
        complete_run(&conn, search.id, run).unwrap();
        let entries = list_search_entries(&conn, search.id).unwrap();
        let fields = vec![
            "pmid".to_string(),
            "title".to_string(),
            "summary".to_string(),
            "journal".to_string(),
            "publication_date".to_string(),
            "doi".to_string(),
            "title_translated".to_string(),
            "reading_notes".to_string(),
        ];

        let headers = fields
            .iter()
            .map(|field| xlsx_export_field_label(field).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            headers,
            vec![
                "PMID",
                "Title",
                "Abstract",
                "Journal.Book",
                "Publication.Year",
                "DOI",
                "标题中文",
                "阅读笔记",
            ]
        );
        let xlsx = render_export_xlsx(&entries, &fields, &HashMap::new(), &HashMap::new()).unwrap();
        assert!(xlsx.starts_with(b"PK"));
        assert!(xlsx.len() > 1_000);
    }

    #[test]
    fn google_translate_export_combines_fields_and_skips_existing_translations() {
        let conn = search_db();
        let search = create_search(&conn, "Google Translate", None, "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run, &["1".to_string(), "2".to_string()]).unwrap();
        let (first_entry, _) = finish_item(&conn, run, search.id, &record("1", "First title"));
        let (second_entry, _) = finish_item(&conn, run, search.id, &record("2", "Second title"));
        complete_run(&conn, search.id, run).unwrap();
        conn.execute(
            "INSERT INTO translations (entry_id, field, translated_text) VALUES (?1, 'title', '已有标题')",
            [first_entry],
        )
        .unwrap();
        let path =
            std::env::temp_dir().join(format!("cento-google-export-{}.xlsx", std::process::id()));
        let report = export_google_translate_entries(
            &conn,
            &path,
            Some(search.id),
            &[first_entry, second_entry],
            true,
            true,
            true,
        )
        .unwrap();
        assert_eq!(report.article_count, 2);
        assert_eq!(report.title_count, 1);
        assert_eq!(report.summary_count, 2);
        assert_eq!(report.skipped_translated, 1);
        assert_eq!(report.row_count, 3);
        assert_eq!(report.file_paths.len(), 1);
        for path in report.file_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn partial_run_merges_successes_without_removing_previous_snapshot() {
        let conn = search_db();
        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        let first_run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, first_run, &["1".to_string()]).unwrap();
        let (first_entry, _) = finish_item(&conn, first_run, search.id, &record("1", "One"));
        complete_run(&conn, search.id, first_run).unwrap();

        let partial_run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, partial_run, &["2".to_string(), "3".to_string()]).unwrap();
        let (second_entry, _) = finish_item(&conn, partial_run, search.id, &record("2", "Two"));
        mark_run_item_failed(&conn, partial_run, "3", "EFetch 未返回该 PMID").unwrap();
        finalize_partial_run(
            &conn,
            search.id,
            partial_run,
            "部分 PMID 获取失败，可继续重试",
        )
        .unwrap();

        let first_current: i64 = conn
            .query_row(
                "SELECT is_current_match FROM pubmed_search_entries WHERE search_id = ?1 AND entry_id = ?2",
                params![search.id, first_entry],
                |row| row.get(0),
            )
            .unwrap();
        let second_current: i64 = conn
            .query_row(
                "SELECT is_current_match FROM pubmed_search_entries WHERE search_id = ?1 AND entry_id = ?2",
                params![search.id, second_entry],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_current, 1);
        assert_eq!(second_current, 1);

        let search = get_search(&conn, search.id).unwrap();
        assert_eq!(search.total_entries, 2);
        assert_eq!(search.last_result_count, 2);
    }

    #[test]
    fn first_partial_run_publishes_usable_snapshot() {
        let conn = search_db();
        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run, &["1".to_string(), "2".to_string()]).unwrap();
        let (entry_id, _) = finish_item(&conn, run, search.id, &record("1", "One"));
        mark_run_item_failed(&conn, run, "2", "EFetch 未返回该 PMID").unwrap();

        finalize_partial_run(&conn, search.id, run, "部分 PMID 获取失败，可继续重试").unwrap();

        let current: i64 = conn
            .query_row(
                "SELECT is_current_match FROM pubmed_search_entries
                 WHERE search_id = ?1 AND entry_id = ?2",
                params![search.id, entry_id],
                |row| row.get(0),
            )
            .unwrap();
        let (last_success_at, last_result_count): (Option<String>, i64) = conn
            .query_row(
                "SELECT last_success_at, last_result_count FROM pubmed_searches WHERE id = ?1",
                [search.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let (status, failed_count): (String, i64) = conn
            .query_row(
                "SELECT status, failed_count FROM pubmed_search_runs WHERE id = ?1",
                [run],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(current, 1);
        assert!(last_success_at.is_some());
        assert_eq!(last_result_count, 1);
        assert_eq!(status, "partial");
        assert_eq!(failed_count, 1);
    }

    #[test]
    fn pubmed_record_persistence_skips_failed_record_and_keeps_rest() {
        let conn = search_db();
        conn.execute_batch(
            "
            CREATE TRIGGER reject_bad_pubmed_entry
            BEFORE INSERT ON entries
            WHEN NEW.title = 'Bad PubMed entry'
            BEGIN
                SELECT RAISE(FAIL, 'forced PubMed entry failure');
            END;
            ",
        )
        .unwrap();

        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        let pmids = vec!["1".to_string(), "2".to_string(), "3".to_string()];
        snapshot_run_items(&conn, run, &pmids).unwrap();

        persist_pubmed_records(
            &conn,
            search.id,
            run,
            &pmids,
            vec![
                record("1", "One"),
                record("2", "Bad PubMed entry"),
                record("3", "Three"),
            ],
        )
        .unwrap();
        finalize_partial_run(&conn, search.id, run, "部分 PMID 获取失败，可继续重试").unwrap();

        let visible = list_search_entries(&conn, search.id).unwrap();
        assert_eq!(visible.len(), 2);
        assert!(visible
            .iter()
            .any(|entry| entry.pmid.as_deref() == Some("1")));
        assert!(visible
            .iter()
            .any(|entry| entry.pmid.as_deref() == Some("3")));
        let failed_message: String = conn
            .query_row(
                "SELECT error_message FROM pubmed_search_run_items
                 WHERE run_id = ?1 AND pmid = '2'",
                [run],
                |row| row.get(0),
            )
            .unwrap();
        assert!(failed_message.contains("forced PubMed entry failure"));
    }

    #[test]
    fn list_searches_repairs_stale_first_partial_snapshot() {
        let conn = search_db();
        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run, &["1".to_string(), "2".to_string()]).unwrap();
        finish_item(&conn, run, search.id, &record("1", "One"));
        mark_run_item_failed(&conn, run, "2", "EFetch 未返回该 PMID").unwrap();
        finalize_run_error(&conn, run, "partial", "interrupted").unwrap();

        let repaired = list_searches(&conn).unwrap();
        let repaired = repaired
            .iter()
            .find(|candidate| candidate.id == search.id)
            .unwrap();

        assert_eq!(repaired.total_entries, 1);
        assert_eq!(repaired.last_result_count, 1);
        assert!(repaired.last_success_at.is_some());
        let status: String = conn
            .query_row(
                "SELECT status FROM pubmed_search_runs WHERE id = ?1",
                [run],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "partial");
    }

    #[test]
    fn completed_run_hides_historical_matches_from_list_and_counts() {
        let conn = search_db();
        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        let first_run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, first_run, &["1".to_string(), "2".to_string()]).unwrap();
        let (first_entry, _) = finish_item(&conn, first_run, search.id, &record("1", "One"));
        let (second_entry, _) = finish_item(&conn, first_run, search.id, &record("2", "Two"));
        complete_run(&conn, search.id, first_run).unwrap();

        let second_run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, second_run, &["2".to_string()]).unwrap();
        assert!(
            reuse_local_run_items(&conn, search.id, second_run, &["2".to_string()])
                .unwrap()
                .is_empty()
        );
        complete_run(&conn, search.id, second_run).unwrap();

        let visible = list_search_entries(&conn, search.id).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].entry_id, second_entry);
        assert_eq!(get_search(&conn, search.id).unwrap().total_entries, 1);

        let historical: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pubmed_search_entries
                 WHERE search_id = ?1 AND entry_id = ?2 AND is_current_match = 0",
                params![search.id, first_entry],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(historical, 1);
    }

    #[test]
    fn completed_run_recreates_missing_membership_for_reused_entry() {
        let conn = search_db();
        let source = create_search(&conn, "Source", None, "sepsis").unwrap();
        let source_run = begin_run(&conn, source.id).unwrap();
        snapshot_run_items(&conn, source_run, &["1".to_string()]).unwrap();
        let (entry_id, _) = finish_item(&conn, source_run, source.id, &record("1", "One"));
        complete_run(&conn, source.id, source_run).unwrap();

        let target = create_search(&conn, "Target", None, "immune").unwrap();
        let target_run = begin_run(&conn, target.id).unwrap();
        snapshot_run_items(&conn, target_run, &["1".to_string()]).unwrap();
        assert!(
            reuse_local_run_items(&conn, target.id, target_run, &["1".to_string()])
                .unwrap()
                .is_empty()
        );
        conn.execute(
            "DELETE FROM pubmed_search_entries WHERE search_id = ?1 AND entry_id = ?2",
            params![target.id, entry_id],
        )
        .unwrap();

        complete_run(&conn, target.id, target_run).unwrap();

        let visible = list_search_entries(&conn, target.id).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].entry_id, entry_id);
        assert!(visible[0].is_current_match);
    }

    #[test]
    fn rejects_concurrent_run_for_same_search() {
        let conn = search_db();
        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        begin_run(&conn, search.id).unwrap();
        assert!(begin_run(&conn, search.id).is_err());
    }

    #[test]
    fn screening_is_independent_per_search_and_kept_list_is_deduplicated() {
        let conn = search_db();
        let first = create_search(&conn, "First", None, "sepsis").unwrap();
        let second = create_search(&conn, "Second", None, "immune").unwrap();
        let article = record("10", "Shared");

        let first_run = begin_run(&conn, first.id).unwrap();
        snapshot_run_items(&conn, first_run, &["10".to_string()]).unwrap();
        let (entry_id, _) = finish_item(&conn, first_run, first.id, &article);
        complete_run(&conn, first.id, first_run).unwrap();

        let second_run = begin_run(&conn, second.id).unwrap();
        snapshot_run_items(&conn, second_run, &["10".to_string()]).unwrap();
        assert!(
            reuse_local_run_items(&conn, second.id, second_run, &["10".to_string()],)
                .unwrap()
                .is_empty()
        );
        complete_run(&conn, second.id, second_run).unwrap();

        let second_result = run_result(&conn, second_run, None).unwrap();
        assert_eq!(second_result.added_count, 1);
        assert_eq!(second_result.reused_count, 0);

        set_screening_status(&conn, first.id, &[entry_id], "keep").unwrap();
        set_screening_status(&conn, second.id, &[entry_id], "exclude").unwrap();

        assert_eq!(
            list_search_entries(&conn, first.id).unwrap()[0].screening_status,
            "keep"
        );
        assert_eq!(
            list_search_entries(&conn, second.id).unwrap()[0].screening_status,
            "exclude"
        );
        let kept = list_kept_entries(&conn).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].searches.len(), 2);
    }

    #[test]
    fn bulk_screening_rolls_back_when_any_entry_is_outside_search() {
        let conn = search_db();
        let search = create_search(&conn, "Sepsis", None, "sepsis").unwrap();
        let run = begin_run(&conn, search.id).unwrap();
        snapshot_run_items(&conn, run, &["1".to_string()]).unwrap();
        let (entry_id, _) = finish_item(&conn, run, search.id, &record("1", "One"));
        complete_run(&conn, search.id, run).unwrap();

        assert!(set_screening_status(&conn, search.id, &[entry_id, 999], "keep").is_err());
        assert_eq!(
            list_search_entries(&conn, search.id).unwrap()[0].screening_status,
            "unreviewed"
        );
        assert!(set_screening_status(&conn, search.id, &[entry_id], "invalid").is_err());

        let suggestions = vec![
            PubmedScreeningSuggestion {
                entry_id,
                pmid: Some("1".to_string()),
                status: "keep".to_string(),
                reason: "符合".to_string(),
            },
            PubmedScreeningSuggestion {
                entry_id: 999,
                pmid: Some("999".to_string()),
                status: "exclude".to_string(),
                reason: "不符合".to_string(),
            },
        ];
        assert!(apply_screening_suggestions(&conn, search.id, &suggestions).is_err());
        assert_eq!(
            list_search_entries(&conn, search.id).unwrap()[0].screening_status,
            "unreviewed"
        );
    }

    #[test]
    fn parses_preview_assessment_and_derives_verdict() {
        let entries = vec![record("1", "Relevant"), record("2", "Off topic")];
        let raw = r#"{
            "summary":"一半样本偏题，建议收紧疾病与技术条件。",
            "suggested_query":"ischemia[Title/Abstract] AND \"single-cell RNA sequencing\"[Title/Abstract]",
            "entries":[
                {"pmid":"1","status":"relevant","reason":"疾病和技术均符合"},
                {"pmid":"2","status":"irrelevant","reason":"缺少缺血性心肌病场景"}
            ]
        }"#;

        let assessment = parse_preview_assessment(raw, "ischemia", &entries).unwrap();

        assert_eq!(assessment.verdict, "poor");
        assert_eq!(assessment.relevant_count, 1);
        assert_eq!(assessment.maybe_count, 0);
        assert_eq!(assessment.irrelevant_count, 1);
        assert_eq!(assessment.sample_size, 2);
        assert_eq!(assessment.precision_percent, 50.0);
        assert_eq!(assessment.entries.len(), 2);
        assert!(assessment.suggested_query.is_some());
    }

    #[test]
    fn systematic_sample_spreads_across_the_ranked_population() {
        let population = (0..1_000).collect::<Vec<_>>();

        let sample = systematic_sample(&population, 100);

        assert_eq!(sample.len(), 100);
        assert_eq!(sample.first(), Some(&5));
        assert_eq!(sample.last(), Some(&995));
        assert!(sample.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn wilson_interval_is_stable_for_a_hundred_record_sample() {
        let (low, high) = wilson_interval(50, 100);

        assert!((low - 0.4038).abs() < 0.001);
        assert!((high - 0.5962).abs() < 0.001);
    }
}
