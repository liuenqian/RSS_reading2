import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('feed and PubMed source menus expose scoped reading statistics', () => {
  assert.match(source, /function showContextMenu[\s\S]*data-action="reading-stats"/);
  assert.match(source, /function showPubmedSearchContextMenu[\s\S]*data-action="reading-stats"/);
  assert.match(source, /invoke\('get_source_reading_stats'/);
  assert.match(source, /openReadingStatsForSource\('feed'/);
  assert.match(source, /openReadingStatsForSource\('pubmed'/);
});

test('reading stats include rhythm, heatmap, structure, and progress views', () => {
  assert.match(html, /id="reading-weekday-chart"/);
  assert.match(html, /id="reading-hour-chart"/);
  assert.match(html, /id="heatmap"/);
  assert.match(html, /id="reading-topic-ring"/);
  assert.match(html, /id="reading-progress-ring"/);
  assert.match(source, /function renderReadingRhythm/);
  assert.match(source, /function renderReadingStructure/);
  assert.match(source, /stats\.tag_read_counts/);
  assert.match(styles, /\.reading-rhythm-grid\s*\{/);
  assert.match(styles, /\.reading-structure-grid\s*\{/);
});

test('duration-like charts are explicitly labeled as read article counts', () => {
  assert.match(html, /按标记已读的篇数统计/);
  assert.match(source, /纵轴为已读篇数/);
  assert.doesNotMatch(html, /总阅读时长/);
});
