import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('AI settings keep required fields visible and advanced controls grouped', () => {
  const apiKeyIndex = html.indexOf('id="api-key"');
  const modelIndex = html.indexOf('id="api-model-preset"');
  const advancedIndex = html.indexOf('settings-advanced-disclosure');
  const providerIndex = html.indexOf('id="ai-provider"');

  assert.ok(apiKeyIndex >= 0, 'API Key input should remain available');
  assert.ok(advancedIndex > apiKeyIndex, 'advanced controls should follow the API Key');
  assert.ok(providerIndex < modelIndex, 'provider should appear before the model');
  assert.ok(modelIndex < apiKeyIndex, 'model should appear before the API Key');
  assert.ok(apiKeyIndex < advancedIndex, 'required fields should appear before advanced settings');
  assert.match(html, /服务商 <span class="required-label">必填<\/span>/);
  assert.match(html, /模型 <span class="required-label">必填<\/span>/);
  assert.match(html, /API Key <span class="required-label">必填<\/span>/);
  assert.match(html, /placeholder="粘贴申请到的 API Key"/);
  assert.match(html, /id="api-mode-provider"[\s\S]*模型服务商/);
  assert.match(html, /id="api-mode-custom"[\s\S]*自定义配置/);
  assert.match(html, /<select[\s\S]*id="api-model-preset"/);
  assert.match(html, /id="api-custom-panel" class="api-config-panel hidden"/);
  assert.match(html, /Base URL <span class="required-label">必填<\/span>/);
  assert.match(html, /Model ID <span class="required-label">必填<\/span>/);
  assert.match(html, /<input type="hidden" id="model" \/>/);
  assert.match(html, /<details id="api-advanced-settings" class="settings-disclosure settings-advanced-disclosure" open>/);

  for (const id of [
    'api-token-profile',
    'api-token-profile-name',
    'btn-new-api-token',
    'btn-delete-api-token',
    'base-url',
    'model',
    'custom-model',
    'model-display-name',
    'model-display-name-count',
    'context-input-tokens',
    'context-output-tokens',
    'tool-call-rounds',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('advanced model capability fields use the requested defaults and persist with settings', () => {
  assert.match(html, /id="model-display-name"[\s\S]*maxlength="32"/);
  assert.match(html, /id="context-input-tokens"[\s\S]*value="1140000"/);
  assert.match(html, /id="context-output-tokens"[\s\S]*value="16000"/);
  assert.match(html, /id="tool-call-rounds"[\s\S]*value="500"/);
  assert.match(source, /model_display_name: modelDisplayNameInput\.value\.trim\(\)/);
  assert.match(source, /context_input_tokens: positiveIntegerValue\(contextInputTokensInput, 1140000\)/);
  assert.match(source, /context_output_tokens: positiveIntegerValue\(contextOutputTokensInput, 16000\)/);
  assert.match(source, /tool_call_rounds: positiveIntegerValue\(toolCallRoundsInput, 500\)/);
});

test('model management provides a real add edit activate and delete workflow', () => {
  for (const id of [
    'btn-add-ai-model',
    'ai-model-list',
    'ai-model-empty',
    'ai-model-status',
    'ai-model-editor',
    'ai-model-editor-title',
    'btn-cancel-ai-model',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /模型管理/);
  assert.match(html, /<th>模型<\/th>[\s\S]*<th>服务商<\/th>[\s\S]*<th>状态<\/th>[\s\S]*操作/);
  assert.match(source, /invoke\('list_ai_models'\)/);
  assert.match(source, /invoke\('get_ai_model', \{ configId \}\)/);
  assert.match(source, /invoke\('save_ai_model', \{ settings \}\)/);
  assert.match(source, /invoke\('activate_ai_model', \{ configId \}\)/);
  assert.match(source, /invoke\('delete_ai_model', \{ configId \}\)/);
});

test('AI settings restore API application links and collapse the balance panel', () => {
  assert.match(html, /href="https:\/\/www\.sensenova\.cn\/"/);
  assert.match(html, /<option value="sensenova">SenseNova 免费 API（推荐）<\/option>/);
  assert.match(html, />申请免费 API Key<\/a/);
  assert.match(source, /const SENSENOVA_PRESET = \{[\s\S]*token\.sensenova\.cn\/v1/);
  assert.match(source, /href: 'https:\/\/platform\.deepseek\.com\/api_keys'/);
  assert.match(source, /function providerStorageId[\s\S]*provider === 'sensenova' \? 'deepseek'/);
  assert.match(source, /function displayProviderId[\s\S]*isSenseNovaUrl/);

  const balanceCardIndex = html.indexOf('id="deepseek-balance-card"');
  const balanceCardEnd = html.indexOf('</details>', balanceCardIndex);
  const balanceMarkup = html.slice(balanceCardIndex, balanceCardEnd);
  assert.match(balanceMarkup, /settings-card-disclosure/);
  assert.doesNotMatch(balanceMarkup, /<details[^>]*\sopen(?:\s|>)/);
  assert.match(balanceMarkup, /id="btn-refresh-balance"/);
});

test('test and save actions stay next to the required API Key', () => {
  const apiCardStart = html.lastIndexOf('<div class="settings-card">', html.indexOf('id="api-key"'));
  const apiCardEnd = html.indexOf('</div>\n                        </div>', html.indexOf('id="btn-save-settings"'));
  const apiCardMarkup = html.slice(apiCardStart, apiCardEnd);

  assert.match(apiCardMarkup, /id="btn-test"/);
  assert.match(apiCardMarkup, /id="btn-save-settings"/);
  assert.equal(html.match(/id="btn-save-settings"/g)?.length, 1);
  assert.match(source, /function supportsDeepSeekBalance[\s\S]*api\\\.deepseek\\\.com/);
  assert.match(source, /function selectApiConfigMode\(mode\)/);
  assert.match(source, /btnApiModeProvider\?\.addEventListener\('click'/);
  assert.match(source, /modelPresetSelect\?\.addEventListener\('change'/);
  assert.match(source, /customModelInput\?\.addEventListener\('input'/);
});
