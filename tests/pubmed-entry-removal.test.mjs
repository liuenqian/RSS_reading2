import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const commands = await readFile(new URL('../src-tauri/src/commands/pubmed_search_cmd.rs', import.meta.url), 'utf8');
const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

test('feed refresh preserves the active PubMed or kept-entry scope', () => {
  assert.match(main, /async function reloadEntriesAfterFeedRefresh\(\)/);
  assert.match(main, /reloadEntriesAfterFeedRefresh[\s\S]*mode === 'pubmed'[\s\S]*selectPubmedSearch/);
  assert.match(main, /reloadEntriesAfterFeedRefresh[\s\S]*mode === 'kept'[\s\S]*enterKeptMode/);
  assert.match(main, /async function refreshAll\([\s\S]*await reloadEntriesAfterFeedRefresh\(\)/);
  assert.match(main, /scheduler-refreshed[\s\S]*await reloadEntriesAfterFeedRefresh\(\)/);
});

test('selected PubMed entries can be permanently removed from the current search', () => {
  assert.match(html, /id="btn-pubmed-remove-selected"/);
  assert.match(main, /async function removeSelectedPubmedEntries\(\)/);
  assert.match(main, /invoke\('remove_pubmed_search_entries'/);
  assert.match(main, /btnPubmedRemoveSelected\?\.addEventListener\('click', removeSelectedPubmedEntries\)/);
  assert.match(commands, /pub fn remove_pubmed_search_entries/);
  assert.match(lib, /pubmed_search_cmd::remove_pubmed_search_entries/);
});

test('the active PubMed search can clear its imported results without deleting the search', () => {
  assert.match(html, /id="btn-clear-current-pubmed-search"[\s\S]*清空结果/);
  assert.match(main, /async function clearCurrentPubmedSearchEntries\(\)/);
  assert.match(main, /clearCurrentPubmedSearchEntries[\s\S]*confirmDialog\([\s\S]*okLabel: '清空结果'[\s\S]*danger: true/);
  assert.match(main, /invoke\('clear_pubmed_search_entries'/);
  assert.match(main, /btnClearCurrentPubmedSearch\?\.addEventListener\('click', clearCurrentPubmedSearchEntries\)/);
  assert.match(commands, /pub fn clear_pubmed_search_entries/);
  assert.match(lib, /pubmed_search_cmd::clear_pubmed_search_entries/);
});
