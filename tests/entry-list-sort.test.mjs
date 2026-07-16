import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeEntrySortMode, sortEntries } from '../src/entry_sort.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const entries = [
  { id: 1, publication_date: '2022-04-01', metrics: { if: '5.2', q: 'Q2', b: 'B3' } },
  { id: 2, published_at: '2024-01-10T00:00:00Z', metrics: { if: '12.1', q: 'Q1', b: 'B2' } },
  { id: 3, publication_date: '', metrics: { if: 'N/A', q: 'N/A', b: 'B1' } },
  { id: 4, publication_date: '2020', metrics: { if: '<0.1', q: 'Q4', b: 'B4' } },
];

const ids = mode => sortEntries(entries, mode, entry => entry.metrics).map(entry => entry.id);

test('sorts publication year in both directions and keeps missing years last', () => {
  assert.deepEqual(ids('year-desc'), [2, 1, 4, 3]);
  assert.deepEqual(ids('year-asc'), [4, 1, 2, 3]);
});

test('sorts impact factor and keeps unavailable metrics last', () => {
  assert.deepEqual(ids('if-desc'), [2, 1, 4, 3]);
  assert.deepEqual(ids('if-asc'), [4, 1, 2, 3]);
});

test('sorts JCR and CAS partitions in both directions', () => {
  assert.deepEqual(ids('jcr-asc'), [2, 1, 4, 3]);
  assert.deepEqual(ids('jcr-desc'), [4, 1, 2, 3]);
  assert.deepEqual(ids('cas-asc'), [3, 2, 1, 4]);
  assert.deepEqual(ids('cas-desc'), [4, 1, 2, 3]);
});

test('normalizes unknown modes and preserves default order', () => {
  assert.equal(normalizeEntrySortMode('unknown'), 'default');
  assert.deepEqual(ids('unknown'), [1, 2, 3, 4]);
});

test('wires all entry sorting modes into the feed list and persists the selection', () => {
  assert.match(html, /id="entry-sort"/);
  assert.match(html, /id="entry-sort-direction"/);
  assert.match(html, /class="entry-header-top"[\s\S]*class="entry-sort-row"/);
  for (const field of ['year', 'if', 'jcr', 'cas']) {
    assert.match(html, new RegExp(`value="${field}"`));
  }
  const sortSelect = html.match(/<select id="entry-sort"[\s\S]*?<\/select>/)?.[0] || '';
  for (const mode of ['year-desc', 'year-asc', 'if-desc', 'if-asc', 'jcr-asc', 'jcr-desc', 'cas-asc', 'cas-desc']) {
    assert.doesNotMatch(sortSelect, new RegExp(`value="${mode}"`));
  }
  assert.match(source, /ENTRY_SORT_STORAGE_KEY\s*=\s*'entry-sort-v2'/);
  assert.match(source, /entrySortDirectionMode\s*=\s*entrySortDirectionMode === 'asc' \? 'desc' : 'asc'/);
  assert.match(source, /sortEntries\(filtered, entrySortMode, lookupJournalMetrics\)/);
  assert.match(source, /function getFilteredPubmedEntries[\s\S]*return sortPubmedEntriesForCurrentView\(filtered\)/);
  assert.match(source, /function sortPubmedEntriesForCurrentView[\s\S]*return sortEntries\(sorted, entrySortMode, lookupJournalMetrics\)/);
});

test('prioritizes the current PubMed list order for batch translation', () => {
  assert.match(source, /const followsCurrentView = mode === 'pubmed' && currentPubmedSearch\?\.id === search\.id/);
  assert.match(source, /const orderedEntries = followsCurrentView[\s\S]*sortPubmedEntriesForCurrentView\(entries\)[\s\S]*: entries/);
  assert.match(source, /await translateEntries\(orderedEntries, field\)/);
});

test('all article overview pages share the article sorter and briefings have their own sorter', () => {
  for (const view of ['all', 'unread', 'starred', 'reading-notes', 'kept']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
  assert.match(html, /id="briefing-sort"/);
  assert.match(html, /id="briefing-sort-direction"/);
  assert.match(source, /BRIEFING_SORT_STORAGE_KEY\s*=\s*'briefing-sort-v1'/);
  assert.match(source, /function filteredBriefingsForCurrentQuery[\s\S]*briefingSortField[\s\S]*\.sort\(/);
  assert.match(source, /briefingSortDirectionMode\s*=\s*briefingSortDirectionMode === 'asc' \? 'desc' : 'asc'/);
});
