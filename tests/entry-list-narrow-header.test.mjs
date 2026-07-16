import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('narrow entry list keeps filters on the first row and sorting on the second row', () => {
  assert.match(styles, /container-name:\s*entry-list/);
  assert.match(styles, /@container entry-list \(max-width: 640px\)/);
  assert.match(styles, /@container entry-list \(max-width: 640px\)[\s\S]*\.entry-header-top\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(styles, /@container entry-list \(max-width: 640px\)[\s\S]*\.entry-reading-filter-section\s*\{[^}]*flex:\s*1 1 0/s);
  assert.match(styles, /\.entry-sort-row\s*\{[^}]*width:\s*100%/s);
  assert.match(styles, /\.entry-metric-filter-section:not\(\[open\]\)[^}]*>[^{]*\.compact-filter-summary\s*\{[^}]*width:\s*fit-content/s);
  assert.match(styles, /\.entry-sort-control\s*\{[^}]*width:\s*min\(100%, 184px\)/s);
  assert.match(styles, /\.entry-sort-control select\s*\{[^}]*appearance:\s*none/s);
  assert.match(styles, /\.entry-list-header #entry-filter \.seg-btn\s*\{[^}]*white-space:\s*nowrap/s);
});
