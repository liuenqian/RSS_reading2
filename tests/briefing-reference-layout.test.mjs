import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeBriefingReferencesMarkdown } from '../src/briefing_references.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const service = await readFile(new URL('../src-tauri/src/services/briefing_service.rs', import.meta.url), 'utf8');

test('legacy briefing references become independent markdown list items', () => {
  const input = `## 参考文献
[1] [First paper](https://example.test/1) — Journal One
[2] [Second paper](https://example.test/2) — Journal Two`;
  assert.equal(
    normalizeBriefingReferencesMarkdown(input),
    `## 参考文献
- [1] [First paper](https://example.test/1) — Journal One
- [2] [Second paper](https://example.test/2) — Journal Two`,
  );
});

test('normalization does not rewrite numbered citations outside the reference section', () => {
  const input = `## 研究结果
[1] 这里是正文引用

## 参考文献
[1] [Paper](https://example.test/1) — Journal`;
  const output = normalizeBriefingReferencesMarkdown(input);
  assert.match(output, /## 研究结果\n\[1\] 这里是正文引用/);
  assert.match(output, /## 参考文献\n- \[1\] \[Paper\]/);
});

test('briefing renderer decorates references with aligned numbers and metadata', () => {
  assert.match(main, /decorateBriefingReferenceLists\(template\.content\)/);
  assert.match(main, /briefing-reference-number/);
  assert.match(main, /briefing-reference-title/);
  assert.match(main, /briefing-reference-meta/);
  assert.match(styles, /\.briefing-md \.briefing-reference-item[\s\S]*grid-template-columns: 2\.25em minmax\(0, 1fr\)/);
  assert.match(styles, /\.briefing-md \.briefing-reference-title[\s\S]*border-bottom: 0/);
});

test('new briefing prompts require one markdown list item per reference', () => {
  assert.match(main, /每条必须以 \\`- \[n\]\\` 开头/);
  assert.match(service, /每条必须以 `- \[n\]` 开头/);
  assert.match(service, /不要把多条参考文献写在同一段/);
});
