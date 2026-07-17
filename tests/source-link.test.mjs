import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildPubmedSearchUrl, feedSourceLink } from '../src/source_link.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('builds an encoded PubMed result link from a saved query', () => {
  const url = new URL(buildPubmedSearchUrl('SLC6A6[Title/Abstract] AND heart failure'));
  assert.equal(url.origin, 'https://pubmed.ncbi.nlm.nih.gov');
  assert.equal(url.searchParams.get('term'), 'SLC6A6[Title/Abstract] AND heart failure');
  assert.equal(buildPubmedSearchUrl('  '), '');
});

test('opens PubMed feeds on PubMed and ordinary feeds at their source URL', () => {
  assert.deepEqual(
    feedSourceLink({
      url: 'https://pubmed.ncbi.nlm.nih.gov/rss/search/example/',
      pubmed_query: 'macrophage[Title/Abstract]',
    }),
    {
      label: '在 PubMed 打开',
      url: buildPubmedSearchUrl('macrophage[Title/Abstract]'),
    },
  );
  assert.deepEqual(
    feedSourceLink({ url: 'https://example.com/feed.xml' }),
    { label: '打开订阅源', url: 'https://example.com/feed.xml' },
  );
});

test('wires source links into both context menus', () => {
  assert.match(source, /function showPubmedSearchContextMenu[\s\S]*data-action="open-source">在 PubMed 打开/);
  assert.match(source, /function showContextMenu[\s\S]*data-action="open-source">\$\{sourceLink\.label\}/);
  assert.match(source, /buildPubmedSearchUrl\(search\.query\)/);
  assert.match(source, /openUrl\(sourceLink\.url\)/);
});
