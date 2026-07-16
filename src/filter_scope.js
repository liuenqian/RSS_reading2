const ENTRY_FILTER_VALUES = new Set(['all', 'unread', 'starred', 'reading-notes']);

const METRIC_FILTER_VALUES = {
  if: new Set(['all', 'ge5', 'ge10', 'ge20', 'na']),
  q: new Set(['all', 'Q1', 'Q2', 'Q3', 'Q4', 'na']),
  b: new Set(['all', 'B1', 'B2', 'B3', 'B4', 'na']),
  top: new Set(['all', 'top', 'non-top', 'na']),
};

const PUBMED_STATUS_VALUES = new Set(['all', 'unreviewed', 'keep', 'maybe', 'exclude']);
const PUBMED_SORT_VALUES = new Set([
  'publication-desc',
  'publication-asc',
  'added-desc',
  'added-asc',
  'if-desc',
  'if-asc',
  'rank',
]);
const PUBMED_STAR_VALUES = new Set(['all', 'starred', 'unstarred']);

export function createDefaultFilterScopeState() {
  return {
    entryFilter: 'all',
    tagFilter: 'all',
    entrySortField: 'default',
    entrySortDirection: 'desc',
    metricFilters: { if: 'all', q: 'all', b: 'all', top: 'all' },
    pubmedFilters: {
      status: 'all',
      sort: 'publication-desc',
      star: 'all',
      publishedFrom: '',
      publishedTo: '',
      addedFrom: '',
      addedTo: '',
    },
    pubmedSnapshotId: null,
  };
}

function allowedValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

export function normalizeFilterScopeState(value) {
  const defaults = createDefaultFilterScopeState();
  const state = value && typeof value === 'object' ? value : {};
  const metrics = state.metricFilters && typeof state.metricFilters === 'object'
    ? state.metricFilters
    : {};
  const pubmed = state.pubmedFilters && typeof state.pubmedFilters === 'object'
    ? state.pubmedFilters
    : {};

  return {
    entryFilter: allowedValue(state.entryFilter, ENTRY_FILTER_VALUES, defaults.entryFilter),
    tagFilter: typeof state.tagFilter === 'string' && state.tagFilter.trim()
      ? state.tagFilter
      : defaults.tagFilter,
    entrySortField: ['default', 'year', 'if', 'jcr', 'cas'].includes(state.entrySortField)
      ? state.entrySortField
      : defaults.entrySortField,
    entrySortDirection: state.entrySortDirection === 'asc' ? 'asc' : 'desc',
    metricFilters: Object.fromEntries(
      Object.entries(METRIC_FILTER_VALUES).map(([key, allowed]) => [
        key,
        allowedValue(metrics[key], allowed, defaults.metricFilters[key]),
      ])
    ),
    pubmedFilters: {
      status: allowedValue(pubmed.status, PUBMED_STATUS_VALUES, defaults.pubmedFilters.status),
      sort: allowedValue(pubmed.sort, PUBMED_SORT_VALUES, defaults.pubmedFilters.sort),
      star: allowedValue(pubmed.star, PUBMED_STAR_VALUES, defaults.pubmedFilters.star),
      publishedFrom: typeof pubmed.publishedFrom === 'string' ? pubmed.publishedFrom : '',
      publishedTo: typeof pubmed.publishedTo === 'string' ? pubmed.publishedTo : '',
      addedFrom: typeof pubmed.addedFrom === 'string' ? pubmed.addedFrom : '',
      addedTo: typeof pubmed.addedTo === 'string' ? pubmed.addedTo : '',
    },
    pubmedSnapshotId: typeof state.pubmedSnapshotId === 'string' && state.pubmedSnapshotId
      ? state.pubmedSnapshotId
      : null,
  };
}

export function filterScopeKey({ mode, pubmedSearchId = null, feedId = null } = {}) {
  if (mode === 'pubmed' && pubmedSearchId != null) return `pubmed:${pubmedSearchId}`;
  if (mode === 'kept') return 'kept';
  if (feedId != null) return `feed:${feedId}`;
  return 'all';
}

export function readFilterScopeState(scopeStates, scopeKey) {
  return normalizeFilterScopeState(scopeStates?.[scopeKey]);
}

export function writeFilterScopeState(scopeStates, scopeKey, state) {
  return {
    ...(scopeStates && typeof scopeStates === 'object' ? scopeStates : {}),
    [scopeKey]: normalizeFilterScopeState(state),
  };
}
