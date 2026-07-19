const GENERIC_AFFILIATION_WORDS = new Set([
  'and', 'the', 'of', 'department', 'division', 'school', 'college', 'faculty',
  'hospital', 'university', 'institute', 'institution', 'center', 'centre',
  'medical', 'medicine', 'science', 'sciences', 'china', 'city', 'affiliated',
]);

const TOPIC_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'using', 'study', 'analysis',
  'patients', 'clinical', 'effect', 'effects', 'role', 'based', 'between', 'after',
  'among', 'into', 'via', 'our', 'their', 'was', 'were', 'are', 'has', 'have',
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function tokens(value, stopWords = new Set()) {
  return normalize(value).split(/\s+/).filter(token => token.length > 1 && !stopWords.has(token));
}

function authorNames(entry) {
  const structured = structuredAuthorNodes(entry).map(node => normalize(node.displayName)).filter(Boolean);
  if (structured.length) return structured;
  return String(entry?.authors || entry?.author || '')
    .split(/[,;|]/)
    .map(normalize)
    .filter(Boolean);
}

function structuredAuthorNodes(entry) {
  const records = Array.isArray(entry?.structured_authors)
    ? entry.structured_authors
    : (Array.isArray(entry?.structuredAuthors) ? entry.structuredAuthors : []);
  return records.map(record => ({
    displayName: record?.display_name || record?.displayName
      || [record?.fore_name || record?.foreName, record?.last_name || record?.lastName].filter(Boolean).join(' ')
      || record?.collective_name || record?.collectiveName || '',
    affiliations: Array.isArray(record?.affiliations) ? record.affiliations.filter(Boolean) : [],
    orcid: String(record?.orcid || '').replace(/^https?:\/\/orcid\.org\//i, '').trim(),
  })).filter(node => node.displayName);
}

function targetAuthorNode(entry, identityNames = []) {
  const requested = identityNames.map(normalize).filter(Boolean);
  if (!requested.length) return null;
  return structuredAuthorNodes(entry).find(node => requested.some(name => namesProbablyMatch(node.displayName, name))) || null;
}

function topicTokens(entry) {
  return tokens(`${entry?.title || ''} ${entry?.summary || ''}`, TOPIC_STOP_WORDS);
}

function affiliationTokens(entry) {
  return tokens(entry?.affiliation || '', GENERIC_AFFILIATION_WORDS);
}

function targetAffiliationTokenSets(entry, identityNames = []) {
  const target = targetAuthorNode(entry, identityNames);
  const structured = target?.affiliations
    .map(value => tokens(value, GENERIC_AFFILIATION_WORDS))
    .filter(value => value.length) || [];
  return structured.length ? structured : [affiliationTokens(entry)].filter(value => value.length);
}

function targetAffiliationTokens(entry, identityNames = []) {
  return [...new Set(targetAffiliationTokenSets(entry, identityNames).flat())];
}

function targetAffiliationLabel(entry, identityNames = []) {
  const target = targetAuthorNode(entry, identityNames);
  return target?.affiliations?.find(Boolean) || entry?.affiliation || '';
}

function publicationYear(entry) {
  return String(entry?.publication_date || entry?.publication_date_raw || entry?.published_at || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
}

function setSimilarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  a.forEach(value => { if (b.has(value)) overlap += 1; });
  return overlap / Math.min(a.size, b.size);
}

function mostFrequent(values, limit = 8) {
  const counts = new Map();
  values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function queryAuthorVariants(query) {
  const variants = [];
  const pattern = /"?([^"()]+?)"?\[(?:Author|Full Author Name)\]/gi;
  let match;
  while ((match = pattern.exec(String(query || '')))) variants.push(normalize(match[1]));
  return variants.filter(Boolean);
}

function namesProbablyMatch(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b || a.replaceAll(' ', '') === b.replaceAll(' ', '')) return true;
  const ap = a.split(' ');
  const bp = b.split(' ');
  if (ap.length < 2 || bp.length < 2) return false;
  const sameEdge = ap[0] === bp[0] || ap.at(-1) === bp.at(-1);
  const initialsA = ap.map(part => part[0]).join('');
  const initialsB = bp.map(part => part[0]).join('');
  return sameEdge && (initialsA === initialsB || initialsA.includes(initialsB) || initialsB.includes(initialsA));
}

