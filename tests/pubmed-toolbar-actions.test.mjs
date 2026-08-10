import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('PubMed toolbar groups import and export into one menu button', () => {
  assert.match(html, /id="btn-pubmed-data-transfer"[\s\S]*<span>导入\/导出<\/span>/);
  assert.doesNotMatch(html, /id="btn-(?:import|export)-pubmed"/);
  assert.match(main, /btnPubmedDataTransfer\?\.addEventListener\('click'[\s\S]*includeCurrentEntries: true/);
  assert.match(main, /includeCurrentEntries \? '<div class="context-item" data-action="export-current">导出当前结果<\/div>'/);
  assert.match(main, /action === 'export-current'[\s\S]*exportCurrentPubmedEntries\(null, button\)/);
});

test('PubMed toolbar keeps update and clear-result actions', () => {
  assert.match(html, /id="btn-run-pubmed-search"[\s\S]*>检查更新<\/button>/);
  assert.match(html, /id="btn-clear-current-pubmed-search"[\s\S]*<span>清空结果<\/span>/);
});

test('context-sensitive PubMed actions stay visible and use disabled states', () => {
  assert.match(main, /btnRunPubmedSearch\.disabled = !hasCurrentSearch \|\| localImport/);
  assert.match(main, /btnClearCurrentPubmedSearch\.disabled = !hasCurrentSearch/);
  assert.doesNotMatch(main, /btnRunPubmedSearch\?\.classList\.(?:add|toggle)\('hidden'/);
  assert.doesNotMatch(main, /btnClearCurrentPubmedSearch\?\.classList\.(?:add|remove)\('hidden'/);
});
