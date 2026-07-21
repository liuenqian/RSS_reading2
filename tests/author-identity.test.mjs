import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assessAuthorFingerprintStability,
  buildAuthorFingerprint,
  buildAuthorIdentityClusters,
  getAuthorNodeCandidates,
  recommendAuthorSeedCandidates,
  scoreAuthorCandidate,
} from '../src/author_identity.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

const entries = [
  { id: 1, authors: 'Ji Jiansong, Zhang Wei, Li Ming', affiliation: 'Department of Radiology, Lishui Central Hospital', title: 'MRI assessment of liver tumors' },
  { id: 2, authors: 'Ji Jiansong, Zhang Wei, Chen Yu', affiliation: 'Radiology Department, Central Hospital of Lishui City', title: 'Imaging biomarkers in liver cancer' },
  { id: 3, authors: 'Ji Jiansong, Zhang Wei, Wang Lei', affiliation: 'The Fifth Affiliated Hospital of Wenzhou Medical University', title: 'MRI imaging of hepatic tumors' },
  { id: 4, authors: 'Ji Jiansong, Smith John', affiliation: 'Department of Computer Science, Stanford University', title: 'Distributed database scheduling' },
];

test('builds an author fingerprint from known seed papers', () => {
  const fingerprint = buildAuthorFingerprint(entries, [1, 2], 'Ji Jiansong');
  assert.deepEqual(fingerprint.anchors, ['ji jiansong']);
  assert.ok(fingerprint.coauthors.includes('zhang wei'));
  assert.ok(fingerprint.stableCoauthors.includes('zhang wei'));
  assert.ok(fingerprint.coauthors.includes('li ming'));
  assert.ok(fingerprint.affiliations.length === 2);
});

test('recommends a small seed set and reports fingerprint stability', () => {
  const candidates = recommendAuthorSeedCandidates(
    entries,
    'Ji Jiansong',
    'Ji J[Author]',
    'Lishui Central Hospital',
  );
  assert.ok(candidates.length <= 10);
  assert.ok(candidates.filter(item => item.recommended).length >= 3);
  assert.deepEqual(new Set(candidates.slice(0, 2).map(item => item.entry.id)), new Set([1, 2]));

  const fingerprint = buildAuthorFingerprint(entries, [1, 2], 'Ji Jiansong');
  const stability = assessAuthorFingerprintStability(fingerprint);
  assert.equal(stability.level, 'usable');
  assert.ok(stability.missing.includes('跨年份证据'));
});

test('uses known institution aliases across different display forms', () => {
  const candidates = recommendAuthorSeedCandidates(
    entries,
    'Ji Jiansong',
    'Ji J[Author]',
    ['丽水市中心医院', 'Lishui Central Hospital'],
  );
  assert.deepEqual(new Set(candidates.slice(0, 2).map(item => item.entry.id)), new Set([1, 2]));

  const fingerprint = buildAuthorFingerprint(
    entries,
    [3],
    'Ji Jiansong',
    'Ji J[Author]',
    ['Lishui Central Hospital'],
  );
  const aliasedInstitution = scoreAuthorCandidate(entries[0], fingerprint);
  assert.ok(aliasedInstitution.reasons.includes('目标单位相近'));
  assert.notEqual(aliasedInstitution.status, 'same_name');
});

test('uses only the target author affiliations from structured PubMed authors', () => {
  const structured = [{
    id: 10,
    authors: 'Ji Jiansong, Smith John',
    affiliation: 'Stanford University; Lishui Central Hospital',
    title: 'Structured author affiliations',
    structured_authors: [
      {
        display_name: 'Ji Jiansong',
        orcid: '0000-0001-2345-6789',
        affiliations: ['Department of Radiology, Lishui Central Hospital'],
      },
      {
        display_name: 'Smith John',
        affiliations: ['Department of Computer Science, Stanford University'],
      },
    ],
  }];

  const fingerprint = buildAuthorFingerprint(structured, [10], 'Ji Jiansong');

  assert.deepEqual(fingerprint.orcids, ['0000-0001-2345-6789']);
  assert.ok(fingerprint.affiliations.flat().includes('lishui'));
  assert.ok(!fingerprint.affiliations.flat().includes('stanford'));
});

