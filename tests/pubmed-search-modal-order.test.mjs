import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

test('PubMed preview appears before formal retrieval options', () => {
  const previewIndex = source.indexOf('id="btn-preview-pubmed-search"');
  const retrievalIndex = source.indexOf('id="pubmed-retrieval-panel"');

  assert.notEqual(previewIndex, -1);
  assert.notEqual(retrievalIndex, -1);
  assert.ok(previewIndex < retrievalIndex);
});
