import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SCI_REVIEW_STAGES,
  createSciReviewProject,
  deleteSciReviewProject,
  normalizeSciReviewProject,
  normalizeSciReviewProjects,
  sciReviewProjectProgress,
  updateSciReviewProject,
} from '../src/sci_review_workspace.js';

test('综述工作台固定为八个连续阶段', () => {
  assert.deepEqual(
    SCI_REVIEW_STAGES.map(stage => stage.id),
    ['search', 'pool', 'screening', 'reading', 'framework', 'figures', 'writing', 'submission'],
  );
});

test('创建项目时保留最小起始信息并默认进入检索阶段', () => {
  const project = createSciReviewProject({
    name: '心肌缺血综述',
    direction: '心肌缺血后的纤维化重塑',
    keywords: 'myocardial ischemia, fibrosis',
    targetTier: 'JCR Q1',
  }, '2026-07-20T08:00:00.000Z');

  assert.equal(project.name, '心肌缺血综述');
  assert.equal(project.activeStage, 'search');
  assert.equal(project.databaseScope, 'pubmed');
  assert.equal(project.targetTier, 'JCR Q1');
  assert.equal(project.createdAt, '2026-07-20T08:00:00.000Z');
});

test('项目更新不会改变 id 和创建时间', () => {
  const project = createSciReviewProject({
    id: 'review-1',
    name: '旧名称',
    direction: '方向',
    keywords: '关键词',
  }, '2026-07-20T08:00:00.000Z');
  const updated = updateSciReviewProject([project], project.id, {
    name: '新名称',
    activeStage: 'framework',
    linkedPubmedSearchId: '42',
  }, '2026-07-20T09:00:00.000Z')[0];

  assert.equal(updated.id, project.id);
  assert.equal(updated.createdAt, project.createdAt);
  assert.equal(updated.name, '新名称');
  assert.equal(updated.activeStage, 'framework');
  assert.equal(updated.linkedPubmedSearchId, 42);
});

test('规范化会过滤重复项目并修正非法阶段', () => {
  const projects = normalizeSciReviewProjects([
    { id: 'same', name: 'A', activeStage: 'invalid' },
    { id: 'same', name: 'B', activeStage: 'writing' },
  ]);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'A');
  assert.equal(projects[0].activeStage, 'search');
});

test('项目进度依据已关联和已填写的工作产物计算', () => {
  const empty = createSciReviewProject({ direction: '', keywords: '' });
  const progressed = {
    ...empty,
    direction: '方向',
    keywords: '关键词',
    linkedPubmedSearchId: 1,
    framework: '1. 背景',
  };

  assert.equal(sciReviewProjectProgress(empty), 0);
  assert.equal(sciReviewProjectProgress(progressed), 50);
});

test('删除项目只移除目标项目', () => {
  const projects = [
    createSciReviewProject({ id: 'a', name: 'A' }),
    createSciReviewProject({ id: 'b', name: 'B' }),
  ];
  assert.deepEqual(deleteSciReviewProject(projects, 'a').map(project => project.id), ['b']);
});

test('系统综述检索保存三套方案、试检索结果和最终选择', () => {
  const project = normalizeSciReviewProject({
    id: 'review-search',
    direction: '心肌缺血与纤维化',
    keywords: 'myocardial ischemia, fibrosis',
    searchStrategy: {
      skill_id: 'sci-search-query-generator',
      skill_version: '1784548800',
      quality_gates: ['检索式必须可追溯'],
      core_concepts: ['心肌缺血', '纤维化'],
      term_evidence: [{ chinese_concept: '心肌缺血', recommended_terms: ['myocardial ischemia'] }],
      options: ['broad', 'moderate', 'precise'].map(id => ({
        id,
        label: id,
        pubmed_query: `${id}[Title/Abstract]`,
        wos_query: `TS=(${id})`,
      })),
      recommended_option: 'moderate',
    },
    trialPreviews: {
      moderate: { totalCount: 1286, samples: [{ pmid: '42', title: 'Paper', journal: 'Nature' }] },
    },
    selectedStrategy: 'moderate',
  });

  assert.equal(project.searchMode, 'skill');
  assert.equal(project.searchStrategy.options.length, 3);
  assert.equal(project.searchStrategy.skill_id, 'sci-search-query-generator');
  assert.equal(project.searchStrategy.quality_gates.length, 1);
  assert.equal(project.trialPreviews.moderate.totalCount, 1286);
  assert.equal(project.selectedStrategy, 'moderate');
});

test('后续 Skill 阶段产物会保存输入范围、状态和人工核查项', () => {
  const project = normalizeSciReviewProject({
    id: 'review-artifacts',
    stageArtifacts: {
      reading: {
        skill_name: '08-SCI文献精读器',
        title: '本批精读材料',
        markdown: '# 精读材料',
        completion_state: 'partial',
        input_record_count: 20,
        total_record_count: 6586,
        manual_checks: ['缺失 PDF 的文献不能标记为逐页精读'],
        next_stage: 'framework',
        generated_at: '1784548800000',
      },
    },
  });

  assert.equal(project.stageArtifacts.reading.input_record_count, 20);
  assert.equal(project.stageArtifacts.reading.total_record_count, 6586);
  assert.equal(project.stageArtifacts.reading.completion_state, 'partial');
  assert.deepEqual(project.stageArtifacts.reading.manual_checks, ['缺失 PDF 的文献不能标记为逐页精读']);
});

