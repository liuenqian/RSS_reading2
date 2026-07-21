use crate::models::{
    DeepSeekSettings, SciReviewCitationEvidence, SciReviewJournalCandidate,
    SciReviewJournalRecommendation, SciReviewJournalRecommendationInput, SciReviewLiteratureRecord,
    SciReviewStageArtifact, SciReviewStageInput, SciReviewWritingSection,
    SciReviewWritingSectionInput, TokenUsage,
};
use crate::services::{sci_skill_service, translate_service};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

const ALLOWED_STAGES: &[&str] = &[
    "pool",
    "screening",
    "reading",
    "framework",
    "figures",
    "writing",
    "submission",
];

const STAGE_PROMPT: &str = r#"
你是 RSS Reading 内的 SCI 综述工作流执行器。你必须只依据用户给出的真实项目数据和文献记录工作，不得虚构文献、DOI、PMID、页码、图号、PDF 阅读状态、期刊指标、投稿要求或文件路径。

按 stage 执行对应工作：
- pool：依据真实检索式和记录，生成文献池范围、元数据完整性、去重与导出检查清单。不要声称已经生成未提供路径的文件。
- screening：依据标题/摘要和筛选状态，形成初筛分类规则、证据类别、排除理由规范和待人工复核项。只把输入样本视为本批次，不得声称筛完全部文献。
- reading：为本批次形成精读优先级、摘要级证据卡和全文获取清单。has_free_fulltext=false 或没有正文时，必须写“仅读标题摘要”，不得声称逐页精读。
- framework：依据上游筛选/精读产物形成章节逻辑、证据支撑矩阵和图表需求。证据不足处标记“需要人工核查”。
- figures：依据框架和有 PMCID 的材料形成图表计划、正文引用位置、来源登记与版权状态。不得虚构页码、图号或裁切范围；缺失时标记待核查。
- writing：依据框架、图表计划和真实文献记录生成有证据占位符的分章节草稿。不得生成不存在的引用；引用使用 [PMID:...]、[DOI:...] 或【需要人工核查】。
- submission：若没有明确目标期刊或未提供已联网核查的最新要求，只生成投稿准备缺口清单，并将状态设为 blocked；不得虚构 IF、分区、APC、审稿周期或投稿要求，不得代替用户登录或最终提交。

返回严格 JSON，不要代码围栏：
{
  "stage":"与输入相同",
  "skill_name":"本阶段对应的 Skill 中文名",
  "title":"产物标题",
  "summary":"100字内摘要",
  "markdown":"完整 Markdown 产物",
  "completion_state":"draft|partial|ready|blocked",
  "manual_checks":["需要人工确认的事项"],
  "next_stage":"下一阶段 id"
}

质量要求：markdown 必须说明本次输入记录数与总记录数；只对实际输入范围作结论；上游材料缺失时降低 completion_state，并明确缺口。manual_checks 最多 12 项。
"#;

const JOURNAL_RECOMMENDATION_PROMPT: &str = r#"
你是 SCI 综述目标期刊初选器。只能从 journal_distribution 提供的真实期刊中选择候选，不得新增或改写期刊名称。候选依据包括综述方向、关键词、目标分区、文章类型、用户偏好、正文摘要和该期刊在当前文献池中的出现次数。

本次仅做“基于当前文献池的候选初选”，没有联网验证期刊官网。不得输出或暗示具体 IF、JCR、中科院分区、CiteScore、APC、审稿周期、收录状态或是否接收综述。所有这些事实必须放入 manual_checks，等待官网或权威数据库核查。

将候选分为：ambitious（冲刺）、primary（主投）、safer（稳妥）。输出 3-6 个候选；若可用期刊不足则按实际数量输出。fit_score 为 0-5 的整数。

返回严格 JSON，不要代码围栏：
{
  "summary":"选刊策略摘要",
  "candidates":[{
    "journal_name":"必须与输入完全一致",
    "tier":"ambitious|primary|safer",
    "fit_score":4,
    "reason":"为什么与稿件匹配",
    "risk":"投稿风险或待核查点"
  }],
  "recommended_journal":"必须是 candidates 中的一个期刊",
  "manual_checks":["需核查的期刊事实"]
}
"#;

const WRITING_SECTION_PROMPT: &str = r#"
你是 SCI 综述逐章写作器。只能依据 framework、figure_plan、previous_sections 和 evidence 写作。不得虚构研究、数据、结论、页码、图号、PMID、DOI 或引用。

