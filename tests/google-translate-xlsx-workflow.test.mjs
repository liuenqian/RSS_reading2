import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const commands = await readFile(new URL('../src-tauri/src/commands/pubmed_search_cmd.rs', import.meta.url), 'utf8');
const app = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const service = await readFile(new URL('../src-tauri/src/services/google_translate_xlsx_service.rs', import.meta.url), 'utf8');

test('merges Google translation into the existing PubMed export dialog', () => {
  assert.doesNotMatch(html, /id="pubmed-export-format"/);
  assert.match(html, /id="btn-export-pubmed"/);
  assert.match(main, /function choosePubmedExportFields/);
  assert.match(main, /data-standard-format/);
  assert.match(main, /value="xlsx"[\s\S]*Excel \(\.xlsx\)/);
  assert.match(main, /value="txt"[\s\S]*PubMed TXT/);
  assert.match(main, /cleanup\(\{ mode: 'standard', format, fields \}\)/);
  assert.match(main, /data-mode="standard"[\s\S]*普通导出/);
  assert.match(main, /data-mode="google"[\s\S]*Google 翻译/);
  assert.match(main, /value="all"[\s\S]*当前检索全部/);
  assert.match(main, /value="filtered"[\s\S]*当前筛选结果/);
  assert.match(main, /value="selected"[\s\S]*当前勾选文章/);
  assert.match(main, /data-google-only-untranslated checked/);
  assert.match(main, /data-google-fetch-missing/);
  assert.match(styles, /\.pubmed-google-export-section/);
});

test('orders Google translation actions by workflow', () => {
  const dialogStart = main.indexOf('function choosePubmedExportFields');
  const footerStart = main.indexOf('<footer class="pubmed-modal-footer">', dialogStart);
  const footerEnd = main.indexOf('</footer>', footerStart);
  const footer = main.slice(footerStart, footerEnd);

  const exportIndex = footer.indexOf('data-confirm');
  const openGoogleIndex = footer.indexOf('data-open-google');
  const importIndex = footer.indexOf('data-import-google');
  const cancelIndex = footer.indexOf('data-close');

  assert.ok([exportIndex, openGoogleIndex, importIndex, cancelIndex].every(index => index >= 0));
  assert.ok(exportIndex < openGoogleIndex);
  assert.ok(openGoogleIndex < importIndex);
  assert.ok(importIndex < cancelIndex);
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

test('keeps the export dialog open for Google export and import actions', () => {
  assert.match(main, /function choosePubmedExportFields\(initialFormat, context, onGoogleExport = null\)/);
  assert.match(main, /const message = await onGoogleExport\(googleChoice\)/);
  assert.doesNotMatch(main, /\[data-import-google\][\s\S]{0,180}cleanup\(null\)/);
  assert.match(main, /已取消选择保存位置，窗口将继续保留/);
  assert.match(main, /翻译完成后可直接点击“导入译文”/);
});

test('keeps ordinary PubMed export and excludes Google imports from cost accounting', () => {
  assert.match(main, /invoke\('export_pubmed_entries'/);
  assert.match(service, /google-translate-web-document/);
  assert.doesNotMatch(service, /record_usage|cost_service/);
});