function fingerprintAnchorNames(seeds, targetAuthor, query) {
  const seedNames = seeds.map(authorNames);
  const requested = [normalize(targetAuthor), ...queryAuthorVariants(query)].filter(Boolean);
  const requestedMatches = mostFrequent(
    seedNames.flat().filter(name => requested.some(value => namesProbablyMatch(name, value))),
    6,
  );
  if (requestedMatches.length) return requestedMatches;
  if (seedNames.length > 1) {
    const shared = seedNames[0].filter(name => seedNames.slice(1).every(names => names.some(value => namesProbablyMatch(name, value))));
    if (shared.length) return mostFrequent(shared, 4);
  }
  return mostFrequent(seedNames.flat(), seeds.length === 1 ? 4 : 2);
}

export function recommendAuthorSeedCandidates(
  entries,
  targetAuthor = '',
  query = '',
  referenceAffiliations = [],
  limit = 10,
) {
  const requested = [normalize(targetAuthor), ...queryAuthorVariants(query)].filter(Boolean);
  const referenceSets = (Array.isArray(referenceAffiliations) ? referenceAffiliations : [referenceAffiliations])
    .map(value => tokens(value, GENERIC_AFFILIATION_WORDS))
    .filter(value => value.length);
  const ranked = entries.map(entry => {
    const names = authorNames(entry);
    const nameMatch = requested.length > 0 && names.some(name => requested.some(value => namesProbablyMatch(name, value)));
    const targetAffiliations = targetAffiliationTokenSets(entry, requested);
    const affiliation = Math.max(0, ...referenceSets.flatMap(value => targetAffiliations.map(candidate => setSimilarity(value, candidate))));
    const metadataScore = (names.length ? 8 : 0)
      + (targetAffiliations.length ? 5 : 0)
      + (topicTokens(entry).length ? 4 : 0)
      + (publicationYear(entry) ? 3 : 0);
    const score = Math.min(100, (nameMatch ? 50 : 0) + Math.round(affiliation * 35) + metadataScore);
    const reasons = [];
    if (nameMatch) reasons.push('姓名变体匹配');
    if (affiliation >= 0.45) reasons.push('参考单位相近');
    if (names.length >= 2) reasons.push('共同作者信息完整');
    if (topicTokens(entry).length) reasons.push('可提取研究方向');
    if (!reasons.length) reasons.push('身份信息较少');
    return { entry, score, reasons, nameMatch, affiliation };
  }).sort((a, b) => b.score - a.score || Number(b.entry.id) - Number(a.entry.id));

  const candidates = ranked
    .filter(item => item.nameMatch || item.affiliation >= 0.3 || !requested.length)
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 10)));
  const fallback = candidates.length ? candidates : ranked.slice(0, Math.max(1, Math.min(10, Number(limit) || 10)));
  const recommendedCount = referenceSets.length && fallback[0]?.score >= 80
    ? Math.min(3, fallback.length)
    : Math.min(fallback.length >= 5 ? 5 : 3, fallback.length);
  return fallback.map((item, index) => ({ ...item, recommended: index < recommendedCount }));
}

export function buildAuthorFingerprint(entries, seedIds, targetAuthor = '', query = '', affiliationAliases = []) {
  const ids = new Set(seedIds.map(Number));
  const seeds = entries.filter(entry => ids.has(Number(entry.id)));
  if (!seeds.length) return null;

  const anchors = fingerprintAnchorNames(seeds, targetAuthor, query);
  const isAnchor = name => anchors.some(anchor => namesProbablyMatch(name, anchor));
  const targetNodes = seeds.map(seed => targetAuthorNode(seed, anchors)).filter(Boolean);
  const years = seeds.map(publicationYear).filter(Boolean).map(Number);
  return {
    seedIds: seeds.map(entry => Number(entry.id)),
    targetAuthor: normalize(targetAuthor),
    anchors,
    affiliations: [
      ...seeds.flatMap(seed => targetAffiliationTokenSets(seed, anchors)),
      ...(Array.isArray(affiliationAliases) ? affiliationAliases : [affiliationAliases])
        .map(value => tokens(value, GENERIC_AFFILIATION_WORDS)),
    ].filter(list => list.length),
    orcids: mostFrequent(targetNodes.map(node => node.orcid), 8),
    coauthors: mostFrequent(seeds.flatMap(authorNames).filter(name => !isAnchor(name)), 30),
    topics: mostFrequent(seeds.flatMap(topicTokens), 40),
    yearRange: years.length ? [Math.min(...years), Math.max(...years)] : null,
  };
}