引用规则：正文只能使用 evidence 中给出的精确标识符，格式固定为 [PMID:12345678] 或 [DOI:10.xxxx/xxxx]。没有足够证据的判断写【需要人工核查】，不能用常识补齐。优先使用有 note_content 的证据，并区分摘要级证据和阅读笔记证据。

按 section_id 写作：
- introduction：第一章引言，从广泛背景逐步收窄到具体方向，包含重要性、现状、争议/空白、综述目的范围和全文结构；不要提前展开主体技术细节。
- body：严格沿用 framework 和引言逻辑，形成有二级/三级标题的主体章节；按机制、方法、证据或应用关系综合比较，不得逐篇罗列摘要；每章结尾写小结和过渡。
- synthesis：在前文基础上写讨论、与现有综述相比的价值、证据相关的局限性、由局限自然推出的未来展望和简洁结论；不得引入新主题或新证据。

返回严格 JSON，不要代码围栏：
{
  "section_id":"与输入相同",
  "title":"本部分标题",
  "markdown":"完整 Markdown 章节正文",
  "citations":[{
    "paragraph_id":"P1",
    "claim":"关键论点",
    "identifiers":["PMID:12345678"],
    "basis":"该证据如何支撑论点；说明摘要或阅读笔记"
  }],
  "manual_checks":["证据不足或需用户确认的事项"]
}

写作质量：每个关键判断必须进入 citations；段落围绕论点组织；避免“近年来受到广泛关注”等空话；避免重复；保持章节衔接；中文学术表达准确、具体、克制。
"#;

fn stage_skill_ids(stage: &str) -> Result<Vec<&'static str>, String> {
    match stage {
        "pool" => Ok(vec!["sci-literature-search-exporter"]),
        "screening" => Ok(vec![
            "sci-topic-gap-identifier",
            "sci-benchmark-review-library-deep-learning",
            "sci-literature-screening-organizer",
        ]),
        "reading" => Ok(vec![
            "sci-pdf-literature-acquisition-organizer",
            "sci-literature-intensive-reader",
        ]),
        "framework" => Ok(vec!["sci-review-framework-builder"]),
        "figures" => Ok(vec![
            "sci-review-figure-layout-citation-planner",
            "sci-figure-permission-requester",
        ]),
        "submission" => Ok(vec![
            "sci-review-deep-polisher",
            "sci-figure-permission-requester",
            "sci-submission-guide",
        ]),
        "writing" => Err("写作阶段必须使用 11、12、13 三个逐章 Skill".to_string()),
        _ => Err("当前阶段没有登记严格 Skill".to_string()),
    }
}

fn load_stage_skills(stage: &str) -> Result<(String, String, String, String, Vec<String>), String> {
    let skill_ids = stage_skill_ids(stage)?;
    let joined_ids = skill_ids.join(" → ");
    let mut texts = Vec::new();
    let mut names = Vec::new();
    let mut versions = Vec::new();
    let mut quality_gates = Vec::new();
    for skill_id in skill_ids {
        let spec = sci_skill_service::get_spec(skill_id)?;
        names.push(spec.skill_name);
        versions.push(format!("{}={}", spec.skill_id, spec.skill_version));
        quality_gates.extend(spec.quality_gates);
        texts.push(format!(
            "## {}\n\n{}",
            spec.skill_id,
            sci_skill_service::get_skill_text(skill_id)?
        ));
    }
    Ok((
        joined_ids,
        names.join(" → "),
        versions.join("; "),
        texts.join("\n\n"),
        quality_gates,
    ))
}

