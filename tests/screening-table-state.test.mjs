import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  defaultScreeningTableConfig,
  normalizeScreeningTableConfig,
  reorderScreeningTableColumns,
  screeningScopeKey,
  toggleScreeningTableSort,
} from '../src/screening_table_state.js';
import { calculateScreeningTableWindow } from '../src/screening_table_window.js';
const viewSource = await readFile(new URL('../src/screening_table_view.js', import.meta.url), 'utf8');

test('screening table config keeps independent scope key and fills missing columns', () => {
  assert.equal(screeningScopeKey('pubmed', 4), 'pubmed:4');
  const config = normalizeScreeningTableConfig({ columns: [{ key: 'title', visible: false }] });
  assert.equal(config.columns.length, defaultScreeningTableConfig().columns.length);
  assert.equal(config.columns.find(column => column.key === 'title').visible, false);
  assert.ok(config.columns.some(column => column.key === 'titleTranslated'));
  assert.equal(config.columns.find(column => column.key === 'b').visible, true);
});

test('screening table clamps custom row height and column widths', () => {
  const config = normalizeScreeningTableConfig({
    rowHeight: 999,
    columns: [{ key: 'authors', width: 12 }],
  });
  assert.equal(config.rowHeight, 140);
  assert.equal(config.columns.find(column => column.key === 'authors').width, 48);
});

test('screening table sort toggles direction', () => {
  const config = defaultScreeningTableConfig();
  assert.deepEqual(toggleScreeningTableSort(config, 'journal').sorts, [{ field: 'journal', direction: 'desc' }]);
  assert.deepEqual(toggleScreeningTableSort({ ...config, sorts: [{ field: 'journal', direction: 'desc' }] }, 'journal').sorts, [{ field: 'journal', direction: 'asc' }]);
});

test('screening table columns can be reordered by key', () => {
  const config = normalizeScreeningTableConfig({
    columns: [
      { key: 'title' },
      { key: 'authors' },
      { key: 'journal' },
    ],
  });
  const reordered = reorderScreeningTableColumns(config, 'journal', 'title');
  assert.deepEqual(reordered.columns.slice(0, 3).map(column => column.key), ['journal', 'title', 'authors']);
  assert.equal(reorderScreeningTableColumns(config, 'missing', 'title'), config);
});

test('screening table window adds overscan and spacer heights', () => {
  assert.deepEqual(calculateScreeningTableWindow(1000, 420, 400, 42, 2), { first: 8, last: 22, top: 336, bottom: 41076 });
});

test('screening table spacer rows do not inherit the normal row height', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.screening-table tr\.screening-table-spacer,\s*\.screening-table tr\.screening-table-spacer td[\s\S]*?height: 0;[\s\S]*?padding: 0;[\s\S]*?border: 0;/);
});

test('screening table headers expose direct reorder and resize interactions', () => {
  assert.match(viewSource, /th\.draggable = true/);
  assert.match(viewSource, /data-column-resize/);
  assert.match(viewSource, /reorderScreeningTableColumns\(config, draggedHeaderKey, targetKey\)/);
  assert.match(viewSource, /options\.onConfigChange\?\.\(\{[\s\S]*width/);
});
