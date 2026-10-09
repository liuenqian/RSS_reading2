import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

function loadFunctions(context, names) {
  vm.createContext(context);
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing function ${name}`);
    const end = source.indexOf('\n}\n', start);
    const asyncStart = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
    vm.runInContext(source.slice(asyncStart, end + 2), context);
  }
  return context;
}

function routeHarness(route = {}) {
  const context = {
    GOOGLE_WEB_TRANSLATION_MODEL_ID: '__google_web__',
    aiModels: [],
    translationPrimaryAiModel: { value: '' },
    googleWebTranslationEnabled: { checked: false },
    translationRouteOrder: { value: 'ai-first', disabled: true },
    btnSaveTranslationRoute: { disabled: false },
    route,
    status: '',
    renderTranslationPrimaryModelOptions(id) { context.translationPrimaryAiModel.value = id; },
    setTranslationRouteStatus(message) { context.status = message; },
    async invoke(command, args) {
      if (command === 'get_translation_route_settings') return context.route;
      assert.equal(command, 'save_translation_route_settings');
      context.route = args.settings;
      return context.route;
    },
  };
  return loadFunctions(context, [
    'translationPrimaryServiceLabel', 'describeTranslationRoute', 'translationRouteOrderValue',
    'syncTranslationPrimarySelection', 'syncTranslationRouteControls',
    'loadTranslationRouteSettings', 'saveTranslationRouteSettings',
  ]);
}

test('Google-only mode is selectable and survives saving and reloading', async () => {
  assert.match(html, /value="google-only">仅用 Google，失败就提示/);
  const context = routeHarness();
  context.googleWebTranslationEnabled.checked = true;
  context.translationRouteOrder.value = 'google-only';
  await context.saveTranslationRouteSettings();
  assert.equal(context.route.googleWebOnly, true);
  assert.equal(context.route.googleWebEnabled, true);
  assert.equal(context.route.googleWebFirst, true);
  assert.match(context.status, /不会调用 AI API/);
  assert.equal(context.btnSaveTranslationRoute.disabled, false);

  context.translationRouteOrder.value = 'ai-first';
  await context.loadTranslationRouteSettings();
  assert.equal(context.translationRouteOrder.value, 'google-only');
  assert.equal(context.translationRouteOrder.disabled, false);
});

test('selecting Google as primary preserves an explicit Google-only policy', () => {
  const context = routeHarness();
  context.translationRouteOrder.value = 'google-only';
  context.translationPrimaryAiModel.value = '__google_web__';
  context.syncTranslationPrimarySelection();
  assert.equal(context.googleWebTranslationEnabled.checked, true);
  assert.equal(context.translationRouteOrder.value, 'google-only');
});

test('legacy settings keep the existing Google-first fallback mode', async () => {
  const context = routeHarness({ googleWebEnabled: true, googleWebFirst: true });
  await context.loadTranslationRouteSettings();
  assert.equal(context.translationRouteOrder.value, 'google-first');
  assert.match(context.status, /失败后使用/);
});

test('switching to an allowed fallback policy or disabling Google clears Google-only', async () => {
  const context = routeHarness({ googleWebEnabled: true, googleWebFirst: true, googleWebOnly: true });
  await context.loadTranslationRouteSettings();
  context.translationRouteOrder.value = 'google-first';
  await context.saveTranslationRouteSettings();
  assert.equal(context.route.googleWebOnly, false);

  context.translationRouteOrder.value = 'google-only';
  context.googleWebTranslationEnabled.checked = false;
  await context.saveTranslationRouteSettings();
  assert.equal(context.route.googleWebOnly, false);
  assert.equal(context.route.googleWebEnabled, false);
  assert.equal(context.translationRouteOrder.disabled, true);
});

test('batch translation shows the Google failure reason and confirms no AI API call', async () => {
  const failure = '仅用 Google 模式：Google 请求失败 (429)；未调用 AI API';
  const messages = [];
  const context = loadFunctions({
    DEFAULT_TRANSLATION_CONCURRENCY: 5,
    setGlobalStatus(message, type) { messages.push({ message, type }); },
    async invoke() { throw failure; },
    async runConcurrentQueue(items, task, { onSettled }) {
      for (const item of items) {
        try { onSettled({ ok: true, item, value: await task(item) }); }
        catch (error) { onSettled({ ok: false, item, error }); }
      }
    },
  }, ['entryNeedsTitleTranslation', 'entryNeedsSummaryTranslation', 'translateEntries']);
  await context.translateEntries([{ id: 1, title: 'Example paper' }], 'title');
  assert.equal(messages.at(-1).type, 'error');
  assert.ok(messages.at(-1).message.includes(failure));
  assert.match(messages.at(-1).message, /失败 1 篇/);
});
