import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const commands = await readFile(new URL('../src-tauri/src/commands/entry_cmd.rs', import.meta.url), 'utf8');
const fulltext = await readFile(new URL('../src-tauri/src/services/fulltext_service.rs', import.meta.url), 'utf8');
const app = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

test('PDF download uses the built-in open-access workflow', () => {
  assert.match(main, /function chooseOpenAccessPdfDownloadOptions/);
  assert.match(main, /合法开放获取 PDF 下载/);
  assert.match(main, /invoke\('download_open_access_pdfs'/);
  assert.match(main, /downloadOpenAccessPdfs\(targetEntries\)/);
  assert.match(main, /downloadOpenAccessPdfs\(\[currentEntry\]\)/);
  assert.doesNotMatch(main, /download_papers_with_nature/);
  assert.doesNotMatch(html, /Sci-Hub/i);
});

test('open-access backend validates and records downloaded PDFs', () => {
  assert.match(commands, /pub async fn download_open_access_pdfs/);
  assert.match(commands, /Sha256::digest/);
  assert.match(commands, /upsert_pdf_fulltext/);
  assert.match(app, /entry_cmd::download_open_access_pdfs/);
  assert.doesNotMatch(app, /nature_download_cmd|download_papers_with_nature/);
  assert.match(fulltext, /pub async fn resolve_open_access_pdf/);
  assert.match(fulltext, /PMC Open Access/);
  assert.match(fulltext, /Europe PMC/);
  assert.match(fulltext, /Unpaywall/);
  assert.doesNotMatch(fulltext, /sci-hub/i);
});

test('downloaded PDFs can be opened through the system local reader', () => {
  assert.match(html, /id="btn-pdf-open-local"/);
  assert.match(main, /invoke\('get_entry_local_pdf_path'/);
  assert.match(main, /invoke\('open_entry_local_pdf'/);
  assert.match(commands, /pub fn get_entry_local_pdf_path/);
  assert.match(commands, /pub fn open_entry_local_pdf/);
  assert.match(commands, /open_path\(path/);
  assert.match(app, /entry_cmd::open_entry_local_pdf/);
  assert.match(commands, /set_pdf_local_path/);
});
