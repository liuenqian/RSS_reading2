import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function orderHarness(newestFirstIds, savedOrder = null) {
  const storage = new Map();
  const key = 'pubmed-search-order-v1';
  if (savedOrder !== null) storage.set(key, savedOrder);
  const context = {
    allPubmedSearches: newestFirstIds.map(id => ({ id })),
    PUBMED_SEARCH_ORDER_STORAGE_KEY: key,
    localStorage: {
      getItem(name) { return storage.get(name) ?? null; },
      setItem(name, value) { storage.set(name, value); },
    },
    renderPubmedSearchList() {},
  };
  vm.createContext(context);
  for (const name of ['applyPubmedSearchOrder', 'savePubmedSearchOrder', 'movePubmedSearch']) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing function ${name}`);
    const end = source.indexOf('\n}\n', start);
    vm.runInContext(source.slice(start, end + 2), context);
  }
  return {
    context,
    ids: () => Array.from(context.allPubmedSearches, search => search.id),
    saved: () => storage.get(key),
  };
}

test('without manual order, keeps the backend creation order with newest searches first', () => {
  const harness = orderHarness([4, 3, 2, 1]);
  harness.context.applyPubmedSearchOrder();
  assert.deepEqual(harness.ids(), [4, 3, 2, 1]);
  assert.equal(harness.saved(), undefined);
});

test('new searches go above the saved manual order and keep their creation order', () => {
  const harness = orderHarness([5, 4, 3, 2, 1], '[2,1,3]');
  harness.context.applyPubmedSearchOrder();
  assert.deepEqual(harness.ids(), [5, 4, 2, 1, 3]);
});

test('manual moves persist across reloads and the next new search still goes first', () => {
  const harness = orderHarness([5, 4, 3, 2, 1], '[2,1,3]');
  harness.context.applyPubmedSearchOrder();
  harness.context.movePubmedSearch(3, -1);
  assert.deepEqual(harness.ids(), [5, 4, 2, 3, 1]);
  assert.deepEqual(JSON.parse(harness.saved()), [5, 4, 2, 3, 1]);

  harness.context.allPubmedSearches = [5, 4, 3, 2, 1].map(id => ({ id }));
  harness.context.applyPubmedSearchOrder();
  assert.deepEqual(harness.ids(), [5, 4, 2, 3, 1]);

  harness.context.allPubmedSearches = [6, 5, 4, 3, 2, 1].map(id => ({ id }));
  harness.context.applyPubmedSearchOrder();
  assert.deepEqual(harness.ids(), [6, 5, 4, 2, 3, 1]);
});

test('deleted searches in saved order do not affect surviving manual positions', () => {
  const harness = orderHarness([5, 4, 3, 2], '[99,2,1,3]');
  harness.context.applyPubmedSearchOrder();
  assert.deepEqual(harness.ids(), [5, 4, 2, 3]);
});

test('invalid stored order falls back to creation order', () => {
  for (const saved of ['not JSON', 'null', '{}', '["invalid"]']) {
    const harness = orderHarness([3, 2, 1], saved);
    harness.context.applyPubmedSearchOrder();
    assert.deepEqual(harness.ids(), [3, 2, 1]);
  }
});

test('moving beyond the list boundaries does not change or save the order', () => {
  const harness = orderHarness([3, 2, 1]);
  harness.context.movePubmedSearch(3, -1);
  harness.context.movePubmedSearch(1, 1);
  harness.context.movePubmedSearch(99, -1);
  assert.deepEqual(harness.ids(), [3, 2, 1]);
  assert.equal(harness.saved(), undefined);
});
