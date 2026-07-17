import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const commands = await readFile(new URL('../src-tauri/src/commands/pubmed_search_cmd.rs', import.meta.url), 'utf8');
const app = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const service = await readFile(new URL('../src-tauri/src/services/google_translate_xlsx_service.rs', import.meta.url), 'utf8');

test('merges Google translation into the existing PubMed export dialog', () => {
  assert.match(main, /function choosePubmedExportFields/);
  assert.match(main, /data-mode="standard"[\s\S]*普通导出/);
  assert.match(main, /data-mode="google"[\s\S]*Google 翻译/);
  assert.match(main, /value="all"[\s\S]*当前检索全部/);
  assert.match(main, /value="filtered"[\s\S]*当前筛选结果/);
  assert.match(main, /value="selected"[\s\S]*当前勾选文章/);
  assert.match(main, /data-google-only-untranslated checked/);
  assert.match(main, /data-google-fetch-missing/);
  assert.match(styles, /\.pubmed-google-export-section/);
});

test('wires export, import preview, apply, and the Google documents shortcut', () => {
  assert.match(main, /export_google_translate_xlsx/);
  assert.match(main, /preview_google_translate_import/);
  assert.match(main, /apply_google_translate_import/);
  assert.match(main, /https:\/\/translate\.google\.com\/\?sl=en&tl=zh-CN&op=docs/);
  for (const command of [
    'export_google_translate_xlsx',
    'preview_google_translate_import',
    'apply_google_translate_import',
  ]) {
    assert.match(commands, new RegExp(`pub fn ${command}`));
    assert.match(app, new RegExp(`pubmed_search_cmd::${command}`));
  }
});

test('keeps ordinary PubMed export and excludes Google imports from cost accounting', () => {
  assert.match(main, /invoke\('export_pubmed_entries'/);
  assert.match(service, /google-translate-web-document/);
  assert.doesNotMatch(service, /record_usage|cost_service/);
});
