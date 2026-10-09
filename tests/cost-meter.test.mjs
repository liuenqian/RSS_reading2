import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function costHarness(summary = null) {
  const elements = Object.fromEntries([
    'cost-value', 'cost-chars', 'cost-fill', 'cost-model', 'cost-meter',
  ].map(id => [id, { textContent: '', title: '', style: {} }]));
  const context = {
    currentCostSummary: summary,
    costSummaryLoadFailed: false,
    document: { getElementById: id => elements[id] },
    AI_PROVIDER_META: {
      deepseek: { label: 'DeepSeek' },
      google_web: { label: 'Google' },
      openai_compatible: { label: '自定义 API' },
    },
    activeProviderId: () => 'openai_compatible',
    activeModelDisplayName: () => 'custom-model',
    console: { warn() {} },
    async invoke(command) {
      assert.equal(command, 'get_cost_summary');
      return summary;
    },
    window: { __TAURI__: { event: {
      listen(name, listener) {
        assert.equal(name, 'cost-updated');
        context.costListener = listener;
      },
    } } },
  };
  vm.createContext(context);
  for (const name of ['formatCny', 'updateCostMeter', 'loadCostSummary', 'setupCostEvents']) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `missing function ${name}`);
    const end = source.indexOf('\n}\n', start);
    const asyncStart = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
    vm.runInContext(source.slice(asyncStart, end + 2), context);
  }
  return { context, elements };
}

function usageRow(provider, model, miss, output, cny) {
  return {
    provider, model,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: miss,
    completion_tokens: output,
    cny,
  };
}

test('loading is distinct from a missing model price', () => {
  const { context, elements } = costHarness();
  context.updateCostMeter();
  assert.equal(elements['cost-value'].textContent, '加载中…');
  assert.equal(elements['cost-chars'].textContent, '— tokens');
  assert.match(elements['cost-meter'].title, /正在加载/);
});

test('Google-only usage displays zero API cost', () => {
  const { context, elements } = costHarness({ total_cny: 0, breakdown: [
    usageRow('google_web', 'Google Translate', 0, 0, 0),
  ] });
  context.updateCostMeter();
  assert.equal(elements['cost-value'].textContent, '¥ 0.00');
  assert.equal(elements['cost-chars'].textContent, '0 tokens');
  assert.doesNotMatch(elements['cost-meter'].title, /缺少/);
});

test('unknown prices explain why a total is unavailable without losing usage', () => {
  const { context, elements } = costHarness({ total_cny: null, breakdown: [
    usageRow('google_web', 'Google Translate', 0, 0, 0),
    usageRow('openai_compatible', 'custom-model', 112781, 36982, null),
  ] });
  context.updateCostMeter();
  assert.equal(elements['cost-value'].textContent, '缺少价格');
  assert.equal(elements['cost-chars'].textContent, `${(149763).toLocaleString()} tokens`);
  assert.equal(elements['cost-fill'].style.width, '0%');
  assert.match(elements['cost-meter'].title, /custom-model.*缺少该服务的模型价格/);
  assert.match(elements['cost-meter'].title, /不代表未扣费.*服务商账单/);
});

test('a known subtotal is never presented as the complete monthly total', () => {
  const { context, elements } = costHarness({ total_cny: null, breakdown: [
    usageRow('deepseek', 'deepseek-chat', 1000, 500, 0.006),
    usageRow('openai_compatible', 'custom-model', 100, 100, null),
  ] });
  context.updateCostMeter();
  assert.equal(elements['cost-value'].textContent, '缺少价格');
  assert.match(elements['cost-meter'].title, /¥ 0\.0060/);
  assert.match(elements['cost-meter'].title, /无法计算本月总额/);
});

test('known cost keeps its amount and progress bar', () => {
  const { context, elements } = costHarness({ total_cny: 10, breakdown: [
    usageRow('deepseek', 'deepseek-chat', 1000, 500, 10),
  ] });
  context.updateCostMeter();
  assert.equal(elements['cost-value'].textContent, '¥ 10.00');
  assert.equal(elements['cost-fill'].style.width, '50%');
});

test('a failed initial load is visible and a successful retry clears it', async () => {
  const { context, elements } = costHarness();
  context.invoke = async () => { throw new Error('database unavailable'); };
  await context.loadCostSummary();
  assert.equal(elements['cost-value'].textContent, '加载失败');
  assert.match(elements['cost-meter'].title, /加载失败/);

  context.invoke = async () => ({ total_cny: 0, breakdown: [] });
  await context.loadCostSummary();
  assert.equal(context.costSummaryLoadFailed, false);
  assert.equal(elements['cost-value'].textContent, '¥ 0.00');
  assert.equal(elements['cost-meter'].title, '本月暂无 AI 用量');
});

test('a failed refresh retains previous usage and marks it as stale', async () => {
  const { context, elements } = costHarness({ total_cny: 0, breakdown: [] });
  context.invoke = async () => { throw new Error('database unavailable'); };
  await context.loadCostSummary();
  assert.equal(elements['cost-value'].textContent, '¥ 0.00');
  assert.match(elements['cost-meter'].title, /刷新失败.*上次统计/);

  context.setupCostEvents();
  context.costListener({ payload: { total_cny: 1, breakdown: [] } });
  assert.equal(context.costSummaryLoadFailed, false);
  assert.equal(elements['cost-value'].textContent, '¥ 1.00');
  assert.doesNotMatch(elements['cost-meter'].title, /刷新失败/);
});
