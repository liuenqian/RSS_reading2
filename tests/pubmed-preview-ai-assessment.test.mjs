import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

test('PubMed preview enables formal retrieval before optional AI assessment', () => {
  const previewCall = source.indexOf("invoke('preview_pubmed_search'");
  const assessmentCall = source.indexOf("invoke('assess_pubmed_search_preview'", previewCall);
  const enableRetrieval = source.indexOf("document.getElementById('pubmed-retrieval-panel').disabled = false", previewCall);

  assert.notEqual(previewCall, -1);
  assert.notEqual(assessmentCall, -1);
  assert.notEqual(enableRetrieval, -1);
  assert.ok(previewCall < enableRetrieval);
  assert.ok(enableRetrieval < assessmentCall);
  assert.match(html, /id="pubmed-preview-ai-enabled"[^>]*type="checkbox"[^>]*checked/);
  assert.match(source, /document\.getElementById\('pubmed-preview-ai-enabled'\)\?\.checked/);
  assert.match(source, /document\.getElementById\('pubmed-preview-ai-enabled'\)\.checked = true/);
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