test('requires an explicit target node when one paper has duplicate matching authors', () => {
  const ambiguous = [{
    id: 20,
    title: 'Two matching author nodes',
    structured_authors: [
      { author_order: 1, display_name: 'Ji Jiansong', affiliations: ['Hospital A'] },
      { author_order: 2, display_name: 'Ji Jiansong', affiliations: ['Hospital B'] },
    ],
  }];

  assert.equal(getAuthorNodeCandidates(ambiguous[0], 'Ji Jiansong').length, 2);
  assert.deepEqual(buildAuthorFingerprint(ambiguous, [20], 'Ji Jiansong').affiliations, []);
  const selected = buildAuthorFingerprint(ambiguous, [20], 'Ji Jiansong', '', [], { 20: 2 });
  assert.ok(selected.affiliationLabels.includes('Hospital B'));
  assert.ok(!selected.affiliationLabels.includes('Hospital A'));
});

test('uses coauthors and topics to retain papers after an affiliation change', () => {
  const fingerprint = buildAuthorFingerprint(entries, [1, 2], 'Ji Jiansong');
  const changedInstitution = scoreAuthorCandidate(entries[2], fingerprint);
  const homonym = scoreAuthorCandidate(entries[3], fingerprint);
  assert.ok(changedInstitution.score > homonym.score);
  assert.notEqual(changedInstitution.status, 'same_name');
  assert.equal(homonym.status, 'same_name');
});

test('groups candidates and preserves explicit cluster decisions', () => {
  const fingerprint = buildAuthorFingerprint(entries, [1, 2], 'Ji Jiansong');
  const clusters = buildAuthorIdentityClusters(entries, fingerprint);
  assert.equal(clusters.find(cluster => cluster.entries.some(entry => entry.id === 1)).entries.length, 2);
  const target = clusters.find(cluster => cluster.entries.some(entry => entry.id === 4));
  const decided = buildAuthorIdentityClusters(entries, fingerprint, { [target.key]: 'review' });
  assert.equal(decided.find(cluster => cluster.key === target.key).status, 'review');
});

test('wires seed selection and cluster review into PubMed author searches', () => {
  assert.doesNotMatch(html, /id="btn-pubmed-author-identity"/);
  assert.match(source, /function openAuthorIdentityReview\(\)/);
  assert.match(source, /data-action="author-identity"/);
  assert.match(source, /用选中的 .* 篇建立作者指纹/);
  assert.match(source, /recommendAuthorSeedCandidates\(/);
  assert.match(source, /assessAuthorFingerprintStability\(/);
  assert.match(source, /种子论文最多选择 10 篇/);
  assert.match(source, /推荐种子候选/);
  assert.match(source, /单位写法/);
  assert.match(source, /data-add-affiliation-alias/);
  assert.match(source, /data-remove-affiliation-alias/);
  assert.match(source, /next\.affiliationAliases/);
  assert.doesNotMatch(source, /勾选 1–3 篇/);
  assert.match(source, /buildAuthorFingerprint\(/);
  assert.match(source, /applyAuthorIdentityClusterStatus/);
  assert.match(source, /save_pubmed_author_identity_state/);
  assert.match(source, /bulk_set_pubmed_screening_status/);
  assert.match(source, /主要单位/);
  assert.match(source, /常见共同作者/);
  assert.match(source, /研究方向/);
  assert.match(source, /function authorIdentityGroupLabel\(index\)/);
  assert.match(source, /authorIdentityStatusMap\(allEntries\)/);
  assert.match(source, /build_pubmed_author_expansion_queries/);
  assert.match(source, /pendingExpansionCandidates/);
  assert.match(source, /activeExpansionQuery/);
  assert.match(source, /data-activate-expansion/);
  assert.match(source, /data-seed-author/);
  assert.match(source, /seedAuthorSelections/);
  assert.match(styles, /\.author-identity-panel/);
  assert.match(styles, /\.author-identity-grid/);
  assert.match(styles, /\.author-seed-candidate/);
  assert.match(styles, /\.author-affiliation-chip/);
  assert.match(styles, /\.author-identity-badge\.same-name/);
});

test('keeps author identity out of the article toolbar and in the author search menu', () => {
  const toolbarStart = html.indexOf('<div class="pubmed-batch-actions">');
  const toolbarEnd = html.indexOf('</div>', toolbarStart);

  assert.ok(toolbarStart >= 0);
  assert.ok(toolbarEnd > toolbarStart);
  assert.equal(html.slice(toolbarStart, toolbarEnd).includes('作者身份'), false);
  assert.match(source, /data-action="author-identity"/);
  assert.match(source, /isAuthorPubmedSearch\(search\)/);
  assert.match(source, /action === 'author-identity'/);
});

test('recognizes legacy author searches from their name and restores the author field', () => {
  assert.match(source, /作者\\s\*\[|｜\]/);
  assert.match(source, /nameMatch/);
  assert.match(source, /match\?\.\[1\] \|\| nameMatch\?\.\[1\]/);
  assert.match(source, /setPubmedSearchBuilderMode\(authorIdentity \? 'author' : 'topic'\)/);
});
