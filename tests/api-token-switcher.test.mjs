import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

test('API token profiles can be managed in settings and switched from a toolbar menu', () => {
  assert.match(html, /id="api-token-profile"/);
  assert.match(html, /id="api-token-profile-name"/);
  assert.match(html, /id="btn-new-api-token"/);
  assert.match(html, /id="btn-delete-api-token"/);
  assert.match(html, /id="toolbar-api-button"/);
  assert.match(html, /id="toolbar-api-menu"/);
  assert.match(html, /id="toolbar-api-list"/);
  assert.match(html, /id="btn-manage-api-tokens"/);

  assert.match(source, /invoke\('list_api_token_profiles'/);
  assert.match(source, /invoke\('upsert_api_token_profile'/);
  assert.match(source, /invoke\('activate_api_token_profile'/);
  assert.match(source, /invoke\('delete_api_token_profile'/);
});

test('API picker is embedded in the monthly usage card', () => {
  const feedList = html.indexOf('id="feed-list"');
  const sidebarAiTools = html.indexOf('id="sidebar-ai-tools"');
  const globalStatus = html.indexOf('id="global-status"');

  assert.ok(feedList < sidebarAiTools);
  assert.ok(sidebarAiTools < globalStatus);
  assert.match(source, /toolbarApiPicker\.classList\.add\('sidebar-api-picker'\)/);
  assert.match(source, /costMeterBot\?\.append\(toolbarApiPicker\)/);
  assert.match(source, /document\.getElementById\('cost-model'\)\?\.remove\(\)/);
});

test('quick switching aggregates providers, resumes queued work, and stays compact', () => {
  const start = source.indexOf('async function activateApiTokenProfile');
  const end = source.indexOf('\nfunction ', start + 10);
  const activate = source.slice(start, end > start ? end : undefined);

  assert.match(activate, /start_translation_pipeline/);
  assert.match(activate, /fromToolbar/);
  assert.match(source, /Object\.keys\(AI_PROVIDER_META\)/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /尚未保存 API 配置/);
  assert.match(source, /toolbarApiPicker\.classList\.remove\('hidden'\)/);
  assert.match(source, /showSettings\('translation'\)/);
});
