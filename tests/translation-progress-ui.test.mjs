import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const setupStart = source.indexOf('function setupTranslationEvents()');
const setupEnd = source.indexOf('\nfunction ', setupStart + 10);
const setup = source.slice(setupStart, setupEnd > setupStart ? setupEnd : undefined);

test('translation progress updates the rendered row without rebuilding the list', () => {
  assert.match(source, /function updateRenderedTranslationEntry\(entryId\)/);
  assert.match(setup, /updateRenderedTranslationEntry\(id\)/);
  assert.doesNotMatch(setup, /renderEntryList\(allEntries\)/);

  const helperStart = source.indexOf('function syncRenderedTranslationTitle');
  const helperEnd = source.indexOf('\nfunction ', helperStart + 10);
  const helper = source.slice(helperStart, helperEnd > helperStart ? helperEnd : undefined);
  assert.match(helper, /entry\._titleTranslating \|\| entry\._summaryTranslating/);

  const retryStart = source.indexOf('async function retrySummaryTranslation()');
  const retryEnd = source.indexOf('\nasync function ', retryStart + 10);
  const retry = source.slice(retryStart, retryEnd > retryStart ? retryEnd : undefined);
  assert.match(retry, /updateRenderedTranslationEntry\(entryId\)/);
  assert.doesNotMatch(retry, /renderEntryList\(allEntries\)/);
});

test('summary retry exposes failures while preserving the original abstract', () => {
  const renderStart = source.indexOf('function renderSummary(entry');
  const renderEnd = source.indexOf('\nfunction ', renderStart + 10);
  const render = source.slice(renderStart, renderEnd > renderStart ? renderEnd : undefined);
  const retryStart = source.indexOf('async function retrySummaryTranslation()');
  const retryEnd = source.indexOf('\nasync function ', retryStart + 10);
  const retry = source.slice(retryStart, retryEnd > retryStart ? retryEnd : undefined);

  assert.match(render, /entry\._transError/);
  assert.match(render, /detail-summary-error/);
  assert.match(render, /detail-summary-original/);
  assert.match(retry, /btnRetrySummary\.disabled = true/);
  assert.match(retry, /btnRetrySummary\.disabled = false/);
  assert.match(retry, /setGlobalStatus\(`摘要翻译失败/);
});

test('summary retry button cannot submit a surrounding form', () => {
  const retryButton = html.match(/<button(?=[^>]*id="btn-retry-summary")[^>]*>/u)?.[0] || '';
  assert.match(retryButton, /type="button"/);
});
