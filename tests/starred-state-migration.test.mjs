import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('migrates legacy stars before using database-backed star state', () => {
  assert.match(source, /async function loadStarredState\(\)/);
  assert.match(source, /invoke\('migrate_legacy_starred_ids'/);
  assert.match(source, /invoke\('list_starred_entry_ids'/);
  assert.match(source, /localStorage\.removeItem\('starred-ids'\)/);
  const starredLoad = source.lastIndexOf('loadStarredState();');
  const settingsLoad = source.lastIndexOf('loadSettings();');
  assert.ok(starredLoad >= 0 && settingsLoad > starredLoad);
});

test('database star writes roll back the optimistic UI state on failure', () => {
  assert.match(source, /invoke\('set_entry_starred'/);
  assert.match(source, /starredEntryIds = previous/);
  assert.match(source, /保存星标失败/);
});
