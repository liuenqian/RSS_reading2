import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('narrow entry list keeps reading filters legible and separates action rows', () => {
  assert.match(styles, /container-name:\s*entry-list/);
  assert.match(styles, /@container entry-list \(max-width: 640px\)/);
  assert.match(styles, /\.entry-reading-filter-section\s*\{[^}]*flex:\s*1 0 100%/s);
  assert.match(styles, /\.entry-list-header #entry-filter \.seg-btn\s*\{[^}]*white-space:\s*nowrap/s);
});
