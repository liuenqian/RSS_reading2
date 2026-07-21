import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  addPubmedQuestionHistory,
  normalizePubmedQuestionHistory,
  PUBMED_QUESTION_HISTORY_LIMIT,
} from '../src/pubmed_question_history.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('research question history keeps the latest unique inputs first', () => {
  const history = addPubmedQuestionHistory(['旧问题', '重复问题'], ' 重复问题 ');
  assert.deepEqual(history, ['重复问题', '旧问题']);
  assert.deepEqual(normalizePubmedQuestionHistory(['A', 'a', '', null]), ['A']);
});

test('research question history is capped at the configured local limit', () => {
  const history = Array.from({ length: PUBMED_QUESTION_HISTORY_LIMIT + 5 }, (_, index) => `问题 ${index}`);
  assert.equal(normalizePubmedQuestionHistory(history).length, PUBMED_QUESTION_HISTORY_LIMIT);
});

test('PubMed modal exposes restore and clear controls and records action inputs', () => {
  assert.match(html, /id="pubmed-question-history"/);
  assert.match(html, /id="btn-clear-pubmed-question-history"/);
  assert.match(source, /pubmed-question-history-v1/);
  assert.match(source, /function rememberPubmedQuestion/);
  assert.ok((source.match(/rememberPubmedQuestion\(question\)/g) || []).length >= 3);
  assert.match(source, /localStorage\.removeItem\(PUBMED_QUESTION_HISTORY_STORAGE_KEY\)/);
});
