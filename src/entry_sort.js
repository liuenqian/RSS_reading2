export const ENTRY_SORT_OPTIONS = new Set([
  'default',
  'default-desc',
  'default-asc',
  'year-desc',
  'year-asc',
  'if-desc',
  'if-asc',
  'jcr-asc',
  'jcr-desc',
  'cas-asc',
  'cas-desc',
]);

export function normalizeEntrySortMode(value) {
  return ENTRY_SORT_OPTIONS.has(value) ? value : 'default';
}

function publicationTimeCandidate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const compact = raw.match(/^((?:19|20)\d{2})(\d{2})(\d{2})$/);
  if (compact) {
    const year = Number(compact[1]);
    const month = Number(compact[2]);
    const day = Number(compact[3]);
    if (month > 12 || day > 31) return null;
    return {
      value: Date.UTC(year, Math.max(month, 1) - 1, Math.max(day, 1)),
      precision: day ? 3 : (month ? 2 : 1),
    };
  }

  const partial = raw.match(/^((?:19|20)\d{2})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return {
    value: parsed,
    precision: /[T\s]\d{1,2}:\d{2}/.test(raw)
      ? 4
      : (partial?.[3] ? 3 : (partial?.[2] ? 2 : 1)),
  };
}

function publicationTime(entry) {
  const candidates = [
    publicationTimeCandidate(entry?.published_at),
    publicationTimeCandidate(entry?.publication_date),
    publicationTimeCandidate(entry?.publication_sort_key),
  ].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.reduce((best, candidate) => (
    candidate.precision > best.precision ? candidate : best
  )).value;
}

function impactFactor(metrics) {
  const match = String(metrics?.if || '').trim().match(/[\d.]+/);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

function partitionRank(value, prefix) {
  const match = String(value || '').trim().toUpperCase().match(new RegExp(`${prefix}([1-4])`));
  return match ? Number(match[1]) : null;
}

function compareValuesNullLast(left, right, direction) {
  const leftMissing = left == null || Number.isNaN(left);
  const rightMissing = right == null || Number.isNaN(right);
  if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
  if (leftMissing) return 0;
  return (left - right) * direction;
}

export function sortEntries(entries, sortMode, metricsForEntry = () => null) {
  const mode = normalizeEntrySortMode(sortMode);
  const [field, order] = (mode === 'default' ? 'default-desc' : mode).split('-');
  const direction = order === 'desc' ? -1 : 1;
  const decorated = entries.map((entry, index) => {
    const metrics = field === 'default' || field === 'year' ? null : metricsForEntry(entry);
    let value = null;
    if (field === 'default' || field === 'year') value = publicationTime(entry);
    else if (field === 'if') value = impactFactor(metrics);
    else if (field === 'jcr') value = partitionRank(metrics?.q, 'Q');
    else if (field === 'cas') value = partitionRank(metrics?.b, 'B');
    return { entry, index, value };
  });

  decorated.sort((left, right) => (
    compareValuesNullLast(left.value, right.value, direction)
    || left.index - right.index
  ));
  return decorated.map(item => item.entry);
}
