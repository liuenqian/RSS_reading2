import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('selected paper list can collapse without pushing chat controls out of view', () => {
  const picker = html.indexOf('class="detail-paper-chat-picker"');
  const pickedList = html.indexOf('id="paper-chat-picked-list"');
  const messages = html.indexOf('id="detail-paper-chat-messages"');
  const composer = html.indexOf('class="detail-paper-chat-composer"');

  assert.ok(picker < pickedList);
  assert.ok(pickedList < messages);
  assert.ok(messages < composer);
  assert.match(html, /id="btn-toggle-paper-chat-picked"[\s\S]*?aria-controls="paper-chat-picked-list"[\s\S]*?aria-expanded="true"/);
  assert.match(styles, /\.detail-paper-chat-picker\s*\{[^}]*max-height:\s*min\(38vh, 360px\);[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.paper-chat-picked-list\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s);
  assert.match(styles, /\.paper-chat-picked-list\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(styles, /\.paper-chat-panel \.detail-paper-chat-messages\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
  assert.match(main, /PAPER_CHAT_PICKED_COLLAPSED_STORAGE_KEY = 'paper-chat-picked-collapsed-v1'/);
  assert.match(main, /function setPaperChatPickedCollapsed\(collapsed, \{ persist = true \} = \{\}\)/);
  assert.match(main, /paperChatPickedList\?\.toggleAttribute\('hidden', paperChatPickedCollapsed\)/);
  assert.match(main, /btnPaperChatTogglePicked\?\.addEventListener\('click', \(\) => \{\s*setPaperChatPickedCollapsed\(!paperChatPickedCollapsed\);/s);
});
