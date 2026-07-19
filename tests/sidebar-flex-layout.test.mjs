import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('PubMed and RSS sections share the available sidebar height', () => {
  assert.match(html, /class="sidebar-source-sections"/);
  assert.match(html, /data-sidebar-source-section="pubmed"/);
  assert.match(html, /data-sidebar-source-section="feeds"/);
  assert.match(styles, /\.sidebar-source-sections\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;/);
  assert.match(styles, /\.sidebar-source-section\s*\{[\s\S]*?flex:\s*1 1 0;/);
  assert.match(styles, /\.sidebar-source-section\.is-collapsed\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(main, /closest\('\.sidebar-source-section'\)\?\.classList\.toggle\('is-collapsed', collapsed\)/);
});

test('monthly AI usage remains the final fixed sidebar block', () => {
  const sourceSections = html.indexOf('class="sidebar-source-sections"');
  const globalStatus = html.indexOf('id="global-status"');
  const aiTools = html.indexOf('id="sidebar-ai-tools"');

  assert.ok(sourceSections < globalStatus);
  assert.ok(globalStatus < aiTools);
  assert.match(styles, /\.sidebar-ai-tools\s*\{[\s\S]*?margin:\s*auto 10px 10px;/);
});
