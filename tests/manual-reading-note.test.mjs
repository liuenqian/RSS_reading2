import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const command = await readFile(new URL('../src-tauri/src/commands/reading_cmd.rs', import.meta.url), 'utf8');
const service = await readFile(new URL('../src-tauri/src/services/reading_service.rs', import.meta.url), 'utf8');
const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

test('article detail supports both selected-text annotations and manual notes', () => {
  assert.match(html, /id="manual-reading-note-input"/);
  assert.match(html, /id="btn-manual-reading-note"/);
  assert.match(html, /placeholder="写下自己的阅读笔记、疑问或后续想法"/);
  assert.match(main, /function installGlobalTextHighlightScope/);
  assert.match(main, /function globalReadableSelectionRoot/);
  assert.match(main, /function saveManualReadingNote/);
  assert.match(main, /invoke\('add_manual_reading_note'/);
  assert.match(main, /const entryId = currentEntry\.id/);
  assert.match(main, /loadReadingNotes\(entryId\)/);
  assert.match(main, /manualReadingNoteDrafts/);
  assert.match(main, /function isManualReadingNote/);
  assert.match(main, /isNonRegenerableReadingNote\(note\)/);
  assert.match(main, /暂无阅读笔记/);
  assert.match(styles, /\.manual-reading-note-composer/);
  assert.match(command, /pub fn add_manual_reading_note/);
  assert.match(service, /MANUAL_READING_NOTE_PROFILE_NAME/);
  assert.match(lib, /reading_cmd::add_manual_reading_note/);
});