fn clean_text(value: String, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn timestamp_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn allowed_citation_tokens(input: &SciReviewWritingSectionInput) -> Vec<String> {
    input
        .evidence
        .iter()
        .flat_map(|item| {
            [
                item.pmid
                    .as_ref()
                    .map(|value| format!("[PMID:{}]", value.trim())),
                item.doi
                    .as_ref()
                    .map(|value| format!("[DOI:{}]", value.trim())),
            ]
            .into_iter()
            .flatten()
        })
        .collect()
}

fn validate_markdown_citations(markdown: &str, allowed: &[String]) -> Result<(), String> {
    for marker in ["[PMID:", "[DOI:"] {
        let mut rest = markdown;
        while let Some(start) = rest.find(marker) {
            let tail = &rest[start..];
            let Some(end) = tail.find(']') else {
                return Err("章节正文包含未闭合的引用标识符".to_string());
            };
            let token = &tail[..=end];
            if !allowed.iter().any(|item| item.eq_ignore_ascii_case(token)) {
                return Err(format!("章节正文包含未提供的引用 {}，已拒绝保存", token));
            }
            rest = &tail[end + 1..];
        }
    }
    Ok(())
}

fn record_for_prompt(record: &SciReviewLiteratureRecord) -> serde_json::Value {
    serde_json::json!({
        "entry_id": record.entry_id,
        "title": clean_text(record.title.clone(), 500),
        "abstract": record.abstract_text.as_ref().map(|value| clean_text(value.clone(), 1600)),
        "authors": record.authors.as_ref().map(|value| clean_text(value.clone(), 300)),
        "journal": record.journal,
        "publication_date": record.publication_date,
        "pmid": record.pmid,
        "pmcid": record.pmcid,
        "doi": record.doi,
        "screening_status": record.screening_status,
        "has_free_fulltext": record.has_free_fulltext,
        "has_reading_note": record.has_reading_note,
    })
}

pub async fn run_stage(
    settings: &DeepSeekSettings,
    input: SciReviewStageInput,
) -> Result<(SciReviewStageArtifact, TokenUsage), String> {
    if !ALLOWED_STAGES.contains(&input.stage.as_str()) {
        return Err("不支持的 SCI 综述阶段".to_string());
    }
    if input.direction.trim().is_empty() || input.keywords.trim().is_empty() {
        return Err("请先填写研究方向和关键词".to_string());
    }
    if input.stage != "submission" && input.total_records == 0 {
        return Err("当前项目没有可用于执行本阶段的文献记录".to_string());
    }
    if matches!(
        input.stage.as_str(),
        "screening" | "reading" | "framework" | "figures" | "submission"
    ) && input.upstream_artifacts.is_empty()
    {
        return Err(format!(
            "严格 Skill 模式禁止跳过上游阶段：{} 尚未提供上游产物",
            input.stage
        ));
    }
    let (skill_id, skill_name, skill_version, skill_text, quality_gates) =
        load_stage_skills(&input.stage)?;
    let records = input
        .records
        .iter()
        .take(80)
        .map(record_for_prompt)
        .collect::<Vec<_>>();
    let request = serde_json::json!({
        "stage": input.stage,
        "project_name": clean_text(input.project_name, 120),
        "direction": clean_text(input.direction, 500),
        "keywords": clean_text(input.keywords, 800),
        "target_tier": clean_text(input.target_tier, 120),
        "linked_search_name": input.linked_search_name,
        "pubmed_query": input.pubmed_query,
        "total_records": input.total_records,
        "input_record_count": records.len(),
        "records": records,
        "upstream_artifacts": input.upstream_artifacts.into_iter().take(4).map(|value| clean_text(value, 12_000)).collect::<Vec<_>>(),
        "target_journal": input.target_journal,
    });
    let system_prompt = format!(
        "{}\n\n# 必须严格执行的 Skill 原文\n\n{}\n\n不得删减或替换原 Skill 的 Required Inputs、Core Workflow、Output Files、Quality Gates 和 Prohibited Actions。缺少必需输入或无法完成外部动作时必须返回 blocked 或 partial，并列出人工操作；禁止声称完成。",
        STAGE_PROMPT, skill_text
    );
    let output = translate_service::complete_with_prompts(
        settings,
        &system_prompt,
        &serde_json::to_string_pretty(&request).map_err(|error| error.to_string())?,
        0.2,
        7_000,
    )
    .await?;
    let cleaned = output
        .content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: serde_json::Value = serde_json::from_str(cleaned)
        .map_err(|error| format!("AI 返回的阶段产物不是有效 JSON：{}", error))?;
    let stage = value
        .get("stage")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    if stage != input.stage {
        return Err("AI 返回的阶段与当前阶段不一致，请重新执行".to_string());
    }
    let completion_state = value
        .get("completion_state")
        .and_then(|item| item.as_str())
        .unwrap_or("partial");
    let mut completion_state =
        if ["draft", "partial", "ready", "blocked"].contains(&completion_state) {
            completion_state.to_string()
        } else {
            "partial".to_string()
        };
    if input.stage == "reading" || input.stage == "figures" {
        completion_state = "partial".to_string();
    } else if input.stage == "writing" {
        completion_state = "draft".to_string();
    } else if input.stage == "submission" {
        completion_state = "blocked".to_string();
    } else if input.stage == "screening" && input.total_records > input.records.len() {
        completion_state = "partial".to_string();
    }
    let manual_checks = value
        .get("manual_checks")
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str())
        .map(|item| clean_text(item.to_string(), 400))
        .filter(|item| !item.is_empty())
        .take(12)
        .collect();
    let artifact = SciReviewStageArtifact {
        stage: input.stage,
        skill_id,
        skill_version,
        skill_name,
        title: clean_text(
            value
                .get("title")
                .and_then(|item| item.as_str())
                .unwrap_or("阶段产物")
                .to_string(),
            200,
        ),
        summary: clean_text(
            value
                .get("summary")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            800,
        ),
        markdown: clean_text(
            value
                .get("markdown")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            80_000,
        ),
        completion_state,
        input_record_count: input.records.len().min(80),
        total_record_count: input.total_records,
        manual_checks,
        quality_gates,
        next_stage: clean_text(
            value
                .get("next_stage")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            40,
        ),
        generated_at: timestamp_millis(),
    };
    if artifact.markdown.is_empty() {
        return Err("AI 未返回阶段 Markdown 产物，请重新执行".to_string());
    }
    Ok((artifact, output.usage))
}

