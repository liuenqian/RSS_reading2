import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildPubmedSearchUrl } from '../src/source_link.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('PubMed preview appears before formal retrieval options', () => {
  const previewIndex = html.indexOf('id="btn-preview-pubmed-search"');
  const retrievalIndex = html.indexOf('id="pubmed-retrieval-panel"');

  assert.notEqual(previewIndex, -1);
  assert.notEqual(retrievalIndex, -1);
  assert.ok(previewIndex < retrievalIndex);
});

test('PubMed query can be checked on the official search page before saving', () => {
  const queryIndex = html.indexOf('id="pubmed-batch-query-input"');
  const openIndex = html.indexOf('id="btn-open-pubmed-query"');
  const retrievalIndex = html.indexOf('id="pubmed-retrieval-panel"');

  assert.ok(queryIndex < openIndex);
  assert.ok(openIndex < retrievalIndex);
  assert.match(source, /function openPubmedQueryInBrowser\(\)/);
  assert.match(source, /openUrl\(buildPubmedSearchUrl\(query\)\)/);
  const url = new URL(buildPubmedSearchUrl('heart failure[Title/Abstract]'));
  assert.equal(url.origin, 'https://pubmed.ncbi.nlm.nih.gov');
  assert.equal(url.searchParams.get('term'), 'heart failure[Title/Abstract]');
});
