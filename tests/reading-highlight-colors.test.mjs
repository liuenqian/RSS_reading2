import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('reading text surfaces share the color highlight picker', () => {
  assert.match(main, /READING_HIGHLIGHT_COLORS/);
  assert.match(main, /READING_ANNOTATION_TOOLS/);
  assert.match(main, /setupReadingHighlighter\(\)/);
  assert.match(main, /function trimReadingSelectionRange/);
  assert.match(main, /selection\.addRange\(range\.cloneRange\(\)\)/);
  assert.match(main, /type="color"/);
  assert.match(main, /function parseReadingHighlightHexColor/);
  assert.match(main, /data-highlight-hex-input/);
  assert.match(main, /data-highlight-hex-apply/);
  assert.match(main, /function applyReadingHighlightHexInput/);
  assert.match(main, /readingHighlightPopover\?\.contains\(elementFromNode\(event\.target\)\)/);
  for (const tool of ['highlight', 'underline', 'note', 'box', 'pen']) {
    assert.match(main, new RegExp(`data-highlight-tool="\\$\\{tool\\.id\\}"`));
    assert.match(main, new RegExp(`reading-annotation-tool-\\$\\{tool\\.id\\}`));
  }
  assert.match(main, /READING_SELECT_TEXT_CLASS/);
  assert.match(main, /wrapReadingSelectableText\(root\)/);
  assert.match(main, /unwrapReadingSelectableText\(root\)/);
  assert.match(main, /detailSummaryHighlightScope\(entry, 'zh'\)/);
  assert.match(main, /detailSummaryHighlightScope\(entry, 'en'\)/);
  assert.match(main, /entry:\$\{currentEntry\?\.id \|\| 'unknown'\}:note:/);
  assert.match(main, /paper-chat:\$\{getPaperChatRequestSignature\(\)\}:message:/);
  assert.match(main, /briefing:\$\{briefing\.id\}:content/);
  assert.match(main, /briefing:\$\{b\.id\}:lead-in/);
  assert.match(main, /function installGlobalTextHighlightScope/);
  assert.match(main, /function globalReadableSelectionRoot/);
  assert.match(main, /function showReadingHighlightPopoverForMark/);
  assert.match(main, /function deletePendingReadingHighlight/);
  assert.match(main, /function openPendingReadingNoteEditor/);
  assert.match(main, /function savePendingReadingNote/);
  assert.match(main, /function ensureReadingHighlightMeaningTooltip/);
  assert.match(main, /function showReadingHighlightMeaningTooltip/);
  assert.match(main, /function hideReadingHighlightMeaningTooltip/);
  assert.match(main, /function positionReadingHighlightMeaningTooltip/);
  assert.match(main, /readingHighlightColorMeaning\(color\)/);
  assert.match(main, /relatedMark\?\.dataset\.highlightId === mark\.dataset\.highlightId/);
  assert.match(main, /data-reading-note-input/);
  assert.doesNotMatch(main, /window\.prompt\('给这段文字添加备注'/);
  assert.match(main, /data-delete-reading-highlight/);
  assert.match(main, /record\?\.id !== highlightId/);
  assert.match(main, /\[data-window-drag-region\], \.toolbar, \.sidebar, \.entry-list, \.briefing-list/);
  assert.doesNotMatch(main, /function installRenderedEntryItemHighlightScopes/);
  assert.match(main, /entry:\$\{entry\.id\}:detail-title:/);
  assert.doesNotMatch(main, /briefing:\$\{b\.id\}:list-title/);
});

test('highlight colors render in all annotation UIs', () => {
  assert.match(styles, /\.reading-highlight-popover/);
  assert.match(styles, /\.reading-highlight-scope::selection/);
  assert.match(styles, /\.reading-highlight-yellow/);
  assert.match(styles, /\.reading-highlight-purple/);
  assert.match(styles, /\.reading-annotation-tools/);
  assert.match(styles, /\.reading-annotation-highlight/);
  assert.match(styles, /\.reading-annotation-underline/);
  assert.match(styles, /\.reading-annotation-note/);
  assert.match(styles, /\.reading-annotation-box/);
  assert.match(styles, /\.reading-annotation-pen/);
  assert.match(styles, /\.reading-highlight-scope \*::selection/);
  assert.match(styles, /\.reading-highlight-scope \.reading-select-text::selection/);
  assert.match(styles, /\.reading-highlight-popover\.is-managing-existing \.reading-highlight-delete/);
  assert.match(styles, /\.reading-highlight-popover\.is-adding-note \.reading-highlight-note-editor/);
  assert.match(styles, /\.briefing-highlight/);
  assert.match(styles, /\.reading-highlight-meaning-tooltip/);
  assert.match(styles, /\.reading-highlight-tooltip-swatch/);
  assert.match(styles, /\.reading-highlight-hex-input/);
  assert.match(styles, /\.annotation-color-add-hex/);
});
