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
const managerSource = await readFile(new URL('../src/screening_workbook_manager.js', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

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

test('screening table migrates a legacy workbook into a managed workbook list', () => {
  const config = normalizeScreeningTableConfig({
    workbook: {
      path: '/Users/demo/Desktop/literature-screening.xlsx',
      articleCount: 24,
      lastExportedAt: '2026-08-10T08:00:00.000Z',
    },
  });
  assert.equal(config.workbooks.length, 1);
  assert.equal(config.workbooks[0].path, '/Users/demo/Desktop/literature-screening.xlsx');
  assert.equal(config.workbooks[0].articleCount, 24);
  assert.equal(config.workbooks[0].lastImportedAt, '');
  assert.equal(config.workbooks[0].name, 'literature-screening.xlsx');
  assert.equal(config.workbooks[0].managed, 'manual');
  assert.deepEqual(normalizeScreeningTableConfig({ workbook: { path: '   ' } }).workbooks, []);
});

test('screening table keeps distinct managed workbook paths only once', () => {
  const config = normalizeScreeningTableConfig({
    workbooks: [
      { id: 'first', path: '/tmp/one.xlsx' },
      { id: 'duplicate', path: '/tmp/one.xlsx' },
      { id: 'second', path: '/tmp/two.xlsx', articleCount: 3 },
    ],
  });
  assert.deepEqual(config.workbooks.map(workbook => workbook.id), ['first', 'second']);
  assert.equal(config.workbooks[1].articleCount, 3);
});

test('screening table preserves Cento-managed workbooks', () => {
  const config = normalizeScreeningTableConfig({
    workbooks: [{ id: 'cento-pubmed-2', path: '/tmp/pubmed-2-screening.xlsx', managed: 'cento' }],
  });
  assert.equal(config.workbooks[0].managed, 'cento');
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

test('screening table exposes the workbook manager entry point', () => {
  assert.match(viewSource, /打开 Excel/);
  assert.match(viewSource, /data-screening-action="open-workbook"/);
  assert.match(viewSource, /options\.onOpenWorkbook/);
  assert.match(viewSource, /同步 Excel/);
  assert.match(viewSource, /data-screening-action="sync-workbook"/);
  assert.match(viewSource, /options\.onSyncWorkbook/);
  assert.match(viewSource, /工作簿汇总/);
  assert.match(viewSource, /data-screening-action="manage-workbooks"/);
  assert.match(viewSource, /options\.onManageWorkbooks/);
});

test('standalone screening opens its full scope without inherited launch filters', () => {
  assert.doesNotMatch(mainSource, /standaloneScreeningLaunchFilters/);
  assert.doesNotMatch(mainSource, /screeningWindowLaunchKey/);
  assert.match(mainSource, /if \(!isStandaloneScreeningWorkspace\(\)\) \{/);
  assert.match(mainSource, /await invoke\('open_screening_window', scope\)/);
});

test('workbook manager exposes all project actions', () => {
  for (const action of ['create', 'import', 'table', 'open', 'sync', 'export', 'remove']) {
    assert.match(managerSource, new RegExp(`data-workbook-action=\\"${action}\\"`));
  }
  assert.match(managerSource, /data-workbook-target/);
  assert.match(managerSource, /screening-workbook-search/);
  assert.match(managerSource, /screening-workbook-list-heading/);
  assert.match(managerSource, /return-current/);
  assert.match(managerSource, /自动管理/);
});
