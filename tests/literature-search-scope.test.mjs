import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('captures the selected PubMed search without copying its full result set', () => {
  assert.match(source, /const pubmedScope = mode === 'pubmed' \? currentPubmedSearch : null/);
  assert.match(source, /pubmedSearchId: pubmedScope\?\.id \|\| null/);
  assert.match(source, /pubmedSearchName: pubmedScope\?\.name \|\| ''/);
  assert.doesNotMatch(source, /pubmedEntries: pubmedScope/);
});

test('sends PubMed searches through the complete backend text index', () => {
  assert.match(source, /await invoke\('search_entries', \{[\s\S]*pubmedSearchId: searchPubmedId/);
  assert.match(source, /enterLiteratureSearchMode\(\{ preservePubmedSearch: !!searchPubmedId \}\)/);
  assert.match(source, /isScopedPubmedSearch[\s\S]*getFilteredPubmedEntries\(entries\)/);
  assert.match(source, /const query = mode === 'search' \? ''/);
});

test('uses translated PubMed fields and falls back to the RSS publication date', () => {
  assert.match(source, /entry\.title_translated,[\s\S]*entry\.summary_translated/);
  assert.doesNotMatch(source, /entry\.translated_title|entry\.translated_summary/);
  assert.match(source, /const value = entry\.publication_date \|\| entry\.published_at \|\| ''/);
});

test('keeps feed and global searches on the existing backend path', () => {
  assert.match(source, /const searchFeedId = searchPubmedId \? null : \(selectedFeedId \|\| null\)/);
  assert.match(source, /feedId: searchFeedId,[\s\S]*pubmedSearchId: searchPubmedId/);
});

test('clearing a scoped search restores its PubMed search or feed', () => {
  assert.match(source, /if \(restore\?\.mode === 'pubmed' && restore\.pubmedSearchId\) \{\s*selectPubmedSearch\(restore\.pubmedSearchId\)/);
  assert.match(source, /else if \(restore\?\.selectedFeedId \|\| currentSearchFeedId\) \{\s*selectFeed\(restore\?\.selectedFeedId \|\| currentSearchFeedId\)/);
});

test('PubMed toolbar actions stay inside the list column', () => {
  assert.match(styles, /\.pubmed-batch-heading[\s\S]*right: auto;[\s\S]*width: calc\(var\(--list-width\) - 66px\)/);
  assert.match(styles, /\.pubmed-batch-heading[\s\S]*max-width: calc\(100% - 52px\)/);
});
