import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../src-tauri/src/services/briefing_service.rs', import.meta.url), 'utf8');

test('briefing source selector supports RSS feeds and saved PubMed searches', () => {
  assert.match(index, /id="briefing-source-scope"/);
  assert.match(index, /value="rss">全部 RSS 订阅/);
  assert.match(index, /value="feed">指定 RSS 订阅/);
  assert.match(index, /value="pubmed">指定 PubMed 检索/);
  assert.match(main, /sourceScope, sourceId/);
  assert.match(main, /briefing-source-scope/);
  assert.match(main, /briefing-source-id/);
});

test('briefing header gives source controls their own responsive row', () => {
  assert.match(styles, /\.briefing-list-header\s*\{[\s\S]*"title sort generate"[\s\S]*"source source source"/);
  assert.match(styles, /@container briefing-list \(max-width: 440px\)/);
  assert.match(styles, /\.briefing-source-row\s*\{[\s\S]*grid-area: source/);
  assert.match(styles, /\.briefing-source-row select\s*\{[\s\S]*background-color:\s*var\(--accent-faint\)[\s\S]*color:\s*var\(--accent-deep\)[\s\S]*appearance:\s*none/);
  assert.match(styles, /\.briefing-source-row select:focus\s*\{[\s\S]*border-color:\s*var\(--accent\)/);
});

test('RSS and PubMed context menus generate briefings for the selected source', () => {
  assert.match(main, /data-action="generate-briefing">生成此订阅简报/);
  assert.match(main, /data-action="generate-briefing">生成此检索简报/);
  assert.match(main, /generateBriefingForSource\('feed', feed\.id\)/);
  assert.match(main, /generateBriefingForSource\('pubmed', search\.id\)/);
  assert.match(main, /function generateBriefingForSource[\s\S]*briefing-source-scope[\s\S]*briefing-source-id[\s\S]*enterBriefingMode\(\)[\s\S]*generateBriefingNow\(\)/);
});

test('selected entries can generate a briefing from their context menu', () => {
  assert.match(main, /data-action="generate-briefing-selection">按所选 \$\{targetEntries\.length\} 篇生成简报/);
  assert.match(main, /async function generateBriefingForEntries\(entries\)/);
  assert.match(main, /generateBriefingNow\(\{ entryIds \}\)/);
  assert.match(main, /sourceScope = entryIds\.length[\s\S]*'selection'/);
  assert.match(main, /entryIds: entryIds\.length \? entryIds : null/);
});

test('manual briefing generation is on demand while scheduler passes cadence', () => {
  assert.match(main, /async function generateBriefingNow\(options = \{\}\)/);
  assert.match(main, /const expectedFrequency = options\?\.expectedFrequency \|\| null;/);
  assert.match(main, /invoke\('generate_briefing', \{[\s\S]*customPrompt,[\s\S]*expectedFrequency,[\s\S]*sourceScope,[\s\S]*sourceId,[\s\S]*entryIds/);
  assert.match(main, /generateBriefingNow\(\{ expectedFrequency: freq \}\)/);
  assert.doesNotMatch(main, /const expectedFrequency = localStorage\.getItem\('briefing-frequency'\) \|\| 'weekly';/);
});

test('briefing backend isolates source membership and records its label', () => {
  assert.match(service, /entry_feed_memberships/);
  assert.match(service, /pubmed_search_entries/);
  assert.match(service, /source_scope/);
  assert.match(service, /source_name/);
});
