export const ENTRY_SORT_OPTIONS = new Set([
  'default',
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

function publicationYear(entry) {
  const candidates = [entry?.publication_date, entry?.published_at, entry?.publication_sort_key];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/(?:19|20)\d{2}/);
    if (match) return Number(match[0]);
  }
  return null;
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
  if (mode === 'default') return [...entries];

  const [field, order] = mode.split('-');
  const direction = order === 'desc' ? -1 : 1;
  const decorated = entries.map((entry, index) => {
    const metrics = field === 'year' ? null : metricsForEntry(entry);
    let value = null;
    if (field === 'year') value = publicationYear(entry);
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
