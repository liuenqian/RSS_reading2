import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('marking an entry read preserves the article list scroll position', () => {
  assert.match(source, /const listScrollTop = entryItemsEl\?\.scrollTop \?\? 0;/);
  assert.match(source, /renderEntryList\(allEntries, \{ preserveScrollTop: listScrollTop \}\);/);
  assert.match(source, /function restoreEntryListScrollTop\(scrollTop\)/);
  assert.match(source, /entryItemsEl\.scrollTop = scrollTop;/);
});

test('already-read PubMed clicks and note loading preserve list position', () => {
  assert.match(source, /else renderEntryList\(allEntries, \{ preserveScrollTop: entryItemsEl\?\.scrollTop \?\? 0 \}\);/);
  assert.match(source, /async function loadReadingNotes\(entryId\)[\s\S]*const listScrollTop = entryItemsEl\?\.scrollTop \?\? 0;[\s\S]*renderEntryList\(allEntries, \{ preserveScrollTop: listScrollTop \}\);/);
});
