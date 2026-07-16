const TRANSIENT_ERROR_PATTERN = /(?:\b(?:408|409|429|500|502|503|504)\b|timeout|timed out|请求失败|连接失败|network|暂时不可用|rate.?limit)/i;

export const DEFAULT_TRANSLATION_CONCURRENCY = 5;

export function isRetryableTranslationError(error) {
  return TRANSIENT_ERROR_PATTERN.test(String(error || ''));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Run independent translation requests with bounded concurrency and retries. */
export async function runConcurrentQueue(items, worker, options = {}) {
  const concurrency = Math.max(1, Math.min(
    Number(options.concurrency) || DEFAULT_TRANSLATION_CONCURRENCY,
    items.length || 1,
  ));
  const maxRetries = Math.max(0, Number(options.maxRetries) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      const item = items[index];
      options.onStart?.(item, index, items.length);
      let succeeded = false;
      let error = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const value = await worker(item, index);
          results[index] = { item, index, ok: true, value };
          succeeded = true;
          break;
        } catch (caught) {
          error = caught;
          if (attempt >= maxRetries || !isRetryableTranslationError(caught)) break;
          await wait(retryDelayMs * (2 ** attempt));
        }
      }
      if (!succeeded) results[index] = { item, index, ok: false, error };
      options.onSettled?.(results[index]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runWorker));
  return results;
}