pub async fn recommend_journals(
    settings: &DeepSeekSettings,
    input: SciReviewJournalRecommendationInput,
) -> Result<(SciReviewJournalRecommendation, TokenUsage), String> {
    if input.draft_excerpt.trim().is_empty() {
        return Err("请先完成写作阶段，生成正文草稿后再进行目标期刊推荐".to_string());
    }
    let distribution = input
        .journal_distribution
        .into_iter()
        .filter(|item| !item.journal_name.trim().is_empty() && item.article_count > 0)
        .take(30)
        .collect::<Vec<_>>();
    if distribution.is_empty() {
        return Err("当前文献池没有可用于选刊的期刊信息".to_string());
    }
    let allowed = distribution
        .iter()
        .map(|item| {
            (
                item.journal_name.trim().to_lowercase(),
                (item.journal_name.trim().to_string(), item.article_count),
            )
        })
        .collect::<HashMap<_, _>>();
    let request = serde_json::json!({
        "project_name": clean_text(input.project_name, 120),
        "direction": clean_text(input.direction, 500),
        "keywords": clean_text(input.keywords, 800),
        "target_tier": clean_text(input.target_tier, 120),
        "article_type": clean_text(input.article_type, 120),
        "oa_preference": clean_text(input.oa_preference, 80),
        "apc_preference": clean_text(input.apc_preference, 80),
        "timeline_preference": clean_text(input.timeline_preference, 80),
        "draft_excerpt": clean_text(input.draft_excerpt, 12_000),
        "journal_distribution": distribution,
    });
    let selector = sci_skill_service::get_spec("sci-target-journal-selector")?;
    let learner = sci_skill_service::get_spec("sci-target-journal-deep-learner")?;
    let skill_text = format!(
        "## {}\n\n{}\n\n## {}\n\n{}",
        selector.skill_id,
        sci_skill_service::get_skill_text(&selector.skill_id)?,
        learner.skill_id,
        sci_skill_service::get_skill_text(&learner.skill_id)?
    );
    let system_prompt = format!(
        "{}\n\n# 必须严格执行的复合 Skill 原文\n\n{}\n\n先执行 14-SCI 目标期刊选择器，再执行 15-SCI 目标期刊深度学习器。不得跳过任一阶段；无法完成官网核查时必须标记人工核查。",
        JOURNAL_RECOMMENDATION_PROMPT, skill_text
    );
    let output = translate_service::complete_with_prompts(
        settings,
        &system_prompt,
        &serde_json::to_string_pretty(&request).map_err(|error| error.to_string())?,
        0.1,
        4_000,
    )
    .await?;
    let cleaned = output
        .content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: serde_json::Value = serde_json::from_str(cleaned)
        .map_err(|error| format!("AI 返回的候选期刊不是有效 JSON：{}", error))?;
    let candidates = value
        .get("candidates")
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let requested_name = item.get("journal_name")?.as_str()?.trim();
            let (journal_name, evidence_count) = allowed.get(&requested_name.to_lowercase())?;
            let tier = item
                .get("tier")
                .and_then(|value| value.as_str())
                .unwrap_or("primary");
            let tier = if ["ambitious", "primary", "safer"].contains(&tier) {
                tier.to_string()
            } else {
                "primary".to_string()
            };
            Some(SciReviewJournalCandidate {
                journal_name: journal_name.clone(),
                tier,
                fit_score: item
                    .get("fit_score")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(3)
                    .min(5) as u8,
                evidence_count: *evidence_count,
                reason: clean_text(
                    item.get("reason")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    600,
                ),
                risk: clean_text(
                    item.get("risk")
                        .and_then(|value| value.as_str())
                        .unwrap_or("需要核查期刊官网和最新指标")
                        .to_string(),
                    600,
                ),
                verification_status: "needs_official_verification".to_string(),
            })
        })
        .take(6)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Err("AI 未从当前文献池中返回有效候选期刊，请重新生成".to_string());
    }
    let requested_recommendation = value
        .get("recommended_journal")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    let recommended_journal = candidates
        .iter()
        .find(|item| {
            item.journal_name
                .eq_ignore_ascii_case(requested_recommendation)
        })
        .map(|item| item.journal_name.clone())
        .unwrap_or_else(|| candidates[0].journal_name.clone());
    let mut manual_checks = value
        .get("manual_checks")
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str())
        .map(|item| clean_text(item.to_string(), 400))
        .filter(|item| !item.is_empty())
        .take(8)
        .collect::<Vec<_>>();
    manual_checks.push("确认期刊官网 Scope 与 Review Article 接收政策".to_string());
    manual_checks.push("核查最新 SCI/SCIE 收录、JCR/中科院分区、IF、APC 与投稿周期".to_string());
    manual_checks.sort();
    manual_checks.dedup();
    let recommendation = SciReviewJournalRecommendation {
        skill_id: format!("{} → {}", selector.skill_id, learner.skill_id),
        skill_version: format!(
            "{}={}; {}={}",
            selector.skill_id, selector.skill_version, learner.skill_id, learner.skill_version
        ),
        quality_gates: selector
            .quality_gates
            .into_iter()
            .chain(learner.quality_gates)
            .collect(),
        summary: clean_text(
            value
                .get("summary")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            800,
        ),
        candidates,
        recommended_journal,
        manual_checks: manual_checks.into_iter().take(10).collect(),
        generated_at: timestamp_millis(),
    };
    Ok((recommendation, output.usage))
}

