import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('PubMed rename uses an inline editor instead of window.prompt', () => {
  assert.doesNotMatch(source, /window\.prompt\('检索名称'/);
  assert.match(source, /startRenamePubmedSearch\(search\.id\)/);
  assert.match(source, /class="pubmed-search-rename-input"/);
  assert.match(source, /invoke\('rename_pubmed_search'/);
});
