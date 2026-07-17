import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

test('each model keeps one API key without a second profile manager', () => {
  assert.equal(html.match(/id="api-key"/g)?.length, 1);
  assert.doesNotMatch(html, /id="api-token-profile"/);
  assert.doesNotMatch(html, /id="api-token-profile-name"/);
  assert.doesNotMatch(html, /id="btn-new-api-token"/);
  assert.doesNotMatch(html, /id="btn-delete-api-token"/);
  assert.match(html, /id="toolbar-api-button"/);
  assert.match(html, /id="toolbar-api-menu"/);
  assert.match(html, /id="toolbar-api-list"/);
  assert.match(html, /id="btn-manage-ai-models"/);

  assert.doesNotMatch(source, /invoke\('list_api_token_profiles'/);
  assert.doesNotMatch(source, /invoke\('upsert_api_token_profile'/);
  assert.doesNotMatch(source, /invoke\('activate_api_token_profile'/);
  assert.doesNotMatch(source, /invoke\('delete_api_token_profile'/);
  assert.match(source, /const savedSettings = await invoke\('save_ai_model', \{ settings \}\)/);
});

test('model picker is embedded in the monthly usage card', () => {
  const feedList = html.indexOf('id="feed-list"');
  const sidebarAiTools = html.indexOf('id="sidebar-ai-tools"');
  const globalStatus = html.indexOf('id="global-status"');

  assert.ok(feedList < sidebarAiTools);
  assert.ok(sidebarAiTools < globalStatus);
  assert.match(source, /toolbarApiPicker\.classList\.add\('sidebar-api-picker'\)/);
  assert.match(source, /costMeterBot\?\.append\(toolbarApiPicker\)/);
  assert.match(source, /document\.getElementById\('cost-model'\)\?\.remove\(\)/);
});

test('quick switching activates saved models and stays compact', () => {
  const start = source.indexOf('async function activateAiModel');
  const end = source.indexOf('\nfunction ', start + 10);
  const activate = source.slice(start, end > start ? end : undefined);

  assert.match(activate, /start_translation_pipeline/);
  assert.match(source, /invoke\('list_ai_models'\)/);
  assert.match(source, /option\.dataset\.modelId = model\.id/);
  assert.match(source, /activateAiModel\(option\.dataset\.modelId\)/);
  assert.match(source, /尚未添加模型/);
  assert.match(source, /toolbarApiPicker\.classList\.remove\('hidden'\)/);
  assert.match(source, /showSettings\('translation'\)/);
});
