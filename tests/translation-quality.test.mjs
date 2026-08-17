import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchesTranslationQualityFilter,
  translationQualityIssues,
} from '../src/translation_quality.js';

test('translation quality flags untranslated English and missing protected tokens', () => {
  const entry = {
    title: 'A 2024 study of 10.1000/example.7',
    title_translated: 'A 2024 study of example',
    summary: 'A sufficiently long English abstract with 95 participants and detailed methods.'.repeat(2),
    summary_translated: '简短摘要',
  };
  const issues = translationQualityIssues(entry);

  assert.ok(issues.some(issue => issue.field === 'title' && issue.code === 'still-english'));
  assert.ok(issues.some(issue => issue.field === 'title' && issue.code === 'protected-token-missing'));
  assert.ok(issues.some(issue => issue.field === 'summary' && issue.code === 'too-short'));
  assert.equal(matchesTranslationQualityFilter(entry, 'title-risk'), true);
  assert.equal(matchesTranslationQualityFilter(entry, 'summary-risk'), true);
});

test('translation quality does not flag a Chinese translation that retains DOI and numbers', () => {
  const entry = {
    title: 'Study protocol 2024',
    title_translated: '2024 年研究方案',
    summary: 'The trial enrolled 120 participants; DOI 10.1000/example.7.',
    summary_translated: '该试验纳入 120 名受试者；DOI 为 10.1000/example.7。',
  };

  assert.deepEqual(translationQualityIssues(entry), []);
  assert.equal(matchesTranslationQualityFilter(entry, 'risk'), false);
});

test('translation quality retains field-specific request failures for retry', () => {
  const entry = {
    title: 'English title',
    summary: 'English summary',
    _translationErrors: { summary: 'Google 请求失败: timeout' },
  };

  const issues = translationQualityIssues(entry);
  assert.ok(issues.some(issue => issue.field === 'summary' && issue.code === 'request-error'));
  assert.equal(matchesTranslationQualityFilter(entry, 'summary-risk'), true);
});
