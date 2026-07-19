import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

test('RSS entry opens the complete PubMed builder in subscription mode', () => {
  assert.match(html, /data-feed-add-mode="pubmed">PubMed 检索/);
  assert.doesNotMatch(html, /id="feed-add-author-builder"/);
  assert.match(main, /openPubmedSearchModal\(\{ creationTarget: 'feed' \}\)/);
  assert.match(main, /pubmedCreationTarget = creationTarget === 'feed' \? 'feed' : 'search'/);
  assert.match(main, /添加 PubMed RSS 订阅/);
});

test('subscription mode previews normally and creates a PubMed RSS feed', () => {
  assert.match(html, /id="pubmed-rss-options"/);
  assert.match(html, /id="pubmed-rss-limit"/);
  assert.match(main, /pubmedCreationTarget === 'feed'[\s\S]*build_pubmed_rss_url/);
  assert.match(main, /await persistNewFeed\(generatedUrl, \{[\s\S]*pubmedQuery: query,[\s\S]*pubmedLimit/);
  assert.match(main, /button\.textContent = '生成并添加订阅'/);
});

test('RSS subscription mode keeps AI assessment behind the preview action', () => {
  const previewStart = main.indexOf('async function previewPubmedSearch');
  const previewEnd = main.indexOf('\nasync function createAndRunPubmedSearch', previewStart);
  const preview = main.slice(previewStart, previewEnd);
  const queryGenerationStart = main.indexOf('async function generatePubmedQuery');
  const queryGenerationEnd = main.indexOf('\nfunction openPubmedQueryInBrowser', queryGenerationStart);
  const queryGeneration = main.slice(queryGenerationStart, queryGenerationEnd);

  assert.match(preview, /pubmedCreationTarget === 'search'/);
  assert.match(preview, /assess_pubmed_search_preview/);
  assert.doesNotMatch(queryGeneration, /assess_pubmed_search_preview/);
  assert.match(main, /点击预览结果后再进行 AI 评估/);
});