test('AI 候选期刊与用户确认状态分开保存', () => {
  const project = normalizeSciReviewProject({
    id: 'review-journals',
    articleType: 'systematic-review',
    oaPreference: 'prefer-non-oa',
    journalRecommendation: {
      skill_id: 'sci-target-journal-selector → sci-target-journal-deep-learner',
      skill_version: 'selector=1; learner=1',
      quality_gates: ['目标期刊必须人工确认'],
      summary: '优先选择主题匹配的主投期刊',
      recommended_journal: 'Journal A',
      candidates: [
        { journal_name: 'Journal A', tier: 'primary', fit_score: 5, evidence_count: 18, reason: '匹配', risk: '需官网核查' },
        { journal_name: 'Journal B', tier: 'safer', fit_score: 4, evidence_count: 9, reason: '较稳妥', risk: '需官网核查' },
      ],
      manual_checks: ['核查是否接收综述'],
    },
    selectedJournalCandidate: 'Journal A',
  });

  assert.equal(project.journalRecommendation.candidates.length, 2);
  assert.match(project.journalRecommendation.skill_id, /sci-target-journal-selector/);
  assert.equal(project.selectedJournalCandidate, 'Journal A');
  assert.equal(project.targetJournal, '');
  assert.equal(project.journalConfirmedAt, '');
});

test('逐章写作产物分别保存正文、引用证据和阅读笔记数量', () => {
  const project = normalizeSciReviewProject({
    id: 'review-writing',
    writingSections: {
      introduction: {
        skill_id: 'sci-review-chapter-one-writer',
        skill_version: '1784548800',
        title: '第一章 引言',
        markdown: '# 第一章 引言\n\n正文 [PMID:123]',
        citations: [{ paragraph_id: 'P1', claim: '关键论点', identifiers: ['PMID:123'], basis: '阅读笔记' }],
        evidence_record_count: 12,
        reading_note_count: 7,
        manual_checks: ['核查研究空白'],
        quality_gates: ['研究空白必须有证据支持'],
        completion_state: 'ready',
        output_files: ['/tmp/第一章初稿.md'],
      },
    },
  });

  assert.equal(project.writingSections.introduction.evidence_record_count, 12);
  assert.equal(project.writingSections.introduction.reading_note_count, 7);
  assert.equal(project.writingSections.introduction.citations[0].identifiers[0], 'PMID:123');
  assert.equal(project.writingSections.introduction.skill_id, 'sci-review-chapter-one-writer');
  assert.equal(project.writingSections.introduction.completion_state, 'ready');
  assert.equal(project.writingSections.introduction.output_files.length, 1);
  assert.equal(project.writingSections.body, undefined);
});

test('工作台通过结构化命令生成策略并把预览留给显式操作', () => {
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const workspace = fs.readFileSync(new URL('../src/sci_review_workspace.js', import.meta.url), 'utf8');
  const rust = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  assert.match(main, /invoke\('generate_sci_review_search_strategy'/);
  assert.match(main, /invoke\('run_sci_review_stage'/);
  assert.match(main, /invoke\('recommend_sci_review_journals'/);
  assert.match(main, /invoke\('write_sci_review_section'/);
  assert.match(main, /invoke\('confirm_sci_review_writing_quality_gates'/);
  assert.match(main, /invoke\('list_sci_skill_specs'/);
  assert.match(main, /previewSciReviewStrategy/);
  assert.match(workspace, /preview-strategy/);
  assert.match(workspace, /data-review-wos-confirm/);
  assert.match(workspace, /databaseScope === 'pubmed-wos' && !project\.wosLoginConfirmed/);
  assert.match(workspace, /linkPubmedSearch\(projectId, searchId\)/);
  assert.match(workspace, /reconcilePubmedLinks\(\)/);
  assert.match(workspace, /data-review-action="recommend-journals"/);
  assert.match(workspace, /data-review-action="confirm-journal"/);
  assert.match(workspace, /journalConfirmedAt/);
  assert.match(workspace, /data-review-action="write-section"/);
  assert.match(workspace, /data-review-action="confirm-writing-gates"/);
  assert.match(workspace, /completion_state === 'ready'/);
  assert.match(workspace, /setStageStatus\([^\n]+, 'running'\)/);
  assert.match(workspace, /setWritingStatus\([^\n]+, 'running'\)/);
  assert.match(workspace, /setJournalStatus\([^\n]+, 'running'\)/);
  assert.match(workspace, /setStrategyStatus\([^\n]+, 'running'\)/);
  assert.match(fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'), /review-progress-indeterminate/);
  assert.match(workspace, /reading_note_count/);
  assert.doesNotMatch(workspace, /stageExecutionMarkup\(project, 'writing'\)/);
  assert.match(main, /pendingSciReviewProjectId/);
  assert.match(main, /linkPubmedSearch\(reviewProjectId, search\.id\)/);
  assert.match(rust, /pubmed_cmd::generate_sci_review_search_strategy/);
  assert.match(rust, /sci_review_cmd::run_sci_review_stage/);
  assert.match(rust, /sci_review_cmd::recommend_sci_review_journals/);
  assert.match(rust, /sci_review_cmd::write_sci_review_section/);
  assert.match(rust, /sci_review_cmd::confirm_sci_review_writing_quality_gates/);
});
