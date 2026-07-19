export const SCREENING_TABLE_SCHEMA_VERSION = 1;

export const SCREENING_TABLE_COLUMNS = [
  { key: 'position', label: '#', width: 48, visible: true, pinned: true },
  { key: 'titleTranslated', sortField: 'title', label: '中文标题', width: 320, visible: true, pinned: true },
  { key: 'title', sortField: 'title', label: '英文标题', width: 360, visible: true, pinned: false },
  { key: 'summaryTranslated', label: '中文摘要', width: 420, visible: false, pinned: false },
  { key: 'summary', label: '英文摘要', width: 460, visible: false, pinned: false },
  { key: 'authors', sortField: 'authors', label: '作者', width: 220, visible: true, pinned: false },
  { key: 'journal', sortField: 'journal', label: '期刊', width: 180, visible: true, pinned: false },
  { key: 'publicationDate', sortField: 'publication', label: '发表日期', width: 122, visible: true, pinned: false },
  { key: 'publicationDateRaw', label: '发表日期原文', width: 140, visible: false, pinned: false },
  { key: 'firstSeenAt', sortField: 'added', label: '加入时间', width: 150, visible: false, pinned: false },
  { key: 'pmid', label: 'PMID', width: 110, visible: true, pinned: false },
  { key: 'pmcid', label: 'PMCID', width: 110, visible: false, pinned: false },
  { key: 'doi', label: 'DOI', width: 210, visible: false, pinned: false },
  { key: 'affiliation', label: '作者单位', width: 300, visible: false, pinned: false },
  { key: 'hasFreeFulltext', label: '免费全文', width: 86, visible: false, pinned: false },
  { key: 'impactFactor', sortField: 'if', label: 'IF', width: 72, visible: true, pinned: false },
  { key: 'q', sortField: 'q', label: 'JCR', width: 72, visible: true, pinned: false },
  { key: 'b', sortField: 'b', label: '中科院分区', width: 96, visible: true, pinned: false },
  { key: 'top', sortField: 'top', label: 'Top 期刊', width: 86, visible: false, pinned: false },
  { key: 'screeningStatus', sortField: 'status', label: '筛选状态', width: 112, visible: true, pinned: false },
  { key: 'exclusionReason', label: '排除原因', width: 180, visible: false, pinned: false },
  { key: 'screeningNote', label: '筛选备注', width: 220, visible: false, pinned: false },
  { key: 'isRead', sortField: 'read', label: '已读', width: 68, visible: true, pinned: false },
  { key: 'isStarred', sortField: 'starred', label: '标星', width: 68, visible: true, pinned: false },
  { key: 'tags', label: '标签', width: 180, visible: false, pinned: false },
  { key: 'hasReadingNote', label: '阅读笔记', width: 90, visible: false, pinned: false },
];

export function screeningScopeKey(scopeKind, scopeId) {
  return `${scopeKind}:${Number(scopeId)}`;
}

export function defaultScreeningTableConfig() {
  return {
    schemaVersion: SCREENING_TABLE_SCHEMA_VERSION,
    columns: SCREENING_TABLE_COLUMNS.map(column => ({ ...column })),
    rowDensity: 'compact',
    rowHeight: 48,
    searchQuery: '',
    scrollTop: 0,
    sorts: [{ field: 'publication', direction: 'desc' }],
  };
}

export function normalizeScreeningTableConfig(input = {}) {
  const defaults = defaultScreeningTableConfig();
  const sourceColumns = Array.isArray(input.columns) ? input.columns : [];
  const byKey = new Map(sourceColumns.map(column => [column.key, column]));
  const known = new Set(defaults.columns.map(column => column.key));
  const columns = [
    ...sourceColumns.filter(column => known.has(column.key)),
    ...defaults.columns.filter(column => !byKey.has(column.key)),
  ].map(column => {
    const fallback = defaults.columns.find(item => item.key === column.key) || column;
    return {
      ...fallback,
      ...column,
      label: fallback.label,
      sortField: fallback.sortField,
      width: Math.max(48, Math.min(720, Number(column.width) || fallback.width)),
      visible: column.visible !== false,
      pinned: column.pinned === true,
    };
  });
  return {
    ...defaults,
    ...input,
    schemaVersion: SCREENING_TABLE_SCHEMA_VERSION,
    columns,
    rowDensity: input.rowDensity === 'summary' ? 'summary' : 'compact',
    rowHeight: Math.max(34, Math.min(140, Number(input.rowHeight) || defaults.rowHeight)),
    scrollTop: Math.max(0, Number(input.scrollTop) || 0),
    sorts: Array.isArray(input.sorts) && input.sorts.length
      ? input.sorts.slice(0, 3).map(sort => ({
          field: String(sort.field || 'publication'),
          direction: sort.direction === 'asc' ? 'asc' : 'desc',
        }))
      : defaults.sorts,
  };
}

export function toggleScreeningTableSort(config, field) {
  const current = config.sorts?.[0];
  const direction = current?.field === field && current.direction === 'desc' ? 'asc' : 'desc';
  return { ...config, sorts: [{ field, direction }] };
}

export function reorderScreeningTableColumns(config, draggedKey, targetKey) {
  const columns = [...(config.columns || [])];
  const fromIndex = columns.findIndex(column => column.key === draggedKey);
  const targetIndex = columns.findIndex(column => column.key === targetKey);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return config;
  const [moved] = columns.splice(fromIndex, 1);
  columns.splice(targetIndex, 0, moved);
  return { ...config, columns };
}
