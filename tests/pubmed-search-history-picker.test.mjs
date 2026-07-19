import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('search name field suggests previously used names without loading old results', () => {
  assert.match(html, /id="pubmed-search-name"[^>]*list="pubmed-search-name-history"/);
  assert.match(html, /<datalist id="pubmed-search-name-history"><\/datalist>/);
  assert.match(source, /function renderPubmedSearchNameHistory[\s\S]*allPubmedSearches\.map\(search => search\.name/);
  assert.doesNotMatch(source, /loadSavedPubmedSearchIntoModal/);
  assert.doesNotMatch(html, /btn-view-pubmed-search-history/);
});
