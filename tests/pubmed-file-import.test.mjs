import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('PubMed file import is wired from settings to both Tauri commands', () => {
  const html = read('src/index.html');
  const main = read('src/main.js');
  const commands = read('src-tauri/src/commands/pubmed_search_cmd.rs');
  const lib = read('src-tauri/src/lib.rs');

  assert.match(html, /id="btn-data-transfer"/);
  assert.doesNotMatch(html, /id="btn-(?:import|export)-opml"/);
  assert.match(main, /function showDataTransferMenu/);
  assert.match(main, /data-action="import-pubmed"/);
  assert.match(main, /data-action="import-opml"/);
  assert.match(main, /data-action="export-opml"/);
  assert.match(main, /extensions: \['txt', 'nbib', 'csv'\]/);
  assert.match(main, /invoke\('preview_pubmed_file_import'/);
  assert.match(main, /invoke\('import_pubmed_file'/);
  assert.match(main, /isLocalPubmedImport/);
  assert.match(commands, /pub fn preview_pubmed_file_import/);
  assert.match(commands, /pub fn import_pubmed_file/);
  assert.match(lib, /pubmed_search_cmd::preview_pubmed_file_import/);
  assert.match(lib, /pubmed_search_cmd::import_pubmed_file/);
});

test('PubMed parsers accept official text, NBIB and CSV exports', () => {
  const service = read('src-tauri/src/services/pubmed_file_import_service.rs');

  assert.match(service, /"nbib" \| "txt" => parse_pubmed_nbib/);
  assert.match(service, /"csv" => parse_pubmed_csv/);
  assert.match(service, /CSV 缺少 PubMed 导出格式必需的 PMID 列/);
});
