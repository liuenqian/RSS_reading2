import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const models = await readFile(new URL('../src-tauri/src/models.rs', import.meta.url), 'utf8');
const service = await readFile(new URL('../src-tauri/src/services/briefing_service.rs', import.meta.url), 'utf8');
const commands = await readFile(new URL('../src-tauri/src/commands/briefing_cmd.rs', import.meta.url), 'utf8');
const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const db = await readFile(new URL('../src-tauri/src/db.rs', import.meta.url), 'utf8');
const migrations = await readFile(new URL('../src-tauri/src/db_migrations.rs', import.meta.url), 'utf8');

test('briefings support manual notes and persistent highlights', () => {
  assert.match(html, /id="briefing-note-input"/);
  assert.match(html, /id="btn-briefing-save-note"/);
  assert.doesNotMatch(html, /id="btn-briefing-highlight"/);
  assert.doesNotMatch(html, /data-briefing-highlight-color=/);
  assert.match(html, /id="briefing-annotations-list"/);

  assert.match(main, /function buildBriefingSelectionAnchor/);
  assert.match(main, /function saveBriefingSelectionAnnotation/);
  assert.match(main, /briefingScopeIdFromHighlightScope/);
  assert.match(main, /kind: 'highlight'/);
  assert.match(main, /startChar/);
  assert.match(main, /invoke\('add_briefing_annotation'/);
  assert.match(main, /invoke\('list_briefing_annotations'/);
  assert.match(main, /invoke\('list_all_briefing_annotations'/);
  assert.match(main, /createReadingHighlightMark/);
  assert.match(main, /briefingAnnotationId/);
  assert.match(main, /:not\(\[data-briefing-annotation-id\]\)/);
  assert.match(main, /renderSelectedBriefingBody/);
  assert.match(main, /applyBriefingHighlights/);

  assert.match(styles, /\.briefing-highlight-yellow/);
  assert.match(styles, /\.briefing-note-composer/);
  assert.match(styles, /\.briefing-annotation-card/);

  assert.match(models, /pub struct BriefingAnnotation/);
  assert.match(service, /pub fn add_briefing_annotation/);
  assert.match(commands, /pub fn update_briefing_annotation/);
  assert.match(commands, /pub fn list_all_briefing_annotations/);
  assert.match(lib, /briefing_cmd::delete_briefing_annotation/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS briefing_annotations/);
  assert.match(migrations, /ensure_briefing_annotation_table/);
  assert.match(migrations, /const PUBMED_SCHEMA_VERSION: i64 = 15/);
  assert.match(migrations, /ensure_briefing_annotation_color_schema/);
  assert.match(service, /value\.starts_with\('#'\)/);
});
