import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildMedciteSearchUrl,
  buildMedreadingSearchUrl,
  buildPubmedSearchUrl,
  feedSourceLink,
} from '../src/source_link.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('builds an encoded PubMed result link from a saved query', () => {
  const url = new URL(buildPubmedSearchUrl('SLC6A6[Title/Abstract] AND heart failure'));
  assert.equal(url.origin, 'https://pubmed.ncbi.nlm.nih.gov');
  assert.equal(url.searchParams.get('term'), 'SLC6A6[Title/Abstract] AND heart failure');
  assert.equal(buildPubmedSearchUrl('  '), '');
});

test('builds an encoded MedCite search link from a saved query', () => {
  const url = new URL(buildMedciteSearchUrl('SLC6A6[Title/Abstract] AND heart failure'));
  assert.equal(url.origin, 'https://medcite.cn');
  assert.equal(url.pathname, '/home');
  assert.equal(url.searchParams.get('tab'), 'search');
  assert.equal(url.searchParams.get('q'), 'SLC6A6[Title/Abstract] AND heart failure');
  assert.equal(buildMedciteSearchUrl('  '), '');
});

test('builds an encoded MedReading search link from a saved query', () => {
  const url = new URL(buildMedreadingSearchUrl('SLC6A6[Title/Abstract] AND heart failure'));
  assert.equal(url.origin, 'https://www.medreading.cn');
  assert.equal(url.pathname, '/query');
  assert.equal(url.searchParams.get('search_type'), 'title');
  assert.equal(url.searchParams.get('search_value'), 'SLC6A6[Title/Abstract] AND heart failure');
  assert.equal(url.searchParams.get('is_subject'), '');
  assert.equal(url.searchParams.get('source'), '');
  assert.equal(url.searchParams.get('tk'), '');
  assert.equal(buildMedreadingSearchUrl('  '), '');
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
  assert.match(source, /function showPubmedSearchContextMenu[\s\S]*data-action="open-medcite">在 MedCite 打开/);
  assert.match(source, /function showPubmedSearchContextMenu[\s\S]*data-action="open-medreading">在 MedReading 打开/);
  assert.match(source, /function showContextMenu[\s\S]*data-action="open-source">\$\{sourceLink\.label\}/);
  assert.match(source, /buildPubmedSearchUrl\(search\.query\)/);
  assert.match(source, /buildMedciteSearchUrl\(search\.query\)/);
  assert.match(source, /buildMedreadingSearchUrl\(search\.query\)/);
  assert.match(source, /openUrl\(sourceLink\.url\)/);
});

test('article detail prefers official DOI and PubMed access routes', () => {
  assert.match(source, /function officialArticleAccess\(entry\)/);
  assert.match(source, /https:\/\/doi\.org\/\$\{encodeURIComponent\(doi\)\}/);
  assert.match(source, /https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\$\{encodeURIComponent\(pmid\)\}\//);
  assert.match(source, /syncDetailOfficialAccess\(entry\)/);
});
