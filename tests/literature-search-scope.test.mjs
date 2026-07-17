import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('captures the selected PubMed search and its complete result set', () => {
  assert.match(source, /const pubmedScope = mode === 'pubmed' \? currentPubmedSearch : null/);
  assert.match(source, /pubmedSearchId: pubmedScope\?\.id \|\| null/);
  assert.match(source, /pubmedSearchName: pubmedScope\?\.name \|\| ''/);
  assert.match(source, /pubmedEntries: pubmedScope \? \[\.\.\.allEntries\] : null/);
});

test('filters every PubMed query from the saved full result set', () => {
  assert.match(source, /const searchPubmedEntries = searchPubmedId && Array\.isArray\(restore\?\.pubmedEntries\)/);
  assert.match(source, /searchPubmedEntries\.filter\(entry => entryMatchesLiteratureSearchQuery\(entry, query\)\)/);
  assert.match(source, /enterLiteratureSearchMode\(\{ preservePubmedSearch: !!searchPubmedId \}\)/);
  assert.match(source, /isScopedPubmedSearch[\s\S]*getFilteredPubmedEntries\(entries\)/);
});

test('keeps feed and global searches on the existing backend path', () => {
  assert.match(source, /const searchFeedId = searchPubmedId \? null : \(selectedFeedId \|\| null\)/);
  assert.match(source, /await invoke\('search_entries', \{ query, feedId: searchFeedId \}\)/);
});

test('clearing a scoped search restores its PubMed search or feed', () => {
  assert.match(source, /if \(restore\?\.mode === 'pubmed' && restore\.pubmedSearchId\) \{\s*selectPubmedSearch\(restore\.pubmedSearchId\)/);
  assert.match(source, /else if \(restore\?\.selectedFeedId \|\| currentSearchFeedId\) \{\s*selectFeed\(restore\?\.selectedFeedId \|\| currentSearchFeedId\)/);
});