pub async fn write_section(
    settings: &DeepSeekSettings,
    input: SciReviewWritingSectionInput,
) -> Result<(SciReviewWritingSection, TokenUsage), String> {
    if !["introduction", "body", "synthesis"].contains(&input.section_id.as_str()) {
        return Err("不支持的综述写作部分".to_string());
    }
    if input.framework.trim().is_empty() {
        return Err("请先完成并确认综述框架".to_string());
    }
    if input.figure_plan.trim().is_empty() {
        return Err("请先完成图表与正文引用计划".to_string());
    }
    if input.evidence.len() < 3 {
        return Err("可用于写作的真实文献证据不足 3 篇".to_string());
    }
    if input.section_id != "introduction" && input.previous_sections.is_empty() {
        return Err("请按顺序先完成前一部分，再生成当前部分".to_string());
    }
    let allowed_tokens = allowed_citation_tokens(&input);
    if allowed_tokens.is_empty() {
        return Err("当前证据没有 PMID 或 DOI，无法生成可追溯正文".to_string());
    }
    let note_count = input
        .evidence
        .iter()
        .filter(|item| {
            item.note_content
                .as_ref()
                .is_some_and(|value| !value.trim().is_empty())
        })
        .count();
    if note_count == 0 {
        return Err("当前保留文献没有精读笔记；严格 Skill 模式禁止只凭摘要撰写正文".to_string());
    }
    let skill_id = match input.section_id.as_str() {
        "introduction" => "sci-review-chapter-one-writer",
        "body" => "sci-review-chapter-two-writer",
        "synthesis" => "sci-review-subsequent-chapters-writer",
        _ => unreachable!(),
    };
    let skill_spec = sci_skill_service::get_spec(skill_id)?;
    let skill_text = sci_skill_service::get_skill_text(skill_id)?;
    let evidence_count = input.evidence.len().min(24);
    let request = serde_json::json!({
        "section_id": input.section_id,
        "project_name": clean_text(input.project_name, 120),
        "direction": clean_text(input.direction, 500),
        "keywords": clean_text(input.keywords, 800),
        "framework": clean_text(input.framework, 20_000),
        "figure_plan": clean_text(input.figure_plan, 12_000),
        "previous_sections": input.previous_sections.into_iter().take(2).map(|value| clean_text(value, 24_000)).collect::<Vec<_>>(),
        "evidence": input.evidence.iter().take(24).map(|item| serde_json::json!({
            "entry_id": item.entry_id,
            "title": clean_text(item.title.clone(), 500),
            "abstract": item.abstract_text.as_ref().map(|value| clean_text(value.clone(), 1800)),
            "pmid": item.pmid,
            "doi": item.doi,
            "reading_note": item.note_content.as_ref().map(|value| clean_text(value.clone(), 4500)),
        })).collect::<Vec<_>>(),
        "allowed_citation_tokens": allowed_tokens,
    });
    let system_prompt = format!(
        "{}\n\n# 必须严格执行的 Skill 原文\n\n{}\n\n不得删减、改写或绕过上述 Skill 的 Required Inputs、Core Workflow、Quality Gates 和 Prohibited Actions。当前软件无法自动完成的动作必须标记为需要人工核查，不能声称已完成。",
        WRITING_SECTION_PROMPT, skill_text
    );
    let output = translate_service::complete_with_prompts(
        settings,
        &system_prompt,
        &serde_json::to_string_pretty(&request).map_err(|error| error.to_string())?,
        0.25,
        8_000,
    )
    .await?;
    let cleaned = output
        .content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: serde_json::Value = serde_json::from_str(cleaned)
        .map_err(|error| format!("AI 返回的章节产物不是有效 JSON：{}", error))?;
    let section_id = value
        .get("section_id")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    if section_id != input.section_id {
        return Err("AI 返回的写作部分与当前部分不一致".to_string());
    }
    let markdown = clean_text(
        value
            .get("markdown")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string(),
        100_000,
    );
    if markdown.is_empty() {
        return Err("AI 未返回章节正文".to_string());
    }
    validate_markdown_citations(&markdown, &allowed_tokens)?;
    let citations = value
        .get("citations")
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .map(|item| {
            let identifiers = item
                .get("identifiers")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str())
                .map(|value| {
                    value
                        .trim()
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .to_string()
                })
                .filter(|value| {
                    allowed_tokens.iter().any(|allowed| {
                        allowed
                            .trim_start_matches('[')
                            .trim_end_matches(']')
                            .eq_ignore_ascii_case(value)
                    })
                })
                .take(8)
                .collect();
            SciReviewCitationEvidence {
                paragraph_id: clean_text(
                    item.get("paragraph_id")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    40,
                ),
                claim: clean_text(
                    item.get("claim")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    500,
                ),
                identifiers,
                basis: clean_text(
                    item.get("basis")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    800,
                ),
            }
        })
        .filter(|item| !item.claim.is_empty() && !item.identifiers.is_empty())
        .take(80)
        .collect();
    let manual_checks = value
        .get("manual_checks")
        .and_then(|item| item.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str())
        .map(|item| clean_text(item.to_string(), 400))
        .filter(|item| !item.is_empty())
        .take(15)
        .collect();
    let section = SciReviewWritingSection {
        skill_id: skill_spec.skill_id,
        skill_version: skill_spec.skill_version,
        section_id: input.section_id,
        title: clean_text(
            value
                .get("title")
                .and_then(|item| item.as_str())
                .unwrap_or("综述章节")
                .to_string(),
            200,
        ),
        markdown,
        citations,
        evidence_record_count: evidence_count,
        reading_note_count: note_count,
        manual_checks,
        quality_gates: skill_spec.quality_gates,
        completion_state: "partial".to_string(),
        output_files: Vec::new(),
        generated_at: timestamp_millis(),
    };
    Ok((section, output.usage))
}

#[cfg(test)]
mod tests {
    use super::{stage_skill_ids, validate_markdown_citations};

    #[test]
    fn writing_citations_must_come_from_the_evidence_bundle() {
        let allowed = vec!["[PMID:123]".to_string(), "[DOI:10.1000/test]".to_string()];
        assert!(validate_markdown_citations("结论 [PMID:123]", &allowed).is_ok());
        assert!(validate_markdown_citations("结论 [PMID:999]", &allowed).is_err());
    }

    #[test]
    fn composite_stages_keep_the_skill_workflow_order() {
        assert_eq!(
            stage_skill_ids("screening").unwrap(),
            vec![
                "sci-topic-gap-identifier",
                "sci-benchmark-review-library-deep-learning",
                "sci-literature-screening-organizer",
            ]
        );
        assert_eq!(
            stage_skill_ids("submission").unwrap(),
            vec![
                "sci-review-deep-polisher",
                "sci-figure-permission-requester",
                "sci-submission-guide",
            ]
        );
    }
}