export function assessAuthorFingerprintStability(fingerprint) {
  if (!fingerprint) {
    return { score: 0, level: 'empty', label: '尚未建立', missing: ['需要确认种子论文'] };
  }
  const seedCount = fingerprint.seedIds.length;
  const missing = [];
  let score = Math.min(40, seedCount * 10);
  if (fingerprint.anchors.length) score += 15;
  else missing.push('姓名变体');
  if (fingerprint.affiliations.length) score += Math.min(20, 10 + fingerprint.affiliations.length * 3);
  else missing.push('作者单位');
  if (fingerprint.coauthors.length >= 3) score += 15;
  else missing.push('稳定共同作者');
  if (fingerprint.topics.length >= 5) score += 10;
  else missing.push('研究方向');
  if (fingerprint.yearRange && fingerprint.yearRange[1] - fingerprint.yearRange[0] >= 3) score += 10;
  else missing.push('跨年份证据');
  score = Math.min(100, score);
  const level = score >= 75 && seedCount >= 3 ? 'stable' : score >= 55 ? 'usable' : 'weak';
  const label = { stable: '稳定', usable: '可用，建议补充', weak: '证据不足' }[level];
  return { score, level, label, missing };
}

function candidateEvidence(entry, fingerprint) {
  const names = authorNames(entry);
  const anchorMatch = fingerprint.anchors.some(anchor => names.some(name => namesProbablyMatch(name, anchor)));
  const targetAffiliations = targetAffiliationTokenSets(entry, fingerprint.anchors);
  const affiliation = Math.max(0, ...fingerprint.affiliations.flatMap(value => targetAffiliations.map(candidate => setSimilarity(value, candidate))));
  const targetNode = targetAuthorNode(entry, fingerprint.anchors);
  const orcid = Boolean(targetNode?.orcid && fingerprint.orcids?.includes(targetNode.orcid));
  const coauthors = names.filter(name => !fingerprint.anchors.some(anchor => namesProbablyMatch(name, anchor)));
  const coauthor = setSimilarity(fingerprint.coauthors, coauthors);
  const topic = setSimilarity(fingerprint.topics, topicTokens(entry));
  return { names, coauthors, anchorMatch, affiliation, coauthor, topic, orcid };
}

export function scoreAuthorCandidate(entry, fingerprint) {
  if (!fingerprint) return { score: 0, status: 'review', reasons: ['尚未设置种子论文'] };
  if (fingerprint.seedIds.includes(Number(entry.id))) {
    return { score: 100, status: 'confirmed', reasons: ['种子论文'] };
  }

  const evidence = candidateEvidence(entry, fingerprint);
  let score = (evidence.orcid ? 55 : (evidence.anchorMatch ? 30 : 0))
    + Math.round(evidence.affiliation * 30)
    + Math.round(evidence.coauthor * 25)
    + Math.round(evidence.topic * 15);
  score = Math.min(100, score);
  const reasons = [];
  if (evidence.orcid) reasons.push('ORCID 一致');
  if (evidence.anchorMatch) reasons.push('姓名变体匹配');
  if (evidence.affiliation >= 0.45) reasons.push('目标单位相近');
  if (evidence.coauthor >= 0.2) reasons.push('共同作者重合');
  if (evidence.topic >= 0.2) reasons.push('研究方向连续');
  if (!reasons.length) reasons.push('缺少身份交叉证据');
  const independentEvidence = [evidence.orcid, evidence.affiliation >= 0.45, evidence.coauthor >= 0.2, evidence.topic >= 0.2].filter(Boolean).length;
  const conflictingIdentity = evidence.anchorMatch
    && fingerprint.affiliations.length > 0
    && targetAffiliationTokens(entry, fingerprint.anchors).length > 0
    && evidence.affiliation < 0.15
    && evidence.coauthor < 0.1
    && evidence.topic < 0.1;
  const status = conflictingIdentity
    ? 'same_name'
    : score >= 72 && independentEvidence >= 2
    ? 'confirmed'
    : score >= 52 && independentEvidence >= 1
      ? 'likely'
      : score >= 35 || evidence.anchorMatch
        ? 'review'
        : 'same_name';
  return { score, status, reasons, evidence };
}

