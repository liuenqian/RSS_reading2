import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shortJournalDisplayName } from '../src/journal_name.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('shows only the primary journal name', () => {
  assert.equal(
    shortJournalDisplayName('Phytomedicine : international journal of phytotherapy and phytopharmacology'),
    'Phytomedicine',
  );
  assert.equal(shortJournalDisplayName('CA: a cancer journal for clinicians'), 'CA');
  assert.equal(shortJournalDisplayName('Russian chemical bulletin = Izvestiia Akademii nauk'), 'Russian chemical bulletin');
  assert.equal(shortJournalDisplayName('Nature Medicine'), 'Nature Medicine');
  assert.equal(shortJournalDisplayName(null), '');
});

test('uses the short journal name across visible article surfaces', () => {
  assert.match(source, /shortJournalDisplayName\(entry\.journal\)/);
  assert.match(source, /shortJournalDisplayName\(journalName\(entry\)\)/);
  assert.match(source, /shortJournalDisplayName\(entry\.journal \|\| journalName\(entry\)\)/);
});
