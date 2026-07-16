import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRetryableTranslationError,
  runConcurrentQueue,
} from '../src/translation_queue.js';

test('translation queue respects its concurrency limit and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, index) => index);

  const results = await runConcurrentQueue(items, async item => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, item % 3));
    active -= 1;
    return item * 2;
  }, { concurrency: 4 });

  assert.equal(peak, 4);
  assert.deepEqual(results.map(result => result.value), items.map(item => item * 2));
});

test('translation queue retries transient failures but not permanent errors', async () => {
  const attempts = new Map();
  const results = await runConcurrentQueue(['transient', 'permanent'], async item => {
    const attempt = (attempts.get(item) || 0) + 1;
    attempts.set(item, attempt);
    if (item === 'transient' && attempt < 3) throw new Error('API 错误 (429)');
    if (item === 'permanent') throw new Error('API Key 无效');
    return 'ok';
  }, { concurrency: 2, maxRetries: 2, retryDelayMs: 0 });

  assert.equal(results[0].ok, true);
  assert.equal(attempts.get('transient'), 3);
  assert.equal(results[1].ok, false);
  assert.equal(attempts.get('permanent'), 1);
});

test('retry detection covers rate limits and temporary request failures', () => {
  assert.equal(isRetryableTranslationError('DeepSeek API 错误 (429): busy'), true);
  assert.equal(isRetryableTranslationError('DeepSeek 请求失败: timeout'), true);
  assert.equal(isRetryableTranslationError('API Key 无效'), false);
});

test('translation queue records falsy thrown values as failures', async () => {
  const [result] = await runConcurrentQueue([1], async () => {
    throw null;
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, null);
});