function groupCandidates(entries, fingerprint) {
  const groups = [];
  entries.forEach(entry => {
    const assessment = scoreAuthorCandidate(entry, fingerprint);
    const affiliation = targetAffiliationTokens(entry, fingerprint.anchors);
    const coauthors = assessment.evidence?.coauthors || [];
    let best = null;
    groups.forEach(group => {
      const affiliationScore = Math.max(0, ...group.affiliations.map(value => setSimilarity(value, affiliation)));
      const coauthorScore = setSimilarity(group.coauthors, coauthors);
      const score = affiliationScore * 0.75 + coauthorScore * 0.25;
      if ((affiliationScore >= 0.55 || (!affiliation.length && coauthorScore >= 0.3)) && (!best || score > best.score)) {
        best = { group, score };
      }
    });
    const group = best?.group || {
      entries: [], assessments: [], affiliations: [], coauthors: [], topics: [], reasons: new Set(),
    };
    if (!best) groups.push(group);
    group.entries.push(entry);
    group.assessments.push(assessment);
    if (affiliation.length) group.affiliations.push(affiliation);
    group.coauthors.push(...coauthors);
    group.topics.push(...topicTokens(entry));
    assessment.reasons.forEach(reason => group.reasons.add(reason));
  });
  return groups;
}

function groupStatus(group) {
  const counts = { confirmed: 0, likely: 0, review: 0, same_name: 0 };
  group.assessments.forEach(item => { counts[item.status] += 1; });
  if (counts.confirmed >= Math.ceil(group.entries.length / 2)) return 'confirmed';
  if (counts.confirmed + counts.likely >= Math.ceil(group.entries.length / 2)) return 'likely';
  if (counts.same_name === group.entries.length) return 'same_name';
  return 'review';
}

export function buildAuthorIdentityClusters(entries, fingerprint, decisions = {}) {
  return groupCandidates(entries, fingerprint).map((group, index) => {
    const affiliation = group.entries
      .map(entry => targetAffiliationLabel(entry, fingerprint.anchors))
      .find(Boolean) || '单位信息不足';
    const affiliationKey = mostFrequent(group.affiliations.flat(), 5).sort().join('-');
    const fallbackKey = mostFrequent(group.coauthors, 4).sort().join('-') || String(index);
    const key = `identity:${affiliationKey || fallbackKey}`;
    const automaticStatus = groupStatus(group);
    return {
      key,
      status: decisions[key] || automaticStatus,
      entries: group.entries,
      score: Math.round(group.assessments.reduce((sum, value) => sum + value.score, 0) / group.assessments.length),
      reasons: [...group.reasons],
      affiliation,
      coauthors: mostFrequent(group.coauthors, 5),
      topics: mostFrequent(group.topics, 5),
      years: [...new Set(group.entries.map(publicationYear).filter(Boolean))].sort(),
      assessments: group.assessments,
    };
  }).sort((a, b) => {
    const order = { review: 0, likely: 1, confirmed: 2, same_name: 3 };
    return order[a.status] - order[b.status] || b.entries.length - a.entries.length;
  });
}

export const AUTHOR_IDENTITY_META = {
  confirmed: { label: '确认作者', className: 'confirmed' },
  likely: { label: '高度可能', className: 'likely' },
  review: { label: '需要确认', className: 'review' },
  same_name: { label: '同名作者', className: 'same-name' },
};
