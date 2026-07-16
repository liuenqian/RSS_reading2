import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');

test('API token profiles can be managed in settings and switched from the toolbar', () => {
  assert.match(html, /id="api-token-profile"/);
  assert.match(html, /id="api-token-profile-name"/);
  assert.match(html, /id="btn-new-api-token"/);
  assert.match(html, /id="btn-delete-api-token"/);
  assert.match(html, /id="toolbar-api-token"/);

  assert.match(source, /invoke\('list_api_token_profiles'/);
  assert.match(source, /invoke\('upsert_api_token_profile'/);
  assert.match(source, /invoke\('activate_api_token_profile'/);
  assert.match(source, /invoke\('delete_api_token_profile'/);
});

test('quick switching resumes queued work and only occupies the toolbar when useful', () => {
  const start = source.indexOf('async function activateApiTokenProfile');
  const end = source.indexOf('\nfunction ', start + 10);
  const activate = source.slice(start, end > start ? end : undefined);

  assert.match(activate, /start_translation_pipeline/);
  assert.match(source, /profiles\.length < 2/);
});
