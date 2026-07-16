import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('unread titles are gray and read titles are black across literature lists', () => {
  assert.match(styles, /\.entry-item\.unread \.entry-title\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*font-weight:\s*400/s);
  assert.match(styles, /\.entry-item\.read \.entry-title\s*\{[^}]*color:\s*var\(--text-primary\)[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.pubmed-entry-item\.unread \.pubmed-entry-title\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*font-weight:\s*400/s);
  assert.match(styles, /\.pubmed-entry-item\.read \.pubmed-entry-title\s*\{[^}]*color:\s*var\(--text-primary\)[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.briefing-title\s*\{[^}]*font-weight:\s*400[^}]*color:\s*var\(--text-secondary\)/s);
  assert.match(styles, /\.briefing-item\.read \.briefing-title\s*\{[^}]*color:\s*var\(--text-primary\)[^}]*font-weight:\s*600/s);
});
