import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizePdfBinary } from '../src/pdf_reader_utils.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const reader = await readFile(new URL('../src/pdf_reader.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const commands = await readFile(new URL('../src-tauri/src/commands/entry_cmd.rs', import.meta.url), 'utf8');
const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

test('normalizes raw PDF IPC responses without copying typed arrays unnecessarily', () => {
  const typed = new Uint8Array([1, 2, 3]);
  assert.equal(normalizePdfBinary(typed), typed);
  assert.deepEqual([...normalizePdfBinary(typed.buffer)], [1, 2, 3]);
  assert.deepEqual([...normalizePdfBinary([4, 5])], [4, 5]);
  assert.throws(() => normalizePdfBinary('invalid'), /PDF 数据格式无效/);
});

test('detail view exposes summary and PDF tabs with complete reader controls', () => {
  const summaryTab = html.indexOf('id="btn-detail-view-summary"');
  const pdfTab = html.indexOf('id="btn-detail-view-pdf"');
  const summaryView = html.indexOf('id="detail-summary-view"');
  const pdfView = html.indexOf('id="detail-pdf-view"');
  assert.ok(summaryTab < pdfTab && pdfTab < summaryView && summaryView < pdfView);
  for (const id of [
    'btn-pdf-previous', 'btn-pdf-next', 'pdf-page-input', 'btn-pdf-zoom-out',
    'btn-pdf-zoom-in', 'btn-pdf-fit-width', 'pdf-search-input',
    'btn-pdf-search-next', 'btn-pdf-open-external', 'btn-pdf-download',
    'detail-pdf-canvas',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('PDF reader is loaded on demand and uses bundled PDF.js assets', () => {
  assert.match(main, /import\('\.\/pdf_reader\.js'\)/);
  assert.match(main, /invoke\('fetch_entry_pdf', \{ entryId: entry\.id \}\)/);
  assert.match(main, /pdf-reader-page-v1-/);
  assert.match(reader, /\.\/vendor\/pdfjs\/pdf\.mjs/);
  assert.match(reader, /\.\/vendor\/pdfjs\/pdf\.worker\.mjs/);
  assert.doesNotMatch(reader, /https?:\/\//);
});

test('backend returns bounded raw PDF bytes and registers the command', () => {
  assert.match(commands, /pub async fn fetch_entry_pdf/);
  assert.match(commands, /Response::new\(bytes\)/);
  assert.match(lib, /entry_cmd::fetch_entry_pdf/);
});

test('reader layout remains embedded in the existing detail surface', () => {
  assert.match(styles, /\.detail-view-tabs\s*\{/);
  assert.match(styles, /\.detail-pdf-toolbar\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /\.detail-pdf-stage\s*\{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.detail-pdf-stage canvas\s*\{/);
});
