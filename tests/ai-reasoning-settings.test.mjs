import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function settingsHarness() {
  const context = {
    providerSelect: { value: 'openai_compatible' },
    reasoningEffortSelect: { value: '', disabled: false },
    editingAiModelId: null,
    lastPresetProvider: 'deepseek',
    SENSENOVA_PRESET: { baseUrl: 'https://example.com/v1', model: 'example-model' },
    updateModelDisplayNameCount() {},
    syncApiConfigMode() {},
    displayProviderId(settings) { return settings.provider; },
    showSettingsStatus() {},
    setAiModelEditorVisible() {},
  };
  for (const name of [
    'apiKeyInput', 'baseUrlInput', 'modelInput', 'modelDisplayNameInput',
    'contextInputTokensInput', 'contextOutputTokensInput', 'toolCallRoundsInput',
    'systemPromptInput', 'retentionSelect',
  ]) context[name] = { value: '' };
  vm.createContext(context);
  vm.runInContext(`
    function activeProviderId() { return providerSelect.value; }
    function providerStorageId() { return providerSelect.value; }
    function syncProviderUi() { syncReasoningEffortControls(); }
  `, context);
  for (const name of [
    'positiveIntegerValue', 'syncReasoningEffortControls', 'collectAiSettings',
    'applyProviderSettings', 'beginAddAiModel',
  ]) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing function ${name}`);
    const end = source.indexOf('\n}\n', start);
    vm.runInContext(source.slice(start, end + 2), context);
  }
  return context;
}

test('collects an explicit effort and keeps server default optional', () => {
  const context = settingsHarness();
  assert.equal(context.collectAiSettings().reasoning_effort, null);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    context.reasoningEffortSelect.value = effort;
    assert.equal(context.collectAiSettings().reasoning_effort, effort);
  }
  context.reasoningEffortSelect.value = '';
  assert.equal(context.collectAiSettings().reasoning_effort, null);
});

test('loading another model or a legacy model resets the effort', () => {
  const context = settingsHarness();
  context.applyProviderSettings({ provider: 'openai_compatible', reasoning_effort: 'high' });
  assert.equal(context.reasoningEffortSelect.value, 'high');
  context.applyProviderSettings({ provider: 'openai', reasoning_effort: 'low' });
  assert.equal(context.reasoningEffortSelect.value, 'low');
  context.applyProviderSettings({ provider: 'openai_compatible' });
  assert.equal(context.collectAiSettings().reasoning_effort, null);
});

test('unsupported providers clear and disable the effort control', () => {
  const context = settingsHarness();
  for (const provider of ['deepseek', 'sensenova', 'anthropic', 'gemini']) {
    context.providerSelect.value = provider;
    context.reasoningEffortSelect.value = 'high';
    context.syncReasoningEffortControls();
    assert.equal(context.reasoningEffortSelect.disabled, true);
    assert.equal(context.collectAiSettings().reasoning_effort, null);
  }
  context.providerSelect.value = 'openai_compatible';
  context.syncReasoningEffortControls();
  assert.equal(context.reasoningEffortSelect.disabled, false);
  assert.equal(context.collectAiSettings().reasoning_effort, null);
});

test('adding a model does not inherit the previous model effort', () => {
  const context = settingsHarness();
  context.reasoningEffortSelect.value = 'max';
  context.beginAddAiModel();
  assert.equal(context.reasoningEffortSelect.value, '');
  assert.equal(context.collectAiSettings().reasoning_effort, null);
});
