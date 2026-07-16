import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createDefaultFilterScopeState,
  filterScopeKey,
  readFilterScopeState,
  writeFilterScopeState,
} from '../src/filter_scope.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('builds independent keys for saved PubMed searches and feed folders', () => {
  assert.equal(filterScopeKey({ mode: 'pubmed', pubmedSearchId: 3 }), 'pubmed:3');
  assert.equal(filterScopeKey({ mode: 'pubmed', pubmedSearchId: 4 }), 'pubmed:4');
  assert.equal(filterScopeKey({ mode: 'feed', feedId: 8 }), 'feed:8');
  assert.equal(filterScopeKey({ mode: 'search', feedId: 8 }), 'feed:8');
  assert.equal(filterScopeKey({ mode: 'kept' }), 'kept');
  assert.equal(filterScopeKey({ mode: 'feed' }), 'all');
});

test('keeps every filter state isolated between scopes', () => {
  let scopes = {};
  scopes = writeFilterScopeState(scopes, 'pubmed:3', {
    entryFilter: 'unread',
    tagFilter: 'fibrosis',
    entrySortField: 'if',
    entrySortDirection: 'asc',
    metricFilters: { if: 'ge10', q: 'Q1', b: 'B2', top: 'top' },
    pubmedFilters: {
      status: 'keep',
      sort: 'if-desc',
      star: 'starred',
      publishedFrom: '2024-01',
      publishedTo: '2025-12',
      addedFrom: '2026-01-01',
      addedTo: '2026-07-16',
    },
    pubmedSnapshotId: 'snapshot-3',
  });
  scopes = writeFilterScopeState(scopes, 'pubmed:4', createDefaultFilterScopeState());

  assert.equal(readFilterScopeState(scopes, 'pubmed:3').entryFilter, 'unread');
  assert.equal(readFilterScopeState(scopes, 'pubmed:3').entrySortField, 'if');
  assert.equal(readFilterScopeState(scopes, 'pubmed:3').entrySortDirection, 'asc');
  assert.equal(readFilterScopeState(scopes, 'pubmed:3').metricFilters.if, 'ge10');
  assert.equal(readFilterScopeState(scopes, 'pubmed:3').pubmedFilters.status, 'keep');
  assert.equal(readFilterScopeState(scopes, 'pubmed:3').pubmedSnapshotId, 'snapshot-3');
  assert.deepEqual(readFilterScopeState(scopes, 'pubmed:4'), createDefaultFilterScopeState());
  assert.deepEqual(readFilterScopeState(scopes, 'feed:8'), createDefaultFilterScopeState());
});

test('restores scoped filters when navigation changes the active source', () => {
  assert.match(source, /function restoreCurrentFilterScope/);
  assert.match(source, /async function selectPubmedSearch[\s\S]*restoreCurrentFilterScope\(\)/);
  assert.match(source, /function selectFeed[\s\S]*restoreCurrentFilterScope\(\)/);
  assert.match(source, /function enterKeptMode[\s\S]*restoreCurrentFilterScope\(\)/);
  assert.match(source, /function persistEntrySortMode\(\)[\s\S]*persistCurrentFilterScope\(\)/);
  assert.match(source, /FILTER_SCOPE_STORAGE_KEY\s*=\s*'entry-filter-scopes-v1'/);
});
