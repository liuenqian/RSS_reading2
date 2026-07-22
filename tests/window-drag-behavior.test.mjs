import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('custom window drag regions do not trigger Tauri double-click maximize', () => {
  assert.doesNotMatch(html, /data-tauri-drag-region/);
  assert.match(html, /data-window-drag-region/);
  assert.match(main, /closest\('\[data-window-drag-region\]'\)/);
  assert.match(main, /e\.button !== 0 \|\| e\.detail !== 1/);
  for (const selector of ['.sidebar-row', '.feed-item', '.pubmed-search-item']) {
    assert.match(main, new RegExp(`'\\${selector}'`));
  }
});
