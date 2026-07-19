import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const entryCommands = await readFile(new URL('../src-tauri/src/commands/entry_cmd.rs', import.meta.url), 'utf8');
const entryService = await readFile(new URL('../src-tauri/src/services/entry_service.rs', import.meta.url), 'utf8');

test('word cloud defaults to local English frequency analysis', () => {
  assert.match(html, /id="btn-word-frequency"/);
  assert.match(html, /data-word-frequency-language="en">英文/);
  assert.match(main, /let wordFrequencyLanguage = 'en'/);
  assert.match(main, /wordFrequencyLanguage = 'en';[\s\S]*invoke\('analyze_word_frequency'/);
  assert.match(entryService, /english_word_frequency_terms/);
  assert.match(entryService, /entry_pdf_fulltexts/);
  assert.match(entryService, /reading_notes/);
});

test('keyword translation only runs after the explicit translate action', () => {
  const openStart = main.indexOf('async function openWordFrequencyModal');
  const openEnd = main.indexOf('\nfunction closeWordFrequencyModal', openStart);
  const openFunction = main.slice(openStart, openEnd);
  const translateStart = main.indexOf('async function translateWordFrequencyTerms');
  const translateEnd = main.indexOf('\nfunction searchWordFrequencyTerm', translateStart);
  const translateFunction = main.slice(translateStart, translateEnd);

  assert.doesNotMatch(openFunction, /translate_word_frequency_terms/);
  assert.match(translateFunction, /invoke\('translate_word_frequency_terms'/);
  assert.match(main, /btn-translate-word-frequency'[\s\S]*translateWordFrequencyTerms/);
  assert.match(entryCommands, /pub async fn translate_word_frequency_terms/);
});

test('translated terms are cached and can switch back to English', () => {
  assert.match(main, /WORD_FREQUENCY_TRANSLATION_CACHE_KEY/);
  assert.match(main, /persistWordFrequencyTranslations\(\)/);
  assert.match(html, /data-word-frequency-language="zh" disabled>中文/);
  assert.match(main, /setWordFrequencyLanguage/);
  assert.match(main, /data-word-frequency-term/);
});
