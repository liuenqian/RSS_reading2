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
  assert.match(retry, /await invoke\('clear_entry_translation', \{ entryId, field: 'summary' \}\)/);
  assert.match(retry, /summary_translated = null/);
  assert.match(retry, /正在清除旧摘要翻译并重新翻译/);
  assert.match(retry, /setGlobalStatus\(`摘要翻译失败/);
  assert.match(retry, /摘要翻译完成：\$\{result\.model\}/);
});

test('manual translation completion identifies the actual provider model', () => {
  const translateStart = source.indexOf('async function translateEntries(');
  const translateEnd = source.indexOf('\nfunction ', translateStart + 10);
  const translate = source.slice(translateStart, translateEnd > translateStart ? translateEnd : undefined);

  assert.match(translate, /const usedModels = new Set\(\)/);
  assert.match(translate, /result\.value\?\.translated/);
  assert.match(translate, /usedModels\.add\(result\.value\.model\)/);
  assert.match(translate, /\[\.\.\.usedModels\]\.join\('、'\)/);
});

test('summary retry button cannot submit a surrounding form', () => {
  const retryButton = html.match(/<button(?=[^>]*id="btn-retry-summary")[^>]*>/u)?.[0] || '';
  assert.match(retryButton, /type="button"/);
  assert.match(html, /清除后重新翻译/);
});

test('translation quality filter and batch retry use explainable local risk rules', () => {
  assert.match(html, /id="translation-quality-filter"/);
  assert.match(html, /id="btn-entry-bulk-retranslate-risk"/);
  assert.match(source, /matchesTranslationQualityFilter\(entry, translationQualityFilter\)/);
  assert.match(source, /function getTranslationQualityRetryTasks\(entries\)/);
  assert.match(source, /await invoke\('clear_entry_translation', \{ entryId, field: task\.field \}\)/);
  assert.match(source, /清除并重译风险译文/);
  assert.match(source, /data-action="retranslate-risk"/);
});

test('sidebar overview counts use the database aggregate instead of the 200-entry snapshot', () => {
  assert.match(source, /invoke\('get_entry_overview_counts'\)/);
  const overviewStart = source.indexOf('function updateOverviewCounts()');
  const overviewEnd = source.indexOf('\nfunction ', overviewStart + 10);
  const overview = source.slice(overviewStart, overviewEnd > overviewStart ? overviewEnd : undefined);

  assert.match(overview, /const counts = overviewCounts \|\|/);
  assert.match(overview, /elAll\.textContent = counts\.total/);
  assert.match(overview, /const unread = counts\.unread/);
  assert.match(overview, /const liveStarCount = counts\.starred/);
});
