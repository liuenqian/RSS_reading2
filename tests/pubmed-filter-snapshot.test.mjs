import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('PubMed filter snapshots use an in-app naming dialog and persist entry ids', () => {
  assert.match(main, /async function saveCurrentPubmedSnapshot\(\)/);
  assert.match(main, /await textInputDialog\('快照名称'/);
  assert.doesNotMatch(main, /window\.prompt\('快照名称'/);
  assert.match(main, /entryIds:\s*entries\.map\(entry => entry\.id\)/);
  assert.match(main, /localStorage\.setItem\(PUBMED_SNAPSHOT_STORAGE_KEY/);
  assert.match(main, /snapshotIds\.has\(entry\.id\)/);
  assert.match(main, /btnSavePubmedSnapshot\?\.addEventListener\('click', saveCurrentPubmedSnapshot\)/);
  assert.match(styles, /\.text-input-dialog-input/);
});
