import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
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

test('briefing backend isolates source membership and records its label', () => {
  assert.match(service, /entry_feed_memberships/);
  assert.match(service, /pubmed_search_entries/);
  assert.match(service, /source_scope/);
  assert.match(service, /source_name/);
});
