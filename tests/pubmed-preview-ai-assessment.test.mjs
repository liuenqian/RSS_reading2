import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const pubmedServiceSource = await readFile(new URL('../src-tauri/src/services/pubmed_search_service.rs', import.meta.url), 'utf8');

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

test('PubMed preview enables formal retrieval before optional AI assessment', () => {
  const previewCall = source.indexOf("invoke('preview_pubmed_search'");
  const assessmentCall = source.indexOf("invoke('assess_pubmed_search_preview'", previewCall);
  const enableRetrieval = source.indexOf("document.getElementById('pubmed-retrieval-panel').disabled = false", previewCall);
  const queryGenerationStart = source.indexOf('async function generatePubmedQuery');
  const queryGenerationEnd = source.indexOf('\nfunction openPubmedQueryInBrowser', queryGenerationStart);
  const queryGeneration = source.slice(queryGenerationStart, queryGenerationEnd);
  const authorGenerationStart = source.indexOf('async function buildPubmedAuthorQuery');
  const authorGenerationEnd = source.indexOf('\nfunction closePubmedSearchModal', authorGenerationStart);
  const authorGeneration = source.slice(authorGenerationStart, authorGenerationEnd);

  assert.notEqual(previewCall, -1);
  assert.notEqual(assessmentCall, -1);
  assert.notEqual(enableRetrieval, -1);
  assert.doesNotMatch(queryGeneration, /assess_pubmed_search_preview/);
  assert.doesNotMatch(authorGeneration, /assess_pubmed_search_preview/);
  assert.match(queryGeneration, /点击预览结果后再进行 AI 评估/);
  assert.match(authorGeneration, /点击预览结果后再进行 AI 评估/);
  assert.ok(previewCall < enableRetrieval);
  assert.ok(enableRetrieval < assessmentCall);
  assert.match(html, /id="pubmed-preview-ai-enabled"[^>]*type="checkbox"/);
  assert.doesNotMatch(html.match(/<input[^>]*id="pubmed-preview-ai-enabled"[^>]*>/u)?.[0] || '', /checked/);
  assert.match(source, /document\.getElementById\('pubmed-preview-ai-enabled'\)\?\.checked/);
  assert.match(source, /document\.getElementById\('pubmed-preview-ai-enabled'\)\.checked = false/);
  assert.match(source, /确认种子论文后才可进行复杂 AI 作者评估/);
  assert.match(source, /loadAuthorIdentityState\(currentPubmedSearch\.id\)\.seedIds\.length/);
  assert.match(source, /data-use-suggested-query/);
  assert.match(source, /查准率估计/);
  assert.match(source, /查全风险/);
  assert.match(source, /查看其余/);
});

test('PubMed quality assessment exposes auditable sampling metrics', () => {
  assert.match(source, /AI 检索式质量评估/);
  assert.match(source, /查准率估计/);
  assert.match(source, /查全风险/);
  assert.match(source, /不等同于真实查全率/);
  assert.match(source, /抽样题名与摘要/);
  assert.match(source, /pubmed-preview-item-abstract/);
  assert.match(source, /查看其余.*篇抽样文献/);
});

test('AI quota errors preserve the PubMed preview and offer recovery actions', () => {
  assert.match(source, /data-open-ai-settings/);
  assert.match(source, /data-retry-ai-assessment/);
  assert.match(source, /PubMed 预览结果已保留/);
  assert.match(source, /retryPubmedPreviewAssessment/);
});

test('author query generation separates and restores detected affiliations', () => {
  const start = source.indexOf('async function buildPubmedAuthorQuery');
  const end = source.indexOf('\nfunction closePubmedSearchModal', start);
  const authorGeneration = source.slice(start, end);

  assert.match(authorGeneration, /result\?\.author_name/);
  assert.match(authorGeneration, /result\?\.affiliation/);
  assert.match(authorGeneration, /result\?\.candidates/);
  assert.match(authorGeneration, /pubmed-author-name'\)\.value = detectedAuthor/);
  assert.match(authorGeneration, /pubmed-author-affiliation'\)\.value = detectedAffiliation/);
  assert.match(authorGeneration, /已识别作者/);
  assert.doesNotMatch(authorGeneration, /assess_pubmed_search_preview/);
  assert.match(source, /function extractAuthorSearchIdentity\(source\)/);
  assert.match(source, /setPubmedSearchBuilderMode\(authorIdentity \? 'author' : 'topic'\)/);
});

test('author query generation renders selectable complete candidates', () => {
  assert.match(html, /id="pubmed-author-query-candidates"/);
  assert.match(source, /function renderPubmedAuthorQueryCandidates\(candidates = \[\]\)/);
  assert.match(source, /name="pubmed-author-query-candidate"/);
  assert.match(source, /candidate\.query/);
});

test('author identity input does not show an example reminder', () => {
  const authorInput = html.match(/<input[^>]*id="pubmed-author-name"[^>]*>/u)?.[0] || '';

  assert.ok(authorInput);
  assert.doesNotMatch(authorInput, /placeholder=/);
  assert.doesNotMatch(html, /例如：梁瑞政/);
});

test('author previews use author and affiliation assessment instead of topic relevance', () => {
  const previewStart = source.indexOf('async function previewPubmedSearch');
  const previewEnd = source.indexOf('\nfunction updatePubmedRetrievalUi', previewStart);
  const preview = source.slice(previewStart, previewEnd);

  assert.match(preview, /assess_pubmed_author_preview/);
  assert.match(preview, /作者归属/);
  assert.match(source, /function pubmedPreviewEntryAssessmentMeta\(status, kind = 'topic'\)/);
  assert.match(source, /AI 作者归属评估/);
  assert.match(source, /作者匹配率估计/);
  assert.match(appSource, /pubmed_search_cmd::assess_pubmed_author_preview/);
});

test('author assessment always renders an actionable next-step recommendation', () => {
  assert.match(source, /function authorAssessmentNextStep\(assessment\)/);
  assert.match(source, /不建议直接采用当前检索式抓取/);
  assert.match(source, /机构的中英文名、简称、院系\/附属医院和历史名称/);
  assert.match(source, /当前没有发现可以安全自动加入的姓名变体/);
  assert.match(source, /下一步建议/);
});

test('author assessment normalizes institution naming variants', () => {
  assert.match(pubmedServiceSource, /中文\/英文全称、简称、缩写、不同翻译或罗马化、历史名称和单位更名/);
  assert.match(pubmedServiceSource, /院系、实验室、附属医院、上级机构之间的隶属关系/);
  assert.match(pubmedServiceSource, /Soochow University 与 Suzhou University 可能指同一机构/);
  assert.match(pubmedServiceSource, /不能仅因原始字符串不同就判为不同机构/);
});
