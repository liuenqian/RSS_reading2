export const SCI_REVIEW_STORAGE_KEY = 'sci-review-projects-v1';

export const SCI_REVIEW_STAGES = [
  { id: 'search', label: '检索' },
  { id: 'pool', label: '文献池' },
  { id: 'screening', label: '筛选' },
  { id: 'reading', label: '精读' },
  { id: 'framework', label: '框架' },
  { id: 'figures', label: '图表' },
  { id: 'writing', label: '写作' },
  { id: 'submission', label: '投稿' },
];

const STAGE_IDS = new Set(SCI_REVIEW_STAGES.map(stage => stage.id));

function cleanText(value, maxLength = 10_000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeLinkedId(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSearchStrategy(value) {
  if (!value || typeof value !== 'object') return null;
  const options = Array.isArray(value.options) ? value.options : [];
  const normalizedOptions = ['broad', 'moderate', 'precise'].map(id => {
    const option = options.find(item => item?.id === id);
    if (!option) return null;
  return {
      id,
      label: cleanText(option.label, 40),
      pubmed_query: cleanText(option.pubmed_query, 8_000),
      wos_query: cleanText(option.wos_query, 8_000),
      purpose: cleanText(option.purpose, 500),
      recall: cleanText(option.recall, 300),
      precision: cleanText(option.precision, 300),
      use_case: cleanText(option.use_case, 500),
      risk: cleanText(option.risk, 500),
    };
  }).filter(Boolean);
  if (normalizedOptions.length !== 3) return null;
    return {
    skill_id: cleanText(value.skill_id, 300),
    skill_version: cleanText(value.skill_version, 300),
    quality_gates: (Array.isArray(value.quality_gates) ? value.quality_gates : []).map(item => cleanText(item, 500)).filter(Boolean).slice(0, 80),
    direction: cleanText(value.direction, 300),
    keywords: cleanText(value.keywords, 600),
    target_tier: cleanText(value.target_tier, 100),
    core_concepts: (Array.isArray(value.core_concepts) ? value.core_concepts : []).map(item => cleanText(item, 120)).filter(Boolean).slice(0, 5),
    manual_checks: (Array.isArray(value.manual_checks) ? value.manual_checks : []).map(item => cleanText(item, 300)).filter(Boolean).slice(0, 12),
    term_evidence: (Array.isArray(value.term_evidence) ? value.term_evidence : []).map(item => ({
      chinese_concept: cleanText(item?.chinese_concept, 120),
      concept_breakdown: cleanText(item?.concept_breakdown, 300),
      recommended_terms: (Array.isArray(item?.recommended_terms) ? item.recommended_terms : []).map(term => cleanText(term, 160)).filter(Boolean).slice(0, 12),
      term_type: cleanText(item?.term_type, 80),
      variants: (Array.isArray(item?.variants) ? item.variants : []).map(term => cleanText(term, 160)).filter(Boolean).slice(0, 20),
      mesh_evidence: cleanText(item?.mesh_evidence, 300),
      pubmed_evidence: cleanText(item?.pubmed_evidence, 300),
      wos_evidence: cleanText(item?.wos_evidence, 300),
      inclusion_decision: cleanText(item?.inclusion_decision, 300),
      risk: cleanText(item?.risk, 300),
    })).slice(0, 12),
    options: normalizedOptions,
    recommended_option: ['broad', 'moderate', 'precise'].includes(value.recommended_option) ? value.recommended_option : 'moderate',
    recommendation_reason: cleanText(value.recommendation_reason, 500),
  };
}

function normalizeTrialPreviews(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(['broad', 'moderate', 'precise'].flatMap(id => {
    const preview = value[id];
    if (!preview || typeof preview !== 'object') return [];
    return [[id, {
      totalCount: Math.max(0, Number(preview.totalCount) || 0),
      samples: (Array.isArray(preview.samples) ? preview.samples : []).slice(0, 3).map(item => ({
        pmid: cleanText(item?.pmid, 40),
        title: cleanText(item?.title, 500),
        journal: cleanText(item?.journal, 200),
      })),
    }]];
  }));
}

function normalizeStageArtifacts(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(SCI_REVIEW_STAGES.slice(1).flatMap(({ id }) => {
    const artifact = value[id];
    if (!artifact || typeof artifact !== 'object') return [];
    return [[id, {
      stage: id,
      skill_id: cleanText(artifact.skill_id, 120),
      skill_version: cleanText(artifact.skill_version, 80),
      skill_name: cleanText(artifact.skill_name, 120),
      title: cleanText(artifact.title, 200),
      summary: cleanText(artifact.summary, 800),
      markdown: cleanText(artifact.markdown, 80_000),
      completion_state: ['draft', 'partial', 'ready', 'blocked'].includes(artifact.completion_state) ? artifact.completion_state : 'partial',
      input_record_count: Math.max(0, Number(artifact.input_record_count) || 0),
      total_record_count: Math.max(0, Number(artifact.total_record_count) || 0),
      manual_checks: (Array.isArray(artifact.manual_checks) ? artifact.manual_checks : []).map(item => cleanText(item, 400)).filter(Boolean).slice(0, 12),
      quality_gates: (Array.isArray(artifact.quality_gates) ? artifact.quality_gates : []).map(item => cleanText(item, 500)).filter(Boolean).slice(0, 80),
      next_stage: STAGE_IDS.has(artifact.next_stage) ? artifact.next_stage : '',
      generated_at: cleanText(artifact.generated_at, 80),
    }]];
  }));
}

function normalizeJournalRecommendation(value) {
  if (!value || typeof value !== 'object') return null;
  const candidates = (Array.isArray(value.candidates) ? value.candidates : []).map(item => ({
    journal_name: cleanText(item?.journal_name, 200),
    tier: ['ambitious', 'primary', 'safer'].includes(item?.tier) ? item.tier : 'primary',
    fit_score: Math.max(0, Math.min(5, Number(item?.fit_score) || 0)),
    evidence_count: Math.max(0, Number(item?.evidence_count) || 0),
    reason: cleanText(item?.reason, 600),
    risk: cleanText(item?.risk, 600),
    verification_status: item?.verification_status === 'verified' ? 'verified' : 'needs_official_verification',
  })).filter(item => item.journal_name).slice(0, 6);
  if (!candidates.length) return null;
  const recommendedJournal = cleanText(value.recommended_journal, 200);
  return {
    skill_id: cleanText(value.skill_id, 300),
    skill_version: cleanText(value.skill_version, 300),
    quality_gates: (Array.isArray(value.quality_gates) ? value.quality_gates : []).map(item => cleanText(item, 500)).filter(Boolean).slice(0, 80),
    summary: cleanText(value.summary, 800),
    candidates,
    recommended_journal: candidates.some(item => item.journal_name === recommendedJournal) ? recommendedJournal : candidates[0].journal_name,
    manual_checks: (Array.isArray(value.manual_checks) ? value.manual_checks : []).map(item => cleanText(item, 400)).filter(Boolean).slice(0, 10),
    generated_at: cleanText(value.generated_at, 80),
  };
}

const WRITING_SECTION_STEPS = [
  { id: 'introduction', label: '第一章 · 引言', description: '背景 → 具体问题 → 研究空白 → 综述目的与范围' },
  { id: 'body', label: '主体章节', description: '严格按照综述框架综合机制、方法、证据与应用' },
  { id: 'synthesis', label: '讨论与结论', description: '讨论、局限性、未来展望和结论' },
];

function normalizeWritingSections(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(WRITING_SECTION_STEPS.flatMap(({ id }) => {
    const section = value[id];
    if (!section || typeof section !== 'object') return [];
    return [[id, {
      skill_id: cleanText(section.skill_id, 120),
      skill_version: cleanText(section.skill_version, 80),
      section_id: id,
      title: cleanText(section.title, 200),
      markdown: cleanText(section.markdown, 100_000),
      citations: (Array.isArray(section.citations) ? section.citations : []).map(item => ({
        paragraph_id: cleanText(item?.paragraph_id, 40),
        claim: cleanText(item?.claim, 500),
        identifiers: (Array.isArray(item?.identifiers) ? item.identifiers : []).map(value => cleanText(value, 160)).filter(Boolean).slice(0, 8),
        basis: cleanText(item?.basis, 800),
      })).filter(item => item.claim && item.identifiers.length).slice(0, 80),
      evidence_record_count: Math.max(0, Number(section.evidence_record_count) || 0),
      reading_note_count: Math.max(0, Number(section.reading_note_count) || 0),
      manual_checks: (Array.isArray(section.manual_checks) ? section.manual_checks : []).map(item => cleanText(item, 400)).filter(Boolean).slice(0, 15),
      quality_gates: (Array.isArray(section.quality_gates) ? section.quality_gates : []).map(item => cleanText(item, 500)).filter(Boolean).slice(0, 80),
      completion_state: section.completion_state === 'ready' ? 'ready' : 'partial',
      output_files: (Array.isArray(section.output_files) ? section.output_files : []).map(item => cleanText(item, 1_000)).filter(Boolean).slice(0, 20),
      generated_at: cleanText(section.generated_at, 80),
    }]];
  }));
}

function mergeWritingSections(sections) {
  return WRITING_SECTION_STEPS.map(({ id }) => sections[id]?.markdown).filter(Boolean).join('\n\n');
}

function createId(now = Date.now()) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `review-${now}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeSciReviewProject(value = {}) {
  const now = new Date().toISOString();
  const direction = cleanText(value.direction, 300);
  const name = cleanText(value.name, 100) || direction || '未命名综述项目';
  const activeStage = STAGE_IDS.has(value.activeStage) ? value.activeStage : 'search';

  return {
    id: cleanText(value.id, 100) || createId(),
    name,
    direction,
    keywords: cleanText(value.keywords, 600),
    targetTier: cleanText(value.targetTier, 100) || '待定',
    activeStage,
    linkedPubmedSearchId: normalizeLinkedId(value.linkedPubmedSearchId),
    linkedPmcSearchId: normalizeLinkedId(value.linkedPmcSearchId),
    searchMode: value.searchMode === 'import' ? 'import' : 'skill',
    databaseScope: value.databaseScope === 'pubmed-wos' ? 'pubmed-wos' : 'pubmed',
    wosLoginConfirmed: value.wosLoginConfirmed === true,
    wosLoginConfirmedAt: cleanText(value.wosLoginConfirmedAt, 80),
    searchStrategy: normalizeSearchStrategy(value.searchStrategy),
    trialPreviews: normalizeTrialPreviews(value.trialPreviews),
    selectedStrategy: ['broad', 'moderate', 'precise', 'custom'].includes(value.selectedStrategy) ? value.selectedStrategy : '',
    customPubmedQuery: cleanText(value.customPubmedQuery, 8_000),
    customWosQuery: cleanText(value.customWosQuery, 8_000),
    stageArtifacts: normalizeStageArtifacts(value.stageArtifacts),
    writingSections: normalizeWritingSections(value.writingSections),
    framework: cleanText(value.framework, 30_000),
    draft: cleanText(value.draft, 80_000),
    articleType: ['narrative-review', 'systematic-review', 'scoping-review', 'mini-review', 'perspective'].includes(value.articleType) ? value.articleType : 'narrative-review',
    oaPreference: ['any', 'prefer-non-oa', 'prefer-oa'].includes(value.oaPreference) ? value.oaPreference : 'any',
    apcPreference: ['any', 'avoid', 'limited'].includes(value.apcPreference) ? value.apcPreference : 'any',
    timelinePreference: ['any', 'fast', 'quality-first'].includes(value.timelinePreference) ? value.timelinePreference : 'any',
    journalRecommendation: normalizeJournalRecommendation(value.journalRecommendation),
    selectedJournalCandidate: cleanText(value.selectedJournalCandidate, 200),
    targetJournal: cleanText(value.targetJournal, 200),
    journalConfirmedAt: cleanText(value.journalConfirmedAt, 80),
    submissionNotes: cleanText(value.submissionNotes, 20_000),
    createdAt: cleanText(value.createdAt, 80) || now,
    updatedAt: cleanText(value.updatedAt, 80) || now,
  };
}

export function normalizeSciReviewProjects(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(normalizeSciReviewProject).filter(project => {
    if (seen.has(project.id)) return false;
    seen.add(project.id);
    return true;
  });
}

export function createSciReviewProject(input = {}, now = new Date().toISOString()) {
  return normalizeSciReviewProject({
    ...input,
    id: input.id || createId(Date.parse(now) || Date.now()),
    activeStage: 'search',
    createdAt: now,
    updatedAt: now,
  });
}

export function updateSciReviewProject(projects, projectId, patch, now = new Date().toISOString()) {
  return normalizeSciReviewProjects(projects).map(project => project.id === projectId
    ? normalizeSciReviewProject({ ...project, ...patch, id: project.id, createdAt: project.createdAt, updatedAt: now })
    : project);
}

export function deleteSciReviewProject(projects, projectId) {
  return normalizeSciReviewProjects(projects).filter(project => project.id !== projectId);
}

export function sciReviewProjectProgress(project) {
  const normalized = normalizeSciReviewProject(project);
  const completed = [
    normalized.direction && normalized.keywords,
    normalized.linkedPubmedSearchId || normalized.selectedStrategy,
    normalized.stageArtifacts.screening,
    normalized.framework || normalized.stageArtifacts.framework,
    normalized.linkedPmcSearchId || normalized.stageArtifacts.figures,
    normalized.draft || normalized.stageArtifacts.writing,
  ].filter(Boolean).length;
  return Math.round((completed / 6) * 100);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function keywordTerms(project) {
  return project.keywords
    .split(/[，,;；\n]+/)
    .map(term => term.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function searchById(searches, id) {
  return (Array.isArray(searches) ? searches : []).find(search => Number(search.id) === Number(id)) || null;
}

function countLabel(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function artifactDateLabel(value) {
  if (!value) return '';
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

function strategyOptionMarkup(project, option) {
  const preview = project.trialPreviews[option.id];
  const selected = project.selectedStrategy === option.id;
  const recommended = project.searchStrategy?.recommended_option === option.id;
  return `
    <article class="review-strategy-option ${selected ? 'selected' : ''}">
      <label class="review-strategy-option-head">
        <input type="radio" name="review-strategy" value="${option.id}" data-review-strategy ${selected ? 'checked' : ''}>
        <strong>${escapeHtml(option.label)}</strong>
        ${recommended ? '<span>推荐</span>' : ''}
        ${preview ? `<em>PubMed ${countLabel(preview.totalCount)} 篇</em>` : '<em>尚未试检索</em>'}
      </label>
      <div class="review-strategy-summary"><span>查全：${escapeHtml(option.recall)}</span><span>查准：${escapeHtml(option.precision)}</span></div>
      <p>${escapeHtml(option.purpose)} · ${escapeHtml(option.use_case)}</p>
      <details>
        <summary>查看${project.databaseScope === 'pubmed-wos' ? ' PubMed / WOS' : ' PubMed'}检索式</summary>
        <label>PubMed<code>${escapeHtml(option.pubmed_query)}</code></label>
        ${project.databaseScope === 'pubmed-wos' ? `<label>Web of Science<code>${escapeHtml(option.wos_query)}</code></label>` : ''}
        <small>风险：${escapeHtml(option.risk)}</small>
      </details>
      ${preview?.samples?.length ? `<ul class="review-trial-samples">${preview.samples.map(sample => `<li><span>${escapeHtml(sample.title)}</span><small>${escapeHtml(sample.journal || '期刊待确认')} · PMID ${escapeHtml(sample.pmid)}</small></li>`).join('')}</ul>` : ''}
    </article>`;
}

function generatedStrategyMarkup(project) {
  const strategy = project.searchStrategy;
  if (!strategy) {
    return `<div class="review-empty-state review-strategy-empty"><strong>尚未生成系统综述检索策略</strong><p>AI 将先拆解概念并生成三套 ${project.databaseScope === 'pubmed-wos' ? 'PubMed/WOS' : 'PubMed'} 检索式，不会立即执行质量评估。</p></div>`;
  }
  const manualChecks = project.databaseScope === 'pubmed-wos'
    ? strategy.manual_checks
    : strategy.manual_checks.filter(item => !/\bWOS\b|Web of Science/i.test(item));
  const checks = manualChecks.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  return `
    <section class="review-strategy-result">
      ${strategy.skill_id ? `<div class="review-skill-note">严格执行：${escapeHtml(strategy.skill_id)} · v${escapeHtml(strategy.skill_version || '未知')}</div>` : ''}
      <div class="review-result-heading"><div><h3>检索主题拆解</h3><div class="review-concept-list">${strategy.core_concepts.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div></div><p>${escapeHtml(strategy.recommendation_reason)}</p></div>
      <details class="review-evidence-panel" open>
        <summary>术语证据表 · ${strategy.term_evidence.length} 个概念</summary>
        <div class="review-evidence-table-wrap"><table class="review-evidence-table"><thead><tr><th>中文概念</th><th>推荐英文术语</th><th>同义词/变体</th><th>证据状态</th><th>纳入与风险</th></tr></thead><tbody>
          ${strategy.term_evidence.map(item => `<tr><td><strong>${escapeHtml(item.chinese_concept)}</strong><small>${escapeHtml(item.concept_breakdown)}</small></td><td>${item.recommended_terms.map(term => `<code>${escapeHtml(term)}</code>`).join('')}</td><td>${escapeHtml(item.variants.join('；') || '无')}</td><td><span>${escapeHtml(item.mesh_evidence)}</span><span>${escapeHtml(item.pubmed_evidence)}</span>${project.databaseScope === 'pubmed-wos' ? `<span>${escapeHtml(item.wos_evidence)}</span>` : ''}</td><td><span>${escapeHtml(item.inclusion_decision)}</span><small>${escapeHtml(item.risk)}</small></td></tr>`).join('')}
        </tbody></table></div>
      </details>
      ${checks ? `<details class="review-manual-checks"><summary>需要人工核查 · ${manualChecks.length} 项</summary><ul>${checks}</ul></details>` : ''}
      ${strategy.quality_gates.length ? `<details class="review-manual-checks"><summary>02-Skill 原文质量门槛 · ${strategy.quality_gates.length} 项</summary><ul>${strategy.quality_gates.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
      <div class="review-strategy-options">${strategy.options.map(option => strategyOptionMarkup(project, option)).join('')}</div>
      <article class="review-strategy-option ${project.selectedStrategy === 'custom' ? 'selected' : ''}">
        <label class="review-strategy-option-head"><input type="radio" name="review-strategy" value="custom" data-review-strategy ${project.selectedStrategy === 'custom' ? 'checked' : ''}><strong>自定义检索式</strong><em>D</em></label>
        ${project.selectedStrategy === 'custom' ? `<div class="review-custom-query-grid"><label>PubMed<textarea data-review-field="customPubmedQuery">${escapeHtml(project.customPubmedQuery)}</textarea></label><label>Web of Science<textarea data-review-field="customWosQuery">${escapeHtml(project.customWosQuery)}</textarea></label></div>` : '<p>在三套方案基础上自行修改后再保存。</p>'}
      </article>
      <div class="review-strategy-actions"><button class="btn btn-secondary" type="button" data-review-action="preview-strategy">预览三套方案</button><span data-review-strategy-status></span><button class="btn btn-primary" type="button" data-review-action="use-strategy" ${project.selectedStrategy ? '' : 'disabled'}>确认并创建 PubMed 检索</button></div>
    </section>`;
}

const STAGE_EXECUTION_LABELS = {
  pool: '执行 03-SCI 文献检索导出器',
  screening: '执行 04 → 05 → 06 筛选 Skill',
  reading: '执行 07 → 08 精读 Skill',
  framework: '生成综述框架',
  figures: '执行 10 → 17 图表与授权 Skill',
  writing: '生成分章节草稿',
  submission: '执行 16 → 17 → 19 投稿准备 Skill',
};

function stageHasStrictPrerequisites(project, stage) {
  if (stage === 'pool') return Boolean(project.linkedPubmedSearchId);
  if (stage === 'screening') return Boolean(project.stageArtifacts.pool);
  if (stage === 'reading') return Boolean(project.stageArtifacts.screening);
  if (stage === 'framework') return Boolean(project.stageArtifacts.reading);
  if (stage === 'figures') return Boolean(project.stageArtifacts.framework || project.framework);
  if (stage === 'submission') return Boolean(
    project.targetJournal
      && project.journalConfirmedAt
      && project.writingSections.introduction?.completion_state === 'ready'
      && project.writingSections.body?.completion_state === 'ready'
      && project.writingSections.synthesis?.completion_state === 'ready'
  );
  return true;
}

function stageExecutionMarkup(project, stage) {
  const artifact = project.stageArtifacts[stage];
  const stateLabels = { draft: '草稿', partial: '部分完成', ready: '可进入下一步', blocked: '存在阻塞' };
  const canRun = stageHasStrictPrerequisites(project, stage);
  return `
    <section class="review-stage-execution">
      <div class="review-stage-execution-head">
        <div><strong>Skill 阶段执行</strong><p>读取当前文献池和已保存的上游产物；只在你点击后调用 AI。</p></div>
        <button class="btn btn-primary" type="button" data-review-action="run-stage" ${canRun ? '' : 'disabled'}>${artifact ? '重新执行本阶段' : STAGE_EXECUTION_LABELS[stage]}</button>
      </div>
      <div class="review-stage-run-status" data-review-stage-status></div>
      ${artifact ? `
        <article class="review-stage-artifact">
          <header><div><span>${escapeHtml(artifact.skill_name || 'SCI 综述工作流')} · ${escapeHtml(artifact.skill_id || '旧产物')} · v${escapeHtml(artifact.skill_version || '未知')}</span><h3>${escapeHtml(artifact.title || '阶段产物')}</h3></div><em data-state="${artifact.completion_state}">${stateLabels[artifact.completion_state]}</em></header>
          <p>${escapeHtml(artifact.summary)}</p>
          <div class="review-artifact-meta"><span>本批 ${countLabel(artifact.input_record_count)} 篇</span><span>文献池 ${countLabel(artifact.total_record_count)} 篇</span><span>${escapeHtml(artifactDateLabel(artifact.generated_at))}</span></div>
          <details open><summary>查看阶段产物</summary><pre>${escapeHtml(artifact.markdown)}</pre></details>
          ${artifact.manual_checks.length ? `<details class="review-manual-checks"><summary>需要人工核查 · ${artifact.manual_checks.length} 项</summary><ul>${artifact.manual_checks.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
          ${artifact.quality_gates.length ? `<details class="review-manual-checks"><summary>Skill 原文质量门槛 · ${artifact.quality_gates.length} 项</summary><ul>${artifact.quality_gates.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
          ${artifact.next_stage ? `<button class="btn btn-secondary" type="button" data-review-stage="${artifact.next_stage}">进入下一步</button>` : ''}
        </article>` : '<div class="review-empty-state review-stage-artifact-empty"><strong>尚未生成本阶段产物</strong><p>执行前会检查真实输入范围；缺少全文、图源或期刊核查时会保留为待办。</p></div>'}
    </section>`;
}

function journalRecommendationMarkup(project) {
  const recommendation = project.journalRecommendation;
  if (!recommendation) {
    return '<div class="review-empty-state review-journal-empty"><strong>尚未生成候选期刊</strong><p>AI 会从当前文献池真实出现的期刊中分梯队推荐；最新指标仍需官网核查。</p></div>';
  }
  const tierLabels = { ambitious: '冲刺', primary: '主投', safer: '稳妥' };
  return `
    <section class="review-journal-recommendation">
      ${recommendation.skill_id ? `<div class="review-skill-note">严格执行：${escapeHtml(recommendation.skill_id)} · v${escapeHtml(recommendation.skill_version || '未知')}</div>` : ''}
      <div class="review-journal-summary"><p>${escapeHtml(recommendation.summary)}</p><small>${escapeHtml(artifactDateLabel(recommendation.generated_at))}</small></div>
      <div class="review-journal-candidates">
        ${recommendation.candidates.map(candidate => {
          const selected = project.selectedJournalCandidate === candidate.journal_name;
          return `<label class="review-journal-candidate ${selected ? 'selected' : ''}">
            <input type="radio" name="review-journal-candidate" value="${escapeHtml(candidate.journal_name)}" data-review-journal-candidate ${selected ? 'checked' : ''}>
            <span class="review-journal-tier" data-tier="${candidate.tier}">${tierLabels[candidate.tier]}</span>
            <strong>${escapeHtml(candidate.journal_name)}</strong>
            <div><span>匹配度 ${candidate.fit_score}/5</span><span>文献池 ${countLabel(candidate.evidence_count)} 篇</span></div>
            <p>${escapeHtml(candidate.reason)}</p>
            <small>${escapeHtml(candidate.risk || '需要核查期刊官网')}</small>
          </label>`;
        }).join('')}
      </div>
      <div class="review-journal-confirm-row"><span>确认前请核查官网 Scope、综述类型与最新分区。</span><button class="btn btn-primary" type="button" data-review-action="confirm-journal" ${project.selectedJournalCandidate ? '' : 'disabled'}>确认目标期刊</button></div>
      ${recommendation.manual_checks.length ? `<details class="review-manual-checks"><summary>官网核查清单 · ${recommendation.manual_checks.length} 项</summary><ul>${recommendation.manual_checks.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
      ${recommendation.quality_gates.length ? `<details class="review-manual-checks"><summary>14 → 15 Skill 原文质量门槛 · ${recommendation.quality_gates.length} 项</summary><ul>${recommendation.quality_gates.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
    </section>`;
}

function writingSectionMarkup(project, step, canGenerate) {
  const section = project.writingSections[step.id];
  const isReady = section?.completion_state === 'ready';
  return `
    <article class="review-writing-section ${section ? 'completed' : ''} ${isReady ? 'ready' : ''}">
      <header><div><span>${isReady ? '质量门槛已确认' : (section ? '待核查' : '待生成')}</span><h3>${escapeHtml(step.label)}</h3><p>${escapeHtml(step.description)}</p></div><button class="btn ${section ? 'btn-secondary' : 'btn-primary'}" type="button" data-review-action="write-section" data-writing-section="${step.id}" ${canGenerate ? '' : 'disabled'}>${section ? '重新生成本部分' : '生成本部分'}</button></header>
      ${section ? `
        <div class="review-writing-meta"><span>${escapeHtml(section.skill_id || '旧产物')} · v${escapeHtml(section.skill_version || '未知')}</span><span>证据文献 ${countLabel(section.evidence_record_count)} 篇</span><span>阅读笔记 ${countLabel(section.reading_note_count)} 篇</span><span>论点证据 ${countLabel(section.citations.length)} 条</span><span>${escapeHtml(artifactDateLabel(section.generated_at))}</span></div>
        <details open><summary>查看章节正文</summary><pre>${escapeHtml(section.markdown)}</pre></details>
        <details><summary>引用证据表 · ${section.citations.length} 条</summary><div class="review-writing-citations">${section.citations.map(item => `<div><strong>${escapeHtml(item.paragraph_id || '段落')}</strong><span>${escapeHtml(item.claim)}</span><code>${escapeHtml(item.identifiers.join('；'))}</code><small>${escapeHtml(item.basis)}</small></div>`).join('')}</div></details>
        ${section.manual_checks.length ? `<details class="review-manual-checks"><summary>需要人工核查 · ${section.manual_checks.length} 项</summary><ul>${section.manual_checks.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
        ${section.quality_gates.length ? `<details class="review-manual-checks"><summary>Skill 原文质量门槛 · ${section.quality_gates.length} 项</summary><ul>${section.quality_gates.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
        ${section.output_files.length ? `<details><summary>实际输出文件 · ${section.output_files.length} 个</summary><ul class="review-output-files">${section.output_files.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
        <div class="review-writing-confirm"><span>${isReady ? '已落盘保存质量门槛确认记录。' : '请先逐项核对 Skill 原文质量门槛，再允许进入下一章。'}</span>${isReady ? '' : `<button class="btn btn-primary" type="button" data-review-action="confirm-writing-gates" data-writing-section="${step.id}">确认质量门槛</button>`}</div>
      ` : `<p class="review-writing-gate">${canGenerate ? '将读取真实摘要、已有阅读笔记、综述框架和图表引用计划。' : '请先完成上一部分及必要的框架/图表计划。'}</p>`}
    </article>`;
}

function strictSkillRegistryMarkup(specs) {
  const normalized = Array.isArray(specs) ? specs : [];
  const available = normalized.filter(item => item.available).length;
  return `<section class="review-skill-registry"><h2>严格 Skill 模式</h2><p>${available}/${normalized.length || 20} 个 Skill 原文可用</p><details><summary>查看 01-20 执行规范</summary><ol>${normalized.map(item => `<li class="${item.available ? 'available' : 'missing'}"><span>${String(item.step).padStart(2, '0')}</span><strong>${escapeHtml(item.skill_name)}</strong><em>${item.available ? `v${escapeHtml(item.skill_version)}` : '缺失，禁止执行'}</em></li>`).join('')}</ol></details></section>`;
}

function projectStageMarkup(project, context) {
  const pubmedSearches = context.pubmedSearches;
  const pmcSearches = context.pmcSearches;
  const pubmed = searchById(pubmedSearches, project.linkedPubmedSearchId);
  const pmc = searchById(pmcSearches, project.linkedPmcSearchId);
  const pubmedOptions = pubmedSearches.map(search => `
    <option value="${escapeHtml(search.id)}" ${Number(search.id) === project.linkedPubmedSearchId ? 'selected' : ''}>
      ${escapeHtml(search.name)} · ${countLabel(search.total_entries)} 篇
    </option>`).join('');
  const pmcOptions = pmcSearches.map(search => `
    <option value="${escapeHtml(search.id)}" ${Number(search.id) === project.linkedPmcSearchId ? 'selected' : ''}>
      ${escapeHtml(search.name)}
    </option>`).join('');

  if (project.activeStage === 'search') {
    return `
      <div class="review-stage-heading">
        <div><h2>检索策略</h2><p>先按 SCI Skill 校准术语并比较三套方案，再保存最终检索。</p></div>
      </div>
      <div class="review-search-mode-tabs" role="tablist">
        <button class="${project.searchMode === 'skill' ? 'active' : ''}" type="button" data-review-search-mode="skill">系统综述检索</button>
        <button class="${project.searchMode === 'import' ? 'active' : ''}" type="button" data-review-search-mode="import">导入已有检索</button>
      </div>
      <div class="review-form-grid">
        <label class="review-field review-field-wide"><span>项目名称</span><input data-review-field="name" maxlength="100" value="${escapeHtml(project.name)}"></label>
        <label class="review-field review-field-wide"><span>研究方向</span><input data-review-field="direction" maxlength="300" value="${escapeHtml(project.direction)}" placeholder="例如：心肌缺血后的纤维化重塑"></label>
        <label class="review-field review-field-wide"><span>研究关键词</span><input data-review-field="keywords" maxlength="600" value="${escapeHtml(project.keywords)}" placeholder="中文、英文或混合关键词，用逗号分隔"></label>
        <label class="review-field"><span>目标分区</span><input data-review-field="targetTier" maxlength="100" value="${escapeHtml(project.targetTier)}" placeholder="例如：中科院一区 / JCR Q1"></label>
        ${project.searchMode === 'import' ? `<label class="review-field"><span>关联 PubMed 检索</span><select data-review-field="linkedPubmedSearchId"><option value="">尚未关联</option>${pubmedOptions}</select></label>` : `<label class="review-field"><span>检索数据库</span><select data-review-field="databaseScope"><option value="pubmed" ${project.databaseScope === 'pubmed' ? 'selected' : ''}>仅 PubMed（默认）</option><option value="pubmed-wos" ${project.databaseScope === 'pubmed-wos' ? 'selected' : ''}>PubMed + Web of Science</option></select></label>`}
      </div>
      ${project.searchMode === 'skill' ? `
        ${project.databaseScope === 'pubmed-wos' ? `<div class="review-wos-gate ${project.wosLoginConfirmed ? 'confirmed' : ''}"><div><strong>${project.wosLoginConfirmed ? 'WOS 机构登录已确认' : '双库检索需要确认 Web of Science 机构登录'}</strong><p>${project.wosLoginConfirmed ? `确认时间：${escapeHtml(project.wosLoginConfirmedAt || '本机已确认')}` : '没有 WOS 权限时，可将检索数据库切换为“仅 PubMed”。'}</p></div><div><button class="btn btn-secondary" type="button" data-review-action="open-wos">打开 WOS 官网</button><label><input type="checkbox" data-review-wos-confirm ${project.wosLoginConfirmed ? 'checked' : ''}> 我已确认机构登录</label></div></div>` : ''}
        <div class="review-generate-row"><div><strong>02-SCI 检索式生成器</strong><p>生成概念拆解、术语证据和宽泛/适量/精准${project.databaseScope === 'pubmed-wos' ? '双库' : ' PubMed'}检索式。</p></div><button class="btn btn-primary" type="button" data-review-action="generate-strategy">${project.searchStrategy ? '重新生成策略' : '生成检索策略'}</button></div>
        ${generatedStrategyMarkup(project)}
      ` : `<section class="review-linked-card ${pubmed ? '' : 'is-empty'}"><div><span class="review-card-eyebrow">导入已有检索</span><strong>${escapeHtml(pubmed?.name || '尚未关联 PubMed 检索')}</strong><p>${escapeHtml(pubmed?.query || '从上方选择已有检索；此入口不执行 Skill 术语校准。')}</p></div>${pubmed ? `<button class="btn btn-primary" type="button" data-review-action="open-pubmed" data-search-id="${pubmed.id}">查看 ${countLabel(pubmed.total_entries)} 篇结果</button>` : ''}</section>`}`;
  }

  if (project.activeStage === 'pool') {
    return `
      <div class="review-stage-heading"><div><h2>文献池</h2><p>文献仍保存在原 PubMed 检索中，项目只建立引用关系。</p></div></div>
      ${pubmed ? `
        <div class="review-metric-grid">
          <div><span>候选文献</span><strong>${countLabel(pubmed.total_entries)}</strong></div>
          <div><span>未筛选</span><strong>${countLabel(pubmed.unreviewed_count)}</strong></div>
          <div><span>保留</span><strong>${countLabel(pubmed.keep_count)}</strong></div>
          <div><span>待定</span><strong>${countLabel(pubmed.maybe_count)}</strong></div>
        </div>
        <section class="review-linked-card"><div><span class="review-card-eyebrow">${escapeHtml(pubmed.name)}</span><strong>继续在现有文献列表中管理</strong><p>${escapeHtml(pubmed.query)}</p></div><button class="btn btn-secondary" type="button" data-review-action="open-pubmed" data-search-id="${pubmed.id}">打开文献池</button></section>
        ${stageExecutionMarkup(project, 'pool')}
      ` : '<div class="review-empty-state"><strong>尚未建立文献池</strong><p>先在“检索”阶段关联一个 PubMed 检索。</p></div>'}`;
  }

  if (project.activeStage === 'screening') {
    return `
      <div class="review-stage-heading"><div><h2>文献筛选</h2><p>沿用当前检索独立的筛选状态、期刊指标和排序条件。</p></div></div>
      ${pubmed ? `
        <div class="review-metric-grid">
          <div><span>保留</span><strong>${countLabel(pubmed.keep_count)}</strong></div>
          <div><span>待定</span><strong>${countLabel(pubmed.maybe_count)}</strong></div>
          <div><span>排除</span><strong>${countLabel(pubmed.exclude_count)}</strong></div>
          <div><span>待处理</span><strong>${countLabel(pubmed.unreviewed_count)}</strong></div>
        </div>
        <div class="review-action-band"><div><strong>初筛工作台</strong><p>按 IF、JCR、中科院分区、Top 期刊和筛选状态继续处理。</p></div><button class="btn btn-primary" type="button" data-review-action="open-screening" data-search-id="${pubmed.id}">进入初筛</button></div>
        ${stageExecutionMarkup(project, 'screening')}
      ` : '<div class="review-empty-state"><strong>暂无可筛选文献</strong><p>先关联一个 PubMed 检索。</p></div>'}`;
  }

  if (project.activeStage === 'reading') {
    return `
      <div class="review-stage-heading"><div><h2>精读与笔记</h2><p>从保留文献进入阅读笔记，原文、摘要、PDF 与 AI 笔记仍归档在文献记录中。</p></div></div>
      <div class="review-action-band"><div><strong>阅读笔记</strong><p>打开全局笔记列表后，可按当前项目的关键词继续检索。</p></div><button class="btn btn-primary" type="button" data-review-action="open-reading">打开阅读笔记</button></div>
      ${pubmed ? `<div class="review-action-band"><div><strong>${escapeHtml(pubmed.name)}</strong><p>先回到文献池选择需要精读的文章。</p></div><button class="btn btn-secondary" type="button" data-review-action="open-pubmed" data-search-id="${pubmed.id}">查看保留文献</button></div>` : ''}
      ${pubmed ? stageExecutionMarkup(project, 'reading') : ''}`;
  }

  if (project.activeStage === 'framework') {
    return `
      <div class="review-stage-heading"><div><h2>综述框架</h2><p>先固定章节逻辑，再把精读证据归入对应章节。</p></div></div>
      ${stageExecutionMarkup(project, 'framework')}
      <label class="review-editor"><span>章节框架</span><textarea data-review-field="framework" placeholder="阶段产物生成后可在这里继续人工调整">${escapeHtml(project.framework)}</textarea><small>自动保存在当前项目中</small></label>`;
  }

  if (project.activeStage === 'figures') {
    return `
      <div class="review-stage-heading"><div><h2>图表规划</h2><p>关联 PMC 图库检索，集中参考高分文章的图形摘要和 Figure。</p></div><button class="btn btn-secondary" type="button" data-review-action="new-pmc">新建 PMC 图库检索</button></div>
      <label class="review-field review-standalone-field"><span>关联 PMC 图库</span><select data-review-field="linkedPmcSearchId"><option value="">尚未关联</option>${pmcOptions}</select></label>
      <div class="review-action-band"><div><strong>${escapeHtml(pmc?.name || '尚未选择图库')}</strong><p>${pmc ? '打开后可按期刊、IF、分区和 Figure 编号浏览。' : '图库不是生成图表计划的前置条件，但没有图源时会标记待核查。'}</p></div>${pmc ? `<button class="btn btn-secondary" type="button" data-review-action="open-pmc" data-search-id="${pmc.id}">打开图库</button>` : ''}</div>
      ${stageExecutionMarkup(project, 'figures')}`;
  }

  if (project.activeStage === 'writing') {
    const hasReading = Boolean(project.stageArtifacts.reading);
    const hasFramework = Boolean(project.framework || project.stageArtifacts.framework?.markdown);
    const hasFigurePlan = Boolean(project.stageArtifacts.figures?.markdown);
    const canIntroduction = hasReading && hasFramework && hasFigurePlan;
    const canBody = canIntroduction && project.writingSections.introduction?.completion_state === 'ready';
    const canSynthesis = canBody && project.writingSections.body?.completion_state === 'ready';
    return `
      <div class="review-stage-heading"><div><h2>证据约束写作</h2><p>按章节顺序生成；每个关键判断必须关联真实 PMID/DOI 和摘要或阅读笔记。</p></div></div>
      ${!canIntroduction ? '<div class="review-writing-prerequisite"><strong>写作前置材料不完整</strong><p>请先完成 08-SCI 文献精读、09-综述框架和 10-图表引用计划。严格 Skill 模式不会跳过上游证据。</p></div>' : ''}
      <div class="review-stage-run-status" data-review-writing-status></div>
      <div class="review-writing-sections">
        ${writingSectionMarkup(project, WRITING_SECTION_STEPS[0], canIntroduction)}
        ${writingSectionMarkup(project, WRITING_SECTION_STEPS[1], canBody)}
        ${writingSectionMarkup(project, WRITING_SECTION_STEPS[2], canSynthesis)}
      </div>
      <label class="review-editor review-editor-large"><span>合并全文草稿</span><textarea data-review-field="draft" placeholder="逐章生成后会自动合并；也可以在这里继续人工修改">${escapeHtml(project.draft)}</textarea><small>自动保存在当前项目中；重新生成某一部分会按三个部分重新合并</small></label>`;
  }

  const hasDraft = WRITING_SECTION_STEPS.every(({ id }) => project.writingSections[id]?.completion_state === 'ready');
  return `
    <div class="review-stage-heading"><div><h2>AI 选刊与投稿</h2><p>AI 先按真实文献池生成候选期刊，你确认后再准备投稿材料。</p></div></div>
    <div class="review-form-grid review-journal-preferences">
      <label class="review-field"><span>文章类型</span><select data-review-field="articleType"><option value="narrative-review" ${project.articleType === 'narrative-review' ? 'selected' : ''}>叙述性综述</option><option value="systematic-review" ${project.articleType === 'systematic-review' ? 'selected' : ''}>系统综述</option><option value="scoping-review" ${project.articleType === 'scoping-review' ? 'selected' : ''}>范围综述</option><option value="mini-review" ${project.articleType === 'mini-review' ? 'selected' : ''}>Mini Review</option><option value="perspective" ${project.articleType === 'perspective' ? 'selected' : ''}>Perspective</option></select></label>
      <label class="review-field"><span>开放获取偏好</span><select data-review-field="oaPreference"><option value="any" ${project.oaPreference === 'any' ? 'selected' : ''}>不限</option><option value="prefer-non-oa" ${project.oaPreference === 'prefer-non-oa' ? 'selected' : ''}>优先非 OA</option><option value="prefer-oa" ${project.oaPreference === 'prefer-oa' ? 'selected' : ''}>优先 OA</option></select></label>
      <label class="review-field"><span>APC 偏好</span><select data-review-field="apcPreference"><option value="any" ${project.apcPreference === 'any' ? 'selected' : ''}>不限</option><option value="avoid" ${project.apcPreference === 'avoid' ? 'selected' : ''}>尽量避免 APC</option><option value="limited" ${project.apcPreference === 'limited' ? 'selected' : ''}>预算有限</option></select></label>
      <label class="review-field"><span>投稿策略</span><select data-review-field="timelinePreference"><option value="any" ${project.timelinePreference === 'any' ? 'selected' : ''}>平衡匹配度与周期</option><option value="fast" ${project.timelinePreference === 'fast' ? 'selected' : ''}>优先较快处理</option><option value="quality-first" ${project.timelinePreference === 'quality-first' ? 'selected' : ''}>期刊质量优先</option></select></label>
    </div>
    <div class="review-generate-row review-journal-generate"><div><strong>14-SCI 目标期刊选择器</strong><p>${hasDraft ? '基于正文草稿、目标分区和当前文献池的期刊分布生成三梯队候选。' : '需要先在“写作”阶段生成正文草稿。'}</p></div><button class="btn btn-primary" type="button" data-review-action="recommend-journals" ${hasDraft ? '' : 'disabled'}>${project.journalRecommendation ? '重新推荐候选期刊' : 'AI 推荐候选期刊'}</button></div>
    <div class="review-stage-run-status" data-review-journal-status></div>
    ${journalRecommendationMarkup(project)}
    ${project.targetJournal && project.journalConfirmedAt ? `<section class="review-confirmed-journal"><span>已确认目标期刊</span><strong>${escapeHtml(project.targetJournal)}</strong><small>${escapeHtml(artifactDateLabel(project.journalConfirmedAt))}</small></section>` : ''}
    ${stageExecutionMarkup(project, 'submission')}
    <label class="review-editor"><span>投稿准备内容</span><textarea data-review-field="submissionNotes" placeholder="确认期刊后执行投稿准备，将在这里保存结果">${escapeHtml(project.submissionNotes)}</textarea><small>自动保存在当前项目中</small></label>`;
}

function sidebarMarkup(projects, activeProjectId) {
  if (!projects.length) return '<li class="review-project-empty">尚无项目</li>';
  return projects.map(project => `
    <li class="review-project-item ${project.id === activeProjectId ? 'selected' : ''}" data-review-project-id="${escapeHtml(project.id)}">
      <span class="review-project-icon">◇</span>
      <span class="review-project-name">${escapeHtml(project.name)}</span>
      <span class="sidebar-row-count">${sciReviewProjectProgress(project)}%</span>
    </li>`).join('');
}

function workspaceMarkup(project, context) {
  const progress = sciReviewProjectProgress(project);
  const terms = keywordTerms(project);
  return `
    <header class="review-workspace-header">
      <div><div class="review-workspace-eyebrow">SCI 综述工作台</div><h1>${escapeHtml(project.name)}</h1><p>${escapeHtml(project.direction || '尚未填写研究方向')}</p></div>
      <div class="review-header-actions"><span class="review-tier-badge">${escapeHtml(project.targetTier)}</span><button class="btn btn-ghost" type="button" data-review-action="delete-project">删除项目</button></div>
    </header>
    <nav class="review-stepper" aria-label="综述项目阶段">
      ${SCI_REVIEW_STAGES.map((stage, index) => `<button class="review-step ${stage.id === project.activeStage ? 'active' : ''}" type="button" data-review-stage="${stage.id}"><span>${index + 1}</span><em>${stage.label}</em></button>`).join('')}
    </nav>
    <div class="review-workspace-columns">
      <div class="review-stage-panel">${projectStageMarkup(project, context)}</div>
      <aside class="review-inspector">
        <section><h2>项目基础</h2><dl><div><dt>研究方向</dt><dd>${escapeHtml(project.direction || '待填写')}</dd></div><div><dt>目标分区</dt><dd>${escapeHtml(project.targetTier)}</dd></div></dl></section>
        <section><h2>关键词</h2><div class="review-term-list">${terms.length ? terms.map(term => `<span>${escapeHtml(term)}</span>`).join('') : '<p>尚未填写关键词</p>'}</div></section>
        <section class="review-progress-section"><h2>项目进度</h2><div class="review-progress-meta"><strong>${progress}%</strong><span>资料准备度</span></div><div class="review-progress-track"><span style="width:${progress}%"></span></div><p>进度依据检索关联、框架、图库、草稿和目标期刊计算。</p></section>
        ${strictSkillRegistryMarkup(context.skillSpecs)}
      </aside>
    </div>`;
}

export class SciReviewWorkspace {
  constructor({ projectList, workspace, modal, getPubmedSearches, getPmcSearches, getSkillSpecs, callbacks = {} }) {
    this.projectList = projectList;
    this.workspace = workspace;
    this.modal = modal;
    this.getPubmedSearches = getPubmedSearches || (() => []);
    this.getPmcSearches = getPmcSearches || (() => []);
    this.getSkillSpecs = getSkillSpecs || (() => []);
    this.callbacks = callbacks;
    this.projects = this.load();
    this.activeProjectId = null;
    this.runningStage = '';
    this.bindEvents();
    this.renderSidebar();
  }

  load() {
    try {
      return normalizeSciReviewProjects(JSON.parse(localStorage.getItem(SCI_REVIEW_STORAGE_KEY) || '[]'));
    } catch {
      return [];
    }
  }

  persist() {
    localStorage.setItem(SCI_REVIEW_STORAGE_KEY, JSON.stringify(this.projects));
  }

  get activeProject() {
    return this.projects.find(project => project.id === this.activeProjectId) || null;
  }

  renderSidebar() {
    if (this.projectList) this.projectList.innerHTML = sidebarMarkup(this.projects, this.activeProjectId);
  }

  renderWorkspace() {
    if (!this.workspace || !this.activeProject) return;
    this.workspace.innerHTML = workspaceMarkup(this.activeProject, {
      pubmedSearches: this.getPubmedSearches(),
      pmcSearches: this.getPmcSearches(),
      skillSpecs: this.getSkillSpecs(),
    });
  }

  open(projectId) {
    if (!this.projects.some(project => project.id === projectId)) return false;
    this.activeProjectId = projectId;
    this.renderSidebar();
    this.renderWorkspace();
    return true;
  }

  refresh() {
    this.reconcilePubmedLinks();
    this.renderSidebar();
    if (this.activeProject) this.renderWorkspace();
  }

  reconcilePubmedLinks() {
    const searches = this.getPubmedSearches();
    let changed = false;
    this.projects = this.projects.map(project => {
      if (project.linkedPubmedSearchId) return project;
      const selectedOption = project.searchStrategy?.options.find(item => item.id === project.selectedStrategy);
      const expectedQuery = project.selectedStrategy === 'custom'
        ? project.customPubmedQuery
        : selectedOption?.pubmed_query || '';
      const expectedName = `【综述｜${project.name}】`;
      const matches = searches.filter(search => search.name === expectedName
        && (!expectedQuery || String(search.query || '').trim() === expectedQuery.trim()));
      if (matches.length !== 1) return project;
      changed = true;
      return normalizeSciReviewProject({ ...project, linkedPubmedSearchId: matches[0].id });
    });
    if (changed) this.persist();
    return changed;
  }

  openCreateModal() {
    this.modal?.classList.remove('hidden');
    const nameInput = this.modal?.querySelector('#review-project-name');
    if (nameInput) requestAnimationFrame(() => nameInput.focus());
  }

  closeCreateModal() {
    this.modal?.classList.add('hidden');
    this.modal?.querySelector('form')?.reset();
  }

  createFromModal() {
    const form = this.modal?.querySelector('form');
    if (!form) return;
    const data = new FormData(form);
    const project = createSciReviewProject({
      name: data.get('name'),
      direction: data.get('direction'),
      keywords: data.get('keywords'),
      targetTier: data.get('targetTier'),
    });
    if (!project.direction || !project.keywords) return;
    this.projects = [project, ...this.projects];
    this.persist();
    this.closeCreateModal();
    this.callbacks.onOpenProject?.(project.id);
  }

  patchActive(patch, { render = true } = {}) {
    const project = this.activeProject;
    if (!project) return;
    this.projects = updateSciReviewProject(this.projects, project.id, patch);
    this.persist();
    this.renderSidebar();
    if (render) this.renderWorkspace();
    this.callbacks.onProjectChanged?.(this.activeProject);
  }

  linkPubmedSearch(projectId, searchId) {
    if (!this.projects.some(project => project.id === projectId)) return false;
    this.projects = updateSciReviewProject(this.projects, projectId, {
      linkedPubmedSearchId: searchId,
      activeStage: 'pool',
    });
    this.activeProjectId = projectId;
    this.persist();
    this.renderSidebar();
    this.renderWorkspace();
    this.callbacks.onProjectChanged?.(this.activeProject);
    return true;
  }

  setStrategyStatus(message, type = '') {
    const status = this.workspace?.querySelector('[data-review-strategy-status]');
    if (!status) return;
    status.textContent = message;
    status.dataset.type = type;
  }

  setStageStatus(message, type = '') {
    const status = this.workspace?.querySelector('[data-review-stage-status]');
    if (!status) return;
    status.textContent = message;
    status.dataset.type = type;
  }

  setJournalStatus(message, type = '') {
    const status = this.workspace?.querySelector('[data-review-journal-status]');
    if (!status) return;
    status.textContent = message;
    status.dataset.type = type;
  }

  setWritingStatus(message, type = '') {
    const status = this.workspace?.querySelector('[data-review-writing-status]');
    if (!status) return;
    status.textContent = message;
    status.dataset.type = type;
  }

  async writeSection(sectionId) {
    const project = this.activeProject;
    if (!project || this.runningStage) return;
    this.runningStage = `writing-${sectionId}`;
    this.setWritingStatus('正在读取精读笔记、证据记录和前序章节…', 'running');
    try {
      const section = await this.callbacks.onWriteSection?.(project, sectionId);
      if (!section) return;
      const writingSections = { ...project.writingSections, [sectionId]: section };
      if (sectionId === 'introduction') {
        delete writingSections.body;
        delete writingSections.synthesis;
      } else if (sectionId === 'body') {
        delete writingSections.synthesis;
      }
      const draft = mergeWritingSections(writingSections);
      const stageArtifacts = { ...project.stageArtifacts };
      delete stageArtifacts.writing;
      this.patchActive({
        writingSections,
        draft,
        stageArtifacts,
        journalRecommendation: null,
        selectedJournalCandidate: '',
        targetJournal: '',
        journalConfirmedAt: '',
        submissionNotes: '',
      });
      this.setWritingStatus('本部分已生成；核查并确认 Skill 质量门槛后才能进入下一章', 'success');
    } catch (error) {
      this.setWritingStatus(`写作失败：${error}`, 'error');
    } finally {
      this.runningStage = '';
    }
  }

  async confirmWritingGates(sectionId) {
    const project = this.activeProject;
    const section = project?.writingSections?.[sectionId];
    if (!project || !section || section.completion_state === 'ready' || this.runningStage) return;
    if (!window.confirm(`确认已逐项核查“${section.skill_id}”的 ${section.quality_gates.length} 条质量门槛？`)) return;
    this.runningStage = `confirm-${sectionId}`;
    this.setWritingStatus('正在保存 Skill 质量门槛确认记录…', 'running');
    try {
      const confirmationFile = await this.callbacks.onConfirmWritingGates?.(project, section);
      const writingSections = {
        ...project.writingSections,
        [sectionId]: {
          ...section,
          completion_state: 'ready',
          output_files: [...new Set([...section.output_files, confirmationFile].filter(Boolean))],
        },
      };
      this.patchActive({ writingSections, draft: mergeWritingSections(writingSections) });
      this.setWritingStatus('质量门槛确认记录已保存，可以进入下一章', 'success');
    } catch (error) {
      this.setWritingStatus(`确认失败：${error}`, 'error');
    } finally {
      this.runningStage = '';
    }
  }

  async recommendJournals() {
    const project = this.activeProject;
    if (!project || this.runningStage) return;
    this.runningStage = 'journal-recommendation';
    this.setJournalStatus('正在分析正文和当前文献池中的期刊分布…', 'running');
    try {
      const recommendation = await this.callbacks.onRecommendJournals?.(project);
      if (!recommendation) return;
      this.patchActive({
        journalRecommendation: recommendation,
        selectedJournalCandidate: recommendation.recommended_journal,
        targetJournal: '',
        journalConfirmedAt: '',
      });
      this.setJournalStatus('候选期刊已生成，请选择并确认', 'success');
    } catch (error) {
      this.setJournalStatus(`推荐失败：${error}`, 'error');
    } finally {
      this.runningStage = '';
    }
  }

  confirmJournal() {
    const project = this.activeProject;
    const selected = project?.selectedJournalCandidate;
    if (!selected || !project.journalRecommendation?.candidates.some(item => item.journal_name === selected)) {
      this.setJournalStatus('请先选择一个候选期刊', 'error');
      return;
    }
    const stageArtifacts = { ...project.stageArtifacts };
    delete stageArtifacts.submission;
    this.patchActive({
      targetJournal: selected,
      journalConfirmedAt: String(Date.now()),
      stageArtifacts,
      submissionNotes: '',
    });
    this.setJournalStatus('目标期刊已确认，可以继续核查投稿准备', 'success');
  }

  async runActiveStage() {
    const project = this.activeProject;
    const stage = project?.activeStage;
    if (!project || !stage || stage === 'search' || this.runningStage) return;
    this.runningStage = stage;
    this.setStageStatus('正在读取当前项目的真实文献和上游产物…', 'running');
    try {
      const artifact = await this.callbacks.onRunStage?.(project, stage);
      if (!artifact) return;
      const patch = { stageArtifacts: { ...project.stageArtifacts, [stage]: artifact } };
      if (stage === 'framework') patch.framework = artifact.markdown;
      if (stage === 'writing') patch.draft = artifact.markdown;
      if (stage === 'submission') patch.submissionNotes = artifact.markdown;
      this.patchActive(patch);
      this.setStageStatus('阶段产物已保存', 'success');
    } catch (error) {
      this.setStageStatus(`执行失败：${error}`, 'error');
    } finally {
      this.runningStage = '';
    }
  }

  async generateStrategy() {
    const project = this.activeProject;
    if (project?.databaseScope === 'pubmed-wos' && !project.wosLoginConfirmed) {
      this.setStrategyStatus('请先打开 WOS 并确认机构登录', 'error');
      return;
    }
    if (!project?.direction || !project?.keywords) {
      this.setStrategyStatus('请先填写研究方向和关键词', 'error');
      return;
    }
    this.setStrategyStatus(`AI 正在拆解概念并生成 ${project.databaseScope === 'pubmed-wos' ? 'PubMed/WOS' : 'PubMed'} 三套方案…`, 'running');
    try {
      const strategy = await this.callbacks.onGenerateStrategy?.(project);
      if (!strategy) return;
      this.patchActive({ searchStrategy: strategy, trialPreviews: {}, selectedStrategy: strategy.recommended_option || 'moderate' });
      this.setStrategyStatus('检索策略已生成；点击预览后核查真实命中结果', 'success');
    } catch (error) {
      this.setStrategyStatus(`生成失败：${error}`, 'error');
    }
  }

  async previewStrategy() {
    const project = this.activeProject;
    if (!project?.searchStrategy) return;
    this.setStrategyStatus('正在依次试检索 PubMed 三套方案，不执行 AI 质量评估…', 'running');
    try {
      const previews = await this.callbacks.onPreviewStrategy?.(project);
      if (!previews) return;
      this.patchActive({ trialPreviews: previews });
      this.setStrategyStatus(project.databaseScope === 'pubmed-wos'
        ? 'PubMed 三套方案预览完成；WOS 结果请在机构登录后核查'
        : 'PubMed 三套方案预览完成', 'success');
    } catch (error) {
      this.setStrategyStatus(`预览失败：${error}`, 'error');
    }
  }

  useSelectedStrategy() {
    const project = this.activeProject;
    if (!project?.selectedStrategy) return;
    const custom = project.selectedStrategy === 'custom';
    const option = project.searchStrategy?.options.find(item => item.id === project.selectedStrategy);
    const pubmedQuery = custom ? project.customPubmedQuery : option?.pubmed_query;
    const wosQuery = custom ? project.customWosQuery : option?.wos_query;
    if (!pubmedQuery) {
      this.setStrategyStatus('请先填写最终 PubMed 检索式', 'error');
      return;
    }
    this.callbacks.onUseStrategy?.({ project, option, pubmedQuery, wosQuery });
  }

  bindEvents() {
    this.projectList?.addEventListener('click', event => {
      const item = event.target.closest('[data-review-project-id]');
      if (item) this.callbacks.onOpenProject?.(item.dataset.reviewProjectId);
    });

    this.workspace?.addEventListener('click', async event => {
      const stage = event.target.closest('[data-review-stage]');
      if (stage) {
        this.patchActive({ activeStage: stage.dataset.reviewStage });
        return;
      }
      const searchMode = event.target.closest('[data-review-search-mode]');
      if (searchMode) {
        this.patchActive({ searchMode: searchMode.dataset.reviewSearchMode });
        return;
      }
      const action = event.target.closest('[data-review-action]');
      if (!action) return;
      const searchId = Number(action.dataset.searchId) || null;
      const writingSection = action.dataset.writingSection || '';
      const handlers = {
        'new-pubmed': () => this.callbacks.onNewPubmed?.(),
        'open-pubmed': () => this.callbacks.onOpenPubmed?.(searchId),
        'open-screening': () => this.callbacks.onOpenScreening?.(searchId),
        'open-reading': () => this.callbacks.onOpenReading?.(),
        'new-pmc': () => this.callbacks.onNewPmc?.(),
        'open-pmc': () => this.callbacks.onOpenPmc?.(searchId),
        'open-wos': () => this.callbacks.onOpenWos?.(),
        'run-stage': () => this.runActiveStage(),
        'recommend-journals': () => this.recommendJournals(),
        'confirm-journal': () => this.confirmJournal(),
        'write-section': () => this.writeSection(writingSection),
        'confirm-writing-gates': () => this.confirmWritingGates(writingSection),
        'generate-strategy': () => this.generateStrategy(),
        'preview-strategy': () => this.previewStrategy(),
        'use-strategy': () => this.useSelectedStrategy(),
        'delete-project': () => {
          if (!this.activeProject || !window.confirm(`删除综述项目“${this.activeProject.name}”？文献和检索记录不会被删除。`)) return;
          const deletedId = this.activeProject.id;
          this.projects = deleteSciReviewProject(this.projects, deletedId);
          this.activeProjectId = null;
          this.persist();
          this.renderSidebar();
          this.callbacks.onProjectDeleted?.(deletedId);
        },
      };
      await handlers[action.dataset.reviewAction]?.();
    });

    this.workspace?.addEventListener('change', event => {
      const journalCandidate = event.target.closest('[data-review-journal-candidate]');
      if (journalCandidate) {
        this.patchActive({ selectedJournalCandidate: journalCandidate.value });
        return;
      }
      const strategy = event.target.closest('[data-review-strategy]');
      if (strategy) {
        this.patchActive({ selectedStrategy: strategy.value });
        return;
      }
      const wosConfirmation = event.target.closest('[data-review-wos-confirm]');
      if (wosConfirmation) {
        this.patchActive({
          wosLoginConfirmed: wosConfirmation.checked,
          wosLoginConfirmedAt: wosConfirmation.checked ? new Date().toISOString() : '',
        });
        return;
      }
      const field = event.target.closest('[data-review-field]');
      if (!field) return;
      const key = field.dataset.reviewField;
      const value = ['linkedPubmedSearchId', 'linkedPmcSearchId'].includes(key)
        ? normalizeLinkedId(field.value)
        : field.value;
      const invalidatesStrategy = ['direction', 'keywords', 'targetTier', 'databaseScope'].includes(key)
        && this.activeProject?.[key] !== value;
      const invalidatesJournals = ['articleType', 'oaPreference', 'apcPreference', 'timelinePreference', 'targetTier'].includes(key)
        && this.activeProject?.[key] !== value;
      const patch = invalidatesStrategy
        ? { [key]: value, searchStrategy: null, trialPreviews: {}, selectedStrategy: '' }
        : { [key]: value };
      if (invalidatesJournals) Object.assign(patch, { journalRecommendation: null, selectedJournalCandidate: '', targetJournal: '', journalConfirmedAt: '' });
      this.patchActive(patch);
    });

    this.workspace?.addEventListener('input', event => {
      const field = event.target.closest('textarea[data-review-field]');
      if (!field) return;
      this.patchActive({ [field.dataset.reviewField]: field.value }, { render: false });
    });

    this.modal?.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault();
      this.createFromModal();
    });
    this.modal?.querySelectorAll('[data-review-modal-close]').forEach(element => {
      element.addEventListener('click', () => this.closeCreateModal());
    });
  }
}
