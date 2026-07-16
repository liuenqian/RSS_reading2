import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('literature growth monitor lives in reading stats before the heatmap', () => {
  const statsIndex = html.indexOf('id="section-stats"');
  const growthIndex = html.indexOf('id="literature-growth-list"');
  const heatmapIndex = html.indexOf('id="heatmap"');

  assert.ok(statsIndex < growthIndex);
  assert.ok(growthIndex < heatmapIndex);
  assert.match(html, /id="literature-growth-filter"/);
});

test('growth monitor compares weekly windows and renders a 30-day trend', () => {
  assert.match(source, /stats\.growth_sources/);
  assert.match(source, /source\.last_7_days/);
  assert.match(source, /source\.previous_7_days/);
  assert.match(source, /source\.last_30_days/);
  assert.match(source, /function renderLiteratureGrowthSparkline/);
  assert.match(source, /class="literature-growth-count/);
  assert.match(source, /class="literature-growth-day" datetime=/);
  assert.match(styles, /\.literature-growth-series\s*\{/);
  assert.match(styles, /grid-template-columns:\s*repeat\(30,/);
});
