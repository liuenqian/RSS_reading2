import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const commands = await readFile(new URL('../src-tauri/src/commands/data_transfer_cmd.rs', import.meta.url), 'utf8');
const service = await readFile(new URL('../src-tauri/src/services/data_transfer_service.rs', import.meta.url), 'utf8');
const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

test('unified transfer menu exposes sanitized database export and overwrite import', () => {
  assert.match(main, /data-action="import-database"[\s\S]*导入迁移数据库/);
  assert.match(main, /data-action="export-database"[\s\S]*导出迁移数据库/);
  assert.match(main, /extensions: \['cento-db'\]/);
  assert.match(main, /invoke\('preview_transfer_database'/);
  assert.match(main, /备份并导入/);
  assert.match(main, /invoke\('import_transfer_database'/);
  assert.match(main, /invoke\('export_transfer_database'/);
});

test('backend export is sanitized and import keeps a recovery database', () => {
  assert.match(commands, /pub fn export_transfer_database/);
  assert.match(commands, /pub fn preview_transfer_database/);
  assert.match(commands, /pub fn import_transfer_database/);
  assert.match(service, /DELETE FROM settings[\s\S]*DELETE FROM cost_log[\s\S]*DELETE FROM entry_pdf_fulltexts/);
  assert.match(service, /cento\.pre-transfer-import-/);
  assert.match(service, /已自动恢复导入前数据库/);
  assert.match(lib, /data_transfer_cmd::export_transfer_database/);
  assert.match(lib, /data_transfer_cmd::preview_transfer_database/);
  assert.match(lib, /data_transfer_cmd::import_transfer_database/);
});
