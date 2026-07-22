import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('annotation center aggregates and filters saved reading marks', () => {
  assert.match(html, /data-view="annotations"/);
  assert.match(html, /id="count-annotations"/);
  assert.match(html, /id="annotation-library"/);
  assert.match(html, /id="annotation-library-search"/);
  assert.match(html, /id="annotation-library-source-filter"/);
  assert.match(html, /id="annotation-library-type-filter"/);
  assert.match(html, /id="annotation-library-color-filter"/);
  assert.match(html, /id="annotation-color-meaning-menu"/);
  assert.match(html, /id="annotation-color-meaning-rows"/);
  assert.match(html, /id="btn-save-color-meanings"/);
  assert.match(html, /id="annotation-new-color"/);
  assert.match(html, /id="btn-add-annotation-color"/);

  assert.match(main, /function collectReadingAnnotations/);
  assert.match(main, /function loadBriefingLibraryAnnotations/);
  assert.match(main, /invoke\('list_all_briefing_annotations'/);
  assert.match(main, /storageKind: 'briefing-db'/);
  assert.match(main, /data-annotation-storage/);
  assert.match(main, /function renderAnnotationLibrary/);
  assert.match(main, /function enterAnnotationMode/);
  assert.match(main, /function deleteReadingAnnotationFromLibrary/);
  assert.match(main, /function openReadingAnnotationSource/);
  assert.match(main, /READING_HIGHLIGHT_COLOR_MEANINGS_KEY/);
  assert.match(main, /READING_HIGHLIGHT_PALETTE_KEY/);
  assert.match(main, /function readReadingHighlightColorMeanings/);
  assert.match(main, /function saveReadingHighlightColorMeanings/);
  assert.match(main, /function readingHighlightColorDisplayName/);
  assert.match(main, /function renderAnnotationColorMeaningEditor/);
  assert.match(main, /function syncAnnotationLibraryColorFilterOptions/);
  assert.match(main, /function readReadingHighlightPalette/);
  assert.match(main, /usedCustomReadingHighlightColors/);
  assert.match(main, /function saveReadingHighlightPalette/);
  assert.match(main, /function addAnnotationCustomColor/);
  assert.match(main, /function wireAnnotationColorRowDrag/);
  assert.match(main, /data-color-move/);
  assert.match(main, /data-color-remove/);
  assert.match(main, /scopeId\.match\(\/\^\(entry\|briefing\):\(\\d\+\):\/u\)/);
  assert.match(main, /mode === 'annotations'/);

  assert.match(styles, /\.annotation-library/);
  assert.match(styles, /\.annotation-library-controls/);
  assert.match(styles, /\.annotation-library-group/);
  assert.match(styles, /\.annotation-library-card/);
  assert.match(styles, /\.annotation-color-meaning-panel/);
  assert.match(styles, /\.annotation-library-color-meaning/);
  assert.match(styles, /\.annotation-color-add-row/);
  assert.match(styles, /\.annotation-color-drag-handle/);
});
