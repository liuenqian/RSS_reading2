import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const fetchCommands = await readFile(new URL('../src-tauri/src/commands/fetch_cmd.rs', import.meta.url), 'utf8');
const scheduler = await readFile(new URL('../src-tauri/src/services/scheduler.rs', import.meta.url), 'utf8');
const app = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const pubmedCommands = await readFile(new URL('../src-tauri/src/commands/pubmed_search_cmd.rs', import.meta.url), 'utf8');
const conversionCommands = await readFile(new URL('../src-tauri/src/commands/pubmed_conversion_cmd.rs', import.meta.url), 'utf8');
const services = await readFile(new URL('../src-tauri/src/services/mod.rs', import.meta.url), 'utf8');

test('translation only runs after explicit user actions', () => {
  assert.doesNotMatch(main, /start_translation_pipeline/);
  assert.doesNotMatch(fetchCommands, /translation_pipeline::spawn|start_translation_pipeline/);
  assert.doesNotMatch(scheduler, /translation_pipeline::spawn/);
  assert.doesNotMatch(pubmedCommands, /translation_pipeline::spawn/);
  assert.doesNotMatch(conversionCommands, /translation_pipeline::spawn/);
  assert.doesNotMatch(services, /pub mod translation_pipeline/);
  assert.doesNotMatch(app, /fetch_cmd::start_translation_pipeline/);
  assert.match(main, /translateEntries\(targetEntries, 'title'\)/);
  assert.match(main, /translateEntries\(targetEntries, 'summary'\)/);
  assert.match(app, /translate_cmd::translate_entry_title/);
  assert.match(app, /translate_cmd::translate_entry_summary/);
});

test('visible translation copy describes on-demand behavior', () => {
  assert.match(html, /配置按需翻译（可选）/);
  assert.match(html, /不会在抓取后自动消耗 token/);
  assert.doesNotMatch(html, /标题、摘要会被自动翻译为中文/);
});
