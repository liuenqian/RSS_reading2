import {
  DEFAULT_TRANSLATION_CONCURRENCY,
  runConcurrentQueue,
} from './translation_queue.js';
import { normalizeEntrySortMode, sortEntries } from './entry_sort.js';
import { shortJournalDisplayName } from './journal_name.js';
import {
  createDefaultFilterScopeState,
  filterScopeKey,
  normalizeFilterScopeState,
  writeFilterScopeState,
} from './filter_scope.js';
const { invoke } = window.__TAURI__.core;
const markdownitFactory = globalThis.markdownit;
const markdownitTaskLists = globalThis.markdownitTaskLists;
const markdownitFootnote = globalThis.markdownitFootnote;
const DOMPurify = globalThis.DOMPurify;
const MARKDOWN_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const MARKDOWN_IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'data:']);
const markdownRenderer = createMarkdownRenderer();

function createMarkdownRenderer() {
  if (typeof markdownitFactory !== 'function') return null;

  const md = markdownitFactory({
    html: true,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  if (typeof markdownitTaskLists === 'function') {
    md.use(markdownitTaskLists, {
      enabled: false,
      label: true,
      labelAfter: true,
    });
  }
  if (typeof markdownitFootnote === 'function') {
    md.use(markdownitFootnote);
  }
  return md;
}

function isHashHref(href) {
  return typeof href === 'string' && href.startsWith('#');
}

function isAllowedAbsoluteUrl(rawUrl, allowedProtocols) {
  if (!rawUrl || isHashHref(rawUrl)) return false;

  try {
    const parsed = new URL(rawUrl);
    return allowedProtocols.has(parsed.protocol);
  } catch {
    return false;
  }
}

function sanitizeMarkdownHtml(html) {
  if (!html) return '';
  if (DOMPurify?.sanitize) {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['data-open-url', 'loading', 'referrerpolicy', 'rel'],
    });
  }
  return html;
}

function decorateMarkdownHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeMarkdownHtml(html);

  template.content.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    anchor.classList.add('briefing-md-link');

    if (isHashHref(href)) {
      anchor.classList.add('is-local');
      return;
    }

    if (isAllowedAbsoluteUrl(href, MARKDOWN_LINK_PROTOCOLS)) {
      anchor.dataset.openUrl = href;
      anchor.setAttribute('rel', 'noreferrer noopener');
      return;
    }

    anchor.removeAttribute('href');
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
  });

  template.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!isAllowedAbsoluteUrl(src, MARKDOWN_IMAGE_PROTOCOLS)) {
      const fallback = document.createElement('span');
      fallback.className = 'briefing-md-image-fallback';
      fallback.textContent = img.getAttribute('alt') || '[图片]';
      img.replaceWith(fallback);
      return;
    }

    img.classList.add('briefing-md-image');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('referrerpolicy', 'no-referrer');
  });

  template.content.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('briefing-md-table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'briefing-md-table-wrap';
    table.parentNode?.insertBefore(wrap, table);
    wrap.appendChild(table);
  });

  return template.innerHTML;
}

// ── DOM refs ──────────────────────────────────────
let settingsView, mainView, contentArea;
let btnSettings, btnSidebar, btnRefresh, refreshIcon, btnTogglePaperChatToolbar;
let toolbarSubtitle, toolbarApiPicker, toolbarApiButton, toolbarApiLabel;
let toolbarApiMenu, toolbarApiList, btnManageApiTokens;
let providerSelect, apiKeyInput, baseUrlInput, modelInput, modelPresetSelect, customModelInput, systemPromptInput;
let modelDisplayNameInput, modelDisplayNameCount, contextInputTokensInput, contextOutputTokensInput, toolCallRoundsInput;
let btnApiModeProvider, btnApiModeCustom, apiProviderPanel, apiCustomPanel;
let btnToggleApiKey, btnTest, btnSaveSettings, btnSaveGeneral;
let aiModelList, aiModelEmpty, aiModelEditor, aiModelEditorTitle, aiModelStatus;
let btnAddAiModel, btnCancelAiModel;
let apiTokenProfileSelect, apiTokenProfileNameInput, btnNewApiToken, btnDeleteApiToken;
let settingsStatus, generalStatus;
let retentionSelect, themeControl, accentSwatches, fontscaleControl, titleDisplaySelect;
let feedUrlInput, btnAddFeed, addFeedRow, addFeedIcon, feedListEl, globalStatusEl;
let literatureSearchInput, btnClearLiteratureSearch, literatureSearchRow;
let pubmedSearchListEl, pubmedBatchHeader, pubmedBatchMeta;
let pubmedStatusFilter, pubmedSort, pubmedStarFilter, pubmedDateFilters, pubmedPublishedFrom, pubmedPublishedTo, pubmedAddedFrom, pubmedAddedTo;
let pubmedProgressEl, pubmedProgressFill, pubmedProgressLabel, btnRunPubmedSearch, btnCancelPubmedRun;
let pubmedExportFormat, btnExportPubmed;
let pubmedSnapshotSelect, btnSavePubmedSnapshot, btnDeletePubmedSnapshot;
let pubmedBulkStatus, btnPubmedAiScreen;
let entryListEl, briefingListEl, briefingItemsEl, briefingSortSelect, briefingSortDirection;
let entryItemsEl, entryFilter;
let entrySortSelect, entrySortDirection, entryMetricIfFilter, entryMetricQFilter, entryMetricBFilter, entryMetricTopFilter, entryTagFilter;
let entryMetricFilterSummaryCount;
let entryBulkActions, entryBulkCount, btnEntrySelectMode, btnEntryBulkSelectAll, btnEntryBulkSelectUnnoted, btnEntryBulkSelectNoted, btnEntryBulkInvert, btnEntryBulkDeselect, entryBulkExportFormat, btnEntryBulkExport, entryBulkExistingMode, btnEntryBulkGenerate, btnEntryBulkClear;
let detailPanelEl, paperChatPanelEl, briefingDetailEl;
let sidebarResizerEl, listResizerEl, paperChatResizerEl;
let detailEmpty, detailContent, detailTitle, detailJournal, detailAffiliation;
let detailIdentifierStrip;
let detailPublicationDate, detailDateSub;
let detailSummaryContent, detailSummarySection, detailSummaryRetry;
let detailSummaryView, detailPdfView, btnDetailViewSummary, btnDetailViewPdf;
let btnPdfOpenExternal, btnPdfDownload;
let detailReadingNotesContent;
let detailPaperChatHint, detailPaperChatMessages, detailPaperChatScopes, paperChatInput, paperChatComposer;
let paperChatScopeCaption, btnSendPaperChat, btnClearPaperChat, btnTogglePaperChat, btnShowPaperChat;
let paperChatPickedList, btnPaperChatAddCurrent, btnPaperChatClearPicked;
let paperChatPickedLabel;
let paperChatProfileSelect;
let paperChatAttachmentsEl, paperChatAttachmentList, btnPaperChatAddFiles, btnPaperChatAddFolder;
let btnClearPaperChatAttachments;
let readingProfileSortSelect, btnReadingProfilesSort;
let detailBadgeRow, detailSourceBadge, btnOpenUrl, btnRetrySummary, btnPaperGraph;
let btnDetailPdf, btnDetailSciHub;
let detailTagList, detailTagInput, btnDetailAddTag;
let detailPaperGraphSection, paperGraphStage, paperGraphNodeDetail, paperGraphCounts;
let briefingDetailEmpty, briefingDetailContent;

// ── App state ────────────────────────────────────
let currentEntry = null;
let allEntries = [];
let globalEntries = [];
let allFeeds = [];
let allPubmedSearches = [];
let currentPubmedSearch = null;
let activePubmedRunId = null;
let pubmedRenderLimit = 200;
let pubmedPreview = null;
let pubmedPreviewAssessment = null;
let pubmedPreviewSettingsReturnPending = false;
let contextMenu = null;
let renamingFeedId = null;
let renamingPubmedSearchId = null;
let pubmedGeneratorApi = null;
let hasConfiguredApiKey = false;
let sidebarCollapsed = false;
let entryFilterValue = 'all';   // 'all' | 'unread' | 'starred' | 'reading-notes'
let entryTagFilterValue = 'all';
let entrySortMode = 'default';
let entrySortField = 'default';
let entrySortDirectionMode = 'desc';
let briefingSortField = 'date';
let briefingSortDirectionMode = 'desc';
let currentTheme = 'light';
let currentAccent = 'coral';
let currentFontScale = 'md';
let selectedFeedId = null;
let abstractLang = 'zh';
let mode = 'feed';              // 'feed' | 'pubmed' | 'kept' | 'briefing'
let selectedBriefingId = null;
let literatureSearchTimer = null;
let literatureSearchRequestId = 0;
let literatureSearchRestoreState = null;
let journalMetricsIndex = null;
let journalMetricsLoadPromise = null;
let readingProfiles = [];
let editingReadingProfileId = null;
let editingReadingNoteId = null;
const entryMetricFilters = { if: 'all', q: 'all', b: 'all', top: 'all' };
const freeFulltextCheckInFlight = new Set();
const entryPdfLinkCache = new Map();
const entryPdfLinkCheckInFlight = new Map();
let detailPdfReader = null;
let detailPdfUrl = '';
let detailPdfRequestId = 0;
let entrySelectionMode = false;
let selectedEntryIds = new Set();
let apiTokenProfileData = { provider: 'deepseek', active_id: null, profiles: [] };
let toolbarApiProfileRefreshId = 0;
let lastPresetProvider = 'sensenova';
let aiModels = [];
let editingAiModelId = null;
let editingApiTokenProfileId = null;

const SCI_HUB_BASE_URL = 'https://www.sci-hub.st/';
const SCI_HUB_LAST_RELIABLE_PUBLICATION_YEAR = 2020;

const AI_PROVIDER_META = {
  sensenova: {
    label: 'SenseNova',
    baseUrl: 'https://token.sensenova.cn/v1',
    model: 'deepseek-v4-flash',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4-mini',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash',
  },
  openai_compatible: {
    label: 'OpenAI-compatible',
    baseUrl: 'https://example.com/v1',
    model: 'model-name',
  },
};
const SENSENOVA_PRESET = {
  provider: 'deepseek',
  baseUrl: 'https://token.sensenova.cn/v1',
  model: 'deepseek-v4-flash',
};
let entrySelectionAnchorId = null;
let entryBulkExistingStrategy = 'skip';
let paperChatScope = 'single';
let paperChatPinnedEntries = [];
let currentPaperChatProfileId = '';
let paperChatCollapsed = false;
let paperChatAttachments = [];
let paperChatAttachmentsBusy = false;
let activePaperChatRequest = null;
const PAPER_CHAT_ATTACHMENT_LIMIT = 20;
const PAPER_CHAT_ATTACHMENT_CHAR_LIMIT = 100_000;
let currentPaperGraph = null;
let paperGraphFilter = 'all';
let selectedPaperGraphNodeId = null;
let paperGraphHistory = [];
let paperGraphRequestToken = 0;
let paperGraphViewport = { x: 0, y: 0, scale: 1 };
let paperGraphSuppressClickUntil = 0;
const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-width-v1';
const SIDEBAR_DEFAULT_WIDTH = 252;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const LIST_WIDTH_STORAGE_KEY = 'entry-list-width-v1';
const LIST_DEFAULT_WIDTH = 416;
const LIST_MIN_WIDTH = 320;
const LIST_MAX_WIDTH = 760;
const PAPER_CHAT_WIDTH_STORAGE_KEY = 'paper-chat-width-v1';
const PAPER_CHAT_COLLAPSED_STORAGE_KEY = 'paper-chat-collapsed-v1';
const PAPER_CHAT_DEFAULT_WIDTH = 430;
const PAPER_CHAT_MIN_WIDTH = 320;
const PAPER_CHAT_MIN_APP_WIDTH = 1420;
const DETAIL_PANEL_MIN_WIDTH = 420;
const BRIEFING_DETAIL_MIN_WIDTH = 360;
const PANEL_RESIZER_WIDTH = 12;
const SIDEBAR_SECTION_COLLAPSED_STORAGE_KEY = 'sidebar-section-collapsed-v1';
const ENTRY_FILTER_STORAGE_KEY = 'entry-filter-v1';
const ENTRY_FILTER_OPTIONS = ['all', 'unread', 'starred', 'reading-notes'];
const ENTRY_METRIC_FILTER_STORAGE_KEY = 'entry-metric-filters-v1';
const FILTER_SCOPE_STORAGE_KEY = 'entry-filter-scopes-v1';
const ENTRY_SORT_STORAGE_KEY = 'entry-sort-v2';
const LEGACY_ENTRY_SORT_STORAGE_KEY = 'entry-sort-v1';
const BRIEFING_SORT_STORAGE_KEY = 'briefing-sort-v1';
const ENTRY_METRIC_FILTER_OPTIONS = {
  if: ['all', 'ge5', 'ge10', 'ge20', 'na'],
  q: ['all', 'Q1', 'Q2', 'Q3', 'Q4', 'na'],
  b: ['all', 'B1', 'B2', 'B3', 'B4', 'na'],
  top: ['all', 'top', 'non-top', 'na'],
};
const PUBMED_SNAPSHOT_STORAGE_KEY = 'pubmed-filter-snapshots-v1';
const PUBMED_EXPORT_FIELDS_STORAGE_KEY = 'pubmed-export-fields-v1';
const NATURE_DOWNLOAD_PREFS_STORAGE_KEY = 'nature-download-prefs-v1';
const TITLE_DISPLAY_STORAGE_KEY = 'title-display-mode-v1';
const TITLE_DISPLAY_MODES = new Set(['both', 'zh', 'en']);
const PUBMED_EXPORT_FIELDS = [
  ['number', '编号'],
  ['screening_status', '筛选状态'],
  ['title_translated', '标题中文'],
  ['title', '标题英文'],
  ['summary_translated', '摘要中文'],
  ['summary', '摘要英文'],
  ['authors', '作者'],
  ['journal', '期刊'],
  ['publication_date', '发表日期'],
  ['publication_date_raw', '发表日期原文'],
  ['first_seen_at', '加入批次时间'],
  ['pmid', 'PMID'],
  ['pmcid', 'PMCID'],
  ['doi', 'DOI'],
  ['affiliation', '作者单位'],
  ['has_free_fulltext', '免费全文'],
  ['is_read', '已读状态'],
  ['tags', '标签'],
  ['impact_factor', '影响因子'],
  ['jcr_quartile', 'JCR 分区'],
  ['cas_partition', '中科院分区'],
  ['is_top', 'Top 期刊'],
  ['reading_notes', '阅读笔记正文'],
];
const DEFAULT_PUBMED_EXPORT_FIELDS = [
  'number', 'screening_status', 'title_translated', 'title', 'summary_translated',
  'summary', 'authors', 'journal', 'publication_date', 'first_seen_at', 'pmid',
  'doi', 'is_read', 'tags', 'impact_factor', 'jcr_quartile', 'cas_partition',
  'is_top', 'reading_notes',
];
const PUBMED_DOWNLOADER_XLSX_FIELD_ORDER = [
  'pmid', 'title', 'summary', 'authors', 'journal', 'publication_date', 'doi',
  'impact_factor', 'jcr_quartile', 'cas_partition',
];
let pubmedSnapshots = loadPubmedSnapshots();
let activePubmedSnapshotId = null;
const pubmedFilters = {
  status: 'all',
  sort: 'publication-desc',
  star: 'all',
  publishedFrom: '',
  publishedTo: '',
  addedFrom: '',
  addedTo: '',
};
let filterScopeStates = loadFilterScopeStates();

const DRAG_BLOCK_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
].join(',');

// ── Emoji presets ───────────────────────────────
const EMOJI_PRESETS = [
  '🧬','🫀','🫁','🫘','🧠','🩺','🩸','💊',
  '🧪','🔬','⚗️','🧫','🦠','💉','⚕️','🏥',
  '📊','📈','📉','📚','📖','📝','📰','🗂️',
  '⭐','🔖','🏷️','📌','✨','🔥','💡','🎯',
  '🌱','🌿','🌊','☀️','🌙','⚡','❤️','💚',
];

// ── Per-feed metadata (localStorage) ───────────
function feedEmoji(feedId) {
  return localStorage.getItem(`feed-emoji-${feedId}`) || '📡';
}
function setFeedEmoji(feedId, emoji) {
  localStorage.setItem(`feed-emoji-${feedId}`, emoji);
}
// Per-feed interval & notify are stored in SQLite (columns on `feeds`) and
// driven by the Rust-side scheduler. The frontend just reads from the loaded
// Feed objects and pushes changes back via Tauri commands.
function feedInterval(feedId) {
  const f = allFeeds.find(x => x.id === feedId);
  return f?.refresh_interval || '1d';
}
function feedNotify(feedId) {
  const f = allFeeds.find(x => x.id === feedId);
  return !!f?.notify;
}

function isPubmedFeed(feed) {
  return !!feed?.url && feed.url.includes('pubmed.ncbi.nlm.nih.gov/rss/search');
}

function clampPubmedLimit(limit) {
  const parsed = parseInt(limit, 10);
  if (!Number.isFinite(parsed)) return 15;
  const allowed = [5, 10, 15, 20, 50, 100];
  if (allowed.includes(parsed)) return parsed;
  return allowed.reduce((closest, candidate) =>
    Math.abs(candidate - parsed) < Math.abs(closest - parsed) ? candidate : closest
  , 15);
}

function parsePubmedFeedConfig(feed) {
  if (!isPubmedFeed(feed)) return null;

  let query = (feed.pubmed_query || '').trim();
  let limit = feed.pubmed_limit == null ? 15 : clampPubmedLimit(feed.pubmed_limit);
  let queryRecoveredFromUrl = false;

  try {
    const parsedUrl = new URL(feed.url);
    if (!query) {
      query = (parsedUrl.searchParams.get('term') || '').trim();
      queryRecoveredFromUrl = !!query;
    }
    if (feed.pubmed_limit == null) {
      const limitFromUrl = parsedUrl.searchParams.get('limit');
      if (limitFromUrl) limit = clampPubmedLimit(limitFromUrl);
    }
  } catch (error) {
    console.warn('解析 PubMed 订阅配置失败:', error);
  }

  return {
    query,
    limit,
    title: (feed.title || '').trim(),
    url: feed.url,
    missingStoredQuery: !query && !queryRecoveredFromUrl,
  };
}

function starredIds() {
  try { return new Set(JSON.parse(localStorage.getItem('starred-ids') || '[]')); }
  catch { return new Set(); }
}
function toggleStar(entryId) {
  const s = starredIds();
  if (s.has(entryId)) s.delete(entryId); else s.add(entryId);
  localStorage.setItem('starred-ids', JSON.stringify([...s]));
}

function normalizeEntryFilterValue(value) {
  return ENTRY_FILTER_OPTIONS.includes(value) ? value : 'all';
}

function entryFilterLabel(value) {
  return {
    all: '全部文章',
    unread: '未读',
    starred: '星标',
    'reading-notes': '阅读笔记',
  }[normalizeEntryFilterValue(value)] || '全部文章';
}

function persistEntryFilter() {
  try {
    persistCurrentFilterScope();
  } catch (error) {
    console.warn('保存顶部筛选失败:', error);
  }
}

function restoreEntryFilter() {
  try {
    entryFilterValue = normalizeEntryFilterValue(localStorage.getItem(ENTRY_FILTER_STORAGE_KEY) || entryFilterValue);
  } catch (error) {
    console.warn('恢复顶部筛选失败:', error);
    entryFilterValue = 'all';
  }
}

function loadFilterScopeStates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTER_SCOPE_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('读取分范围筛选失败:', error);
    return {};
  }
}

function currentFilterScopeKey() {
  return filterScopeKey({
    mode,
    pubmedSearchId: currentPubmedSearch?.id ?? null,
    feedId: selectedFeedId,
  });
}

function captureCurrentFilterScopeState() {
  return normalizeFilterScopeState({
    entryFilter: entryFilterValue,
    tagFilter: entryTagFilterValue,
    entrySortField,
    entrySortDirection: entrySortDirectionMode,
    metricFilters: { ...entryMetricFilters },
    pubmedFilters: { ...pubmedFilters },
    pubmedSnapshotId: activePubmedSnapshotId,
  });
}

function applyFilterScopeState(state) {
  const next = normalizeFilterScopeState(state);
  entryFilterValue = next.entryFilter;
  entryTagFilterValue = next.tagFilter;
  entrySortField = next.entrySortField;
  entrySortDirectionMode = next.entrySortDirection;
  Object.assign(entryMetricFilters, next.metricFilters);
  Object.assign(pubmedFilters, next.pubmedFilters);
  activePubmedSnapshotId = next.pubmedSnapshotId;
  syncEntryFilterControls();
  syncEntrySortControl();
  syncEntryMetricFilterControls();
  syncPubmedFilterInputs();
  if (entryTagFilter) entryTagFilter.value = entryTagFilterValue;
  if (['pubmed', 'kept'].includes(mode)) refreshPubmedSnapshotControls();
}

function persistCurrentFilterScope() {
  const scopeKey = currentFilterScopeKey();
  filterScopeStates = writeFilterScopeState(
    filterScopeStates,
    scopeKey,
    captureCurrentFilterScopeState()
  );
  localStorage.setItem(FILTER_SCOPE_STORAGE_KEY, JSON.stringify(filterScopeStates));

  if (scopeKey === 'all') {
    localStorage.setItem(ENTRY_FILTER_STORAGE_KEY, normalizeEntryFilterValue(entryFilterValue));
    localStorage.setItem(ENTRY_METRIC_FILTER_STORAGE_KEY, JSON.stringify(entryMetricFilters));
    localStorage.setItem(
      ENTRY_SORT_STORAGE_KEY,
      entrySortField === 'default' ? 'default' : `${entrySortField}-${entrySortDirectionMode}`,
    );
  }
}

function restoreCurrentFilterScope({ useCurrentAsFallback = false } = {}) {
  const scopeKey = currentFilterScopeKey();
  const saved = filterScopeStates[scopeKey];
  const fallback = useCurrentAsFallback
    ? captureCurrentFilterScopeState()
    : createDefaultFilterScopeState();
  applyFilterScopeState(saved || fallback);
  if (!saved) persistCurrentFilterScope();
}

function syncEntryFilterControls() {
  entryFilterValue = normalizeEntryFilterValue(entryFilterValue);

  if (entryFilter) {
    entryFilter.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === entryFilterValue);
    });
  }

  const activeSidebarView = mode === 'briefing'
    ? 'briefing'
    : (mode === 'kept'
      ? 'kept'
      : (mode === 'pubmed' || selectedFeedId ? null : entryFilterValue));
  document.querySelectorAll('.sidebar-row').forEach(row => {
    row.classList.toggle('active', !!activeSidebarView && row.dataset.view === activeSidebarView);
  });
}

function setupWindowDragFallback() {
  document.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.detail !== 1) return;

    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(DRAG_BLOCK_SELECTOR)) return;

    const region = target.closest('[data-tauri-drag-region]');
    if (!region || region.getAttribute('data-tauri-drag-region') === 'false') return;

    const currentWindow =
      window.__TAURI__?.window?.getCurrentWindow?.()
      || window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
    if (!currentWindow?.startDragging) return;

    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    currentWindow.startDragging().catch(() => {});
  });
}

// ── Provider-normalized AI token and cost meter ────────────────────
// The Rust pipeline records every API call's `usage` block into SQLite and
// emits `cost-updated` after each successful translation. We just render
// whatever the backend reports. The old `addTranslationCost(chars)` helper
// stays as a no-op so existing call sites continue to compile cleanly while
// the real number streams in via the event listener below.
let currentCostSummary = null;
function addTranslationCost() { /* no-op: backend handles accounting */ }

// Format CNY adaptively. The old localStorage estimate over-counted by ~3×
// so two decimals felt fine. With real DeepSeek pricing, a casual reader can
// easily spend < ¥0.10/month, which `toFixed(2)` would render as "¥0.00" or
// "¥0.01" — looks broken. So: under ¥0.10, show four decimals; otherwise
// stick to two so the value stays readable in a tight sidebar.
function formatCny(amount) {
  if (amount === 0) return '¥ 0.00';
  if (amount < 0.1) return `¥ ${amount.toFixed(4)}`;
  return `¥ ${amount.toFixed(2)}`;
}

function updateCostMeter() {
  const el = (id) => document.getElementById(id);
  if (!el('cost-value')) return;
  const summary = currentCostSummary;
  const total = summary?.total_cny;
  const tokens = (summary?.breakdown || []).reduce((acc, row) =>
    acc + row.prompt_cache_hit_tokens + row.prompt_cache_miss_tokens + row.completion_tokens,
  0);
  el('cost-value').textContent = total == null ? '未计价' : formatCny(total);
  // Tokens accumulate visibly with every translation — much more responsive
  // than the ¥ value for tracking "did my translations register". For
  // Chinese output, one token ≈ one Chinese character, so the count also
  // reads naturally to the user.
  el('cost-chars').textContent = `${tokens.toLocaleString()} tokens`;
  // The progress bar is now scaled against a 20 ¥/month soft cap — a
  // reasonable monthly budget for a heavy reader. Adjust if needed; this
  // ratio is presentation-only and doesn't affect billing.
  const pct = total == null ? 0 : Math.min(100, total / 20 * 100);
  el('cost-fill').style.width = pct + '%';
  const breakdown = summary?.breakdown || [];
  const activeProvider = activeProviderId();
  const activeMeta = AI_PROVIDER_META[activeProvider] || AI_PROVIDER_META.deepseek;
  const costModel = el('cost-model');
  if (costModel) {
    costModel.textContent = breakdown.length > 0
      ? `${AI_PROVIDER_META[breakdown[0].provider]?.label || breakdown[0].provider} · ${breakdown[0].model}`
      : `${activeMeta.label} · ${activeModelDisplayName()}`;
  }
  // Detailed hover-tooltip so curious users can see the full breakdown
  // (cache hit/miss/output tokens per model).
  const meter = document.getElementById('cost-meter');
  if (meter) {
    if (breakdown.length === 0) {
      meter.title = '本月暂无翻译用量';
    } else {
      meter.title = breakdown
        .map(b =>
          `${AI_PROVIDER_META[b.provider]?.label || b.provider} · ${b.model}: 缓存输入 ${b.prompt_cache_hit_tokens.toLocaleString()} · `
          + `非缓存输入 ${b.prompt_cache_miss_tokens.toLocaleString()} · `
          + `输出 ${b.completion_tokens.toLocaleString()}`
          + (b.cny == null ? ' · 未计价' : ` = ${formatCny(b.cny)}`)
        )
        .join('\n');
    }
  }
}
async function loadCostSummary() {
  try {
    currentCostSummary = await invoke('get_cost_summary');
    updateCostMeter();
  } catch (e) {
    console.warn('get_cost_summary failed:', e);
  }
}
function setupCostEvents() {
  const event = window.__TAURI__?.event;
  if (!event?.listen) return;
  event.listen('cost-updated', (e) => {
    currentCostSummary = e.payload;
    updateCostMeter();
  });
}

// ── Settings helpers ───────────────────────────
function showSettingsStatus(msg, type) {
  if (!settingsStatus) return;
  settingsStatus.textContent = msg;
  settingsStatus.className = 'settings-status ' + (type || '');
}
function showGeneralStatus(msg, type) {
  if (!generalStatus) return;
  generalStatus.textContent = msg;
  generalStatus.className = 'settings-status ' + (type || '');
}

function titleDisplayMode() {
  const saved = localStorage.getItem(TITLE_DISPLAY_STORAGE_KEY) || 'both';
  return TITLE_DISPLAY_MODES.has(saved) ? saved : 'both';
}

function displayTitles(entry) {
  const original = (entry?.title || '').trim();
  const translated = (entry?.title_translated || '').trim();
  const mode = titleDisplayMode();

  if (mode === 'en') return { primary: original || translated, secondary: '' };
  if (mode === 'zh') return { primary: translated || original, secondary: '' };
  return {
    primary: translated || original,
    secondary: translated && original && translated !== original ? original : '',
  };
}

function renderDetailTitle(entry) {
  if (!detailTitle) return;
  const titles = displayTitles(entry);
  const primary = document.createElement('span');
  primary.className = 'detail-title-primary';
  primary.textContent = titles.primary;
  detailTitle.replaceChildren(primary);
  if (titles.secondary) {
    const secondary = document.createElement('span');
    secondary.className = 'detail-title-original';
    secondary.textContent = titles.secondary;
    detailTitle.appendChild(secondary);
  }
}

function activeProviderId() {
  return providerSelect?.value || 'deepseek';
}

function providerStorageId(provider = activeProviderId()) {
  return provider === 'sensenova' ? 'deepseek' : provider;
}

function isSenseNovaUrl(value) {
  return /^https:\/\/token\.sensenova\.cn(?:\/|$)/i.test((value || '').trim());
}

function displayProviderId(settings) {
  if (settings?.provider === 'deepseek' && isSenseNovaUrl(settings.base_url)) {
    return 'sensenova';
  }
  return settings?.provider || 'deepseek';
}

function supportsDeepSeekBalance(provider, baseUrl) {
  return provider === 'deepseek'
    && /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test((baseUrl || '').trim());
}

function syncModelControls() {
  const provider = activeProviderId();
  const meta = AI_PROVIDER_META[provider] || AI_PROVIDER_META.deepseek;
  const configuredModel = (modelInput?.value || meta.model).trim();

  if (provider === 'openai_compatible') {
    if (customModelInput) customModelInput.value = (modelInput?.value || '').trim();
    return;
  }

  if (!modelPresetSelect) return;
  const models = [...new Set([meta.model, configuredModel].filter(Boolean))];
  const displayName = modelDisplayNameInput?.value.trim();
  modelPresetSelect.replaceChildren(...models.map(model => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = displayName && model === configuredModel
      ? `${displayName} (${model})`
      : model;
    return option;
  }));
  modelPresetSelect.value = configuredModel;
  if (modelInput) modelInput.value = configuredModel;
}

function updateModelDisplayNameCount() {
  if (!modelDisplayNameCount) return;
  modelDisplayNameCount.textContent = `${modelDisplayNameInput?.value.length || 0}/32`;
}

function activeModelDisplayName() {
  const providerMeta = AI_PROVIDER_META[activeProviderId()] || AI_PROVIDER_META.deepseek;
  return modelDisplayNameInput?.value.trim()
    || (modelInput?.value || providerMeta.model).trim()
    || providerMeta.label;
}

function positiveIntegerValue(input, fallback) {
  const value = Math.trunc(Number(input?.value));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function syncApiConfigMode() {
  const customMode = activeProviderId() === 'openai_compatible';
  btnApiModeProvider?.classList.toggle('active', !customMode);
  btnApiModeCustom?.classList.toggle('active', customMode);
  btnApiModeProvider?.setAttribute('aria-selected', String(!customMode));
  btnApiModeCustom?.setAttribute('aria-selected', String(customMode));
  apiProviderPanel?.classList.toggle('hidden', customMode);
  apiCustomPanel?.classList.toggle('hidden', !customMode);
  syncModelControls();
}

function selectApiConfigMode(mode) {
  const customMode = mode === 'custom';
  const currentProvider = activeProviderId();
  if (customMode && currentProvider !== 'openai_compatible') {
    lastPresetProvider = currentProvider;
    providerSelect.value = 'openai_compatible';
  } else if (!customMode && currentProvider === 'openai_compatible') {
    providerSelect.value = lastPresetProvider;
  }
  syncApiConfigMode();
  syncProviderUi();
  loadProviderSettings(activeProviderId());
}

function syncProviderUi() {
  const provider = activeProviderId();
  const meta = AI_PROVIDER_META[provider] || AI_PROVIDER_META.deepseek;
  if (baseUrlInput) baseUrlInput.placeholder = meta.baseUrl;
  if (customModelInput) customModelInput.placeholder = meta.model;
  const modelLabel = `${meta.label} · ${activeModelDisplayName()}`;
  const briefingSettingsModel = document.getElementById('briefing-settings-model');
  const briefingDetailModel = document.getElementById('briefing-detail-model');
  if (briefingSettingsModel) briefingSettingsModel.textContent = modelLabel;
  if (briefingDetailModel) briefingDetailModel.textContent = modelLabel;
  const configuredBaseUrl = (baseUrlInput?.value || meta.baseUrl).trim();
  const supportsBalance = supportsDeepSeekBalance(provider, configuredBaseUrl);
  document.getElementById('deepseek-balance-card')?.classList.toggle('hidden', !supportsBalance);
  const keySourceText = document.getElementById('api-key-source-text');
  const keySourceLink = document.getElementById('api-key-source-link');
  if (keySourceLink && keySourceText) {
    const linkConfig = provider === 'sensenova'
      ? { text: '没有 API Key？', label: '申请免费 API Key', href: 'https://www.sensenova.cn/' }
      : provider === 'deepseek'
        ? { text: '没有 API Key？', label: '前往 DeepSeek 控制台', href: 'https://platform.deepseek.com/api_keys' }
        : null;
    keySourceText.textContent = linkConfig?.text || '请在所选服务商控制台创建 API Key。';
    keySourceLink.classList.toggle('hidden', !linkConfig);
    if (linkConfig) {
      keySourceLink.textContent = linkConfig.label;
      keySourceLink.href = linkConfig.href;
    }
  }
  updateCostMeter();
}

function applyProviderSettings(settings, { includeGlobal = false } = {}) {
  const displayProvider = displayProviderId(settings);
  if (providerSelect) providerSelect.value = displayProvider;
  if (displayProvider !== 'openai_compatible') lastPresetProvider = displayProvider;
  apiKeyInput.value = settings.api_key || '';
  baseUrlInput.value = settings.base_url || '';
  modelInput.value = settings.model || '';
  modelDisplayNameInput.value = settings.model_display_name || '';
  contextInputTokensInput.value = String(settings.context_input_tokens || 1140000);
  contextOutputTokensInput.value = String(settings.context_output_tokens || 16000);
  toolCallRoundsInput.value = String(settings.tool_call_rounds || 500);
  editingApiTokenProfileId = settings.api_token_profile_id || null;
  updateModelDisplayNameCount();
  syncApiConfigMode();
  if (includeGlobal) {
    systemPromptInput.value = settings.system_prompt || '';
    retentionSelect.value = String(settings.read_retention_days ?? 0);
  }
  syncProviderUi();
}

function setAiModelEditorVisible(visible, title = '编辑模型') {
  aiModelEditor?.classList.toggle('hidden', !visible);
  if (aiModelEditorTitle) aiModelEditorTitle.textContent = title;
  if (visible) aiModelEditor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setAiModelStatus(message = '', type = '') {
  if (!aiModelStatus) return;
  aiModelStatus.textContent = message;
  aiModelStatus.className = `settings-status ai-model-manager-status${type ? ` ${type}` : ''}`;
}

function renderAiModels(models) {
  aiModels = Array.isArray(models) ? models : [];
  if (!aiModelList) return;
  aiModelList.replaceChildren();
  aiModelEmpty?.classList.toggle('hidden', aiModels.length > 0);

  aiModels.forEach(model => {
    const row = document.createElement('tr');
    row.dataset.modelId = model.id;

    const modelCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'ai-model-name';
    name.textContent = model.name || model.model;
    const modelId = document.createElement('span');
    modelId.className = 'ai-model-id';
    modelId.textContent = model.model;
    modelCell.append(name, modelId);

    const providerCell = document.createElement('td');
    providerCell.className = 'ai-model-provider';
    providerCell.textContent = AI_PROVIDER_META[model.provider]?.label || model.provider;

    const stateCell = document.createElement('td');
    stateCell.className = `ai-model-state${model.active ? ' active' : ''}`;
    stateCell.textContent = model.active ? '当前使用' : '已保存';

    const actionsCell = document.createElement('td');
    actionsCell.className = 'ai-model-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'ai-model-action';
    editButton.dataset.action = 'edit';
    editButton.textContent = '编辑';
    const activateButton = document.createElement('button');
    activateButton.type = 'button';
    activateButton.className = 'ai-model-action';
    activateButton.dataset.action = 'activate';
    activateButton.textContent = model.active ? '使用中' : '启用';
    activateButton.disabled = model.active;
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'ai-model-action danger';
    deleteButton.dataset.action = 'delete';
    deleteButton.textContent = '删除';
    deleteButton.disabled = model.active;
    actionsCell.append(editButton);
    if (!model.active) actionsCell.append(activateButton);
    actionsCell.append(deleteButton);

    row.append(modelCell, providerCell, stateCell, actionsCell);
    aiModelList.appendChild(row);
  });
}

async function refreshAiModels() {
  try {
    const models = await invoke('list_ai_models');
    renderAiModels(models);
    return models;
  } catch (error) {
    setAiModelStatus('加载模型列表失败: ' + error, 'error');
    return [];
  }
}

async function beginAddAiModel() {
  editingAiModelId = null;
  editingApiTokenProfileId = null;
  providerSelect.value = 'sensenova';
  lastPresetProvider = 'sensenova';
  apiKeyInput.value = '';
  baseUrlInput.value = SENSENOVA_PRESET.baseUrl;
  modelInput.value = SENSENOVA_PRESET.model;
  modelDisplayNameInput.value = '';
  contextInputTokensInput.value = '1140000';
  contextOutputTokensInput.value = '16000';
  toolCallRoundsInput.value = '500';
  updateModelDisplayNameCount();
  syncApiConfigMode();
  syncProviderUi();
  await loadApiTokenProfiles('sensenova');
  beginNewApiTokenProfile();
  showSettingsStatus('', '');
  setAiModelEditorVisible(true, '添加模型');
}

async function editAiModel(configId) {
  try {
    const settings = await invoke('get_ai_model', { configId });
    editingAiModelId = settings.config_id;
    applyProviderSettings(settings);
    await loadApiTokenProfiles(activeProviderId());
    if (settings.api_token_profile_id && apiTokenProfileSelect) {
      apiTokenProfileSelect.value = settings.api_token_profile_id;
    }
    setAiModelEditorVisible(true, '编辑模型');
    showSettingsStatus('', '');
  } catch (error) {
    setAiModelStatus('读取模型失败: ' + error, 'error');
  }
}

async function activateAiModel(configId) {
  try {
    const settings = await invoke('activate_ai_model', { configId });
    editingAiModelId = settings.config_id;
    applyProviderSettings(settings, { includeGlobal: true });
    await loadApiTokenProfiles(activeProviderId());
    await refreshAiModels();
    setAiModelEditorVisible(false);
    updateView(!!settings.api_key);
    setAiModelStatus(`已启用 ${settings.model_display_name || settings.model}`, 'success');
    setTimeout(() => setAiModelStatus('', ''), 2500);
    invoke('start_translation_pipeline').catch(() => {});
  } catch (error) {
    setAiModelStatus('启用失败: ' + error, 'error');
  }
}

async function deleteAiModel(configId) {
  const model = aiModels.find(item => item.id === configId);
  if (!model || !window.confirm(`删除模型“${model.name}”？`)) return;
  try {
    renderAiModels(await invoke('delete_ai_model', { configId }));
    setAiModelStatus('模型已删除', 'success');
    setTimeout(() => setAiModelStatus('', ''), 2500);
  } catch (error) {
    setAiModelStatus('删除失败: ' + error, 'error');
  }
}

function activeTokenProfile() {
  return apiTokenProfileData.profiles.find(
    profile => profile.id === apiTokenProfileData.active_id
  ) || null;
}

function fillTokenProfileSelect(select, profiles, activeId) {
  if (!select) return;
  select.replaceChildren();
  profiles.forEach(profile => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.masked_key}`;
    select.appendChild(option);
  });
  if (activeId) select.value = activeId;
}

function closeToolbarApiMenu() {
  if (!toolbarApiMenu || !toolbarApiButton) return;
  toolbarApiMenu.classList.add('hidden');
  toolbarApiButton.setAttribute('aria-expanded', 'false');
}

function toggleToolbarApiMenu() {
  if (!toolbarApiMenu || !toolbarApiButton) return;
  const shouldOpen = toolbarApiMenu.classList.contains('hidden');
  toolbarApiMenu.classList.toggle('hidden', !shouldOpen);
  toolbarApiButton.setAttribute('aria-expanded', String(shouldOpen));
}

function renderToolbarApiProfiles(profileLists) {
  if (!toolbarApiPicker || !toolbarApiList || !toolbarApiLabel) return;

  const availableLists = profileLists.filter(list => (list.profiles || []).length > 0);
  const profileCount = availableLists.reduce(
    (total, list) => total + list.profiles.length,
    0
  );
  const visibleProvider = activeProviderId();
  const currentProvider = providerStorageId(visibleProvider);
  const currentList = availableLists.find(list => list.provider === currentProvider);
  const currentProfile = currentList?.profiles.find(
    profile => profile.id === currentList.active_id
  );
  const currentProviderLabel = AI_PROVIDER_META[visibleProvider]?.label || visibleProvider;

  toolbarApiLabel.textContent = currentProfile
    ? `${currentProviderLabel} · ${currentProfile.name}`
    : '配置 API';
  toolbarApiPicker.classList.remove('hidden');

  toolbarApiList.replaceChildren();
  if (profileCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'toolbar-api-empty';
    empty.textContent = '尚未保存 API 配置';
    toolbarApiList.appendChild(empty);
  }
  availableLists.forEach(list => {
    const providerLabel = AI_PROVIDER_META[list.provider]?.label || list.provider;
    const group = document.createElement('div');
    group.className = 'toolbar-api-provider';

    const heading = document.createElement('div');
    heading.className = 'toolbar-api-provider-label';
    heading.textContent = providerLabel;
    group.appendChild(heading);

    list.profiles.forEach(profile => {
      const isActive = list.provider === currentProvider
        && profile.id === list.active_id;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'toolbar-api-option' + (isActive ? ' active' : '');
      option.dataset.provider = list.provider;
      option.dataset.profileId = profile.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(isActive));

      const providerMark = document.createElement('span');
      providerMark.className = 'toolbar-api-provider-mark';
      providerMark.textContent = providerLabel
        .split(/\s+/)
        .map(part => part[0])
        .join('')
        .slice(0, 3)
        .toUpperCase();

      const copy = document.createElement('span');
      copy.className = 'toolbar-api-option-copy';
      const name = document.createElement('span');
      name.className = 'toolbar-api-option-name';
      name.textContent = profile.name;
      const meta = document.createElement('span');
      meta.className = 'toolbar-api-option-meta';
      meta.textContent = profile.masked_key;
      copy.append(name, meta);

      const check = document.createElement('span');
      check.className = 'toolbar-api-check';
      check.textContent = isActive ? '✓' : '';
      check.setAttribute('aria-hidden', 'true');

      option.append(providerMark, copy, check);
      group.appendChild(option);
    });
    toolbarApiList.appendChild(group);
  });
}

async function refreshToolbarApiProfiles() {
  const requestId = ++toolbarApiProfileRefreshId;
  const providers = Object.keys(AI_PROVIDER_META).filter(provider => provider !== 'sensenova');
  const results = await Promise.allSettled(
    providers.map(async provider => invoke('list_api_token_profiles', { provider }))
  );
  if (requestId !== toolbarApiProfileRefreshId) return;

  const profileLists = results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);
  renderToolbarApiProfiles(profileLists);
}

function renderApiTokenProfiles({ preserveDraft = false } = {}) {
  const profiles = apiTokenProfileData.profiles || [];
  fillTokenProfileSelect(
    apiTokenProfileSelect,
    profiles,
    apiTokenProfileData.active_id
  );
  if (btnDeleteApiToken) btnDeleteApiToken.disabled = profiles.length === 0;

  if (preserveDraft && apiTokenProfileSelect) {
    const option = document.createElement('option');
    option.value = '__new__';
    option.textContent = '新 API Key';
    apiTokenProfileSelect.appendChild(option);
    apiTokenProfileSelect.value = '__new__';
    return;
  }

  const active = activeTokenProfile();
  if (apiTokenProfileNameInput) apiTokenProfileNameInput.value = active?.name || '';
}

async function loadApiTokenProfiles(provider) {
  const storedProvider = providerStorageId(provider);
  try {
    const data = await invoke('list_api_token_profiles', { provider: storedProvider });
    if (providerStorageId(activeProviderId()) !== storedProvider) return;
    apiTokenProfileData = data;
    renderApiTokenProfiles();
    await refreshToolbarApiProfiles();
  } catch (error) {
    showSettingsStatus('加载 API Key 列表失败: ' + error, 'error');
  }
}

async function activateApiTokenProfile(
  profileId,
  provider = activeProviderId(),
  { fromToolbar = false } = {}
) {
  if (!profileId || profileId === '__new__') return;
  const storedProvider = providerStorageId(provider);
  try {
    apiTokenProfileData = await invoke('activate_api_token_profile', {
      provider: storedProvider,
      profileId,
    });
    const settings = await invoke('get_provider_settings', { provider: storedProvider });
    applyProviderSettings(settings);
    renderApiTokenProfiles();
    await refreshToolbarApiProfiles();
    updateView(!!settings.api_key);
    const profileName = activeTokenProfile()?.name || '当前 API Key';
    const providerLabel = AI_PROVIDER_META[provider]?.label || provider;
    showSettingsStatus(`已切换到 ${profileName}`, 'success');
    if (fromToolbar) setGlobalStatus(`已切换到 ${providerLabel} · ${profileName}`, 'success');
    setTimeout(() => showSettingsStatus('', ''), 2200);
    invoke('start_translation_pipeline').catch(() => {});
    if (supportsDeepSeekBalance(activeProviderId(), baseUrlInput?.value)) {
      refreshDeepSeekBalance({ silent: true });
    }
  } catch (error) {
    renderApiTokenProfiles();
    await refreshToolbarApiProfiles();
    showSettingsStatus('切换失败: ' + error, 'error');
    if (fromToolbar) setGlobalStatus('API 切换失败: ' + error, 'error');
  }
}

function beginNewApiTokenProfile() {
  renderApiTokenProfiles({ preserveDraft: true });
  if (apiTokenProfileNameInput) {
    apiTokenProfileNameInput.value = '';
    apiTokenProfileNameInput.focus();
  }
  if (apiKeyInput) apiKeyInput.value = '';
  if (btnDeleteApiToken) btnDeleteApiToken.disabled = true;
  showSettingsStatus('', '');
}

async function deleteCurrentApiTokenProfile() {
  const profile = activeTokenProfile();
  if (!profile || !window.confirm(`删除 API Key“${profile.name}”？`)) return;
  const provider = providerStorageId();
  try {
    apiTokenProfileData = await invoke('delete_api_token_profile', {
      provider,
      profileId: profile.id,
    });
    const settings = await invoke('get_provider_settings', { provider });
    applyProviderSettings(settings);
    renderApiTokenProfiles();
    await refreshToolbarApiProfiles();
    updateView(!!settings.api_key);
    showSettingsStatus('API Key 已删除', 'success');
  } catch (error) {
    showSettingsStatus('删除失败: ' + error, 'error');
  }
}

async function loadProviderSettings(provider) {
  const storedProvider = providerStorageId(provider);
  try {
    const settings = await invoke('get_provider_settings', { provider: storedProvider });
    if (activeProviderId() !== provider) return;
    if (provider === 'sensenova') {
      settings.base_url = SENSENOVA_PRESET.baseUrl;
      settings.model = SENSENOVA_PRESET.model;
    } else if (provider === 'deepseek' && isSenseNovaUrl(settings.base_url)) {
      settings.base_url = AI_PROVIDER_META.deepseek.baseUrl;
      settings.model = AI_PROVIDER_META.deepseek.model;
    }
    applyProviderSettings(settings);
    await loadApiTokenProfiles(provider);
    showSettingsStatus('', '');
  } catch (e) {
    showSettingsStatus('加载服务商配置失败: ' + e, 'error');
  }
}

function collectAiSettings() {
  return {
    config_id: editingAiModelId,
    api_token_profile_id: editingApiTokenProfileId,
    provider: providerStorageId(),
    api_key: apiKeyInput.value.trim(),
    base_url: baseUrlInput.value.trim(),
    model: modelInput.value.trim(),
    model_display_name: modelDisplayNameInput.value.trim(),
    context_input_tokens: positiveIntegerValue(contextInputTokensInput, 1140000),
    context_output_tokens: positiveIntegerValue(contextOutputTokensInput, 16000),
    tool_call_rounds: positiveIntegerValue(toolCallRoundsInput, 500),
    system_prompt: systemPromptInput.value.trim(),
    read_retention_days: parseInt(retentionSelect?.value, 10) || 0,
  };
}

async function loadSettings() {
  try {
    await refreshAiModels();
    const s = await invoke('get_settings');
    editingAiModelId = s.config_id || null;
    applyProviderSettings(s, { includeGlobal: true });
    await loadApiTokenProfiles(activeProviderId());
    setAiModelEditorVisible(!s.api_key, s.config_id ? '编辑模型' : '添加模型');
    updateView(!!s.api_key);
  } catch (e) {
    showSettingsStatus('加载设置失败: ' + e, 'error');
  }
}

// ── DeepSeek balance (real API call) ──────────────
// Queries `GET {base_url}/user/balance` via the Tauri backend so the user can
// see the vendor's actual remaining credit, independent of the local
// localStorage cost approximation.
let balanceLoadInFlight = false;
function setBalanceStatus(msg, type) {
  const el = document.getElementById('balance-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'settings-status ' + (type || '');
}
function renderBalanceMessage(message) {
  const host = document.getElementById('balance-display');
  if (!host) return;
  host.className = 'balance-display balance-empty';
  host.innerHTML = `<div class="balance-empty-text">${escapeHtml(message)}</div>`;
}
function isUnsupportedBalanceError(err) {
  const text = String(err || '');
  return text.includes('不支持余额查询')
    || text.includes('/user/balance')
    || text.includes('404');
}
function renderBalance(balance) {
  const host = document.getElementById('balance-display');
  if (!host) return;
  // Only show CNY — DeepSeek may also return USD when an account has been
  // topped up in dollars, but Cento users in CN expect CNY only.
  const infos = (balance?.balance_infos || []).filter(
    i => (i.currency || '').toUpperCase() === 'CNY'
  );
  if (infos.length === 0) {
    host.className = 'balance-display balance-empty';
    host.innerHTML = `<div class="balance-empty-text">未返回 CNY 余额信息</div>`;
    return;
  }
  host.className = 'balance-display';
  host.innerHTML = infos.map(info => {
    const total = escapeHtml(info.total_balance || '0');
    const granted = escapeHtml(info.granted_balance || '0');
    const toppedUp = escapeHtml(info.topped_up_balance || '0');
    const availClass = balance.is_available ? 'available' : 'unavailable';
    const availText = balance.is_available ? '可用' : '不可用';
    return `
      <div class="balance-total-row">
        <span class="balance-total-label">可用余额</span>
        <span class="balance-availability ${availClass}">${availText}</span>
      </div>
      <div class="balance-total-amount">¥ ${total}</div>
      <div class="balance-breakdown">
        <div class="balance-breakdown-item">
          <span class="balance-breakdown-key">赠送额度</span>
          <span class="balance-breakdown-val">¥ ${granted}</span>
        </div>
        <div class="balance-breakdown-item">
          <span class="balance-breakdown-key">充值额度</span>
          <span class="balance-breakdown-val">¥ ${toppedUp}</span>
        </div>
      </div>
    `;
  }).join('');
}
async function refreshDeepSeekBalance({ silent = false } = {}) {
  if (balanceLoadInFlight) return;
  if (activeProviderId() !== 'deepseek') return;
  const apiKey = apiKeyInput?.value.trim();
  if (!apiKey) {
    if (!silent) setBalanceStatus('请先填写并保存 API Key', 'error');
    return;
  }
  balanceLoadInFlight = true;
  if (!silent) setBalanceStatus('正在查询余额…', 'progress');
  try {
    const balance = await invoke('fetch_deepseek_balance');
    renderBalance(balance);
    if (!silent) {
      setBalanceStatus('已更新', 'success');
      setTimeout(() => setBalanceStatus('', ''), 2500);
    } else {
      setBalanceStatus('', '');
    }
  } catch (e) {
    if (isUnsupportedBalanceError(e)) {
      renderBalanceMessage('当前服务不支持余额查询；若翻译测试可通过，可直接继续使用翻译功能。');
      if (!silent) setBalanceStatus('当前服务不支持余额查询', '');
      else setBalanceStatus('', '');
    } else {
      setBalanceStatus('查询失败: ' + e, 'error');
    }
  } finally {
    balanceLoadInFlight = false;
  }
}

async function saveTranslationSettings() {
  const settings = collectAiSettings();
  try {
    let savedSettings = await invoke('save_ai_model', { settings });
    editingAiModelId = savedSettings.config_id;
    if (settings.api_key) {
      apiTokenProfileData = await invoke('upsert_api_token_profile', {
        provider: settings.provider,
        profileId: apiTokenProfileSelect?.value === '__new__'
          ? null
          : (editingApiTokenProfileId || apiTokenProfileSelect?.value || apiTokenProfileData.active_id),
        name: apiTokenProfileNameInput?.value.trim() || '默认 API Key',
        apiKey: settings.api_key,
      });
      editingApiTokenProfileId = apiTokenProfileData.active_id;
      savedSettings.api_token_profile_id = editingApiTokenProfileId;
      savedSettings = await invoke('save_ai_model', { settings: savedSettings });
    }
    renderApiTokenProfiles();
    await refreshToolbarApiProfiles();
    await refreshAiModels();
    setAiModelEditorVisible(false);
    showSettingsStatus('模型已保存', 'success');
    updateView(!!savedSettings.api_key);
    // If the user just configured (or updated) the API key, kick the pipeline so
    // any entries that were waiting for a key start translating immediately,
    // and refresh the balance card with the new credentials.
    if (settings.api_key && !pubmedPreviewSettingsReturnPending) {
      invoke('start_translation_pipeline').catch(() => {});
      if (supportsDeepSeekBalance(activeProviderId(), settings.base_url)) {
        refreshDeepSeekBalance({ silent: true });
      }
    }
    if (pubmedPreviewSettingsReturnPending) {
      showMain();
      document.getElementById('pubmed-search-modal')?.classList.remove('hidden');
      document.getElementById('pubmed-preview-status').textContent = 'AI 设置已保存，可重试初判';
    }
  } catch (e) {
    showSettingsStatus('保存失败: ' + e, 'error');
  }
}

async function saveGeneralSettings() {
  const settings = collectAiSettings();
  try {
    await invoke('save_settings', { settings });
    localStorage.setItem('theme', currentTheme);
    localStorage.setItem('accent', currentAccent);
    localStorage.setItem('font-scale', currentFontScale);
    showGeneralStatus('设置已保存', 'success');
    setTimeout(() => showGeneralStatus('', ''), 3000);
  } catch (e) {
    showGeneralStatus('保存失败: ' + e, 'error');
  }
}

async function testConnection() {
  btnTest.disabled = true;
  btnTest.textContent = '测试中…';
  showSettingsStatus('', '');
  const settings = collectAiSettings();
  try {
    await invoke('test_connection', { settings });
    showSettingsStatus('连接成功 · 延迟 287ms', 'success');
  } catch (e) {
    showSettingsStatus('连接失败: ' + e, 'error');
  } finally {
    btnTest.disabled = false;
    btnTest.textContent = '测试连接';
  }
}

function toggleApiKeyVisibility() {
  const hidden = apiKeyInput.type === 'password';
  apiKeyInput.type = hidden ? 'text' : 'password';
  btnToggleApiKey.title = hidden ? '隐藏 API Key' : '显示 API Key';
}

// ── View switching ─────────────────────────────
function updateView(hasApiKey) {
  hasConfiguredApiKey = hasApiKey;
  // The onboarding banner in the settings/translation section reminds users
  // they can unlock auto-translation by adding a key. Hide it once a key is
  // present; re-show if they ever clear it. The banner is informational —
  // the main view is fully usable without a key.
  const banner = document.getElementById('onboarding-banner');
  if (banner) banner.classList.toggle('hidden', hasApiKey);
  // Always boot into the main view. Articles render in their original
  // language when no key is configured; the translation pipeline silently
  // skips itself. Users who want Chinese translation can opt in via
  // Settings → 翻译 at any time.
  showMain();
  loadFeeds();
  loadPubmedSearches();
  loadEntries();
  startSchedulerListener();
}

const ICON_SIDEBAR = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="6.2" y1="3" x2="6.2" y2="13"/></svg>`;
const ICON_BACK    = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5"/></svg>`;

function showSettings(section) {
  settingsView.classList.remove('hidden');
  mainView.classList.add('hidden');
  btnSettings.classList.add('active');
  btnSidebar.innerHTML = ICON_BACK;
  btnSidebar.title = '返回';
  btnSidebar.classList.remove('active');
  // Body class drives the appshell layout: in settings mode the sidebar is
  // gone (its parent #main-view is `display:none`), so the toolbar + #app
  // slide left to the viewport edge. See `.toolbar` / `#app` in styles.css.
  document.body.classList.add('settings-mode');
  setToolbarSubtitle('settings');
  if (section) activateSettingsSection(section);
}

function showMain() {
  settingsView.classList.add('hidden');
  mainView.classList.remove('hidden');
  btnSettings.classList.remove('active');
  btnSidebar.innerHTML = ICON_SIDEBAR;
  btnSidebar.title = '侧栏';
  if (!sidebarCollapsed) btnSidebar.classList.add('active');
  document.body.classList.remove('settings-mode');
  setToolbarSubtitle(mode === 'briefing' ? 'briefing' : (mode === 'search' ? 'search' : 'main'));
  if (pubmedPreviewSettingsReturnPending && pubmedPreview) {
    document.getElementById('pubmed-search-modal')?.classList.remove('hidden');
  }
}

function setToolbarSubtitle(context) {
  if (!toolbarSubtitle) return;
  if (context === 'settings') {
    toolbarSubtitle.innerHTML = '<span>设置</span>';
    return;
  }
  if (context === 'briefing') {
    toolbarSubtitle.innerHTML = `
      <span class="ts-accent"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 3.5h7.4a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1Z"/><path d="M11.2 5.5h1.5a.5.5 0 0 1 .5.5v6.5a1 1 0 0 1-2 0"/></svg></span>
      <span>AI 简报</span>
      <span class="ts-meta">·</span>
      <span class="ts-tertiary">${BRIEFINGS.length} 份</span>
    `;
    return;
  }
  if (context === 'search') {
    toolbarSubtitle.innerHTML = `
      <span>检索</span>
      <span class="ts-meta">·</span>
      <span class="ts-tertiary">${allEntries.length} 篇</span>
    `;
    return;
  }
  toolbarSubtitle.innerHTML = '';
}

// ── Sidebar ────────────────────────────────────
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  applyCollapsedState();
  localStorage.setItem('sidebar-collapsed', sidebarCollapsed ? '1' : '0');
}

function applyCollapsedState() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  // `body.sidebar-collapsed` shifts toolbar + #app to the viewport's left
  // edge (matching the sidebar slide-out). `.collapsed` on the sidebar
  // itself drives the translate transform. `.sidebar-hidden` on mainView
  // is kept for any legacy CSS that still keys off it.
  sidebar.classList.toggle('collapsed', sidebarCollapsed);
  sidebarResizerEl?.classList.toggle('hidden', sidebarCollapsed);
  mainView.classList.toggle('sidebar-hidden', sidebarCollapsed);
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  btnSidebar.classList.toggle('active', !sidebarCollapsed);
  requestAnimationFrame(() => {
    applyPaperChatPanelWidth(loadPaperChatPanelWidth());
    syncPaperChatResizerVisibility();
  });
}

function loadSidebarSectionCollapsedState() {
  try {
    const state = JSON.parse(localStorage.getItem(SIDEBAR_SECTION_COLLAPSED_STORAGE_KEY) || '{}');
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

function setSidebarSectionCollapsed(section, collapsed, { persist = true } = {}) {
  const toggle = document.querySelector(`[data-sidebar-section-toggle="${section}"]`);
  const listId = toggle?.getAttribute('aria-controls');
  const list = listId ? document.getElementById(listId) : null;
  if (!toggle || !list) return;

  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.title = `${collapsed ? '展开' : '折叠'}${section === 'pubmed' ? ' PubMed 检索' : '订阅源'}`;
  list.hidden = collapsed;

  if (persist) {
    const state = loadSidebarSectionCollapsedState();
    state[section] = collapsed;
    localStorage.setItem(SIDEBAR_SECTION_COLLAPSED_STORAGE_KEY, JSON.stringify(state));
  }
}

function setupSidebarSectionToggles() {
  const state = loadSidebarSectionCollapsedState();
  document.querySelectorAll('[data-sidebar-section-toggle]').forEach(toggle => {
    const section = toggle.dataset.sidebarSectionToggle;
    setSidebarSectionCollapsed(section, state[section] === true, { persist: false });
    toggle.addEventListener('click', () => {
      setSidebarSectionCollapsed(section, toggle.getAttribute('aria-expanded') === 'true');
    });
  });
}

function setupSidebarResizer() {
  if (!sidebarResizerEl) return;

  applySidebarWidth(loadSidebarWidth());
  requestAnimationFrame(() => applySidebarWidth(loadSidebarWidth()));

  let dragging = false;

  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('sidebar-resizing');
  };

  const handleMove = (event) => {
    if (!dragging) return;
    const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-gutter')) || 0;
    const nextWidth = event.clientX - gutter;
    applySidebarWidth(nextWidth, { persist: true });
  };

  sidebarResizerEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    document.body.classList.add('sidebar-resizing');
    sidebarResizerEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  sidebarResizerEl.addEventListener('pointermove', handleMove);
  sidebarResizerEl.addEventListener('pointerup', (event) => {
    sidebarResizerEl.releasePointerCapture?.(event.pointerId);
    finishDrag();
  });
  sidebarResizerEl.addEventListener('pointercancel', finishDrag);
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('resize', () => applySidebarWidth(loadSidebarWidth()));
}

function setupListResizer() {
  if (!listResizerEl) return;

  applyListPanelWidth(loadListPanelWidth());
  requestAnimationFrame(() => applyListPanelWidth(loadListPanelWidth()));

  let dragging = false;

  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    contentArea.classList.remove('is-resizing');
  };

  const handleMove = (event) => {
    if (!dragging) return;
    const rect = contentArea.getBoundingClientRect();
    const nextWidth = event.clientX - rect.left;
    applyListPanelWidth(nextWidth, { persist: true });
  };

  listResizerEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    contentArea.classList.add('is-resizing');
    listResizerEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  listResizerEl.addEventListener('pointermove', handleMove);
  listResizerEl.addEventListener('pointerup', (event) => {
    listResizerEl.releasePointerCapture?.(event.pointerId);
    finishDrag();
  });
  listResizerEl.addEventListener('pointercancel', finishDrag);
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('resize', () => applyListPanelWidth(loadListPanelWidth()));
}

// ── Settings rail navigation ───────────────────
function activateSettingsSection(sectionId) {
  document.querySelectorAll('.settings-rail-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === sectionId);
  });
  document.querySelectorAll('.settings-section').forEach(sec => {
    sec.classList.toggle('hidden', sec.id !== 'section-' + sectionId);
  });
  if (sectionId === 'stats') renderReadingStats();
  if (sectionId === 'feeds') renderFeedSettingsList();
  if (sectionId === 'translation') refreshDeepSeekBalance({ silent: true });
}

// ── Appearance controls ────────────────────────
function initAppearanceControls() {
  if (themeControl) {
    themeControl.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === currentTheme);
      btn.addEventListener('click', () => {
        currentTheme = btn.dataset.value;
        themeControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.body.dataset.theme = currentTheme;
      });
    });
  }
  if (accentSwatches) {
    accentSwatches.querySelectorAll('.swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.accent === currentAccent);
      sw.addEventListener('click', () => {
        currentAccent = sw.dataset.accent;
        accentSwatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s === sw));
        document.body.dataset.accent = currentAccent;
      });
    });
  }
  if (fontscaleControl) {
    fontscaleControl.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === currentFontScale);
      btn.addEventListener('click', () => {
        currentFontScale = btn.dataset.value;
        fontscaleControl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.body.dataset.fontScale = currentFontScale;
      });
    });
  }
}

function syncAppearanceFromStorage() {
  const t = localStorage.getItem('theme');
  const a = localStorage.getItem('accent');
  const f = localStorage.getItem('font-scale');
  if (t) { currentTheme = t; document.body.dataset.theme = t; }
  if (a) { currentAccent = a; document.body.dataset.accent = a; }
  if (f) { currentFontScale = f; document.body.dataset.fontScale = f; }
}

// ── Global status ──────────────────────────────
function setGlobalStatus(msg, type) {
  if (!globalStatusEl) return;
  globalStatusEl.textContent = msg || '';
  globalStatusEl.className = 'global-status ' + (type || '');
  if (type === 'error' || type === 'success') {
    clearTimeout(globalStatusEl._timeout);
    globalStatusEl._timeout = setTimeout(() => {
      globalStatusEl.textContent = '';
      globalStatusEl.className = 'global-status';
    }, 8000);
  }
}

function isAuthError(error) {
  const msg = String(error).toLowerCase();
  return msg.includes('api key 无效') || msg.includes('401') || msg.includes('authentication');
}

// ── OPML import/export ─────────────────────────
async function exportOpml() {
  try {
    const dialog = window.__TAURI__?.dialog;
    if (!dialog) { setGlobalStatus('对话框插件不可用', 'error'); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await dialog.save({
      title: '导出 OPML',
      defaultPath: `cento-subscriptions-${stamp}.opml`,
      filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }],
    });
    if (!path) return;
    const count = await invoke('export_opml', { path });
    setGlobalStatus(`已导出 ${count} 个订阅源`, 'success');
  } catch (e) {
    setGlobalStatus('导出失败: ' + e, 'error');
  }
}

function selectedPubmedExportFields() {
  try {
    const fields = JSON.parse(localStorage.getItem(PUBMED_EXPORT_FIELDS_STORAGE_KEY) || '[]');
    const allowed = new Set(PUBMED_EXPORT_FIELDS.map(([key]) => key));
    const valid = Array.isArray(fields) ? fields.filter(field => allowed.has(field)) : [];
    return valid.length ? valid : [...DEFAULT_PUBMED_EXPORT_FIELDS];
  } catch {
    return [...DEFAULT_PUBMED_EXPORT_FIELDS];
  }
}

function choosePubmedExportFields(format, count) {
  return new Promise(resolve => {
    const selected = new Set(selectedPubmedExportFields());
    const required = new Set(format === 'xlsx' ? ['pmid'] : []);
    required.forEach(field => selected.add(field));
    const overlay = document.createElement('div');
    overlay.className = 'pubmed-modal';
    overlay.innerHTML = `
      <div class="pubmed-modal-backdrop"></div>
      <section class="pubmed-modal-panel pubmed-export-panel">
        <header class="pubmed-modal-header">
          <div><h2>选择导出字段</h2><p>${format.toUpperCase()} · ${count} 篇文献</p></div>
          <button class="pubmed-modal-close" data-close type="button" aria-label="关闭">×</button>
        </header>
        <div class="pubmed-modal-body">
          <div class="pubmed-export-field-actions">
            <button class="btn btn-secondary btn-sm" data-all type="button">全选</button>
            <button class="btn btn-secondary btn-sm" data-default type="button">常用字段</button>
            <button class="btn btn-secondary btn-sm" data-none type="button">清空</button>
          </div>
          <div class="pubmed-export-field-grid">
            ${PUBMED_EXPORT_FIELDS.map(([key, label]) => `
              <label class="pubmed-export-field">
                <input type="checkbox" value="${key}" ${selected.has(key) ? 'checked' : ''} ${required.has(key) ? 'disabled' : ''} />
                <span>${escapeHtml(label)}</span>
              </label>
            `).join('')}
          </div>
          <p class="pubmed-export-field-status"></p>
        </div>
        <footer class="pubmed-modal-footer">
          <button class="btn btn-secondary" data-close type="button">取消</button>
          <button class="btn btn-primary" data-confirm type="button">继续选择保存位置</button>
        </footer>
      </section>
    `;
    const cleanup = value => {
      overlay.remove();
      resolve(value);
    };
    const setChecks = fields => {
      const values = new Set(fields);
      overlay.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.checked = input.disabled || values.has(input.value);
      });
    };
    overlay.querySelectorAll('[data-close], .pubmed-modal-backdrop').forEach(el => {
      el.addEventListener('click', () => cleanup(null));
    });
    overlay.querySelector('[data-all]').addEventListener('click', () => setChecks(PUBMED_EXPORT_FIELDS.map(([key]) => key)));
    overlay.querySelector('[data-default]').addEventListener('click', () => setChecks(DEFAULT_PUBMED_EXPORT_FIELDS));
    overlay.querySelector('[data-none]').addEventListener('click', () => setChecks([]));
    overlay.querySelector('[data-confirm]').addEventListener('click', () => {
      const fields = [...overlay.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
      if (!fields.length) {
        overlay.querySelector('.pubmed-export-field-status').textContent = '请至少选择一个字段';
        return;
      }
      localStorage.setItem(PUBMED_EXPORT_FIELDS_STORAGE_KEY, JSON.stringify(fields));
      cleanup(fields);
    });
    document.body.appendChild(overlay);
  });
}

function orderPubmedXlsxFields(fields) {
  const selected = new Set(fields);
  return [
    ...PUBMED_DOWNLOADER_XLSX_FIELD_ORDER.filter(field => selected.delete(field)),
    ...fields.filter(field => selected.delete(field)),
  ];
}

function loadNatureDownloadPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem(NATURE_DOWNLOAD_PREFS_STORAGE_KEY) || '{}');
    return {
      accessMode: value.accessMode === 'institution' ? 'institution' : 'oa',
      pathMode: value.pathMode === 'fixed' ? 'fixed' : 'ask',
      fixedFolder: typeof value.fixedFolder === 'string' ? value.fixedFolder : '',
    };
  } catch {
    return { accessMode: 'oa', pathMode: 'ask', fixedFolder: '' };
  }
}

function formatNatureDownloadError(error) {
  const raw = String(error || '').trim();
  if (/CDP proxy not reachable|healthCheck|127\.0\.0\.1:3456\/targets/i.test(raw)) {
    return '未连接到 Chrome 下载会话，请启用 Chrome 远程调试后重试';
  }

  const summary = raw
    .split(/\r?\n/, 1)[0]
    .replace(/\s+at\s+(?:async\s+)?[\s\S]*$/, '')
    .trim();
  if (!summary) return '请稍后重试';
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
}

function chooseNatureDownloadOptions(count) {
  return new Promise(resolve => {
    const prefs = loadNatureDownloadPrefs();
    let fixedFolder = prefs.fixedFolder;
    const overlay = document.createElement('div');
    overlay.className = 'pubmed-modal';
    overlay.innerHTML = `
      <div class="pubmed-modal-backdrop"></div>
      <section class="pubmed-modal-panel nature-download-panel">
        <header class="pubmed-modal-header">
          <div><h2>智能下载 PDF</h2><p>多源解析 · ${count} 篇文献</p></div>
          <button class="pubmed-modal-close" data-close type="button" aria-label="关闭">×</button>
        </header>
        <div class="pubmed-modal-body">
          <label class="pubmed-field">
            <span>全文访问方式</span>
            <select class="settings-select" data-access>
              <option value="oa" ${prefs.accessMode === 'oa' ? 'selected' : ''}>仅使用开放获取来源</option>
              <option value="institution" ${prefs.accessMode === 'institution' ? 'selected' : ''}>使用已配置的机构授权</option>
            </select>
          </label>
          <label class="pubmed-field">
            <span>保存位置</span>
            <select class="settings-select" data-path-mode>
              <option value="ask" ${prefs.pathMode === 'ask' ? 'selected' : ''}>每次询问保存文件夹</option>
              <option value="fixed" ${prefs.pathMode === 'fixed' ? 'selected' : ''}>使用固定下载文件夹</option>
            </select>
          </label>
          <div class="nature-download-folder-row ${prefs.pathMode === 'fixed' ? '' : 'hidden'}" data-folder-row>
            <div class="nature-download-folder" data-folder>${escapeHtml(fixedFolder || '尚未选择文件夹')}</div>
            <button class="btn btn-secondary btn-sm" data-choose-folder type="button">选择文件夹</button>
          </div>
          <p class="nature-download-note">机构授权模式只使用你本人已登录并获授权的浏览器会话；不会读取或保存账号、密码和验证码。</p>
          <p class="pubmed-export-field-status" data-status></p>
        </div>
        <footer class="pubmed-modal-footer">
          <button class="btn btn-secondary" data-close type="button">取消</button>
          <button class="btn btn-primary" data-confirm type="button">开始下载</button>
        </footer>
      </section>
    `;
    const pathMode = overlay.querySelector('[data-path-mode]');
    const folderRow = overlay.querySelector('[data-folder-row]');
    const folderLabel = overlay.querySelector('[data-folder]');
    const cleanup = value => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelectorAll('[data-close], .pubmed-modal-backdrop').forEach(el => {
      el.addEventListener('click', () => cleanup(null));
    });
    pathMode.addEventListener('change', () => folderRow.classList.toggle('hidden', pathMode.value !== 'fixed'));
    overlay.querySelector('[data-choose-folder]').addEventListener('click', async () => {
      const path = await window.__TAURI__?.dialog?.open({ title: '选择固定 PDF 下载文件夹', directory: true, multiple: false });
      if (!path) return;
      fixedFolder = Array.isArray(path) ? path[0] : path;
      folderLabel.textContent = fixedFolder;
    });
    overlay.querySelector('[data-confirm]').addEventListener('click', () => {
      const value = {
        accessMode: overlay.querySelector('[data-access]').value,
        pathMode: pathMode.value,
        fixedFolder,
      };
      if (value.pathMode === 'fixed' && !value.fixedFolder) {
        overlay.querySelector('[data-status]').textContent = '请先选择固定下载文件夹';
        return;
      }
      localStorage.setItem(NATURE_DOWNLOAD_PREFS_STORAGE_KEY, JSON.stringify(value));
      cleanup(value);
    });
    document.body.appendChild(overlay);
  });
}

async function downloadEntriesWithNature(entries) {
  if (!entries.length) return;
  if (entries.length > 20) {
    setGlobalStatus('智能 PDF 下载单次最多支持 20 篇，请缩小勾选范围', 'error');
    return;
  }
  const options = await chooseNatureDownloadOptions(entries.length);
  if (!options) return;
  let outputDir = options.fixedFolder;
  if (options.pathMode === 'ask') {
    const path = await window.__TAURI__?.dialog?.open({ title: '选择 PDF 保存文件夹', directory: true, multiple: false });
    if (!path) return;
    outputDir = Array.isArray(path) ? path[0] : path;
  }
  setGlobalStatus(`正在下载 ${entries.length} 篇 PDF…`, 'progress');
  try {
    const report = await invoke('download_papers_with_nature', {
      items: entries.map(entry => ({
        title: entry.title || entry.title_translated || '',
        doi: entry.doi || null,
        pmid: entry.pmid || null,
        pmcid: entry.pmcid || null,
      })),
      outputDir,
      openAccess: options.accessMode === 'oa',
    });
    const handoff = report.needs_user_action ? `，${report.needs_user_action} 篇需要在浏览器完成登录或验证` : '';
    setGlobalStatus(`PDF 下载完成：成功 ${report.downloaded}/${report.total}${handoff}`, report.needs_user_action ? 'error' : 'success');
  } catch (e) {
    console.error('PDF 下载失败:', e);
    setGlobalStatus(`PDF 下载失败：${formatNatureDownloadError(e)}`, 'error');
  }
}

function pubmedExportMetrics(entries) {
  return entries.map(entry => {
    const metric = lookupJournalMetrics(entry);
    const hasTop = metric && ['0', '1'].includes(String(metric.top));
    return {
      entry_id: entry.id,
      impact_factor: metric && hasVisibleMetric(metric.if) ? String(metric.if) : null,
      jcr_quartile: metric && hasVisibleMetric(metric.q) ? String(metric.q) : null,
      cas_partition: metric && hasVisibleMetric(metric.b) ? formatCasPartition(metric.b) : null,
      is_top: hasTop ? String(metric.top) === '1' : null,
    };
  });
}

function safeExportFileName(value) {
  return String(value || 'pubmed').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, '-').slice(0, 60);
}

async function exportCurrentPubmedEntries(formatOverride = null, sourceButton = btnExportPubmed) {
  if (!['pubmed', 'kept'].includes(mode)) return;
  const selected = getSelectedEntries();
  const entries = selected.length ? selected : getFilteredPubmedEntries(allEntries);
  if (!entries.length) {
    setGlobalStatus('当前没有可导出的文献', 'error');
    return;
  }
  const format = (formatOverride || pubmedExportFormat?.value) === 'txt' ? 'txt' : 'xlsx';
  const selectedFields = await choosePubmedExportFields(format, entries.length);
  if (!selectedFields) return;
  const fields = format === 'xlsx' ? orderPubmedXlsxFields(selectedFields) : selectedFields;
  const dialog = window.__TAURI__?.dialog;
  if (!dialog) {
    setGlobalStatus('对话框插件不可用', 'error');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const scopeName = mode === 'kept' ? '保留文献' : currentPubmedSearch?.name;
  const path = await dialog.save({
    title: `导出 PubMed ${format.toUpperCase()}`,
    defaultPath: `${safeExportFileName(scopeName)}-${stamp}.${format}`,
    filters: [{ name: format === 'xlsx' ? 'Excel' : 'PubMed TXT', extensions: [format] }],
  });
  if (!path) return;
  if (sourceButton) sourceButton.disabled = true;
  try {
    const count = await invoke('export_pubmed_entries', {
      path,
      format,
      searchId: mode === 'pubmed' ? currentPubmedSearch?.id : null,
      entryIds: entries.map(entry => entry.id),
      fields,
      metrics: pubmedExportMetrics(entries),
    });
    setGlobalStatus(`已导出 ${count} 篇文献${selected.length ? '（当前勾选）' : '（当前筛选结果）'}`, 'success');
  } catch (e) {
    setGlobalStatus('导出失败: ' + e, 'error');
  } finally {
    if (sourceButton) sourceButton.disabled = false;
  }
}

function loadPubmedSnapshots() {
  try {
    const snapshots = JSON.parse(localStorage.getItem(PUBMED_SNAPSHOT_STORAGE_KEY) || '[]');
    return Array.isArray(snapshots) ? snapshots.filter(item => item?.id && item?.scope && Array.isArray(item.entryIds)) : [];
  } catch {
    return [];
  }
}

function persistPubmedSnapshots() {
  localStorage.setItem(PUBMED_SNAPSHOT_STORAGE_KEY, JSON.stringify(pubmedSnapshots));
}

function currentPubmedSnapshotScope() {
  if (mode === 'kept') return 'kept';
  return currentPubmedSearch ? `search:${currentPubmedSearch.id}` : '';
}

function currentPubmedSnapshots() {
  const scope = currentPubmedSnapshotScope();
  return scope ? pubmedSnapshots.filter(snapshot => snapshot.scope === scope) : [];
}

function currentPubmedSnapshot() {
  return activePubmedSnapshotId
    ? currentPubmedSnapshots().find(snapshot => snapshot.id === activePubmedSnapshotId) || null
    : null;
}

function refreshPubmedSnapshotControls() {
  if (!pubmedSnapshotSelect) return;
  const snapshots = currentPubmedSnapshots();
  if (activePubmedSnapshotId && !snapshots.some(snapshot => snapshot.id === activePubmedSnapshotId)) {
    activePubmedSnapshotId = null;
  }
  pubmedSnapshotSelect.innerHTML = '<option value="">实时筛选</option>' + snapshots.map(snapshot => (
    `<option value="${escapeHtml(snapshot.id)}">${escapeHtml(snapshot.name)} (${snapshot.entryIds.length})</option>`
  )).join('');
  pubmedSnapshotSelect.value = activePubmedSnapshotId || '';
  btnDeletePubmedSnapshot?.classList.toggle('hidden', !activePubmedSnapshotId);
}

let activePubmedMonthPicker = null;

function closePubmedMonthPicker() {
  if (!activePubmedMonthPicker) return;
  const { picker, onOutsidePointerDown, onKeyDown, onResize } = activePubmedMonthPicker;
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', onResize);
  picker.remove();
  activePubmedMonthPicker = null;
}

function openPubmedMonthPicker(input) {
  closePubmedMonthPicker();
  const current = input.value.match(/^(\d{4})-(\d{2})$/);
  let year = current ? Number(current[1]) : new Date().getFullYear();
  const selectedMonth = current ? Number(current[2]) : null;
  const picker = document.createElement('div');
  picker.className = 'pubmed-month-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', input.getAttribute('aria-label') || '选择月份');

  const positionPicker = () => {
    const rect = input.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - picker.offsetWidth - 8);
    const below = rect.bottom + 6;
    const top = below + picker.offsetHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, rect.top - picker.offsetHeight - 6);
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
  };

  const renderPicker = () => {
    picker.innerHTML = `
      <div class="pubmed-month-picker-header">
        <button class="pubmed-month-picker-nav" type="button" data-year-step="-1" aria-label="上一年">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 4.5-3.5 3.5 3.5 3.5" /></svg>
        </button>
        <strong>${year} 年</strong>
        <button class="pubmed-month-picker-nav" type="button" data-year-step="1" aria-label="下一年">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 4.5 3.5 3.5-3.5 3.5" /></svg>
        </button>
      </div>
      <div class="pubmed-month-picker-grid">
        ${Array.from({ length: 12 }, (_, index) => {
          const month = index + 1;
          const selected = year === Number(current?.[1]) && month === selectedMonth;
          return `<button class="pubmed-month-picker-month${selected ? ' selected' : ''}" type="button" data-month="${month}"${selected ? ' aria-current="date"' : ''}>${month} 月</button>`;
        }).join('')}
      </div>
      <button class="pubmed-month-picker-clear" type="button">清除</button>
    `;
    picker.querySelectorAll('[data-year-step]').forEach(button => {
      button.addEventListener('click', () => {
        year += Number(button.dataset.yearStep);
        renderPicker();
        positionPicker();
      });
    });
    picker.querySelectorAll('[data-month]').forEach(button => {
      button.addEventListener('click', () => {
        input.value = `${year}-${String(button.dataset.month).padStart(2, '0')}`;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closePubmedMonthPicker();
        input.focus();
      });
    });
    picker.querySelector('.pubmed-month-picker-clear')?.addEventListener('click', () => {
      input.value = '';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closePubmedMonthPicker();
      input.focus();
    });
  };

  const onOutsidePointerDown = event => {
    if (event.target !== input && !picker.contains(event.target)) closePubmedMonthPicker();
  };
  const onKeyDown = event => {
    if (event.key === 'Escape') closePubmedMonthPicker();
  };
  const onResize = () => positionPicker();
  activePubmedMonthPicker = { picker, onOutsidePointerDown, onKeyDown, onResize };
  document.body.appendChild(picker);
  renderPicker();
  positionPicker();
  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);
}

function setupPubmedMonthPicker(input) {
  input?.addEventListener('click', () => openPubmedMonthPicker(input));
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      openPubmedMonthPicker(input);
    }
  });
}

function syncPubmedFilterInputs() {
  if (pubmedStatusFilter) pubmedStatusFilter.value = pubmedFilters.status;
  if (pubmedSort) pubmedSort.value = pubmedFilters.sort;
  if (pubmedStarFilter) pubmedStarFilter.value = pubmedFilters.star;
  if (pubmedPublishedFrom) pubmedPublishedFrom.value = pubmedFilters.publishedFrom;
  if (pubmedPublishedTo) pubmedPublishedTo.value = pubmedFilters.publishedTo;
  if (pubmedAddedFrom) pubmedAddedFrom.value = pubmedFilters.addedFrom;
  if (pubmedAddedTo) pubmedAddedTo.value = pubmedFilters.addedTo;
}

function syncCompactFilterSummaries() {
  const pubmedActiveCount = [
    pubmedFilters.status !== 'all',
    pubmedFilters.sort !== 'publication-desc',
    Boolean(pubmedFilters.publishedFrom),
    Boolean(pubmedFilters.publishedTo),
    Boolean(pubmedFilters.addedFrom),
    Boolean(pubmedFilters.addedTo),
    Boolean(activePubmedSnapshotId),
  ].filter(Boolean).length;
  const metricActiveCount = Object.values(entryMetricFilters).filter(value => value !== 'all').length
    + (entryTagFilterValue !== 'all' ? 1 : 0)
    + (['pubmed', 'kept'].includes(mode) && pubmedFilters.star !== 'all' ? 1 : 0);
  if (entryMetricFilterSummaryCount) {
    const activeCount = metricActiveCount + (['pubmed', 'kept'].includes(mode) ? pubmedActiveCount : 0);
    entryMetricFilterSummaryCount.textContent = activeCount ? `${activeCount} 项` : '';
  }
}

function activatePubmedSnapshot(snapshotId) {
  activePubmedSnapshotId = snapshotId || null;
  const snapshot = currentPubmedSnapshot();
  if (snapshot) {
    pubmedFilters.star = 'all';
    Object.assign(pubmedFilters, snapshot.filters || {});
    Object.assign(entryMetricFilters, snapshot.metricFilters || {});
    entryTagFilterValue = snapshot.tagFilter || 'all';
    syncPubmedFilterInputs();
    syncEntryMetricFilterControls();
    persistEntryMetricFilters();
    refreshEntryTagFilterOptions(allEntries);
    if (entryTagFilter) entryTagFilter.value = entryTagFilterValue;
  }
  persistCurrentFilterScope();
  clearEntrySelection({ render: false, syncPaperChat: false });
  pubmedRenderLimit = 200;
  refreshPubmedSnapshotControls();
  renderEntryList(allEntries);
  refreshPaperChatAfterScopeDataChange();
}

function saveCurrentPubmedSnapshot() {
  if (!['pubmed', 'kept'].includes(mode)) return;
  const entries = getFilteredPubmedEntries(allEntries);
  if (!entries.length) {
    setGlobalStatus('当前筛选结果为空，无法保存快照', 'error');
    return;
  }
  const now = new Date();
  const defaultName = `快照 ${now.toLocaleDateString('zh-CN')} ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  const name = window.prompt('快照名称', defaultName)?.trim();
  if (!name) return;
  const snapshot = {
    id: `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scope: currentPubmedSnapshotScope(),
    name: name.slice(0, 60),
    entryIds: entries.map(entry => entry.id),
    filters: { ...pubmedFilters },
    metricFilters: { ...entryMetricFilters },
    tagFilter: entryTagFilterValue,
    createdAt: now.toISOString(),
  };
  pubmedSnapshots.push(snapshot);
  persistPubmedSnapshots();
  activePubmedSnapshotId = snapshot.id;
  persistCurrentFilterScope();
  refreshPubmedSnapshotControls();
  renderEntryList(allEntries);
  setGlobalStatus(`已保存快照“${snapshot.name}”，共 ${snapshot.entryIds.length} 篇`, 'success');
}

async function deleteCurrentPubmedSnapshot() {
  const snapshot = currentPubmedSnapshot();
  if (!snapshot) return;
  const confirmed = await confirmDialog(`删除筛选快照“${snapshot.name}”？`, {
    okLabel: '删除', cancelLabel: '取消', danger: true,
  });
  if (!confirmed) return;
  pubmedSnapshots = pubmedSnapshots.filter(item => item.id !== snapshot.id);
  persistPubmedSnapshots();
  activePubmedSnapshotId = null;
  persistCurrentFilterScope();
  refreshPubmedSnapshotControls();
  renderEntryList(allEntries);
  setGlobalStatus('筛选快照已删除', 'success');
}

async function importOpml() {
  try {
    const dialog = window.__TAURI__?.dialog;
    if (!dialog) { setGlobalStatus('对话框插件不可用', 'error'); return; }
    const path = await dialog.open({
      title: '导入 OPML',
      multiple: false,
      directory: false,
      filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }],
    });
    if (!path) return;
    const filePath = Array.isArray(path) ? path[0] : path;
    const report = await invoke('import_opml', { path: filePath });
    const parts = [`新增 ${report.added}`, `已存在 ${report.skipped}`];
    if (report.errors?.length) parts.push(`失败 ${report.errors.length}`);
    setGlobalStatus('导入完成：' + parts.join('，'), report.errors?.length ? 'error' : 'success');
    await loadFeeds();
    if (!document.getElementById('section-feeds')?.classList.contains('hidden')) {
      renderFeedSettingsList();
    }
  } catch (e) {
    setGlobalStatus('导入失败: ' + e, 'error');
  }
}

// ── Feed management ────────────────────────────
let pubmedEditingSearchId = null;
let pubmedSearchBuilderMode = 'topic';

function pubmedRetrievalScope() {
  return document.querySelector('input[name="pubmed-retrieval-scope"]:checked')?.value || '';
}

function pubmedRetrievalOptionsFromForm() {
  const scope = pubmedRetrievalScope();
  const rawLimit = Number(document.getElementById('pubmed-retrieval-limit')?.value || 0);
  const dateFrom = document.getElementById('pubmed-retrieval-date-from')?.value || '';
  const dateTo = document.getElementById('pubmed-retrieval-date-to')?.value || '';
  if (!scope) throw new Error('请选择正式抓取范围');
  if (scope === 'custom' && (!Number.isSafeInteger(rawLimit) || rawLimit < 1)) {
    throw new Error('自定义抓取数量必须是正整数');
  }
  if (scope === 'date_range' || (scope === 'custom' && (dateFrom || dateTo))) {
    if (!dateFrom || !dateTo) throw new Error('请选择完整的开始和结束日期');
    if (dateFrom > dateTo) throw new Error('开始日期不能晚于结束日期');
  }
  const usesDateRange = scope === 'date_range' || (scope === 'custom' && dateFrom && dateTo);
  return {
    scope,
    limit: scope === 'top' ? 10000 : (scope === 'custom' ? rawLimit : null),
    date_from: usesDateRange ? dateFrom : null,
    date_to: usesDateRange ? dateTo : null,
    sort: document.getElementById('pubmed-retrieval-sort')?.value || 'most_recent',
  };
}

function updatePubmedRetrievalUi() {
  const scope = pubmedRetrievalScope();
  document.getElementById('pubmed-retrieval-custom-row')?.classList.toggle('hidden', scope !== 'custom');
  document.getElementById('pubmed-retrieval-date-row')?.classList.toggle('hidden', !['custom', 'date_range'].includes(scope));
  const optionalDate = scope === 'custom';
  const fromLabel = document.getElementById('pubmed-retrieval-date-from-label');
  const toLabel = document.getElementById('pubmed-retrieval-date-to-label');
  if (fromLabel) fromLabel.textContent = optionalDate ? '开始日期（可选）' : '开始日期';
  if (toLabel) toLabel.textContent = optionalDate ? '结束日期（可选）' : '结束日期';
  const total = Number(pubmedPreview?.total_count || 0);
  const count = document.getElementById('pubmed-retrieval-all-count');
  if (count) count.textContent = total ? `(${total.toLocaleString('zh-CN')} 篇)` : '';
  const button = document.getElementById('btn-create-pubmed-search');
  if (!button) return;
  const prefix = pubmedEditingSearchId ? '保存并更新' : '创建并抓取';
  if (pubmedPreview && !scope) {
    button.textContent = '请选择抓取范围';
    button.disabled = true;
    return;
  }
  button.disabled = !pubmedPreview;
  let suffix = '';
  if (pubmedPreview) {
    if (scope === 'all') {
      suffix = `全部 ${total.toLocaleString('zh-CN')} 篇`;
    } else if (scope === 'date_range') {
      suffix = '所选日期范围';
    } else if (scope === 'top') {
      suffix = `前 ${Math.min(10000, total).toLocaleString('zh-CN')} 篇`;
    } else if (scope === 'custom') {
      const limit = Number(document.getElementById('pubmed-retrieval-limit')?.value || 0);
      if (limit > 0) {
        const hasDates = document.getElementById('pubmed-retrieval-date-from')?.value
          && document.getElementById('pubmed-retrieval-date-to')?.value;
        suffix = `${hasDates ? '所选日期内' : ''}最多 ${Math.min(limit, total).toLocaleString('zh-CN')} 篇`;
      }
    }
  }
  button.textContent = suffix ? `${prefix}${suffix}` : prefix;
}

function invalidatePubmedPreview() {
  const hadPreview = !!pubmedPreview;
  pubmedPreview = null;
  pubmedPreviewAssessment = null;
  pubmedPreviewSettingsReturnPending = false;
  document.getElementById('btn-create-pubmed-search').disabled = true;
  document.getElementById('pubmed-retrieval-panel').disabled = true;
  document.getElementById('pubmed-preview-results')?.classList.add('hidden');
  if (hadPreview) {
    document.getElementById('pubmed-preview-status').textContent = '检索式有变化，请重新预览';
  }
  updatePubmedRetrievalUi();
}

function setPubmedRetrievalForm(source) {
  document.querySelectorAll('input[name="pubmed-retrieval-scope"]').forEach(input => {
    input.checked = false;
  });
  const scope = source?.retrieval_scope || '';
  const target = scope
    ? document.querySelector(`input[name="pubmed-retrieval-scope"][value="${scope}"]`)
    : null;
  if (target) target.checked = true;
  const limit = document.getElementById('pubmed-retrieval-limit');
  if (limit) limit.value = String(source?.retrieval_limit || 10000);
  const dateFrom = document.getElementById('pubmed-retrieval-date-from');
  const dateTo = document.getElementById('pubmed-retrieval-date-to');
  if (dateFrom) dateFrom.value = source?.retrieval_date_from || '';
  if (dateTo) dateTo.value = source?.retrieval_date_to || '';
  const sort = document.getElementById('pubmed-retrieval-sort');
  if (sort) sort.value = source?.retrieval_sort || 'most_recent';
  updatePubmedRetrievalUi();
}

function setPubmedSearchBuilderMode(nextMode) {
  pubmedSearchBuilderMode = nextMode === 'author' ? 'author' : 'topic';
  document.querySelectorAll('[data-pubmed-search-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.pubmedSearchMode === pubmedSearchBuilderMode);
  });
  document.getElementById('pubmed-topic-builder')?.classList.toggle('hidden', pubmedSearchBuilderMode !== 'topic');
  document.getElementById('pubmed-author-builder')?.classList.toggle('hidden', pubmedSearchBuilderMode !== 'author');
  invalidatePubmedPreview();
}

function openPubmedSearchModal({ source = null, editing = false } = {}) {
  const modal = document.getElementById('pubmed-search-modal');
  if (!modal) return;
  pubmedEditingSearchId = editing ? source?.id || null : null;
  document.getElementById('pubmed-question').value = source?.question || '';
  document.getElementById('pubmed-batch-query-input').value = source?.query || '';
  document.getElementById('pubmed-author-name').value = '';
  document.getElementById('pubmed-author-affiliation').value = '';
  document.getElementById('pubmed-author-start-date').value = '';
  document.getElementById('pubmed-author-end-date').value = '';
  document.getElementById('pubmed-search-name').value = source
    ? (editing ? source.name : `${source.name} 副本`)
    : '';
  setPubmedRetrievalForm(source);
  document.getElementById('pubmed-modal-title').textContent = editing ? '编辑 PubMed 检索' : '新建 PubMed 检索';
  document.getElementById('pubmed-modal-description').textContent = editing
    ? '保存后保留历史文献与筛选记录，后续更新使用新的检索式。'
    : '确认检索式后，Cento 将直接从 PubMed 抓取并持续更新。';
  document.getElementById('pubmed-preview-status').textContent = '';
  document.getElementById('pubmed-preview-results').innerHTML = '';
  document.getElementById('pubmed-preview-results').classList.add('hidden');
  document.getElementById('btn-create-pubmed-search').disabled = true;
  document.getElementById('pubmed-retrieval-panel').disabled = true;
  document.getElementById('pubmed-preview-ai-enabled').checked = true;
  pubmedPreview = null;
  pubmedPreviewAssessment = null;
  updatePubmedRetrievalUi();
  setPubmedSearchBuilderMode('topic');
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById(source ? 'pubmed-batch-query-input' : 'pubmed-question')?.focus(), 0);
}

async function buildPubmedAuthorQuery() {
  const authorName = document.getElementById('pubmed-author-name').value.trim();
  const affiliation = document.getElementById('pubmed-author-affiliation').value.trim();
  const startDate = document.getElementById('pubmed-author-start-date').value;
  const endDate = document.getElementById('pubmed-author-end-date').value;
  const button = document.getElementById('btn-build-pubmed-author-query');
  const status = document.getElementById('pubmed-preview-status');
  button.disabled = true;
  status.textContent = 'AI 正在识别作者和机构并构建检索式…';
  try {
    const query = await invoke('build_pubmed_author_query', {
      authorName,
      affiliation: affiliation || null,
      startDate: startDate || null,
      endDate: endDate || null,
    });
    loadCostSummary();
    document.getElementById('pubmed-batch-query-input').value = query;
    const nameInput = document.getElementById('pubmed-search-name');
    if (!nameInput.value.trim()) nameInput.value = `【作者｜${authorName}】`;
    document.getElementById('pubmed-question').value = `持续关注作者 ${authorName}${affiliation ? `（${affiliation}）` : ''} 的 PubMed 文献`;
    invalidatePubmedPreview();
    status.textContent = 'AI 作者检索式已构建，请预览并核对作者与机构';
  } catch (e) {
    status.textContent = `构建失败：${e}`;
  } finally {
    button.disabled = false;
  }
}

function closePubmedSearchModal() {
  document.getElementById('pubmed-search-modal')?.classList.add('hidden');
  pubmedEditingSearchId = null;
  pubmedPreviewSettingsReturnPending = false;
}

async function generatePubmedQuery() {
  const question = document.getElementById('pubmed-question').value.trim();
  const button = document.getElementById('btn-generate-pubmed-query');
  const status = document.getElementById('pubmed-preview-status');
  if (!question) {
    status.textContent = '请先填写研究问题';
    return;
  }
  button.disabled = true;
  status.textContent = '正在生成检索式…';
  try {
    const query = await invoke('natural_to_pubmed_query', { text: question });
    loadCostSummary();
    document.getElementById('pubmed-batch-query-input').value = query;
    invalidatePubmedPreview();
    status.textContent = '检索式已生成，可继续修改';
  } catch (e) {
    status.textContent = `AI 生成失败：${e}。仍可手工输入检索式。`;
  } finally {
    button.disabled = false;
  }
}

function openPubmedQueryInBrowser() {
  const input = document.getElementById('pubmed-batch-query-input');
  const query = input?.value.trim() || '';
  const status = document.getElementById('pubmed-preview-status');
  if (!query) {
    if (status) status.textContent = '请先填写 PubMed 检索式';
    input?.focus();
    return;
  }

  const url = new URL('https://pubmed.ncbi.nlm.nih.gov/');
  url.searchParams.set('term', query);
  openUrl(url.toString());
}

function pubmedPreviewEntryAssessmentMeta(status) {
  return {
    relevant: { label: '符合', className: 'relevant' },
    maybe: { label: '待确认', className: 'maybe' },
    irrelevant: { label: '不符合', className: 'irrelevant' },
  }[status] || { label: '待确认', className: 'maybe' };
}

function pubmedPreviewVerdictMeta(verdict) {
  return {
    good: { label: '匹配较好', className: 'good' },
    refine: { label: '建议调整', className: 'refine' },
    poor: { label: '偏题较多', className: 'poor' },
  }[verdict] || { label: '建议复核', className: 'refine' };
}

function pubmedPreviewRecallRiskMeta(risk) {
  return {
    low: { label: '低', className: 'low' },
    moderate: { label: '中', className: 'moderate' },
    high: { label: '高', className: 'high' },
  }[risk] || { label: '中', className: 'moderate' };
}

function truncatePubmedPreviewText(value, limit = 320) {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function renderPubmedPreviewResults(preview, assessment = null, assessmentError = '') {
  const results = document.getElementById('pubmed-preview-results');
  if (!results || !preview) return;
  const assessmentByPmid = new Map((assessment?.entries || []).map(item => [item.pmid, item]));
  const renderSampleEntry = entry => {
    const itemAssessment = assessmentByPmid.get(entry.pmid);
    const assessmentMeta = itemAssessment
      ? pubmedPreviewEntryAssessmentMeta(itemAssessment.status)
      : null;
    const abstractText = truncatePubmedPreviewText(entry.abstract_text || '暂无摘要');
    return `
      <div class="pubmed-preview-item">
        <div class="pubmed-preview-item-heading">
          <div class="pubmed-preview-item-title">${escapeHtml(entry.title)}</div>
          ${assessmentMeta ? `<span class="pubmed-preview-entry-status ${assessmentMeta.className}">${assessmentMeta.label}</span>` : ''}
        </div>
        <div class="pubmed-preview-item-meta">${escapeHtml(shortJournalDisplayName(entry.journal) || '期刊待确认')} · ${escapeHtml(formatPubmedPublicationDate(entry) || '日期待确认')} · PMID ${escapeHtml(entry.pmid)}</div>
        <div class="pubmed-preview-item-abstract">${escapeHtml(abstractText)}</div>
        ${itemAssessment?.reason ? `<div class="pubmed-preview-item-reason">${escapeHtml(itemAssessment.reason)}</div>` : ''}
        ${pubmedSearchBuilderMode === 'author' ? `<div class="pubmed-preview-item-meta">作者：${escapeHtml(entry.authors || '作者待确认')}</div><div class="pubmed-preview-item-meta">机构：${escapeHtml(entry.affiliation || '机构待确认')}</div>` : ''}
      </div>`;
  };
  const sampleEntries = preview.entries || [];
  const previews = sampleEntries.slice(0, 5).map(renderSampleEntry).join('');
  const remainingSamples = sampleEntries.slice(5).map(renderSampleEntry).join('');

  let assessmentHtml = '';
  if (assessment) {
    const verdict = pubmedPreviewVerdictMeta(assessment.verdict);
    const recallRisk = pubmedPreviewRecallRiskMeta(assessment.recall_risk);
    const coverageGaps = (assessment.coverage_gaps || [])
      .map(gap => `<li>${escapeHtml(gap)}</li>`)
      .join('');
    assessmentHtml = `
      <section class="pubmed-preview-assessment ${verdict.className}">
        <div class="pubmed-preview-assessment-heading">
          <strong>AI 检索式质量评估</strong>
          <span class="pubmed-preview-verdict ${verdict.className}">${verdict.label}</span>
        </div>
        <div class="pubmed-preview-quality-grid">
          <div><span>查准率估计</span><strong>${Number(assessment.precision_percent || 0).toFixed(1)}%</strong><small>95% CI ${Number(assessment.precision_low_percent || 0).toFixed(1)}–${Number(assessment.precision_high_percent || 0).toFixed(1)}%</small></div>
          <div><span>查全风险</span><strong class="${recallRisk.className}">${recallRisk.label}</strong><small>不等同于真实查全率</small></div>
          <div><span>抽样规模</span><strong>${assessment.sample_size || assessment.entries?.length || 0}</strong><small>当前排序结果等距抽样</small></div>
          <div><span>摘要可用</span><strong>${assessment.abstract_count || 0}</strong><small>其余仅依据题名判断</small></div>
        </div>
        <div class="pubmed-preview-assessment-counts">
          <span class="relevant">符合 ${assessment.relevant_count}</span>
          <span class="maybe">待确认 ${assessment.maybe_count}</span>
          <span class="irrelevant">不符合 ${assessment.irrelevant_count}</span>
        </div>
        <p>${escapeHtml(assessment.summary || '')}</p>
        <div class="pubmed-preview-recall-note">${escapeHtml(assessment.recall_assessment || '')}</div>
        ${coverageGaps ? `<div class="pubmed-preview-coverage-gaps"><strong>可能的覆盖缺口</strong><ul>${coverageGaps}</ul></div>` : ''}
        ${assessment.suggested_query ? `
          <div class="pubmed-preview-suggested-query">
            <div class="pubmed-preview-suggested-query-heading">
              <strong>建议检索式</strong>
              <button class="btn btn-secondary btn-sm" type="button" data-use-suggested-query>采用建议检索式</button>
            </div>
            <code>${escapeHtml(assessment.suggested_query)}</code>
          </div>` : ''}
      </section>`;
  } else if (assessmentError) {
    const friendlyError = formatPubmedPreviewAssessmentError(assessmentError);
    assessmentHtml = `
      <div class="pubmed-preview-assessment-error">
        <span>${escapeHtml(friendlyError)}</span>
        <div class="pubmed-preview-error-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-open-ai-settings>前往 AI 设置</button>
          <button class="btn btn-secondary btn-sm" type="button" data-retry-ai-assessment>重试 AI 初判</button>
        </div>
      </div>`;
  }

  results.innerHTML = `
    ${assessmentHtml}
    <div class="pubmed-preview-summary">抽样题名与摘要 · 显示前 ${Math.min(5, sampleEntries.length)} 篇${assessment ? ` · AI 已判断 ${assessment.entries?.length || 0} 篇` : ''}</div>
    ${previews || '<div class="pubmed-preview-item-meta">没有可预览记录</div>'}
    ${remainingSamples ? `<details class="pubmed-preview-sample-details"><summary>查看其余 ${sampleEntries.length - 5} 篇抽样文献</summary><div>${remainingSamples}</div></details>` : ''}
  `;
  results.classList.remove('hidden');

  results.querySelector('[data-use-suggested-query]')?.addEventListener('click', () => {
    const queryInput = document.getElementById('pubmed-batch-query-input');
    if (!queryInput || !assessment?.suggested_query) return;
    queryInput.value = assessment.suggested_query;
    invalidatePubmedPreview();
    document.getElementById('pubmed-preview-status').textContent = '已采用 AI 建议检索式，请重新预览';
    queryInput.focus();
  });
  results.querySelector('[data-open-ai-settings]')?.addEventListener('click', () => {
    pubmedPreviewSettingsReturnPending = true;
    document.getElementById('pubmed-search-modal')?.classList.add('hidden');
    showSettings('translation');
  });
  results.querySelector('[data-retry-ai-assessment]')?.addEventListener('click', retryPubmedPreviewAssessment);
}

function formatPubmedPreviewAssessmentError(error) {
  const message = String(error || '未知错误');
  if (/token plan limit exhausted|insufficient quota|quota exceeded|额度已用尽/i.test(message)) {
    return '当前 AI 服务额度已用尽。请更换可用的 API Key 或服务商后重试；PubMed 预览结果已保留。';
  }
  if (/429|请求过于频繁|rate limit/i.test(message)) {
    return '当前 AI 服务请求过于频繁。请稍后重试或更换服务商；PubMed 预览结果已保留。';
  }
  return `AI 初判失败：${message}。你仍可人工检查预览结果。`;
}

async function retryPubmedPreviewAssessment() {
  if (!pubmedPreview) return;
  const question = document.getElementById('pubmed-question')?.value.trim() || '';
  const status = document.getElementById('pubmed-preview-status');
  const button = document.getElementById('btn-preview-pubmed-search');
  if (!question) {
    status.textContent = '请先填写研究问题';
    return;
  }

  button.disabled = true;
  status.textContent = `AI 正在重新评估 ${pubmedPreview.entries.length} 篇样本…`;
  try {
    pubmedPreviewAssessment = await invoke('assess_pubmed_search_preview', {
      question,
      query: pubmedPreview.query,
      entries: pubmedPreview.entries,
    });
    pubmedPreviewSettingsReturnPending = false;
    loadCostSummary();
    renderPubmedPreviewResults(pubmedPreview, pubmedPreviewAssessment);
    const verdict = pubmedPreviewVerdictMeta(pubmedPreviewAssessment.verdict);
    status.textContent = `命中 ${pubmedPreview.total_count.toLocaleString('zh-CN')} 篇 · 抽样 ${pubmedPreviewAssessment.sample_size} 篇 · ${verdict.label}`;
    invoke('start_translation_pipeline').catch(() => {});
  } catch (error) {
    renderPubmedPreviewResults(pubmedPreview, null, String(error));
    status.textContent = `命中 ${pubmedPreview.total_count.toLocaleString('zh-CN')} 篇 · AI 初判失败`;
  } finally {
    button.disabled = false;
  }
}

async function previewPubmedSearch() {
  const query = document.getElementById('pubmed-batch-query-input').value.trim();
  const question = document.getElementById('pubmed-question').value.trim();
  const button = document.getElementById('btn-preview-pubmed-search');
  const status = document.getElementById('pubmed-preview-status');
  const results = document.getElementById('pubmed-preview-results');
  if (!query) {
    status.textContent = '请输入检索式';
    return;
  }
  const options = {
    scope: 'all',
    limit: null,
    date_from: null,
    date_to: null,
    sort: document.getElementById('pubmed-retrieval-sort')?.value || 'most_recent',
  };
  button.disabled = true;
  status.textContent = '正在查询 PubMed…';
  results.classList.add('hidden');
  pubmedPreviewAssessment = null;
  try {
    pubmedPreview = await invoke('preview_pubmed_search', { query, options });
    renderPubmedPreviewResults(pubmedPreview);
    document.getElementById('pubmed-retrieval-panel').disabled = false;
    updatePubmedRetrievalUi();

    const shouldAssess = pubmedSearchBuilderMode === 'topic'
      && question
      && document.getElementById('pubmed-preview-ai-enabled')?.checked
      && (pubmedPreview.entries || []).length > 0;
    if (shouldAssess) {
      status.textContent = `命中 ${pubmedPreview.total_count.toLocaleString('zh-CN')} 篇，AI 正在评估 ${pubmedPreview.entries.length} 篇题名与摘要…`;
      try {
        pubmedPreviewAssessment = await invoke('assess_pubmed_search_preview', {
          question,
          query: pubmedPreview.query,
          entries: pubmedPreview.entries,
        });
        loadCostSummary();
        renderPubmedPreviewResults(pubmedPreview, pubmedPreviewAssessment);
        const verdict = pubmedPreviewVerdictMeta(pubmedPreviewAssessment.verdict);
        status.textContent = `命中 ${pubmedPreview.total_count.toLocaleString('zh-CN')} 篇 · 抽样 ${pubmedPreviewAssessment.sample_size} 篇 · ${verdict.label}`;
      } catch (assessmentError) {
        renderPubmedPreviewResults(pubmedPreview, null, String(assessmentError));
        status.textContent = `命中 ${pubmedPreview.total_count.toLocaleString('zh-CN')} 篇 · AI 初判失败`;
      }
    } else {
      const assessmentHint = pubmedSearchBuilderMode === 'topic'
        && document.getElementById('pubmed-preview-ai-enabled')?.checked
        && !question
        ? ' · 填写研究问题后可进行 AI 初判'
        : '';
      status.textContent = `命中 ${pubmedPreview.total_count.toLocaleString('zh-CN')} 篇${assessmentHint}`;
    }
  } catch (e) {
    pubmedPreview = null;
    pubmedPreviewAssessment = null;
    document.getElementById('pubmed-retrieval-panel').disabled = true;
    status.textContent = `预览失败：${e}`;
    document.getElementById('btn-create-pubmed-search').disabled = true;
  } finally {
    button.disabled = false;
  }
}

async function createAndRunPubmedSearch() {
  const name = document.getElementById('pubmed-search-name').value.trim();
  const question = document.getElementById('pubmed-question').value.trim();
  const query = document.getElementById('pubmed-batch-query-input').value.trim();
  const button = document.getElementById('btn-create-pubmed-search');
  const status = document.getElementById('pubmed-preview-status');
  let options;
  try {
    options = pubmedRetrievalOptionsFromForm();
  } catch (error) {
    status.textContent = String(error.message || error);
    return;
  }
  if (!pubmedPreview || pubmedPreview.query !== query) {
    status.textContent = '检索式有变化，请重新预览';
    button.disabled = true;
    return;
  }
  if (!name) {
    status.textContent = '请填写检索名称';
    return;
  }
  button.disabled = true;
  status.textContent = pubmedEditingSearchId ? '正在保存检索式…' : '正在创建检索批次…';
  try {
    const search = pubmedEditingSearchId
      ? await invoke('update_pubmed_search', {
          id: pubmedEditingSearchId,
          name,
          question: question || null,
          query,
          options,
        })
      : await invoke('create_pubmed_search', { name, question: question || null, query, options });
    closePubmedSearchModal();
    await loadPubmedSearches();
    await selectPubmedSearch(search.id);
    await runCurrentPubmedSearch();
  } catch (e) {
    status.textContent = `${pubmedEditingSearchId ? '保存' : '创建'}失败：${e}`;
    button.disabled = false;
  }
}

async function runCurrentPubmedSearch() {
  if (!currentPubmedSearch || activePubmedRunId) return;
  btnRunPubmedSearch.disabled = true;
  pubmedProgressEl.classList.remove('hidden');
  pubmedProgressLabel.textContent = '正在建立 PMID 快照…';
  pubmedProgressFill.style.width = '0%';
  setGlobalStatus(`正在更新「${currentPubmedSearch.name}」`, 'progress');
  try {
    const result = await invoke('run_pubmed_search', { searchId: currentPubmedSearch.id });
    if (result.status === 'completed') {
      setGlobalStatus(`更新完成：新增 ${result.added_count}，已有 ${result.reused_count}`, 'success');
    } else {
      const detail = result.error_message ? `：${result.error_message}` : `：失败 ${result.failed_count}`;
      setGlobalStatus(`更新${pubmedRunStatusLabel(result.status)}${detail}`, 'error');
    }
    await loadPubmedSearches();
    await selectPubmedSearch(currentPubmedSearch.id);
  } catch (e) {
    setGlobalStatus('PubMed 更新失败: ' + e, 'error');
  } finally {
    activePubmedRunId = null;
    btnRunPubmedSearch.disabled = false;
    setTimeout(() => pubmedProgressEl?.classList.add('hidden'), 1600);
  }
}

function pubmedRunStatusLabel(status) {
  return { partial: '部分完成', failed: '失败', cancelled: '已取消', completed: '完成' }[status] || status;
}

async function applyBulkPubmedStatus(status) {
  if (!currentPubmedSearch || !selectedEntryIds.size || !status) return;
  try {
    await invoke('bulk_set_pubmed_screening_status', {
      searchId: currentPubmedSearch.id,
      entryIds: [...selectedEntryIds],
      status,
    });
    allEntries.forEach(entry => {
      if (selectedEntryIds.has(entry.id)) entry.screening_status = status;
    });
    clearEntrySelection({ keepMode: true, render: false });
    renderEntryList(allEntries);
    await loadPubmedSearches();
    setGlobalStatus(`已将所选文献设为${pubmedStatusLabel(status)}`, 'success');
  } catch (e) {
    setGlobalStatus('批量筛选失败: ' + e, 'error');
  }
}

function requestPubmedScreeningCriteria() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pubmed-modal';
    overlay.innerHTML = `
      <div class="pubmed-modal-backdrop"></div>
      <section class="pubmed-modal-panel pubmed-criteria-panel">
        <header class="pubmed-modal-header"><div><h2>AI 辅助筛选</h2><p>AI 只生成建议，确认前不会修改筛选状态。</p></div></header>
        <div class="pubmed-modal-body">
          <label class="pubmed-field"><span>纳入与排除标准</span><textarea rows="6" placeholder="例如：保留成人脓毒症患者的单细胞研究；排除动物实验、综述和无免疫表型数据的研究。"></textarea></label>
        </div>
        <footer class="pubmed-modal-footer"><button class="btn btn-secondary" data-cancel type="button">取消</button><button class="btn btn-primary" data-submit type="button">生成建议</button></footer>
      </section>`;
    const textarea = overlay.querySelector('textarea');
    const cleanup = value => { overlay.remove(); resolve(value); };
    overlay.querySelector('.pubmed-modal-backdrop').addEventListener('click', () => cleanup(null));
    overlay.querySelector('[data-cancel]').addEventListener('click', () => cleanup(null));
    overlay.querySelector('[data-submit]').addEventListener('click', () => {
      const criteria = textarea.value.trim();
      if (!criteria) { textarea.focus(); return; }
      cleanup(criteria);
    });
    document.body.appendChild(overlay);
    setTimeout(() => textarea.focus(), 0);
  });
}

async function startPubmedAiScreening() {
  if (!currentPubmedSearch) return;
  const entries = getSelectedEntries();
  if (!entries.length) {
    setGlobalStatus('请先勾选需要 AI 辅助筛选的文献', 'error');
    return;
  }
  if (entries.length > 30) {
    setGlobalStatus('AI 筛选单次最多支持 30 篇文献', 'error');
    return;
  }
  const criteria = await requestPubmedScreeningCriteria();
  if (!criteria) return;
  btnPubmedAiScreen.disabled = true;
  setGlobalStatus(`正在分析 ${entries.length} 篇文献…`, 'progress');
  try {
    const result = await invoke('suggest_pubmed_screening', {
      searchId: currentPubmedSearch.id,
      entryIds: entries.map(entry => entry.id),
      criteria,
    });
    loadCostSummary();
    showPubmedSuggestionReview(result, entries);
    setGlobalStatus('AI 建议已生成，等待确认', 'success');
  } catch (e) {
    setGlobalStatus('AI 筛选失败: ' + e, 'error');
  } finally {
    btnPubmedAiScreen.disabled = false;
  }
}

function showPubmedSuggestionReview(result, selectedEntries) {
  const byId = new Map(selectedEntries.map(entry => [entry.id, entry]));
  const overlay = document.createElement('div');
  overlay.className = 'pubmed-modal';
  const rows = (result.suggestions || []).map(suggestion => {
    const entry = byId.get(suggestion.entry_id);
    if (!entry) return '';
    return `
      <div class="pubmed-suggestion-row" data-entry-id="${entry.id}" data-pmid="${escapeHtml(suggestion.pmid || entry.pmid || '')}">
        <div class="pubmed-suggestion-index">${escapeHtml(entry.pmid ? `PMID ${entry.pmid}` : `ID ${entry.id}`)}</div>
        <div class="pubmed-suggestion-paper"><strong>${escapeHtml(entry.title_translated || entry.title)}</strong><span>${escapeHtml(suggestion.reason || '未提供理由')}</span></div>
        <select class="pubmed-status-select status-${escapeHtml(suggestion.status)}">
          <option value="keep" ${suggestion.status === 'keep' ? 'selected' : ''}>保留</option>
          <option value="maybe" ${suggestion.status === 'maybe' ? 'selected' : ''}>待定</option>
          <option value="exclude" ${suggestion.status === 'exclude' ? 'selected' : ''}>排除</option>
        </select>
      </div>`;
  }).join('');
  const empty = !rows
    ? `<div class="pubmed-suggestion-raw"><p>AI 回答未能解析为可应用建议，数据库未改变。</p><pre>${escapeHtml(result.raw_answer || '')}</pre></div>`
    : rows;
  overlay.innerHTML = `
    <div class="pubmed-modal-backdrop"></div>
    <section class="pubmed-modal-panel pubmed-suggestion-panel">
      <header class="pubmed-modal-header"><div><h2>确认 AI 筛选建议</h2><p>逐篇检查并调整状态，点击应用后才写入当前批次。</p></div><button class="pubmed-modal-close" data-close type="button" aria-label="关闭">×</button></header>
      <div class="pubmed-modal-body pubmed-suggestion-list">${empty}</div>
      <footer class="pubmed-modal-footer"><button class="btn btn-secondary" data-close type="button">取消</button>${rows ? '<button class="btn btn-primary" data-apply type="button">应用建议</button>' : ''}</footer>
    </section>`;
  const close = () => overlay.remove();
  overlay.querySelector('.pubmed-modal-backdrop').addEventListener('click', close);
  overlay.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
  overlay.querySelector('[data-apply]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const suggestions = [...overlay.querySelectorAll('.pubmed-suggestion-row')].map(row => ({
      entry_id: Number(row.dataset.entryId),
      pmid: row.dataset.pmid || null,
      status: row.querySelector('select').value,
      reason: row.querySelector('.pubmed-suggestion-paper span').textContent,
    }));
    button.disabled = true;
    try {
      await invoke('apply_pubmed_screening_suggestions', {
        searchId: currentPubmedSearch.id,
        suggestions,
      });
      const statusById = new Map(suggestions.map(item => [item.entry_id, item.status]));
      allEntries.forEach(entry => {
        if (statusById.has(entry.id)) entry.screening_status = statusById.get(entry.id);
      });
      close();
      clearEntrySelection({ render: false });
      renderEntryList(allEntries);
      await loadPubmedSearches();
      setGlobalStatus(`已应用 ${suggestions.length} 条 AI 筛选建议`, 'success');
    } catch (e) {
      button.disabled = false;
      setGlobalStatus('应用 AI 建议失败: ' + e, 'error');
    }
  });
  document.body.appendChild(overlay);
}

function setupPubmedSearchEvents() {
  const event = window.__TAURI__?.event;
  event?.listen?.('pubmed-search-progress', eventPayload => {
    const progress = eventPayload.payload || {};
    if (currentPubmedSearch && progress.search_id !== currentPubmedSearch.id) return;
    activePubmedRunId = progress.run_id || activePubmedRunId;
    const total = Math.max(1, Number(progress.total || 0));
    const processed = Number(progress.processed || 0);
    pubmedProgressEl?.classList.remove('hidden');
    if (pubmedProgressFill) pubmedProgressFill.style.width = `${Math.min(100, processed / total * 100)}%`;
    if (pubmedProgressLabel) pubmedProgressLabel.textContent = `${processed}/${progress.total || 0} · 新增 ${progress.added || 0} · 失败 ${progress.failed || 0}`;
  });
}

async function loadPubmedSearches() {
  try {
    allPubmedSearches = await invoke('list_pubmed_searches');
    renderPubmedSearchList();
    let keptCount = 0;
    try { keptCount = (await invoke('list_kept_pubmed_entries')).length; } catch {}
    const countEl = document.getElementById('count-kept');
    if (countEl) countEl.textContent = keptCount || '';
  } catch (e) {
    allPubmedSearches = [];
    renderPubmedSearchList();
    setGlobalStatus('加载 PubMed 检索失败: ' + e, 'error');
  }
}

function renderPubmedSearchList() {
  if (!pubmedSearchListEl) return;
  pubmedSearchListEl.innerHTML = '';
  if (!allPubmedSearches.length) {
    pubmedSearchListEl.innerHTML = '<li class="pubmed-search-empty">点击 + 新建持续检索</li>';
    return;
  }
  allPubmedSearches.forEach(search => {
    const li = document.createElement('li');
    li.className = 'pubmed-search-item';
    li.dataset.searchId = search.id;
    li.classList.toggle('selected', mode === 'pubmed' && currentPubmedSearch?.id === search.id);

    if (renamingPubmedSearchId === search.id) {
      li.innerHTML = `<input class="pubmed-search-rename-input" type="text" value="${escapeHtml(search.name)}" />`;
      const input = li.querySelector('.pubmed-search-rename-input');
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') finishRenamePubmedSearch(search.id, input.value);
        if (event.key === 'Escape') cancelRenamePubmedSearch();
      });
      input.addEventListener('blur', () => finishRenamePubmedSearch(search.id, input.value));
      pubmedSearchListEl.appendChild(li);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return;
    }

    li.innerHTML = `
      <span class="pubmed-search-item-icon" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/></svg>
      </span>
      <span class="pubmed-search-item-main">
        <span class="pubmed-search-item-title">${escapeHtml(search.name)}</span>
      </span>
      <span class="pubmed-search-item-count">${search.total_entries || ''}</span>
    `;
    li.addEventListener('click', () => selectPubmedSearch(search.id));
    li.addEventListener('contextmenu', event => {
      event.preventDefault();
      showPubmedSearchContextMenu(event.clientX, event.clientY, search);
    });
    pubmedSearchListEl.appendChild(li);
  });
}

function showPubmedSearchContextMenu(x, y, search) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = `
    <div class="context-item" data-action="refresh">更新检索批次</div>
    <div class="context-separator"></div>
    <div class="context-item" data-action="translate-title">批量翻译标题</div>
    <div class="context-item" data-action="translate-summary">批量翻译摘要</div>
    <div class="context-separator"></div>
    <div class="context-item" data-action="edit">编辑检索词</div>
    <div class="context-item" data-action="rename">重命名</div>
    <div class="context-item" data-action="clone">复制为新检索</div>
    <div class="context-item" data-action="convert-to-rss">转为 RSS 订阅</div>
    <div class="context-separator"></div>
    <div class="context-item context-item-danger" data-action="delete">删除</div>
  `;
  menu.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    hideContextMenu();
    if (action === 'refresh') {
      await selectPubmedSearch(search.id);
      await runCurrentPubmedSearch();
    } else if (action === 'translate-title') {
      await translatePubmedSearchEntries(search, 'title');
    } else if (action === 'translate-summary') {
      await translatePubmedSearchEntries(search, 'summary');
    } else if (action === 'edit') {
      openPubmedSearchModal({ source: search, editing: true });
    } else if (action === 'rename') {
      startRenamePubmedSearch(search.id);
    } else if (action === 'clone') {
      openPubmedSearchModal({ source: search });
    } else if (action === 'convert-to-rss') {
      await convertPubmedSearchToFeed(search);
    } else if (action === 'delete') {
      const confirmed = await confirmDialog(`删除检索批次“${search.name}”？筛选记录会删除，但文献阅读记录会保留。`, {
        okLabel: '删除', cancelLabel: '取消', danger: true,
      });
      if (!confirmed) return;
      await invoke('delete_pubmed_search', { id: search.id });
      if (currentPubmedSearch?.id === search.id) await enterKeptMode();
      await loadPubmedSearches();
    }
  });
  mountContextMenu(menu, x, y);
  document.addEventListener('click', hideContextMenu, { once: true });
}

function startRenamePubmedSearch(id) {
  renamingPubmedSearchId = id;
  renderPubmedSearchList();
}

function cancelRenamePubmedSearch() {
  renamingPubmedSearchId = null;
  renderPubmedSearchList();
}

async function finishRenamePubmedSearch(id, name) {
  if (renamingPubmedSearchId !== id) return;
  const trimmed = name.trim();
  const original = allPubmedSearches.find(search => search.id === id);
  if (!trimmed || trimmed === original?.name) {
    cancelRenamePubmedSearch();
    return;
  }

  renamingPubmedSearchId = null;
  try {
    await invoke('rename_pubmed_search', { id, name: trimmed });
    await loadPubmedSearches();
    if (currentPubmedSearch?.id === id) {
      currentPubmedSearch = allPubmedSearches.find(search => search.id === id) || currentPubmedSearch;
      updatePubmedBatchHeader();
    }
    setGlobalStatus('重命名完成', 'success');
  } catch (error) {
    setGlobalStatus('重命名失败: ' + error, 'error');
    await loadPubmedSearches();
  }
}

function normalizePubmedEntry(entry) {
  const pmid = entry.pmid || '';
  return {
    ...entry,
    id: entry.entry_id,
    author: entry.authors,
    source: entry.journal,
    published_at: entry.publication_date || entry.publication_date_raw || null,
    link: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '',
    guid: pmid ? `pubmed:${pmid}` : `entry:${entry.entry_id}`,
    feed_id: null,
    is_read: !!entry.is_read,
    has_reading_note: !!entry.has_reading_note,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  };
}

function entryMatchesLiteratureSearchQuery(entry, query) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const haystack = [
    entry.title,
    entry.translated_title,
    entry.summary,
    entry.translated_summary,
    entry.author,
    entry.authors,
    entry.source,
    entry.journal,
    entry.pmid,
    entry.pmcid,
    entry.doi,
    entry.affiliation,
    ...tags,
  ].filter(Boolean).join('\n').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

async function selectPubmedSearch(searchId) {
  cancelLiteratureSearchForNavigation();
  const search = allPubmedSearches.find(item => item.id === Number(searchId));
  if (!search) return;
  clearEntrySelection({ render: false, syncPaperChat: false });
  mode = 'pubmed';
  currentPubmedSearch = search;
  selectedFeedId = null;
  restoreCurrentFilterScope();
  pubmedRenderLimit = 200;
  enterLiteratureMode();
  document.body.classList.add('pubmed-mode');
  document.querySelectorAll('.feed-item').forEach(el => el.classList.remove('selected'));
  renderPubmedSearchList();
  updatePubmedBatchHeader();
  entryItemsEl.innerHTML = '<li class="entry-empty">正在读取检索结果…</li>';
  try {
    const entries = await invoke('list_pubmed_search_entries', { searchId: search.id });
    allEntries = entries.map(normalizePubmedEntry);
    refreshEntryTagFilterOptions(allEntries);
    renderEntryList(allEntries);
    refreshPaperChatAfterScopeDataChange();
  } catch (e) {
    entryItemsEl.innerHTML = `<li class="entry-empty">加载检索结果失败: ${escapeHtml(String(e))}</li>`;
  }
}

async function enterKeptMode(options = {}) {
  const preserveSearch = !!options.preserveSearch;
  if (!preserveSearch) cancelLiteratureSearchForNavigation();
  clearEntrySelection({ render: false, syncPaperChat: false });
  mode = 'kept';
  currentPubmedSearch = null;
  selectedFeedId = null;
  restoreCurrentFilterScope();
  pubmedRenderLimit = 200;
  enterLiteratureMode();
  document.body.classList.add('pubmed-mode');
  renderPubmedSearchList();
  updatePubmedBatchHeader();
  entryItemsEl.innerHTML = '<li class="entry-empty">正在读取保留文献…</li>';
  try {
    const entries = await invoke('list_kept_pubmed_entries');
    allEntries = entries.map(normalizePubmedEntry);
    refreshEntryTagFilterOptions(allEntries);
    renderEntryList(allEntries);
    refreshPaperChatAfterScopeDataChange();
  } catch (e) {
    entryItemsEl.innerHTML = `<li class="entry-empty">加载保留文献失败: ${escapeHtml(String(e))}</li>`;
  }
}

function enterLiteratureMode() {
  briefingListEl.classList.add('hidden');
  briefingDetailEl.classList.add('hidden');
  entryListEl.classList.remove('hidden');
  detailPanelEl.classList.remove('hidden');
  applyListPanelWidth(loadListPanelWidth());
  applyPaperChatPanelWidth(loadPaperChatPanelWidth());
  syncPaperChatResizerVisibility();
  syncEntryFilterControls();
}

function updatePubmedBatchHeader() {
  if (!pubmedBatchHeader) return;
  pubmedBatchHeader.classList.toggle('hidden', !['pubmed', 'kept'].includes(mode));
  if (mode === 'kept') {
    pubmedBatchMeta.textContent = '';
    btnRunPubmedSearch?.classList.add('hidden');
  } else if (currentPubmedSearch) {
    const updated = currentPubmedSearch.last_success_at
      ? `上次更新 ${formatCompactDateTime(currentPubmedSearch.last_success_at)}`
      : '尚未完成首次抓取';
    pubmedBatchMeta.textContent = updated;
    btnRunPubmedSearch?.classList.remove('hidden');
  }
  refreshPubmedSnapshotControls();
}

function formatCompactDateTime(value) {
  if (!value) return '';
  const date = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadFeeds() {
  try {
    allFeeds = await invoke('list_feeds');
    try { globalEntries = await invoke('list_entries', { feedId: null }); }
    catch { globalEntries = []; }
    renderFeedList(allFeeds);
    updateOverviewCounts();
  } catch (e) {
    setGlobalStatus('加载订阅列表失败: ' + e, 'error');
  }
}

function unreadCountForFeed(feedId) {
  return globalEntries.filter(e => e.feed_id === feedId && !e.is_read).length;
}
function totalCountForFeed(feedId) {
  return globalEntries.filter(e => e.feed_id === feedId).length;
}

function updateOverviewCounts() {
  const elAll = document.getElementById('count-all');
  const elUnread = document.getElementById('count-unread');
  const elStarred = document.getElementById('count-starred');
  const elReadingNotes = document.getElementById('count-reading-notes');
  const elTopAll = document.getElementById('top-count-all');
  const elTopUnread = document.getElementById('top-count-unread');
  const elTopStarred = document.getElementById('top-count-starred');
  const elTopReadingNotes = document.getElementById('top-count-reading-notes');
  const elBriefing = document.getElementById('count-briefing');
  const stars = starredIds();
  if (elAll) elAll.textContent = globalEntries.length || '';
  if (elTopAll) elTopAll.textContent = globalEntries.length || '';
  const unread = globalEntries.filter(e => !e.is_read).length;
  if (elUnread) elUnread.textContent = unread || '';
  if (elTopUnread) elTopUnread.textContent = unread || '';
  const readingNotes = globalEntries.filter(e => e.has_reading_note).length;
  if (elReadingNotes) elReadingNotes.textContent = readingNotes || '';
  if (elTopReadingNotes) elTopReadingNotes.textContent = readingNotes || '';
  // Count only stars that point at live entries. Raw `stars.size` keeps growing
  // with orphan IDs (e.g. starred entries whose feed got deleted), so the badge
  // would refuse to hide even after the user has effectively "cleared" stars.
  const liveStarCount = globalEntries.filter(e => stars.has(e.id)).length;
  if (elStarred) {
    elStarred.textContent = liveStarCount || '';
  }
  if (elTopStarred) elTopStarred.textContent = liveStarCount || '';
  // Show total briefing count next to the sidebar entry — same intent as
  // "全部" (total entries), so users always see how many briefings exist
  // regardless of read state.
  if (elBriefing) elBriefing.textContent = BRIEFINGS.length || '';
  updateTopEntryFilterCounts(allEntries.length ? allEntries : globalEntries);
  // Keep the macOS tray badge in sync with the unread count.
  pushTrayUnread();
}

function updateTopEntryFilterCounts(entries = allEntries) {
  const elTopAll = document.getElementById('top-count-all');
  const elTopUnread = document.getElementById('top-count-unread');
  const elTopStarred = document.getElementById('top-count-starred');
  const elTopReadingNotes = document.getElementById('top-count-reading-notes');
  const stars = starredIds();
  if (elTopAll) elTopAll.textContent = entries.length || '';
  if (elTopUnread) elTopUnread.textContent = entries.filter(e => !e.is_read).length || '';
  if (elTopStarred) elTopStarred.textContent = entries.filter(e => stars.has(e.id)).length || '';
  if (elTopReadingNotes) elTopReadingNotes.textContent = entries.filter(e => e.has_reading_note).length || '';
}

function renderFeedList(feeds) {
  const prevSelected = feedListEl.querySelector('.feed-item.selected')?.dataset.feedId;
  feedListEl.innerHTML = '';
  if (feeds.length === 0) {
    feedListEl.innerHTML = '<li class="feed-empty">暂无订阅源，在上方输入 RSS URL 添加</li>';
    return;
  }
  feeds.forEach(feed => {
    const li = document.createElement('li');
    li.className = 'feed-item';
    li.dataset.feedId = feed.id;
    const unread = unreadCountForFeed(feed.id);
    if (unread > 0) li.classList.add('has-unread');

    if (renamingFeedId === feed.id) {
      li.innerHTML = `<input class="feed-rename-input" type="text" value="${escapeHtml(feed.title || feed.url)}" />`;
      const input = li.querySelector('.feed-rename-input');
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') finishRenameFeed(feed.id, input.value);
        if (e.key === 'Escape') cancelRenameFeed();
      });
      input.addEventListener('blur', () => finishRenameFeed(feed.id, input.value));
      setTimeout(() => { input.focus(); input.select(); }, 0);
    } else {
      const emoji = feedEmoji(feed.id);
      const badgeHtml = unread > 0 ? `<span class="feed-unread-badge">${unread}</span>` : '';
      li.innerHTML = `
        <button class="feed-emoji-btn" data-feed-id="${feed.id}" title="选择图标">${emoji}</button>
        <span class="feed-title">${escapeHtml(feed.title || feed.url)}</span>
        ${badgeHtml}
      `;
    }

    li.addEventListener('click', () => {
      if (renamingFeedId === feed.id) return;
      selectFeed(feed.id);
    });
    li.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, feed); });

    if (feed.id.toString() === prevSelected) li.classList.add('selected');
    feedListEl.appendChild(li);
  });

  feedListEl.querySelectorAll('.feed-emoji-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openEmojiPicker(btn, parseInt(btn.dataset.feedId), () => {
        renderFeedList(allFeeds);
        if (selectedFeedId === parseInt(btn.dataset.feedId)) {
          const feed = allFeeds.find(f => f.id === selectedFeedId);
          if (feed) updateToolbarFeedInfo(feed);
        }
      });
    });
  });
}

function selectFeed(feedId) {
  const query = literatureSearchInput?.value.trim() || '';
  mode = 'feed';
  enterFeedMode();
  document.querySelectorAll('.feed-item').forEach(el => el.classList.toggle('selected', parseInt(el.dataset.feedId) === feedId));
  selectedFeedId = feedId;
  restoreCurrentFilterScope();
  const feed = allFeeds.find(f => f.id === feedId);
  if (feed) updateToolbarFeedInfo(feed);
  if (query) {
    runLiteratureSearch(query);
    return;
  }
  cancelLiteratureSearchForNavigation();
  loadEntries(feedId);
}

function captureLiteratureSearchRestoreState() {
  if (literatureSearchRestoreState) return;
  literatureSearchRestoreState = {
    mode,
    selectedFeedId,
    entryFilterValue,
    pubmedSearchId: currentPubmedSearch?.id || null,
    selectedBriefingId,
  };
}

function syncLiteratureSearchUi() {
  if (!literatureSearchInput || !literatureSearchRow || !btnClearLiteratureSearch) return;
  const hasQuery = literatureSearchInput.value.trim().length > 0;
  literatureSearchRow.classList.toggle('active', hasQuery);
  btnClearLiteratureSearch.classList.toggle('hidden', !hasQuery);
}

function enterLiteratureSearchMode() {
  clearEntrySelection({ render: false, syncPaperChat: false });
  mode = 'search';
  currentPubmedSearch = null;
  document.body.classList.remove('pubmed-mode');
  pubmedBatchHeader?.classList.add('hidden');
  briefingListEl.classList.add('hidden');
  briefingDetailEl.classList.add('hidden');
  entryListEl.classList.remove('hidden');
  detailPanelEl.classList.remove('hidden');
  applyListPanelWidth(loadListPanelWidth());
  applyPaperChatPanelWidth(loadPaperChatPanelWidth());
  syncPaperChatResizerVisibility();
  document.querySelectorAll('.feed-item').forEach(element => {
    element.classList.toggle('selected', selectedFeedId && parseInt(element.dataset.feedId) === selectedFeedId);
  });
  syncEntryFilterControls();
}

async function runLiteratureSearch(query) {
  const requestId = ++literatureSearchRequestId;
  const searchFeedId = selectedFeedId || null;
  enterLiteratureSearchMode();
  entryItemsEl.innerHTML = '<li class="entry-empty">正在检索…</li>';
  const feed = searchFeedId ? allFeeds.find(f => f.id === searchFeedId) : null;
  const scopeLabel = feed ? (feed.title || feed.url || '当前订阅源') : entryFilterLabel(entryFilterValue);
  toolbarSubtitle.innerHTML = `<span>检索</span><span class="ts-meta">·</span><span class="ts-tertiary">${escapeHtml(scopeLabel)} · ${escapeHtml(query)}</span>`;
  try {
    const entries = await invoke('search_entries', { query, feedId: searchFeedId });
    if (
      requestId !== literatureSearchRequestId ||
      literatureSearchInput.value.trim() !== query ||
      (selectedFeedId || null) !== searchFeedId
    ) return;
    allEntries = entries;
    refreshEntryTagFilterOptions(allEntries);
    renderEntryList(allEntries);
    toolbarSubtitle.innerHTML = `
      <span>检索</span>
      <span class="ts-meta">·</span>
      <span class="ts-tertiary">${escapeHtml(scopeLabel)} · ${getFilteredEntries(entries).length} 篇</span>
    `;
    refreshPaperChatAfterScopeDataChange();
  } catch (e) {
    if (requestId !== literatureSearchRequestId) return;
    entryItemsEl.innerHTML = `<li class="entry-empty">检索失败: ${escapeHtml(String(e))}</li>`;
  }
}

function scheduleLiteratureSearch() {
  syncLiteratureSearchUi();
  clearTimeout(literatureSearchTimer);
  const query = literatureSearchInput.value.trim();
  if (mode === 'briefing') {
    renderBriefingList();
    if (query) {
      const visibleBriefings = filteredBriefingsForCurrentQuery();
      const selectedVisible = selectedBriefingId && visibleBriefings.some(b => b.id === selectedBriefingId);
      if (!selectedVisible && visibleBriefings.length) selectBriefing(visibleBriefings[0].id);
      else if (!visibleBriefings.length) showBriefingEmpty();
    }
    return;
  }
  if (!query) {
    clearLiteratureSearch();
    return;
  }
  captureLiteratureSearchRestoreState();
  literatureSearchTimer = setTimeout(() => runLiteratureSearch(query), 180);
}

function cancelLiteratureSearchForNavigation() {
  if (!literatureSearchInput || (!literatureSearchRestoreState && !literatureSearchInput.value)) return;
  clearTimeout(literatureSearchTimer);
  literatureSearchRequestId += 1;
  literatureSearchRestoreState = null;
  literatureSearchInput.value = '';
  syncLiteratureSearchUi();
}

function clearLiteratureSearch() {
  clearTimeout(literatureSearchTimer);
  literatureSearchRequestId += 1;
  const wasSearchMode = mode === 'search';
  const wasKeptMode = mode === 'kept';
  const wasBriefingMode = mode === 'briefing';
  const currentSearchFeedId = selectedFeedId;
  const currentSearchFilterValue = entryFilterValue;
  if (literatureSearchInput) literatureSearchInput.value = '';
  syncLiteratureSearchUi();
  const restore = literatureSearchRestoreState;
  literatureSearchRestoreState = null;
  if (wasKeptMode) {
    enterKeptMode();
    return;
  }
  if (wasBriefingMode) {
    enterBriefingMode();
    return;
  }
  if (wasSearchMode) {
    entryFilterValue = currentSearchFilterValue;
    if (currentSearchFeedId) {
      selectFeed(currentSearchFeedId);
    } else {
      enterFeedMode();
      selectedFeedId = null;
      document.querySelectorAll('.feed-item').forEach(el => el.classList.remove('selected'));
      restoreCurrentFilterScope();
      setToolbarSubtitle('main');
      loadEntries(null);
    }
    return;
  }
  if (!restore) return;

  selectedBriefingId = restore.selectedBriefingId;
  if (restore.mode === 'pubmed' && restore.pubmedSearchId) {
    selectPubmedSearch(restore.pubmedSearchId);
  } else if (restore.mode === 'kept') {
    enterKeptMode();
  } else if (restore.mode === 'briefing') {
    enterBriefingMode();
  } else {
    entryFilterValue = restore.entryFilterValue;
    if (restore.selectedFeedId) selectFeed(restore.selectedFeedId);
    else {
      enterFeedMode();
      selectedFeedId = null;
      restoreCurrentFilterScope();
      setToolbarSubtitle('main');
      loadEntries(null);
    }
  }
}

function updateToolbarFeedInfo(feed) {
  if (!toolbarSubtitle) return;
  if (!settingsView.classList.contains('hidden')) return;
  if (mode === 'briefing') { setToolbarSubtitle('briefing'); return; }
  if (mode === 'search') { setToolbarSubtitle('search'); return; }
  if (!feed) { toolbarSubtitle.innerHTML = ''; return; }
  const unread = unreadCountForFeed(feed.id);
  const total = totalCountForFeed(feed.id);
  toolbarSubtitle.innerHTML = `
    <span>${escapeHtml(feedEmoji(feed.id))}</span>
    <span>${escapeHtml(feed.title || feed.url)}</span>
    <span class="ts-meta">·</span>
    <span class="ts-tertiary">${unread} 未读 / ${total}</span>
  `;
}

// ── Emoji picker ──────────────────────────────
function openEmojiPicker(anchorBtn, feedId, onAfter) {
  document.querySelectorAll('.emoji-picker').forEach(p => p.remove());
  anchorBtn.classList.add('open');

  const picker = document.createElement('div');
  picker.className = 'emoji-picker';
  const current = feedEmoji(feedId);
  picker.innerHTML = `
    <div class="emoji-picker-heading">选择图标</div>
    <div class="emoji-picker-grid">
      ${EMOJI_PRESETS.map(e => `<button class="emoji-cell ${e === current ? 'active' : ''}" data-emoji="${e}">${e}</button>`).join('')}
    </div>
  `;

  const rect = anchorBtn.getBoundingClientRect();
  picker.style.top = (rect.bottom + 6) + 'px';
  picker.style.left = rect.left + 'px';
  document.body.appendChild(picker);

  picker.addEventListener('click', e => {
    const cell = e.target.closest('.emoji-cell');
    if (!cell) return;
    e.stopPropagation();
    setFeedEmoji(feedId, cell.dataset.emoji);
    picker.remove();
    anchorBtn.classList.remove('open');
    if (onAfter) onAfter();
  });

  setTimeout(() => {
    const handler = (ev) => {
      if (!picker.contains(ev.target) && ev.target !== anchorBtn) {
        picker.remove();
        anchorBtn.classList.remove('open');
        document.removeEventListener('click', handler);
      }
    };
    document.addEventListener('click', handler);
  }, 0);
}

function startRenameFeed(id) { renamingFeedId = id; loadFeeds(); }
function cancelRenameFeed() { renamingFeedId = null; loadFeeds(); }

async function finishRenameFeed(id, name) {
  if (renamingFeedId !== id) return;
  const trimmed = name.trim();
  if (!trimmed) { cancelRenameFeed(); return; }
  renamingFeedId = null;
  try {
    await invoke('rename_feed', { id, name: trimmed });
    await loadFeeds();
    if (!document.getElementById('section-feeds').classList.contains('hidden')) renderFeedSettingsList();
    setGlobalStatus('重命名完成', 'success');
  } catch (err) {
    setGlobalStatus('重命名失败: ' + err, 'error');
    await loadFeeds();
  }
}

async function persistNewFeed(url, { title = null, pubmedQuery = null, pubmedLimit = null } = {}) {
  const added = await invoke('add_feed', { url });
  if (title || pubmedQuery || pubmedLimit != null) {
    await invoke('update_feed', {
      id: added.id,
      url,
      title,
      pubmedQuery,
      pubmedLimit,
    });
  }
  await loadFeeds();
  if (!document.getElementById('section-feeds').classList.contains('hidden')) renderFeedSettingsList();
  return added;
}

// ── Add Feed input (pill with animated states) ─
async function addFeed() {
  const url = feedUrlInput.value.trim();
  if (!url) { setGlobalStatus('请输入 RSS URL', 'error'); return; }
  setGlobalStatus('');
  btnAddFeed.disabled = true;
  addFeedRow.classList.add('adding');
  feedUrlInput.placeholder = '正在拉取…';
  try {
    await persistNewFeed(url);
    addFeedRow.classList.remove('adding');
    addFeedRow.classList.add('added');
    if (addFeedIcon) addFeedIcon.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.3 6.5 11 12.5 4.8"/></svg>`;
    feedUrlInput.value = '';
    feedUrlInput.placeholder = '订阅源已添加';
    btnAddFeed.classList.add('hidden');
    setTimeout(() => {
      addFeedRow.classList.remove('added');
      feedUrlInput.placeholder = '粘贴 RSS URL';
      if (addFeedIcon) addFeedIcon.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3.5" x2="8" y2="12.5"/><line x1="3.5" y1="8" x2="12.5" y2="8"/></svg>`;
    }, 1400);
  } catch (e) {
    addFeedRow.classList.remove('adding');
    feedUrlInput.placeholder = '粘贴 RSS URL';
    setGlobalStatus('添加失败: ' + e, 'error');
  } finally {
    btnAddFeed.disabled = false;
  }
}

let feedAddMode = 'url';

function setFeedAddMode(nextMode) {
  feedAddMode = nextMode === 'author' ? 'author' : 'url';
  document.querySelectorAll('[data-feed-add-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.feedAddMode === feedAddMode);
  });
  document.getElementById('feed-add-url-builder')?.classList.toggle('hidden', feedAddMode !== 'url');
  document.getElementById('feed-add-author-builder')?.classList.toggle('hidden', feedAddMode !== 'author');
  document.getElementById('btn-create-feed').textContent = feedAddMode === 'author' ? '创建并添加' : '添加订阅';
  syncFeedAddModalState();
}

function openFeedAddModal() {
  const modal = document.getElementById('feed-add-modal');
  const input = document.getElementById('feed-add-url');
  if (!modal || !input) return;
  input.value = '';
  document.getElementById('feed-author-name').value = '';
  document.getElementById('feed-author-affiliation').value = '';
  document.getElementById('feed-author-start-date').value = '';
  document.getElementById('feed-author-end-date').value = '';
  document.getElementById('feed-author-limit').value = '15';
  document.getElementById('feed-author-title').value = '';
  document.getElementById('feed-add-status').textContent = '';
  setFeedAddMode('url');
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 0);
}

function closeFeedAddModal() {
  document.getElementById('feed-add-modal')?.classList.add('hidden');
}

function syncFeedAddModalState({ clearStatus = true } = {}) {
  const input = document.getElementById('feed-add-url');
  const button = document.getElementById('btn-create-feed');
  if (!input || !button) return;
  const hasRequiredValue = feedAddMode === 'author'
    ? !!document.getElementById('feed-author-name')?.value.trim()
    : !!input.value.trim();
  button.disabled = !hasRequiredValue;
  if (clearStatus) document.getElementById('feed-add-status').textContent = '';
}

async function createFeedFromModal() {
  const input = document.getElementById('feed-add-url');
  const button = document.getElementById('btn-create-feed');
  const status = document.getElementById('feed-add-status');
  const url = input?.value.trim() || '';
  const authorName = document.getElementById('feed-author-name')?.value.trim() || '';
  if (!button || !status || (feedAddMode === 'url' ? !url : !authorName)) return;

  button.disabled = true;
  button.textContent = feedAddMode === 'author' ? '正在创建…' : '正在添加…';
  status.textContent = '';
  try {
    if (feedAddMode === 'author') {
      status.textContent = 'AI 正在识别作者和机构并构建检索式…';
      const query = await invoke('build_pubmed_author_query', {
        authorName,
        affiliation: document.getElementById('feed-author-affiliation').value.trim() || null,
        startDate: document.getElementById('feed-author-start-date').value || null,
        endDate: document.getElementById('feed-author-end-date').value || null,
      });
      loadCostSummary();
      const pubmedLimit = clampPubmedLimit(document.getElementById('feed-author-limit').value);
      status.textContent = '正在生成 PubMed RSS…';
      const generatedUrl = await invoke('build_pubmed_rss_url', { query, limit: pubmedLimit });
      const customTitle = document.getElementById('feed-author-title').value.trim();
      await persistNewFeed(generatedUrl, {
        title: customTitle || `${authorName} 文献`,
        pubmedQuery: query,
        pubmedLimit,
      });
    } else {
      await persistNewFeed(url);
    }
    closeFeedAddModal();
    setGlobalStatus('订阅源已添加', 'success');
  } catch (e) {
    status.textContent = `添加失败：${e}`;
    (feedAddMode === 'author' ? document.getElementById('feed-author-name') : input)?.focus();
  } finally {
    button.textContent = feedAddMode === 'author' ? '创建并添加' : '添加订阅';
    syncFeedAddModalState({ clearStatus: false });
  }
}

// ── In-app confirm modal (window.confirm is blocked in Tauri 2 WKWebView) ──
function confirmDialog(message, { okLabel = '删除', cancelLabel = '取消', danger = true } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-card" role="dialog" aria-modal="true">
        <div class="confirm-msg">${message}</div>
        <div class="confirm-actions">
          <button class="btn btn-secondary btn-sm confirm-cancel" type="button">${cancelLabel}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm confirm-ok" type="button">${okLabel}</button>
        </div>
      </div>
    `;
    const cleanup = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    };
    overlay.addEventListener('click', e => {
      if (e.target === overlay) cleanup(false);
    });
    overlay.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    // Focus the primary action for fast keyboard confirm
    setTimeout(() => overlay.querySelector('.confirm-ok')?.focus(), 0);
  });
}

function isPaperChatReadingNote(note) {
  return String(note?.profile_id || '').startsWith('paper-chat-excerpts');
}

function readingNotePreview(note) {
  const plain = String(note?.content || '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[#>*`_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain ? plain.slice(0, 72) : '暂无内容';
}

function chooseReadingNoteTarget(notes = []) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const optionsHtml = notes.map(note => `
      <button
        class="note-target-option"
        type="button"
        data-note-id="${note.id}"
        data-note-name="${escapeHtml(note.profile_name || '阅读笔记')}"
      >
        <span class="note-target-title">${escapeHtml(note.profile_name || '阅读笔记')}</span>
        <span class="note-target-meta">${escapeHtml(formatReadingNoteTime(note.generated_at))}</span>
        <span class="note-target-preview">${escapeHtml(readingNotePreview(note))}</span>
      </button>
    `).join('');
    overlay.innerHTML = `
      <div class="confirm-card note-target-card" role="dialog" aria-modal="true">
        <div class="confirm-msg">把这轮问答保存到哪条笔记？</div>
        <div class="note-target-list">
          ${optionsHtml}
          <button class="note-target-option note-target-option-new" type="button" data-note-new="1">
            <span class="note-target-title">新建对话摘录</span>
            <span class="note-target-meta">创建一条新的对话笔记</span>
            <span class="note-target-preview">适合把这轮问答单独归档，避免混进已有阅读笔记。</span>
          </button>
        </div>
        <div class="confirm-actions">
          <button class="btn btn-secondary btn-sm note-target-cancel" type="button">取消</button>
        </div>
      </div>
    `;

    const cleanup = (value) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(null);
    };

    overlay.addEventListener('click', e => {
      if (e.target === overlay) cleanup(null);
      const option = e.target.closest('[data-note-id], [data-note-new]');
      if (!option) return;
      if (option.dataset.noteNew) {
        cleanup({ noteId: null, label: '新建对话摘录', isNew: true });
        return;
      }
      cleanup({
        noteId: Number(option.dataset.noteId),
        label: option.dataset.noteName || '阅读笔记',
        isNew: false,
      });
    });
    overlay.querySelector('.note-target-cancel')?.addEventListener('click', () => cleanup(null));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.querySelector('[data-note-id], [data-note-new]')?.focus(), 0);
  });
}

function findQuestionForAssistantMessage(messages, assistantIndex) {
  for (let i = assistantIndex - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return (messages[i].content || '').trim();
  }
  return '';
}

function buildPaperChatNoteExcerpt(question, answer) {
  const blocks = [];
  const normalizedQuestion = String(question || '').trim();
  const normalizedAnswer = String(answer || '').trim();
  if (normalizedQuestion) blocks.push(`**问题**\n${normalizedQuestion}`);
  blocks.push(`**回答**\n${normalizedAnswer}`);
  return blocks.join('\n\n');
}

async function deleteFeed(id) {
  try {
    await invoke('delete_feed', { id });
    hideContextMenu();
    detailEmpty.classList.remove('hidden');
    detailContent.classList.add('hidden');
    if (selectedFeedId === id) selectedFeedId = null;
    await loadFeeds();
    await loadEntries();
    if (!document.getElementById('section-feeds').classList.contains('hidden')) renderFeedSettingsList();
  } catch (e) {
    setGlobalStatus('删除失败: ' + e, 'error');
  }
}

// ── Context menus ──────────────────────────────
function mountContextMenu(menu, x, y) {
  const viewportGap = 8;
  const maxWidth = Math.max(0, window.innerWidth - viewportGap * 2);
  const maxHeight = Math.max(0, window.innerHeight - viewportGap * 2);

  menu.style.maxWidth = `${maxWidth}px`;
  menu.style.maxHeight = `${maxHeight}px`;
  menu.style.overflowY = 'auto';
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(viewportGap, window.innerWidth - rect.width - viewportGap);
  const maxTop = Math.max(viewportGap, window.innerHeight - rect.height - viewportGap);
  menu.style.left = `${Math.max(viewportGap, Math.min(x, maxLeft))}px`;
  menu.style.top = `${Math.max(viewportGap, Math.min(y, maxTop))}px`;
  contextMenu = menu;
}

function showContextMenu(x, y, feed) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = `
    <div class="context-item" data-action="refresh">更新订阅源</div>
    <div class="context-separator"></div>
    <div class="context-item" data-action="translate-title">翻译标题</div>
    <div class="context-item" data-action="translate-summary">翻译摘要</div>
    <div class="context-separator"></div>
    <div class="context-item" data-action="rename">重命名</div>
    ${isPubmedFeed(feed) ? '<div class="context-item" data-action="convert-to-search">转为 PubMed 检索</div>' : ''}
    <div class="context-separator"></div>
    <div class="context-item context-item-danger" data-action="delete">删除</div>
  `;
  menu.addEventListener('click', async e => {
    const action = e.target.dataset.action;
    if (!action) return;
    hideContextMenu();
    if (action === 'refresh') {
      await refreshFeed(feed);
    } else if (action === 'translate-title') {
      await translateFeedEntries(feed, 'title');
    } else if (action === 'translate-summary') {
      await translateFeedEntries(feed, 'summary');
    } else if (action === 'rename') {
      startRenameFeed(feed.id);
    } else if (action === 'convert-to-search') {
      await convertPubmedFeedToSearch(feed);
    } else if (action === 'delete') {
      if (await confirmDialog('确定删除该订阅源及其所有文章？')) deleteFeed(feed.id);
    }
  });
  mountContextMenu(menu, x, y);
  document.addEventListener('click', hideContextMenu, { once: true });
}

async function convertPubmedFeedToSearch(feed) {
  const config = parsePubmedFeedConfig(feed);
  if (!config?.query) {
    setGlobalStatus('这条旧 PubMed RSS 没有保存检索式，请先补充检索式', 'error');
    pubmedGeneratorApi?.beginEdit(feed);
    return;
  }
  const confirmed = await confirmDialog(
    `把“${escapeHtml(feed.title || 'PubMed RSS')}”转为 PubMed 检索？转换完成后将停止 RSS 刷新，并保留已有文章和阅读记录。`,
    { okLabel: '转为 PubMed 检索', cancelLabel: '取消', danger: false },
  );
  if (!confirmed) return;

  setGlobalStatus(`正在把“${feed.title || 'PubMed RSS'}”转为 PubMed 检索…`, 'progress');
  try {
    const search = await invoke('convert_pubmed_feed_to_search', { feedId: feed.id });
    await Promise.all([loadFeeds(), loadPubmedSearches()]);
    await selectPubmedSearch(search.id);
    setGlobalStatus('已转为 PubMed 检索，原 RSS 入口已移除', 'success');
  } catch (error) {
    setGlobalStatus('转换失败，原 RSS 已保留: ' + error, 'error');
  } finally {
    activePubmedRunId = null;
  }
}

async function convertPubmedSearchToFeed(search) {
  const confirmed = await confirmDialog(
    `把“${escapeHtml(search.name)}”转为 RSS 订阅？现有文章和阅读记录会保留，检索筛选状态将不再显示。`,
    { okLabel: '转为 RSS 订阅', cancelLabel: '取消', danger: false },
  );
  if (!confirmed) return;

  setGlobalStatus(`正在为“${search.name}”生成 PubMed RSS…`, 'progress');
  try {
    const feed = await invoke('convert_pubmed_search_to_feed', { searchId: search.id });
    currentPubmedSearch = null;
    await Promise.all([loadPubmedSearches(), loadFeeds()]);
    selectFeed(feed.id);
    setGlobalStatus('已转为 RSS 订阅，原 PubMed 检索入口已移除', 'success');
  } catch (error) {
    setGlobalStatus('转换失败，原 PubMed 检索已保留: ' + error, 'error');
  }
}

async function refreshFeed(feed) {
  if (!feed?.id) return;
  const feedName = feed.title || feed.url || `订阅源 ${feed.id}`;
  setGlobalStatus(`正在更新「${feedName}」…`, 'progress');
  try {
    const result = await invoke('fetch_feed', { feedId: feed.id });
    const first = Array.isArray(result.feeds) ? result.feeds[0] : null;
    let msg = `「${feedName}」更新完成`;
    if ((first?.new_entries || 0) > 0) msg += `，新增 ${first.new_entries} 篇 · 正在自动翻译…`;
    else msg += '，没有新文章';
    if (result.errors?.length) msg += `，${result.errors.length} 个问题`;
    setGlobalStatus(msg, result.errors?.length ? 'error' : 'success');
    await loadFeeds();
    await loadEntries(selectedFeedId);
  } catch (e) {
    setGlobalStatus(`更新「${feedName}」失败: ` + e, 'error');
  }
}

async function deleteBriefing(id) {
  try {
    await invoke('delete_briefing', { id });
    // If the deleted one was selected, clear the detail panel.
    if (selectedBriefingId === id) selectedBriefingId = null;
    // Drop it from the in-memory list immediately so the row vanishes
    // without waiting for the round-trip reload.
    BRIEFINGS = BRIEFINGS.filter(b => b.id !== id);
    readBriefings.delete(id);
    persistReadBriefings();
    renderBriefingList();
    updateOverviewCounts();
    if (BRIEFINGS.length === 0) {
      showBriefingEmpty();
    } else if (!selectedBriefingId) {
      selectBriefing(BRIEFINGS[0].id);
    }
    setGlobalStatus('简报已删除', 'success');
  } catch (e) {
    setGlobalStatus('删除失败: ' + e, 'error');
  }
}

function showBriefingContextMenu(x, y, briefing) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = `<div class="context-item context-item-danger" data-action="delete">删除</div>`;
  menu.addEventListener('click', async e => {
    const action = e.target.dataset.action;
    if (!action) return;
    hideContextMenu();
    if (action === 'delete') {
      if (await confirmDialog('确定删除该简报？此操作不可撤销。')) {
        deleteBriefing(briefing.id);
      }
    }
  });
  mountContextMenu(menu, x, y);
  document.addEventListener('click', hideContextMenu, { once: true });
}

function showEntryContextMenu(x, y, entry) {
  const targetEntries = getContextMenuEntries(entry);
  const isBatch = targetEntries.length > 1;
  const titleEntries = targetEntries.filter(entryNeedsTitleTranslation);
  const summaryEntries = targetEntries.filter(entryNeedsSummaryTranslation);

  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';

  let items = '';
  if (titleEntries.length || summaryEntries.length) {
    if (titleEntries.length) {
      items += `<div class="context-item" data-action="translate-title">${isBatch ? `翻译所选 ${titleEntries.length} 篇标题` : '翻译标题'}</div>`;
    }
    if (summaryEntries.length) {
      items += `<div class="context-item" data-action="translate-summary">${isBatch ? `翻译所选 ${summaryEntries.length} 篇摘要` : '翻译摘要'}</div>`;
    }
    items += '<div class="context-separator"></div>';
  }
  items += `<div class="context-item" data-action="download-pdf">${isBatch ? `下载所选 ${targetEntries.length} 篇 PDF` : '下载 PDF'}</div>`;
  if (!isBatch) {
    if (items) items += '<div class="context-separator"></div>';
    items += `<div class="context-item" data-action="${entry.is_read ? 'mark-unread' : 'mark-read'}">${entry.is_read ? '标为未读' : '标为已读'}</div>`;
    items += `<div class="context-item" data-action="${starredIds().has(entry.id) ? 'unstar' : 'star'}">${starredIds().has(entry.id) ? '取消星标' : '星标'}</div>`;
  }
  if (readingProfiles.length) {
    if (items) items += '<div class="context-separator"></div>';
    items += buildReadingProfileMenuItems(profile =>
      `<div class="context-item" data-action="reading-note" data-profile-id="${escapeHtml(profile.id)}">${isBatch ? '批量生成' : '生成'}${escapeHtml(readingModeLabel(profile.reading_mode))} · ${escapeHtml(profile.name)}</div>`
    );
  }
  if (!items) {
    items = '<div class="context-item disabled">无可用操作</div>';
  }
  menu.innerHTML = items;

  menu.addEventListener('click', async e => {
    const target = e.target.closest('.context-item');
    const action = target?.dataset?.action;
    if (!action) return;
    hideContextMenu();
    if (action === 'download-pdf') {
      await downloadEntriesWithNature(targetEntries);
    } else if (action === 'translate-title') {
      await translateEntries(targetEntries, 'title');
    } else if (action === 'translate-summary') {
      await translateEntries(targetEntries, 'summary');
    } else if (action === 'mark-read') await setEntryRead(entry, true);
    else if (action === 'mark-unread') await setEntryRead(entry, false);
    else if (action === 'star' || action === 'unstar') {
      toggleStar(entry.id);
      renderEntryList(allEntries);
      updateOverviewCounts();
    } else if (action === 'reading-note') {
      if (isBatch) await generateReadingNotesForEntries(targetEntries, target.dataset.profileId);
      else await generateReadingNoteForEntry(entry, target.dataset.profileId);
    }
  });
  mountContextMenu(menu, x, y);
  document.addEventListener('click', hideContextMenu, { once: true });
}

function hideContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
}

function getFilteredEntries(entries = allEntries) {
  if (mode === 'pubmed' || mode === 'kept') return getFilteredPubmedEntries(entries);
  let filtered = entries;
  const stars = starredIds();
  if (entryFilterValue === 'unread') filtered = filtered.filter(e => !e.is_read);
  else if (entryFilterValue === 'starred') filtered = filtered.filter(e => stars.has(e.id));
  else if (entryFilterValue === 'reading-notes') filtered = filtered.filter(e => e.has_reading_note);
  if (entryTagFilterValue !== 'all') {
    filtered = filtered.filter(entry => (entry.tags || []).includes(entryTagFilterValue));
  }

  if (hasActiveEntryMetricFilters()) {
    filtered = filtered.filter(matchesEntryMetricFilters);
  }
  return sortEntries(filtered, entrySortMode, lookupJournalMetrics);
}

function getFilteredPubmedEntries(entries = allEntries) {
  let filtered = [...entries];
  const query = literatureSearchInput?.value.trim() || '';
  if (query) filtered = filtered.filter(entry => entryMatchesLiteratureSearchQuery(entry, query));
  const stars = starredIds();
  if (entryFilterValue === 'unread') filtered = filtered.filter(e => !e.is_read);
  else if (entryFilterValue === 'starred') filtered = filtered.filter(e => stars.has(e.id));
  else if (entryFilterValue === 'reading-notes') filtered = filtered.filter(e => e.has_reading_note);
  const snapshot = currentPubmedSnapshot();
  if (snapshot) {
    const snapshotIds = new Set(snapshot.entryIds);
    filtered = filtered.filter(entry => snapshotIds.has(entry.id));
  }
  if (pubmedFilters.status !== 'all') {
    filtered = filtered.filter(entry => entry.screening_status === pubmedFilters.status);
  }
  if (pubmedFilters.star !== 'all') {
    filtered = filtered.filter(entry => pubmedFilters.star === 'starred' ? stars.has(entry.id) : !stars.has(entry.id));
  }
  if (pubmedFilters.publishedFrom) {
    filtered = filtered.filter(entry => String(entry.publication_date || '') >= pubmedFilters.publishedFrom);
  }
  if (pubmedFilters.publishedTo) {
    filtered = filtered.filter(entry => String(entry.publication_date || '') <= `${pubmedFilters.publishedTo}-31`);
  }
  if (pubmedFilters.addedFrom) {
    filtered = filtered.filter(entry => String(entry.first_seen_at || '').slice(0, 10) >= pubmedFilters.addedFrom);
  }
  if (pubmedFilters.addedTo) {
    filtered = filtered.filter(entry => String(entry.first_seen_at || '').slice(0, 10) <= pubmedFilters.addedTo);
  }
  if (entryTagFilterValue !== 'all') {
    filtered = filtered.filter(entry => (entry.tags || []).includes(entryTagFilterValue));
  }
  if (hasActiveEntryMetricFilters()) filtered = filtered.filter(matchesEntryMetricFilters);

  return sortPubmedEntriesForCurrentView(filtered);
}

function sortPubmedEntriesForCurrentView(entries) {
  const sorted = [...entries];
  const nullLast = (left, right, direction = 1) => {
    const leftMissing = left == null || left === '';
    const rightMissing = right == null || right === '';
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftMissing) return 0;
    if (left < right) return -direction;
    if (left > right) return direction;
    return 0;
  };
  sorted.sort((left, right) => {
    switch (pubmedFilters.sort) {
      case 'publication-asc': return nullLast(left.publication_sort_key, right.publication_sort_key, 1);
      case 'added-desc': return nullLast(left.first_seen_at, right.first_seen_at, -1);
      case 'added-asc': return nullLast(left.first_seen_at, right.first_seen_at, 1);
      case 'if-desc': return nullLast(metricIfValue(left), metricIfValue(right), -1);
      case 'if-asc': return nullLast(metricIfValue(left), metricIfValue(right), 1);
      case 'rank': return nullLast(left.pubmed_rank, right.pubmed_rank, 1);
      default: return nullLast(left.publication_sort_key, right.publication_sort_key, -1);
    }
  });
  return sortEntries(sorted, entrySortMode, lookupJournalMetrics);
}

function metricIfValue(entry) {
  const value = Number(lookupJournalMetrics(entry)?.if);
  return Number.isFinite(value) ? value : null;
}

function collectEntryTagOptions(entries = allEntries) {
  const counts = new Map();
  entries.forEach(entry => {
    (entry.tags || []).forEach(tag => {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    });
  });

  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0], 'zh-CN');
    })
    .map(([tag, count]) => ({ tag, count }));
}

function refreshEntryTagFilterOptions(entries = allEntries) {
  if (!entryTagFilter) return;

  const options = collectEntryTagOptions(entries);
  const previousValue = entryTagFilterValue;
  const nextValue = entryTagFilterValue !== 'all'
    && options.some(item => item.tag === entryTagFilterValue)
    ? entryTagFilterValue
    : 'all';

  entryTagFilter.innerHTML = '';

  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = '全部标签';
  entryTagFilter.appendChild(allOption);

  options.forEach(({ tag, count }) => {
    const option = document.createElement('option');
    option.value = tag;
    option.textContent = `${tag} (${count})`;
    entryTagFilter.appendChild(option);
  });

  entryTagFilterValue = nextValue;
  entryTagFilter.value = nextValue;
  if (nextValue !== previousValue) persistCurrentFilterScope();
}

function renderEntryTagBadges(tags, { limit = 3 } = {}) {
  const list = Array.isArray(tags) ? tags : [];
  const badges = list
    .slice(0, limit)
    .map(tag => `<span class="pill pill-tag">${escapeHtml(tag)}</span>`);
  if (list.length > limit) {
    badges.push(`<span class="pill pill-neutral">+${list.length - limit}</span>`);
  }
  return badges;
}

function getSelectedEntries() {
  return getFilteredEntries(allEntries).filter(entry => selectedEntryIds.has(entry.id));
}

function areAllVisibleEntriesSelected() {
  const visibleEntries = getFilteredEntries(allEntries);
  return visibleEntries.length > 0 && visibleEntries.every(entry => selectedEntryIds.has(entry.id));
}

function getVisibleEntriesWithoutNotes() {
  return getFilteredEntries(allEntries).filter(entry => !entry.has_reading_note);
}

function getVisibleEntriesWithNotes() {
  return getFilteredEntries(allEntries).filter(entry => entry.has_reading_note);
}

function focusEntryList() {
  if (!entryListEl || entryListEl.classList.contains('hidden')) return;
  entryListEl.focus({ preventScroll: true });
}

function isEditableShortcutTarget(target) {
  const el = target instanceof HTMLElement ? target : target?.parentElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  return !!el.closest('[contenteditable="true"]');
}

function canHandleEntrySelectAllShortcut(target) {
  if (isEditableShortcutTarget(target)) return false;
  if (!mainView || mainView.classList.contains('hidden')) return false;
  if (!entryListEl || entryListEl.classList.contains('hidden')) return false;
  return true;
}

function canHandleEntryArrowShortcut(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (entrySelectionMode || isEditableShortcutTarget(event.target)) return false;
  if (!mainView || mainView.classList.contains('hidden')) return false;
  if (!entryListEl || entryListEl.classList.contains('hidden')) return false;
  return ![...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .some(dialog => !dialog.closest('.hidden'));
}

function navigateEntryList(direction) {
  const items = [...entryItemsEl.children]
    .filter(item => item.matches('.entry-item, .pubmed-entry-item'));
  if (!items.length) return;

  const currentIndex = items.findIndex(item =>
    currentEntry && item.dataset.entryId === String(currentEntry.id)
  );
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : items.length - 1)
    : Math.max(0, Math.min(items.length - 1, currentIndex + direction));
  const nextItem = items[nextIndex];
  if (nextIndex === currentIndex) {
    focusEntryList();
    nextItem.scrollIntoView({ block: 'nearest' });
    return;
  }
  const entry = allEntries.find(item => String(item.id) === nextItem.dataset.entryId);
  if (!entry) return;

  focusEntryList();
  items.forEach(item => item.classList.remove('selected'));
  nextItem.classList.add('selected');
  showDetail(entry);
  if (!entry.is_read) void setEntryRead(entry, true);

  requestAnimationFrame(() => {
    entryItemsEl.querySelector(`[data-entry-id="${CSS.escape(String(entry.id))}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function clearEntrySelection({ keepMode = false, render = true, syncPaperChat = true } = {}) {
  selectedEntryIds = new Set();
  entrySelectionAnchorId = null;
  entrySelectionMode = !!keepMode;
  syncEntryBulkActions();
  if (render) renderEntryList(allEntries);
  if (syncPaperChat) refreshPaperChatAfterScopeDataChange();
}

function syncEntryBulkActions() {
  if (!entryBulkCount || !btnEntrySelectMode || !btnEntryBulkSelectAll || !btnEntryBulkSelectUnnoted || !btnEntryBulkSelectNoted || !btnEntryBulkInvert || !btnEntryBulkDeselect || !entryBulkExistingMode || !btnEntryBulkGenerate || !btnEntryBulkClear) return;
  const count = selectedEntryIds.size;
  const visibleEntries = getFilteredEntries(allEntries);
  const unnotedEntries = getVisibleEntriesWithoutNotes();
  const notedEntries = getVisibleEntriesWithNotes();
  entryBulkActions.classList.toggle('selection-mode', entrySelectionMode);
  entryBulkCount.textContent = count ? `已选 ${count} 篇` : '未选择';
  entryBulkCount.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkSelectAll.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkSelectAll.textContent = areAllVisibleEntriesSelected() ? '取消全选' : '全选当前结果';
  btnEntryBulkSelectUnnoted.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkSelectUnnoted.disabled = unnotedEntries.length === 0;
  btnEntryBulkSelectUnnoted.title = unnotedEntries.length === 0
    ? '当前筛选结果下没有未做阅读笔记的文章'
    : `选择当前筛选结果里未做阅读笔记的 ${unnotedEntries.length} 篇文章`;
  btnEntryBulkSelectNoted.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkSelectNoted.disabled = notedEntries.length === 0;
  btnEntryBulkSelectNoted.title = notedEntries.length === 0
    ? '当前筛选结果下没有已有阅读笔记的文章'
    : `选择当前筛选结果里已有阅读笔记的 ${notedEntries.length} 篇文章`;
  btnEntryBulkInvert.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkInvert.disabled = visibleEntries.length === 0;
  btnEntryBulkDeselect.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkDeselect.disabled = count === 0;
  const canExportSelection = ['pubmed', 'kept'].includes(mode) && entrySelectionMode;
  entryBulkExportFormat?.classList.toggle('hidden', !canExportSelection);
  btnEntryBulkExport?.classList.toggle('hidden', !canExportSelection);
  if (btnEntryBulkExport) btnEntryBulkExport.disabled = count === 0;
  entryBulkExistingMode.classList.toggle('hidden', !entrySelectionMode);
  entryBulkExistingMode.value = entryBulkExistingStrategy;
  btnEntryBulkGenerate.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkGenerate.disabled = count === 0 || !readingProfiles.length;
  btnEntryBulkClear.classList.toggle('hidden', !entrySelectionMode);
  btnEntrySelectMode.textContent = entrySelectionMode ? '退出多选' : '多选';
  btnEntrySelectMode.classList.toggle('active', entrySelectionMode);
  const pubmedBatchMode = mode === 'pubmed';
  pubmedBulkStatus?.classList.toggle('hidden', !pubmedBatchMode || !entrySelectionMode);
  if (pubmedBulkStatus) pubmedBulkStatus.disabled = count === 0;
  btnPubmedAiScreen?.classList.toggle('hidden', !pubmedBatchMode || !entrySelectionMode);
  if (btnPubmedAiScreen) btnPubmedAiScreen.disabled = count === 0;
  if (currentEntry) refreshPaperChatScopeControls();
}

function toggleEntrySelection(entryId, { shiftKey = false } = {}) {
  const visibleEntries = getFilteredEntries(allEntries);
  if (
    shiftKey
    && entrySelectionAnchorId
    && visibleEntries.some(entry => entry.id === entrySelectionAnchorId)
  ) {
    const start = visibleEntries.findIndex(entry => entry.id === entrySelectionAnchorId);
    const end = visibleEntries.findIndex(entry => entry.id === entryId);
    if (start >= 0 && end >= 0) {
      const [from, to] = start <= end ? [start, end] : [end, start];
      for (const entry of visibleEntries.slice(from, to + 1)) {
        selectedEntryIds.add(entry.id);
      }
    } else {
      selectedEntryIds.add(entryId);
    }
  } else if (selectedEntryIds.has(entryId)) {
    selectedEntryIds.delete(entryId);
  } else {
    selectedEntryIds.add(entryId);
  }

  entrySelectionAnchorId = entryId;
  syncEntryBulkActions();
  if (currentEntry && getSelectedEntries().length > 1) {
    paperChatScope = 'selection';
  }
  refreshPaperChatAfterScopeDataChange();
}

function toggleSelectAllVisibleEntries() {
  const visibleEntries = getFilteredEntries(allEntries);
  if (!visibleEntries.length) {
    setGlobalStatus('当前筛选结果下没有可选择的文章', 'error');
    return;
  }

  if (areAllVisibleEntriesSelected()) {
    for (const entry of visibleEntries) {
      selectedEntryIds.delete(entry.id);
    }
  } else {
    for (const entry of visibleEntries) {
      selectedEntryIds.add(entry.id);
    }
    entrySelectionAnchorId = visibleEntries[visibleEntries.length - 1]?.id || null;
  }

  syncEntryBulkActions();
  renderEntryList(allEntries);
  if (currentEntry && getSelectedEntries().length > 1) {
    paperChatScope = 'selection';
  }
  refreshPaperChatAfterScopeDataChange();
}

function selectAllVisibleEntries() {
  const visibleEntries = getFilteredEntries(allEntries);
  if (!visibleEntries.length) {
    setGlobalStatus('当前筛选结果下没有可选择的文章', 'error');
    return;
  }

  for (const entry of visibleEntries) {
    selectedEntryIds.add(entry.id);
  }
  entrySelectionAnchorId = visibleEntries[visibleEntries.length - 1]?.id || null;
  syncEntryBulkActions();
  renderEntryList(allEntries);
  if (currentEntry && getSelectedEntries().length > 1) {
    paperChatScope = 'selection';
  }
  refreshPaperChatAfterScopeDataChange();
}

function handleEntryMultiSelect(entry, { shiftKey = false } = {}) {
  focusEntryList();
  if (!currentEntry) showDetail(entry);
  if (!entrySelectionMode) entrySelectionMode = true;
  toggleEntrySelection(entry.id, { shiftKey });
  if (getSelectedEntries().length > 1) {
    paperChatScope = 'selection';
  }
  renderEntryList(allEntries);
}

function selectVisibleEntriesWithoutNotes() {
  const entries = getVisibleEntriesWithoutNotes();
  if (!entries.length) {
    setGlobalStatus('当前筛选结果下没有“未做阅读笔记”的文章', 'error');
    return;
  }

  selectedEntryIds = new Set(entries.map(entry => entry.id));
  entrySelectionAnchorId = entries[entries.length - 1]?.id || null;
  syncEntryBulkActions();
  renderEntryList(allEntries);
  if (currentEntry && getSelectedEntries().length > 1) {
    paperChatScope = 'selection';
  }
  refreshPaperChatAfterScopeDataChange();
}

function selectVisibleEntriesWithNotes() {
  const entries = getVisibleEntriesWithNotes();
  if (!entries.length) {
    setGlobalStatus('当前筛选结果下没有“已有阅读笔记”的文章', 'error');
    return;
  }

  selectedEntryIds = new Set(entries.map(entry => entry.id));
  entrySelectionAnchorId = entries[entries.length - 1]?.id || null;
  syncEntryBulkActions();
  renderEntryList(allEntries);
  if (currentEntry && getSelectedEntries().length > 1) {
    paperChatScope = 'selection';
  }
  refreshPaperChatAfterScopeDataChange();
}

function invertVisibleEntrySelection() {
  const visibleEntries = getFilteredEntries(allEntries);
  if (!visibleEntries.length) {
    setGlobalStatus('当前筛选结果下没有可反选的文章', 'error');
    return;
  }

  const next = new Set(selectedEntryIds);
  for (const entry of visibleEntries) {
    if (next.has(entry.id)) next.delete(entry.id);
    else next.add(entry.id);
  }
  selectedEntryIds = next;
  entrySelectionAnchorId = visibleEntries[visibleEntries.length - 1]?.id || null;
  syncEntryBulkActions();
  renderEntryList(allEntries);
  if (currentEntry && getSelectedEntries().length > 1) {
    paperChatScope = 'selection';
  }
  refreshPaperChatAfterScopeDataChange();
}

function clearSelectedEntriesOnly() {
  selectedEntryIds = new Set();
  entrySelectionAnchorId = null;
  syncEntryBulkActions();
  renderEntryList(allEntries);
  refreshPaperChatAfterScopeDataChange();
}

function getContextMenuEntries(entry) {
  const batchEntries = entrySelectionMode && selectedEntryIds.has(entry.id)
    ? getSelectedEntries()
    : [];
  return batchEntries.length > 1 ? batchEntries : [entry];
}

async function translateEntries(entries, field, contextLabel = '') {
  const fieldLabel = field === 'title' ? '标题' : '摘要';
  const contextPrefix = contextLabel || '';
  const invokeName = field === 'title' ? 'translate_entry_title' : 'translate_entry_summary';
  const needsTranslation = field === 'title' ? entryNeedsTitleTranslation : entryNeedsSummaryTranslation;
  const targetEntries = entries.filter(needsTranslation);
  if (!targetEntries.length) {
    setGlobalStatus(`${contextPrefix}所选文章都已有${fieldLabel}翻译`, 'success');
    return;
  }

  const total = targetEntries.length;
  let completed = 0;
  let translatedCount = 0;
  let skippedCount = 0;
  const failures = [];
  const updateProgress = () => {
    const active = Math.min(DEFAULT_TRANSLATION_CONCURRENCY, total - completed);
    setGlobalStatus(`${contextPrefix}正在翻译${fieldLabel}：已完成 ${completed}/${total}，处理中 ${active} 篇`, 'progress');
  };
  updateProgress();
  await runConcurrentQueue(
    targetEntries,
    entry => invoke(invokeName, { entryId: entry.id }),
    {
      concurrency: DEFAULT_TRANSLATION_CONCURRENCY,
      maxRetries: 2,
      retryDelayMs: 800,
      onSettled: result => {
        completed += 1;
        if (result.ok) {
          if (result.value) translatedCount += 1;
          else skippedCount += 1;
        } else {
          failures.push({
            entry: result.item,
            message: typeof result.error === 'string'
              ? result.error
              : (result.error && result.error.message) || '翻译失败',
          });
        }
        if (completed < total) updateProgress();
      },
    },
  );

  if (!failures.length) {
    setGlobalStatus(
      `${contextPrefix}${fieldLabel}处理完成：翻译 ${translatedCount} 篇，跳过 ${skippedCount} 篇`,
      'success',
    );
    return;
  }

  const preview = failures
    .slice(0, 3)
    .map(item => item.entry.title_translated || item.entry.title || `文献 ${item.entry.id}`)
    .join('；');
  const suffix = failures.length > 3 ? ` 等 ${failures.length} 篇` : '';
  setGlobalStatus(
    `${contextPrefix}${fieldLabel}翻译完成：翻译 ${translatedCount} 篇，跳过 ${skippedCount} 篇，失败 ${failures.length} 篇。${preview}${suffix}`,
    'error',
  );
}

function entryNeedsTitleTranslation(entry) {
  return !entry.title_translated;
}

function entryNeedsSummaryTranslation(entry) {
  return !entry.summary_translated;
}

async function listEntriesForFeedAction(feed) {
  if (selectedFeedId === feed.id) return allEntries;
  return invoke('list_entries', { feedId: feed.id });
}

async function translatePubmedSearchEntries(search, field) {
  if (!search?.id) return;

  const fieldLabel = field === 'title' ? '标题' : '摘要';
  setGlobalStatus(`正在读取「${search.name}」的文章…`, 'progress');
  try {
    const followsCurrentView = mode === 'pubmed' && currentPubmedSearch?.id === search.id;
    const entries = followsCurrentView
      ? allEntries
      : (await invoke('list_pubmed_search_entries', { searchId: search.id })).map(normalizePubmedEntry);
    const orderedEntries = followsCurrentView
      ? sortPubmedEntriesForCurrentView(entries)
      : entries;
    await translateEntries(orderedEntries, field);
  } catch (e) {
    setGlobalStatus(`批量翻译「${search.name}」${fieldLabel}失败: ${e}`, 'error');
  }
}

async function translateFeedEntries(feed, field) {
  if (!feed?.id) return;

  const feedName = feed.title || feed.url || `订阅源 ${feed.id}`;
  const fieldLabel = field === 'title' ? '标题' : '摘要';
  let entries = [];
  try {
    entries = await listEntriesForFeedAction(feed);
  } catch (e) {
    setGlobalStatus(`读取「${feedName}」文章失败: ${e}`, 'error');
    return;
  }

  await translateEntries(entries, field, `「${feedName}」`);
}

function showReadingProfilePickerMenu(x, y, onSelect) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const items = buildReadingProfileMenuItems(profile =>
    `<div class="context-item" data-action="pick-profile" data-profile-id="${escapeHtml(profile.id)}">生成笔记 · ${escapeHtml(profile.name)}</div>`
  );
  menu.innerHTML = items;

  menu.addEventListener('click', async e => {
    const target = e.target.closest('.context-item');
    const action = target?.dataset?.action;
    if (action !== 'pick-profile') return;
    hideContextMenu();
    await onSelect(target.dataset.profileId);
  });

  mountContextMenu(menu, x, y);
  document.addEventListener('click', hideContextMenu, { once: true });
}

async function setEntryRead(entry, isRead) {
  const prev = entry.is_read;
  const listScrollTop = entryItemsEl?.scrollTop ?? 0;
  entry.is_read = isRead;
  const g = globalEntries.find(e => e.id === entry.id);
  if (g) {
    g.is_read = isRead;
    if (isRead && !g.read_at) g.read_at = new Date().toISOString();
  }
  renderEntryList(allEntries, { preserveScrollTop: listScrollTop });
  updateOverviewCounts();
  renderFeedList(allFeeds);
  const feed = allFeeds.find(f => f.id === entry.feed_id);
  if (feed) updateToolbarFeedInfo(feed);
  try {
    await invoke('set_entry_read', { entryId: entry.id, isRead });
  } catch (e) {
    entry.is_read = prev;
    if (g) g.is_read = prev;
    renderEntryList(allEntries, { preserveScrollTop: listScrollTop });
    updateOverviewCounts();
    renderFeedList(allFeeds);
    setGlobalStatus('更新已读状态失败: ' + e, 'error');
  }
}

function normalizeJournalKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replaceAll('&', 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function hasVisibleMetric(value) {
  const text = String(value || '').trim().toUpperCase();
  return !!text && text !== 'N/A';
}

function formatCasPartition(value) {
  const zone = String(value || '').trim().replace(/^[A-Z]+/i, '');
  return zone ? `${zone}区` : String(value || '').trim();
}

function metricToneClass(value) {
  const match = String(value || '').trim().toUpperCase().match(/[QB](\d)/);
  return match ? `metric-tier-${match[1]}` : 'metric-tier-na';
}

function lookupJournalMetrics(entry) {
  if (!journalMetricsIndex) return null;
  const key = normalizeJournalKey(journalName(entry));
  return key ? journalMetricsIndex[key] || null : null;
}

function renderMetricBadges(metrics, { compact = false } = {}) {
  if (!metrics) return '';

  const badges = [];
  if (hasVisibleMetric(metrics.if)) {
    badges.push(`<span class="metric-pill metric-pill-if">IF ${escapeHtml(metrics.if)}</span>`);
  }
  if (hasVisibleMetric(metrics.q)) {
    const qLabel = compact ? metrics.q : `JCR ${metrics.q}`;
    badges.push(`<span class="metric-pill ${metricToneClass(metrics.q)}">${escapeHtml(qLabel)}</span>`);
  }
  if (hasVisibleMetric(metrics.b)) {
    const bLabel = compact ? metrics.b : `中科院 ${formatCasPartition(metrics.b)}`;
    badges.push(`<span class="metric-pill ${metricToneClass(metrics.b)}">${escapeHtml(bLabel)}</span>`);
  }

  return badges.join('');
}

function parseMetricIf(value) {
  const match = String(value || '').trim().match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function persistEntrySortMode() {
  try {
    persistCurrentFilterScope();
  } catch (error) {
    console.warn('保存文献排序失败:', error);
  }
}

function restoreEntrySortMode() {
  try {
    const stored = localStorage.getItem(ENTRY_SORT_STORAGE_KEY)
      || localStorage.getItem(LEGACY_ENTRY_SORT_STORAGE_KEY)
      || 'default';
    const normalized = normalizeEntrySortMode(stored);
    if (normalized === 'default') {
      entrySortField = 'default';
      entrySortDirectionMode = 'desc';
    } else {
      const [field, direction] = normalized.split('-');
      entrySortField = ['year', 'if', 'jcr', 'cas'].includes(field) ? field : 'default';
      entrySortDirectionMode = direction === 'asc' ? 'asc' : 'desc';
    }
    syncEntrySortMode();
  } catch (error) {
    entrySortField = 'default';
    entrySortDirectionMode = 'desc';
    syncEntrySortMode();
    console.warn('恢复文献排序失败:', error);
  }
}

function syncEntrySortMode() {
  entrySortMode = entrySortField === 'default'
    ? 'default'
    : `${entrySortField}-${entrySortDirectionMode}`;
}

function defaultEntrySortDirection(field) {
  return field === 'jcr' || field === 'cas' ? 'asc' : 'desc';
}

function syncEntrySortControl() {
  syncEntrySortMode();
  if (entrySortSelect && entrySortSelect.value !== entrySortField) {
    entrySortSelect.value = entrySortField;
  }
  if (entrySortDirection) {
    const isAscending = entrySortDirectionMode === 'asc';
    entrySortDirection.setAttribute('aria-pressed', String(isAscending));
    entrySortDirection.title = isAscending ? '当前为升序，点击切换为降序' : '当前为降序，点击切换为升序';
    entrySortDirection.querySelector('.entry-sort-direction-label').textContent = isAscending ? '↑' : '↓';
    entrySortDirection.disabled = entrySortField === 'default';
  }
}

function normalizeEntryMetricFilterValue(key, value) {
  const options = ENTRY_METRIC_FILTER_OPTIONS[key] || ['all'];
  return options.includes(value) ? value : 'all';
}

function persistEntryMetricFilters() {
  try {
    persistCurrentFilterScope();
  } catch (error) {
    console.warn('保存分区筛选失败:', error);
  }
}

function restoreEntryMetricFilters() {
  try {
    const raw = localStorage.getItem(ENTRY_METRIC_FILTER_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    Object.keys(ENTRY_METRIC_FILTER_OPTIONS).forEach(key => {
      entryMetricFilters[key] = normalizeEntryMetricFilterValue(key, parsed?.[key]);
    });
  } catch (error) {
    console.warn('恢复分区筛选失败:', error);
  }
}

function syncEntryMetricFilterControls() {
  const controls = {
    if: entryMetricIfFilter,
    q: entryMetricQFilter,
    b: entryMetricBFilter,
    top: entryMetricTopFilter,
  };

  Object.entries(controls).forEach(([key, el]) => {
    if (!el) return;
    const nextValue = normalizeEntryMetricFilterValue(key, entryMetricFilters[key]);
    entryMetricFilters[key] = nextValue;
    if (el.value !== nextValue) {
      el.value = nextValue;
    }
  });
}

function hasActiveEntryMetricFilters() {
  return Object.values(entryMetricFilters).some(value => value !== 'all');
}

function matchesEntryMetricFilters(entry) {
  const metrics = lookupJournalMetrics(entry);
  const ifValue = parseMetricIf(metrics?.if);
  const qValue = String(metrics?.q || '').trim().toUpperCase();
  const bValue = String(metrics?.b || '').trim().toUpperCase();
  const topValue = String(metrics?.top || '').trim();

  if (entryMetricFilters.if !== 'all') {
    if (entryMetricFilters.if === 'na') {
      if (ifValue !== null) return false;
    } else {
      if (ifValue === null) return false;
      if (entryMetricFilters.if === 'ge5' && ifValue < 5) return false;
      if (entryMetricFilters.if === 'ge10' && ifValue < 10) return false;
      if (entryMetricFilters.if === 'ge20' && ifValue < 20) return false;
    }
  }

  if (entryMetricFilters.q !== 'all') {
    if (entryMetricFilters.q === 'na') {
      if (hasVisibleMetric(qValue)) return false;
    } else if (qValue !== entryMetricFilters.q) {
      return false;
    }
  }

  if (entryMetricFilters.b !== 'all') {
    if (entryMetricFilters.b === 'na') {
      if (hasVisibleMetric(bValue)) return false;
    } else if (bValue !== entryMetricFilters.b) {
      return false;
    }
  }

  if (entryMetricFilters.top !== 'all') {
    if (entryMetricFilters.top === 'na') {
      if (topValue === '0' || topValue === '1') return false;
    } else if (entryMetricFilters.top === 'top') {
      if (topValue !== '1') return false;
    } else if (entryMetricFilters.top === 'non-top') {
      if (topValue !== '0') return false;
    }
  }

  return true;
}

async function ensureFreeFulltextStatus(entry) {
  if (!entry || entry.has_free_fulltext !== undefined && entry.has_free_fulltext !== null) return;
  if (freeFulltextCheckInFlight.has(entry.id)) return;

  freeFulltextCheckInFlight.add(entry.id);
  try {
    const hasFreeFulltext = await invoke('ensure_free_fulltext_status', { entryId: entry.id });
    applyEntryUpdate(entry.id, x => { x.has_free_fulltext = !!hasFreeFulltext; });
    renderEntryList(allEntries);
  } catch (e) {
    console.warn('检查免费全文失败:', entry.id, e);
  } finally {
    freeFulltextCheckInFlight.delete(entry.id);
  }
}

function scheduleFreeFulltextChecks(entries) {
  entries
    .filter(entry => entry.has_free_fulltext === null || entry.has_free_fulltext === undefined)
    .slice(0, 12)
    .forEach(entry => {
      ensureFreeFulltextStatus(entry);
    });
}

function renderDetailJournalMeta(entry) {
  const journal = shortJournalDisplayName(journalName(entry));
  const metricHtml = renderMetricBadges(lookupJournalMetrics(entry));
  if (detailJournal) {
    if (journal || metricHtml) {
      const journalHtml = journal ? `《${escapeHtml(journal)}》` : '';
      detailJournal.innerHTML = `${journalHtml}${metricHtml ? `<span class="journal-metrics journal-metrics-detail">${metricHtml}</span>` : ''}`;
      detailJournal.classList.remove('hidden');
    } else {
      detailJournal.innerHTML = '';
      detailJournal.classList.add('hidden');
    }
  }
}

async function loadJournalMetrics() {
  if (journalMetricsIndex) return journalMetricsIndex;
  if (journalMetricsLoadPromise) return journalMetricsLoadPromise;

  journalMetricsLoadPromise = fetch(new URL('./journal-metrics.json', window.location.href))
    .then(async response => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      journalMetricsIndex = await response.json();
      renderEntryList(allEntries);
      if (currentEntry) renderDetailJournalMeta(currentEntry);
      return journalMetricsIndex;
    })
    .catch(error => {
      console.warn('加载期刊指标失败:', error);
      journalMetricsIndex = {};
      return journalMetricsIndex;
    })
    .finally(() => {
      journalMetricsLoadPromise = null;
    });

  return journalMetricsLoadPromise;
}

function setReadingProfileStatus(msg, type = '') {
  const el = document.getElementById('reading-profile-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'settings-status ' + type;
}

function readingProfileFormValues() {
  return {
    name: document.getElementById('reading-profile-name')?.value.trim() || '',
    description: document.getElementById('reading-profile-description')?.value.trim() || '',
    reading_mode: document.getElementById('reading-profile-mode')?.value || 'quick',
    prompt: document.getElementById('reading-profile-prompt')?.value.trim() || '',
  };
}

function readingModeLabel(mode) {
  return mode === 'deep' ? '深度笔记' : '快速笔记';
}

function readingSourceKindLabel(kind) {
  return kind === 'skill' ? 'skill' : '提示词';
}

function buildReadingProfileMenuItems(renderItem) {
  const groups = [
    { kind: 'prompt', label: '提示词' },
    { kind: 'skill', label: 'skill' },
  ];
  let items = '<div class="context-item context-item-section disabled">阅读提示词</div>';
  groups.forEach(group => {
    const profiles = readingProfiles.filter(profile => (profile.source_kind === 'skill' ? 'skill' : 'prompt') === group.kind);
    if (!profiles.length) return;
    items += `<div class="context-item context-item-section disabled">${group.label}</div>`;
    items += profiles.map(renderItem).join('');
  });
  return items;
}

function formatReadingProfilePickerLabel(profile) {
  return `${readingSourceKindLabel(profile.source_kind)} · ${profile.name}`;
}

function formatReadingProfileSourceMeta(profile) {
  return `${readingSourceKindLabel(profile.source_kind)} · ${readingModeLabel(profile.reading_mode)} · ${profile.source_label || '自定义'}`;
}

function compareReadingProfileText(left, right) {
  return left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function compareReadingProfiles(left, right, sortMode) {
  if (sortMode === 'name-desc') {
    return compareReadingProfileText(right.name, left.name) || compareReadingProfileText(left.id, right.id);
  }
  if (sortMode === 'mode') {
    const modeRank = { quick: 0, deep: 1 };
    const modeDiff = (modeRank[left.reading_mode] ?? 9) - (modeRank[right.reading_mode] ?? 9);
    if (modeDiff !== 0) return modeDiff;
  }
  return compareReadingProfileText(left.name, right.name) || compareReadingProfileText(left.id, right.id);
}

function readingProfileSortLabel(sortMode) {
  if (sortMode === 'name-asc') return '名称 A → Z';
  if (sortMode === 'name-desc') return '名称 Z → A';
  if (sortMode === 'mode') return '笔记模式';
  return '手动排序';
}

function setReadingProfileSortMode(sortMode) {
  if (readingProfileSortSelect) {
    readingProfileSortSelect.value = sortMode;
  }
}

function reorderReadingProfiles(fromIndex, toIndex) {
  const next = [...readingProfiles];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function fillReadingProfileEditor(profile = null) {
  editingReadingProfileId = profile?.id || null;
  const nameInput = document.getElementById('reading-profile-name');
  const descInput = document.getElementById('reading-profile-description');
  const modeInput = document.getElementById('reading-profile-mode');
  const promptInput = document.getElementById('reading-profile-prompt');
  if (nameInput) nameInput.value = profile?.name || '';
  if (descInput) descInput.value = profile?.description || '';
  if (modeInput) modeInput.value = profile?.reading_mode || 'quick';
  if (promptInput) promptInput.value = profile?.prompt || '';
}

function renderReadingProfilesSettings() {
  const countEl = document.getElementById('reading-profiles-count');
  const listEl = document.getElementById('reading-profiles-list');
  if (countEl) {
    countEl.textContent = `${readingProfiles.length} 个模板`;
  }
  if (!listEl) return;
  listEl.className = 'reading-profile-list';

  if (!readingProfiles.length) {
    listEl.innerHTML = '<div class="reading-profile-empty">还没有阅读模板。先在下方写一个提示词，再点击「保存模板」。</div>';
    fillReadingProfileEditor(null);
    return;
  }

  if (editingReadingProfileId && !readingProfiles.some(profile => profile.id === editingReadingProfileId)) {
    editingReadingProfileId = null;
  }
  const activeProfile = readingProfiles.find(profile => profile.id === editingReadingProfileId) || readingProfiles[0];
  if (activeProfile && activeProfile.id !== editingReadingProfileId) {
    fillReadingProfileEditor(activeProfile);
  }

  listEl.innerHTML = readingProfiles.map((profile, index) => `
    <div class="reading-profile-row">
      <div class="reading-profile-info">
        <div class="reading-profile-name">${escapeHtml(profile.name)}</div>
        <div class="reading-profile-desc">${escapeHtml(profile.description || '未填写模板简介')}</div>
        <div class="reading-profile-source">${escapeHtml(formatReadingProfileSourceMeta(profile))}</div>
      </div>
      <div class="reading-profile-actions">
        <div class="reading-profile-action-group">
          <button class="btn-ghost btn-sm" data-reading-move="${escapeHtml(profile.id)}" data-reading-offset="-1" ${index === 0 ? 'disabled' : ''}>上移</button>
          <button class="btn-ghost btn-sm" data-reading-move="${escapeHtml(profile.id)}" data-reading-offset="1" ${index === readingProfiles.length - 1 ? 'disabled' : ''}>下移</button>
        </div>
        <div class="reading-profile-action-group">
          <button class="btn-ghost btn-sm" data-reading-edit="${escapeHtml(profile.id)}">编辑</button>
          <button class="btn-ghost btn-sm" data-reading-delete="${escapeHtml(profile.id)}">删除</button>
        </div>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('[data-reading-move]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const profileId = btn.dataset.readingMove;
      const offset = parseInt(btn.dataset.readingOffset || '0', 10);
      if (!profileId || !Number.isFinite(offset)) return;
      await moveReadingProfile(profileId, offset);
    });
  });
  listEl.querySelectorAll('[data-reading-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const profile = readingProfiles.find(item => item.id === btn.dataset.readingEdit);
      if (profile) fillReadingProfileEditor(profile);
      setReadingProfileStatus('');
    });
  });
  listEl.querySelectorAll('[data-reading-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteReadingProfile(btn.dataset.readingDelete);
    });
  });
}

function normalizePaperChatProfileId(profileId) {
  return typeof profileId === 'string' ? profileId.trim() : '';
}

function getPaperChatProfileId() {
  return currentPaperChatProfileId || null;
}

function getCurrentPaperChatProfile() {
  const profileId = getPaperChatProfileId();
  if (!profileId) return null;
  return readingProfiles.find(profile => profile.id === profileId) || null;
}

function getPaperChatDefaultQuestion(profile = getCurrentPaperChatProfile()) {
  if (!profile || profile.source_kind !== 'skill') return '';
  return '请严格按当前 skill 的默认模板直接开始分析，输出完整结果；如果基于当前标题或摘要无法确认，请明确写“需要阅读全文验证”。';
}

function buildPaperChatQuestion(typedQuestion, profile = getCurrentPaperChatProfile()) {
  const manualRequirement = typeof typedQuestion === 'string' ? typedQuestion.trim() : '';
  const defaultQuestion = getPaperChatDefaultQuestion(profile);
  if (!defaultQuestion) return manualRequirement;
  if (!manualRequirement) return defaultQuestion;
  return `${defaultQuestion}\n\n另外请额外满足以下要求：\n${manualRequirement}`;
}

function refreshPaperChatComposerState() {
  if (!btnSendPaperChat) return;
  if (activePaperChatRequest) {
    btnSendPaperChat.textContent = activePaperChatRequest.stopping ? '正在停止' : '停止';
    btnSendPaperChat.disabled = activePaperChatRequest.stopping;
    btnSendPaperChat.title = '停止当前回答';
    return;
  }
  const typedQuestion = paperChatInput?.value.trim() || '';
  const activeProfile = getCurrentPaperChatProfile();
  const usesSkillTemplate = activeProfile?.source_kind === 'skill';
  btnSendPaperChat.textContent = usesSkillTemplate
    ? (typedQuestion ? '模板+要求发送' : '按模板发送')
    : (!typedQuestion && paperChatAttachments.length ? '分析附件' : '发送');
  btnSendPaperChat.disabled = paperChatAttachmentsBusy;
  btnSendPaperChat.title = usesSkillTemplate
    ? (typedQuestion
      ? `当前将按 ${activeProfile.name} 的默认模板并合并你的附加要求发送`
      : `当前将按 ${activeProfile.name} 的默认模板直接发送`)
    : '';
}

function createPaperChatRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `paper-chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatPaperChatAttachmentChars(charCount) {
  const count = Number(charCount) || 0;
  return count >= 10_000 ? `${(count / 10_000).toFixed(1)} 万字` : `${count.toLocaleString('zh-CN')} 字`;
}

function renderPaperChatAttachments() {
  if (!paperChatAttachmentsEl || !paperChatAttachmentList) return;
  paperChatAttachmentsEl.classList.toggle('hidden', paperChatAttachments.length === 0);
  paperChatAttachmentList.innerHTML = paperChatAttachments.map((attachment, index) => `
    <div class="paper-chat-attachment-item" title="${escapeHtml(attachment.path || attachment.name)}">
      <span class="paper-chat-attachment-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
      </span>
      <span class="paper-chat-attachment-text">
        <span class="paper-chat-attachment-name">${escapeHtml(attachment.name)}</span>
        <span class="paper-chat-attachment-meta">${formatPaperChatAttachmentChars(attachment.char_count)}${attachment.truncated ? ' · 已截断' : ''}</span>
      </span>
      <button class="paper-chat-attachment-remove" type="button" data-paper-chat-attachment-remove="${index}" title="移除附件" aria-label="移除附件">×</button>
    </div>
  `).join('');
  refreshPaperChatComposerState();
}

function mergePaperChatAttachments(imported) {
  const merged = [...paperChatAttachments];
  const knownPaths = new Set(merged.map(item => item.path));
  let totalChars = merged.reduce((sum, item) => sum + (Number(item.char_count) || 0), 0);
  let added = 0;
  let rejected = 0;

  for (const source of imported || []) {
    if (!source?.path || knownPaths.has(source.path)) continue;
    if (merged.length >= PAPER_CHAT_ATTACHMENT_LIMIT || totalChars >= PAPER_CHAT_ATTACHMENT_CHAR_LIMIT) {
      rejected += 1;
      continue;
    }
    const remaining = PAPER_CHAT_ATTACHMENT_CHAR_LIMIT - totalChars;
    const attachment = { ...source };
    const contentChars = Array.from(attachment.content || '');
    if (contentChars.length > remaining) {
      attachment.content = contentChars.slice(0, remaining).join('');
      attachment.char_count = remaining;
      attachment.truncated = true;
    }
    if (!attachment.content) {
      rejected += 1;
      continue;
    }
    knownPaths.add(attachment.path);
    totalChars += Number(attachment.char_count) || 0;
    merged.push(attachment);
    added += 1;
  }

  paperChatAttachments = merged;
  renderPaperChatAttachments();
  return { added, rejected };
}

function setPaperChatAttachmentsBusy(busy) {
  paperChatAttachmentsBusy = busy;
  if (btnPaperChatAddFiles) btnPaperChatAddFiles.disabled = busy;
  if (btnPaperChatAddFolder) btnPaperChatAddFolder.disabled = busy;
  if (btnClearPaperChatAttachments) btnClearPaperChatAttachments.disabled = busy;
  refreshPaperChatComposerState();
}

async function importPaperChatAttachmentPaths(paths) {
  const normalizedPaths = [...new Set((paths || []).filter(path => typeof path === 'string' && path.trim()))];
  if (!normalizedPaths.length || paperChatAttachmentsBusy) return;
  setPaperChatAttachmentsBusy(true);
  setGlobalStatus('正在读取附件…', 'progress');
  try {
    const report = await invoke('import_paper_chat_attachments', { paths: normalizedPaths });
    const { added, rejected } = mergePaperChatAttachments(report?.attachments || []);
    const skipped = (report?.skipped?.length || 0) + rejected;
    if (!added) {
      setGlobalStatus(skipped ? '没有新增可用附件，可能已添加或超过容量限制' : '所选附件已经在列表中', 'error');
      return;
    }
    setGlobalStatus(`已添加 ${added} 个附件${skipped ? `，另跳过 ${skipped} 个` : ''}`, 'success');
  } catch (e) {
    setGlobalStatus('读取附件失败: ' + e, 'error');
  } finally {
    setPaperChatAttachmentsBusy(false);
  }
}

async function choosePaperChatAttachments({ directory = false } = {}) {
  const dialog = window.__TAURI__?.dialog;
  if (!dialog || paperChatAttachmentsBusy) {
    if (!dialog) setGlobalStatus('对话框插件不可用', 'error');
    return;
  }
  try {
    const selection = await dialog.open({
      directory,
      multiple: !directory,
      title: directory ? '选择附件文件夹' : '选择对话附件',
      ...(directory ? {} : {
        filters: [{
          name: '支持的文献与文本文件',
          extensions: ['pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'tex', 'rst', 'log'],
        }],
      }),
    });
    if (!selection) return;
    await importPaperChatAttachmentPaths(Array.isArray(selection) ? selection : [selection]);
  } catch (e) {
    setGlobalStatus('选择附件失败: ' + e, 'error');
  }
}

function paperChatDropIsInside(position) {
  if (!paperChatComposer || !position) return false;
  const logical = typeof position.toLogical === 'function'
    ? position.toLogical(window.devicePixelRatio || 1)
    : position;
  const rect = paperChatComposer.getBoundingClientRect();
  return logical.x >= rect.left && logical.x <= rect.right
    && logical.y >= rect.top && logical.y <= rect.bottom;
}

async function setupPaperChatAttachmentDrop() {
  const currentWebview = window.__TAURI__?.webview?.getCurrentWebview?.();
  if (!currentWebview?.onDragDropEvent || !paperChatComposer) return;
  try {
    await currentWebview.onDragDropEvent(event => {
      const payload = event?.payload;
      if (!payload) return;
      if (payload.type === 'leave') {
        paperChatComposer.classList.remove('is-file-drag-over');
        return;
      }
      const isInside = paperChatDropIsInside(payload.position);
      paperChatComposer.classList.toggle('is-file-drag-over', isInside);
      if (payload.type === 'drop') {
        paperChatComposer.classList.remove('is-file-drag-over');
        if (isInside) void importPaperChatAttachmentPaths(payload.paths || []);
      }
    });
  } catch (e) {
    console.warn('初始化对话附件拖放失败', e);
  }
}

function getPaperChatProfileSignature() {
  return getPaperChatProfileId() || 'default';
}

function renderPaperChatProfileOptions() {
  if (!paperChatProfileSelect) return;

  const options = [
    { id: '', label: '标准文献对话' },
    ...readingProfiles.map(profile => ({
      id: profile.id,
      label: formatReadingProfilePickerLabel(profile),
    })),
  ];

  if (currentPaperChatProfileId && !options.some(option => option.id === currentPaperChatProfileId)) {
    currentPaperChatProfileId = '';
  }

  paperChatProfileSelect.innerHTML = options.map(option => `
    <option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>
  `).join('');
  paperChatProfileSelect.value = currentPaperChatProfileId;
  refreshPaperChatComposerState();
}

async function loadReadingProfiles() {
  try {
    readingProfiles = await invoke('get_reading_profiles');
    renderReadingProfilesSettings();
    renderPaperChatProfileOptions();
    syncEntryBulkActions();
    if (!editingReadingProfileId && readingProfiles[0]) {
      fillReadingProfileEditor(readingProfiles[0]);
    }
  } catch (e) {
    setReadingProfileStatus('加载阅读模板失败: ' + e, 'error');
  }
}

async function persistReadingProfiles() {
  await invoke('save_reading_profiles', { profiles: readingProfiles });
  await loadReadingProfiles();
}

async function moveReadingProfile(profileId, offset) {
  const fromIndex = readingProfiles.findIndex(profile => profile.id === profileId);
  if (fromIndex < 0) {
    setReadingProfileStatus('未找到要移动的模板', 'error');
    return;
  }

  const toIndex = Math.max(0, Math.min(readingProfiles.length - 1, fromIndex + offset));
  if (toIndex === fromIndex) return;

  readingProfiles = reorderReadingProfiles(fromIndex, toIndex);
  setReadingProfileSortMode('manual');
  try {
    await persistReadingProfiles();
    setReadingProfileStatus(offset < 0 ? '模板已上移' : '模板已下移', 'success');
  } catch (e) {
    setReadingProfileStatus('移动阅读模板失败: ' + e, 'error');
  }
}

async function applyReadingProfileSort() {
  if (!readingProfiles.length) {
    setReadingProfileStatus('还没有可排序的模板', 'error');
    return;
  }

  const sortMode = readingProfileSortSelect?.value || 'manual';
  if (sortMode === 'manual') {
    setReadingProfileStatus('当前为手动排序，可直接用上移/下移调整。');
    return;
  }

  const sorted = [...readingProfiles].sort((left, right) => compareReadingProfiles(left, right, sortMode));
  const changed = sorted.some((profile, index) => profile.id !== readingProfiles[index]?.id);
  if (!changed) {
    setReadingProfileStatus(`当前顺序已符合“${readingProfileSortLabel(sortMode)}”`, 'success');
    return;
  }

  readingProfiles = sorted;
  try {
    await persistReadingProfiles();
    setReadingProfileStatus(`已按“${readingProfileSortLabel(sortMode)}”重新排序`, 'success');
  } catch (e) {
    setReadingProfileStatus('排序阅读模板失败: ' + e, 'error');
  }
}

async function importReadingSkillProfile() {
  const dialog = window.__TAURI__?.dialog;
  if (!dialog) {
    setReadingProfileStatus('对话框插件不可用', 'error');
    return;
  }
  try {
    const path = await dialog.open({
      directory: true,
      multiple: false,
      title: '选择 skill 文件夹',
    });
    if (!path || Array.isArray(path)) return;
    const profile = await invoke('import_reading_skill', { skillDir: path });
    const existingIndex = readingProfiles.findIndex(item =>
      item.id === profile.id
      || (item.source_kind === 'skill' && item.skill_dir && item.skill_dir === profile.skill_dir)
    );
    if (existingIndex >= 0) {
      readingProfiles = readingProfiles.map((item, index) => index === existingIndex ? profile : item);
    } else {
      readingProfiles = [profile, ...readingProfiles];
    }
    setReadingProfileSortMode('manual');
    await persistReadingProfiles();
    editingReadingProfileId = profile.id;
    fillReadingProfileEditor(readingProfiles.find(item => item.id === profile.id) || profile);
    setReadingProfileStatus(`已导入 skill：${profile.name}`, 'success');
  } catch (e) {
    setReadingProfileStatus('导入 skill 失败: ' + e, 'error');
  }
}

async function saveReadingProfile() {
  const values = readingProfileFormValues();
  if (!values.name) {
    setReadingProfileStatus('请先填写模板名称', 'error');
    return;
  }
  if (!values.prompt) {
    setReadingProfileStatus('请先填写提示词内容', 'error');
    return;
  }

  const existing = editingReadingProfileId
    ? readingProfiles.find(profile => profile.id === editingReadingProfileId)
    : null;
  const profile = {
    id: existing?.id || `custom-${Date.now().toString(36)}`,
    name: values.name,
    description: values.description,
    reading_mode: values.reading_mode || existing?.reading_mode || 'quick',
    prompt: values.prompt,
    source_label: existing?.source_label || '自定义',
    source_kind: existing?.source_kind || 'prompt',
    skill_dir: existing?.skill_dir || null,
    skill_context: existing?.skill_context || null,
  };

  if (existing) {
    readingProfiles = readingProfiles.map(item => item.id === profile.id ? profile : item);
  } else {
    readingProfiles = [profile, ...readingProfiles];
  }
  setReadingProfileSortMode('manual');

  try {
    await persistReadingProfiles();
    editingReadingProfileId = profile.id;
    fillReadingProfileEditor(readingProfiles.find(item => item.id === profile.id) || profile);
    setReadingProfileStatus('阅读模板已保存', 'success');
  } catch (e) {
    setReadingProfileStatus('保存阅读模板失败: ' + e, 'error');
  }
}

async function deleteReadingProfile(profileId = editingReadingProfileId) {
  if (!profileId) {
    setReadingProfileStatus('请先选择要删除的模板', 'error');
    return;
  }
  const profile = readingProfiles.find(item => item.id === profileId);
  if (!profile) {
    setReadingProfileStatus('未找到要删除的模板', 'error');
    return;
  }
  if (!await confirmDialog(`确定删除阅读模板“${profile.name}”吗？`)) {
    return;
  }

  readingProfiles = readingProfiles.filter(item => item.id !== profileId);
  try {
    await persistReadingProfiles();
    fillReadingProfileEditor(readingProfiles[0] || null);
    setReadingProfileStatus('阅读模板已删除', 'success');
  } catch (e) {
    setReadingProfileStatus('删除阅读模板失败: ' + e, 'error');
  }
}

function formatReadingNoteTime(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function deleteReadingNoteById(noteId, profileName = '阅读笔记') {
  if (!noteId || !currentEntry?.id) return;
  if (!await confirmDialog(`确定删除“${profileName}”这条阅读笔记吗？`, {
    okLabel: '删除',
    cancelLabel: '取消',
    danger: true,
  })) {
    return;
  }

  setGlobalStatus(`正在删除「${profileName}」阅读笔记…`, 'progress');
  try {
    await invoke('delete_reading_note', { noteId });
    await loadReadingNotes(currentEntry.id);
    renderEntryList(allEntries);
    setGlobalStatus(`已删除阅读笔记：${profileName}`, 'success');
  } catch (e) {
    setGlobalStatus('删除阅读笔记失败: ' + e, 'error');
  }
}

async function regenerateReadingNoteByProfile(profileId, profileName = '阅读笔记') {
  if (!profileId || !currentEntry) return;
  if (!await confirmDialog(`确定用“${profileName}”模板重生成这条阅读笔记吗？原有内容会被覆盖。`, {
    okLabel: '重生成',
    cancelLabel: '取消',
    danger: false,
  })) {
    return;
  }
  await generateReadingNoteForEntry(currentEntry, profileId);
}

function closeReadingNoteEditors() {
  if (!detailReadingNotesContent) return;
  detailReadingNotesContent.querySelectorAll('.reading-note-card.is-editing').forEach(card => {
    card.classList.remove('is-editing');
  });
  editingReadingNoteId = null;
}

function openReadingNoteEditor(noteId) {
  if (!detailReadingNotesContent) return;
  closeReadingNoteEditors();
  const card = detailReadingNotesContent.querySelector(`[data-reading-note-card="${noteId}"]`);
  if (!card) return;
  card.classList.add('is-editing');
  editingReadingNoteId = String(noteId);
  const textarea = card.querySelector('[data-reading-note-textarea]');
  textarea?.focus();
  textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
}

function setReadingNoteCardBusy(noteId, busy) {
  if (!detailReadingNotesContent) return;
  const card = detailReadingNotesContent.querySelector(`[data-reading-note-card="${noteId}"]`);
  if (!card) return;
  card.querySelectorAll('button, textarea').forEach(el => {
    el.disabled = busy;
  });
}

async function saveReadingNoteContent(noteId) {
  if (!detailReadingNotesContent || !currentEntry?.id) return;
  const card = detailReadingNotesContent.querySelector(`[data-reading-note-card="${noteId}"]`);
  if (!card) return;

  const textarea = card.querySelector('[data-reading-note-textarea]');
  const errorEl = card.querySelector('[data-reading-note-error]');
  const content = textarea?.value || '';

  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
  if (!content.trim()) {
    if (errorEl) {
      errorEl.textContent = '阅读笔记内容不能为空';
      errorEl.classList.remove('hidden');
    }
    textarea?.focus();
    return;
  }

  setReadingNoteCardBusy(noteId, true);
  setGlobalStatus('正在保存阅读笔记…', 'progress');
  try {
    await invoke('update_reading_note', { noteId, content });
    editingReadingNoteId = null;
    await loadReadingNotes(currentEntry.id);
    setGlobalStatus('阅读笔记已保存', 'success');
  } catch (e) {
    if (errorEl) {
      errorEl.textContent = '保存失败: ' + e;
      errorEl.classList.remove('hidden');
    }
    setGlobalStatus('保存阅读笔记失败: ' + e, 'error');
    setReadingNoteCardBusy(noteId, false);
  }
}

function renderReadingNotes(notes) {
  const section = document.getElementById('detail-reading-notes-section');
  const content = detailReadingNotesContent;
  if (!section || !content) return;

  if (!notes?.length) {
    content.innerHTML = '';
    section.classList.add('hidden');
    return;
  }

  content.innerHTML = notes.map(note => `
    <div class="reading-note-card" data-reading-note-card="${note.id}">
      <div class="reading-note-card-header">
        <div class="reading-note-card-meta">
          <div class="reading-note-card-title">${escapeHtml(note.profile_name)}</div>
          <div class="reading-note-card-date">${escapeHtml(formatReadingNoteTime(note.generated_at))}</div>
        </div>
        <div class="reading-note-card-actions">
          <button
            class="btn btn-primary btn-sm reading-note-edit-btn"
            type="button"
            data-reading-note-edit="${note.id}"
          >修改笔记</button>
          ${isPaperChatReadingNote(note) ? '' : `
          <button
            class="btn-ghost btn-sm"
            type="button"
            data-reading-note-regenerate="${escapeHtml(note.profile_id)}"
            data-reading-note-name="${escapeHtml(note.profile_name)}"
          >重生成</button>
          `}
          <button
            class="btn-ghost btn-sm"
            type="button"
            data-reading-note-delete="${note.id}"
            data-reading-note-name="${escapeHtml(note.profile_name)}"
          >删除</button>
        </div>
      </div>
      <div class="reading-note-card-preview">${renderBriefingMarkdown(note.content || '')}</div>
      <div class="reading-note-card-editor">
        <textarea
          class="settings-input settings-textarea reading-note-editor-input"
          data-reading-note-textarea="${note.id}"
          rows="14"
        >${escapeHtml(note.content || '')}</textarea>
        <p class="detail-summary-error hidden reading-note-editor-error" data-reading-note-error="${note.id}"></p>
        <div class="reading-note-card-editor-actions">
          <button
            class="btn btn-primary btn-sm"
            type="button"
            data-reading-note-save="${note.id}"
          >保存</button>
          <button
            class="btn btn-secondary btn-sm"
            type="button"
            data-reading-note-cancel="${note.id}"
          >取消</button>
        </div>
      </div>
    </div>
  `).join('');
  section.classList.remove('hidden');

  if (editingReadingNoteId) {
    openReadingNoteEditor(editingReadingNoteId);
  }

  if (!content.dataset.noteActionBound) {
    content.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('[data-reading-note-edit]');
      if (editBtn) {
        e.preventDefault();
        openReadingNoteEditor(editBtn.dataset.readingNoteEdit);
        return;
      }

      const saveBtn = e.target.closest('[data-reading-note-save]');
      if (saveBtn) {
        e.preventDefault();
        const noteId = parseInt(saveBtn.dataset.readingNoteSave, 10);
        await saveReadingNoteContent(noteId);
        return;
      }

      const cancelBtn = e.target.closest('[data-reading-note-cancel]');
      if (cancelBtn) {
        e.preventDefault();
        closeReadingNoteEditors();
        return;
      }

      const deleteBtn = e.target.closest('[data-reading-note-delete]');
      if (deleteBtn) {
        e.preventDefault();
        const noteId = parseInt(deleteBtn.dataset.readingNoteDelete, 10);
        await deleteReadingNoteById(noteId, deleteBtn.dataset.readingNoteName || '阅读笔记');
        return;
      }

      const regenerateBtn = e.target.closest('[data-reading-note-regenerate]');
      if (regenerateBtn) {
        e.preventDefault();
        await regenerateReadingNoteByProfile(
          regenerateBtn.dataset.readingNoteRegenerate,
          regenerateBtn.dataset.readingNoteName || '阅读笔记',
        );
        return;
      }

      const a = e.target.closest('a[data-open-url]');
      if (!a) return;
      e.preventDefault();
      openUrl(a.dataset.openUrl);
    });
    content.dataset.noteActionBound = '1';
  }
}

async function loadReadingNotes(entryId) {
  const section = document.getElementById('detail-reading-notes-section');
  const content = detailReadingNotesContent;
  if (!section || !content) return;
  const listScrollTop = entryItemsEl?.scrollTop ?? 0;

  const targetEntry = currentEntry;
  if (targetEntry?.id === entryId && targetEntry?.has_reading_note) {
    section.classList.remove('hidden');
    content.innerHTML = '<p class="detail-summary-empty">正在加载阅读笔记…</p>';
  } else {
    section.classList.add('hidden');
    content.innerHTML = '';
  }

  try {
    const notes = await invoke('list_reading_notes', { entryId });
    applyEntryUpdate(entryId, x => { x.has_reading_note = notes.length > 0; });
    renderEntryList(allEntries, { preserveScrollTop: listScrollTop });
    if (currentEntry?.id === entryId) {
      renderReadingNotes(notes);
    }
  } catch (e) {
    if (currentEntry?.id === entryId) {
      section.classList.remove('hidden');
      content.innerHTML = `<p class="detail-summary-error">加载阅读笔记失败: ${escapeHtml(String(e))}</p>`;
    }
  }
}

async function generateReadingNoteForEntry(entry, profileId) {
  const profile = readingProfiles.find(item => item.id === profileId);
  if (!profile) {
    setGlobalStatus('未找到所选阅读模板', 'error');
    return;
  }

  const section = document.getElementById('detail-reading-notes-section');
  if (currentEntry?.id === entry.id && section && detailReadingNotesContent) {
    section.classList.remove('hidden');
    detailReadingNotesContent.innerHTML = `<p class="detail-summary-empty">正在使用「${escapeHtml(profile.name)}」生成阅读笔记…</p>`;
  }

  setGlobalStatus(`正在使用「${profile.name}」生成阅读笔记…`, 'progress');
  try {
    await invoke('generate_reading_note', { entryId: entry.id, profileId });
    loadCostSummary();
    applyEntryUpdate(entry.id, x => { x.has_reading_note = true; });
    currentEntry = entry;
    renderEntryList(allEntries);
    showDetail(entry);
    setGlobalStatus(`已生成阅读笔记：${profile.name}`, 'success');
  } catch (e) {
    if (currentEntry?.id === entry.id && section && detailReadingNotesContent) {
      detailReadingNotesContent.innerHTML = `<p class="detail-summary-error">生成阅读笔记失败: ${escapeHtml(String(e))}</p>`;
    }
    setGlobalStatus('生成阅读笔记失败: ' + e, 'error');
  }
}

async function generateReadingNotesForEntries(entries, profileId) {
  const profile = readingProfiles.find(item => item.id === profileId);
  if (!profile) {
    setGlobalStatus('未找到所选阅读模板', 'error');
    return;
  }
  const targetEntries = entryBulkExistingStrategy === 'force'
    ? entries
    : entries.filter(entry => !entry.has_reading_note);
  const skippedExisting = entries.length - targetEntries.length;

  if (!entries.length) {
    setGlobalStatus('请先选择要批量生成笔记的文章', 'error');
    return;
  }
  if (!targetEntries.length) {
    setGlobalStatus('所选文章都已有阅读笔记；可切换为“强制重生成”后再执行', 'error');
    return;
  }

  const strategyLabel = entryBulkExistingStrategy === 'force' ? '强制重生成已有笔记' : '跳过已有笔记';
  if (!await confirmDialog(`确定使用“${profile.name}”为所选 ${entries.length} 篇文章批量生成阅读笔记吗？\n模式：${strategyLabel}`, {
    okLabel: '开始生成',
    cancelLabel: '取消',
    danger: false,
  })) {
    return;
  }

  let successCount = 0;
  const failures = [];

  for (let index = 0; index < targetEntries.length; index += 1) {
    const entry = targetEntries[index];
    const title = entry.title_translated || entry.title || `文献 ${entry.id}`;
    setGlobalStatus(`正在生成阅读笔记（${index + 1}/${targetEntries.length}）：${title}`, 'progress');
    try {
      await invoke('generate_reading_note', { entryId: entry.id, profileId });
      applyEntryUpdate(entry.id, x => { x.has_reading_note = true; });
      successCount += 1;
    } catch (e) {
      failures.push({
        entry,
        title,
        message: String(e),
      });
    }
  }
  if (successCount > 0) loadCostSummary();

  if (failures.length) {
    selectedEntryIds = new Set(failures.map(item => item.entry.id));
    entrySelectionMode = true;
    entrySelectionAnchorId = failures[failures.length - 1]?.entry.id || null;
  }

  renderEntryList(allEntries);
  updateOverviewCounts();

  if (currentEntry && selectedEntryIds.has(currentEntry.id)) {
    await loadReadingNotes(currentEntry.id);
  }

  if (!failures.length) {
    const skipSuffix = skippedExisting ? `，跳过已有 ${skippedExisting} 篇` : '';
    setGlobalStatus(`已为 ${successCount} 篇文章生成阅读笔记：${profile.name}${skipSuffix}`, 'success');
    return;
  }

  const preview = failures
    .slice(0, 3)
    .map(item => `${item.title}：${item.message}`)
    .join('；');
  const suffix = failures.length > 3 ? `；另有 ${failures.length - 3} 篇失败` : '';
  const skipSuffix = skippedExisting ? `，跳过已有 ${skippedExisting} 篇` : '';
  setGlobalStatus(`批量生成完成：成功 ${successCount} 篇，失败 ${failures.length} 篇${skipSuffix}。已自动保留失败项供重试。${preview}${suffix}`, 'error');
}

function getEntriesForPaperChatTagScope() {
  if (!currentEntry || entryTagFilterValue === 'all') return [];
  return allEntries.filter(entry => (entry.tags || []).includes(entryTagFilterValue));
}

function getPaperChatPinnedScopeEntries() {
  return paperChatPinnedEntries
    .map(item => ({ ...item, _entry: findEntryById(item.id) }))
    .filter(item => item.id > 0);
}

function findEntryById(entryId) {
  if (currentEntry?.id === entryId) return currentEntry;
  return allEntries.find(entry => entry.id === entryId)
    || globalEntries.find(entry => entry.id === entryId)
    || null;
}

function createPaperChatPinnedEntry(entry) {
  return {
    id: entry.id,
    title: entry.title_translated || entry.title,
    source: journalName(entry) || '',
  };
}

function syncCurrentEntryIntoPaperChatPinnedEntries() {
  if (!currentEntry) return;
  paperChatPinnedEntries = paperChatPinnedEntries.map(item =>
    item.id === currentEntry.id ? createPaperChatPinnedEntry(currentEntry) : item
  );
}

function addCurrentEntryToPaperChat() {
  if (!currentEntry) return;
  if (paperChatPinnedEntries.some(item => item.id === currentEntry.id)) {
    setGlobalStatus('当前文献已在对话列表中', 'success');
    return;
  }

  paperChatPinnedEntries = [...paperChatPinnedEntries, createPaperChatPinnedEntry(currentEntry)];
  renderPaperChatPinnedEntries();
  refreshPaperChatAfterScopeDataChange();
  setGlobalStatus('已加入对话文献', 'success');
}

function removeEntryFromPaperChat(entryId) {
  const next = paperChatPinnedEntries.filter(item => item.id !== entryId);
  if (next.length === paperChatPinnedEntries.length) return;
  paperChatPinnedEntries = next;
  renderPaperChatPinnedEntries();
  refreshPaperChatAfterScopeDataChange();
}

function clearPaperChatPinnedEntries() {
  if (!paperChatPinnedEntries.length) return;
  paperChatPinnedEntries = [];
  renderPaperChatPinnedEntries();
  refreshPaperChatAfterScopeDataChange();
}

function getPaperChatDisplayItems(scope = paperChatScope) {
  const meta = getPaperChatScopeMeta(scope);
  if (meta.key === 'manual') {
    return {
      meta,
      allowRemove: true,
      items: paperChatPinnedEntries.map(item => ({
          id: item.id,
          title: item.title || `文献 ${item.id}`,
          source: item.source || '',
        })),
    };
  }

  return {
    meta,
    allowRemove: false,
    items: meta.entries.map(entry => {
      const fullEntry = findEntryById(entry.id) || entry;
      return {
        id: entry.id,
        title: fullEntry.title_translated || fullEntry.title || `文献 ${entry.id}`,
        source: journalName(fullEntry) || '',
      };
    }),
  };
}

function getPaperChatRequestSignature(scope = paperChatScope) {
  return `${getPaperChatScopeIds(scope).join(',')}|${getPaperChatProfileSignature()}`;
}

function getPaperChatDisplayLabel(scope = paperChatScope) {
  const meta = getPaperChatScopeMeta(scope);
  if (meta.key === 'selection') return '本轮多选文献';
  if (meta.key === 'manual') return '手动加入文献';
  if (meta.key === 'feed') return '当前订阅源文献';
  if (meta.key === 'tag') return '当前标签文献';
  return '当前文献';
}

function renderPaperChatPinnedEntries() {
  if (!paperChatPickedList || !btnPaperChatAddCurrent || !btnPaperChatClearPicked || !paperChatPickedLabel) return;

  syncCurrentEntryIntoPaperChatPinnedEntries();

  const { meta, items, allowRemove } = getPaperChatDisplayItems();
  paperChatPickedLabel.textContent = getPaperChatDisplayLabel(meta.key);
  const currentAdded = !!currentEntry && paperChatPinnedEntries.some(item => item.id === currentEntry.id);
  btnPaperChatAddCurrent.textContent = currentAdded ? '已加入当前文献' : '加入当前文献';
  btnPaperChatAddCurrent.disabled = !currentEntry || currentAdded;
  btnPaperChatClearPicked.classList.toggle('hidden', !(meta.key === 'manual' && paperChatPinnedEntries.length > 0));

  if (!items.length) {
    paperChatPickedList.innerHTML = meta.key === 'manual'
      ? '<div class="paper-chat-picked-empty">先在左侧点开一篇文献，再点“加入当前文献”，就能把它纳入这轮对话。</div>'
      : '<div class="paper-chat-picked-empty">当前范围下还没有可用于对话的文献。</div>';
    return;
  }

  paperChatPickedList.innerHTML = `
    ${items.map((item, index) => `
    <div class="paper-chat-picked-item ${allowRemove ? '' : 'readonly'}">
      <button
        type="button"
        class="paper-chat-picked-main"
        data-paper-chat-focus-entry="${item.id}"
        title="定位到这篇文献"
      >
        <span class="paper-chat-picked-index">${index + 1}</span>
        <span class="paper-chat-picked-text">
          <span class="paper-chat-picked-title">${escapeHtml(item.title || `文献 ${item.id}`)}</span>
          ${item.source ? `<span class="paper-chat-picked-source">${escapeHtml(item.source)}</span>` : ''}
        </span>
      </button>
      ${allowRemove ? `<button
        type="button"
        class="paper-chat-picked-remove"
        data-paper-chat-remove-entry="${item.id}"
        title="移出对话"
      >×</button>` : ''}
    </div>
  `).join('')}
  `;
}

function getPaperChatScopeMeta(scope = paperChatScope) {
  if (!currentEntry) {
    return {
      key: 'single',
      label: '当前文献',
      caption: '当前文献',
      hint: '当前按单篇文献回答，可连续追问。',
      entries: [],
      totalCount: 0,
    };
  }

  const selectedEntries = getSelectedEntries();
  const tagEntries = getEntriesForPaperChatTagScope();
  const sourceEntries = allEntries;
  const pinnedEntries = getPaperChatPinnedScopeEntries();

  if (scope === 'manual' && pinnedEntries.length > 0) {
    return {
      key: 'manual',
      label: `手动已选 ${pinnedEntries.length} 篇`,
      caption: `手动已选 ${pinnedEntries.length} 篇文献`,
      hint: '当前按右侧手动加入的全部文献摘要回答。可持续增减文献后继续追问。',
      entries: pinnedEntries.map(item => item._entry || { id: item.id }),
      totalCount: pinnedEntries.length,
    };
  }

  if (scope === 'selection' && selectedEntries.length > 1) {
    return {
      key: 'selection',
      label: `已选 ${selectedEntries.length} 篇`,
      caption: `已选 ${selectedEntries.length} 篇文献`,
      hint: '当前按全部已选文献摘要联合回答。',
      entries: selectedEntries,
      totalCount: selectedEntries.length,
    };
  }

  if (scope === 'feed' && selectedFeedId && sourceEntries.length > 1) {
    return {
      key: 'feed',
      label: `当前订阅源 ${sourceEntries.length} 篇`,
      caption: `当前订阅源 ${sourceEntries.length} 篇文献`,
      hint: '当前按所选订阅源中的全部文献摘要联合回答。',
      entries: sourceEntries,
      totalCount: sourceEntries.length,
    };
  }

  if (scope === 'tag' && tagEntries.length > 1) {
    const tagLabel = `标签“${entryTagFilterValue}”`;
    return {
      key: 'tag',
      label: `${tagLabel} ${tagEntries.length} 篇`,
      caption: `${tagLabel}${tagEntries.length} 篇文献`,
      hint: `当前按标签“${entryTagFilterValue}”的全部文献摘要联合回答。`,
      entries: tagEntries,
      totalCount: tagEntries.length,
    };
  }

  return {
    key: 'single',
    label: '当前文献',
    caption: '当前文献',
    hint: '当前按单篇文献回答，可连续追问。',
    entries: [currentEntry],
    totalCount: 1,
  };
}

function getAvailablePaperChatScopes() {
  const options = [getPaperChatScopeMeta('single')];
  const manualScope = getPaperChatScopeMeta('manual');
  const sourceScope = getPaperChatScopeMeta('feed');
  const tagScope = getPaperChatScopeMeta('tag');
  const selectionScope = getPaperChatScopeMeta('selection');

  if (manualScope.key === 'manual') options.push(manualScope);
  if (sourceScope.key === 'feed') options.push(sourceScope);
  if (tagScope.key === 'tag') options.push(tagScope);
  if (selectionScope.key === 'selection') options.push(selectionScope);

  return options;
}

function getPaperChatScopeEntries(scope = paperChatScope) {
  return getPaperChatScopeMeta(scope).entries;
}

function getPaperChatScopeIds(scope = paperChatScope) {
  return getPaperChatScopeEntries(scope).map(entry => entry.id);
}

function getPaperChatScopeLabel(scope = paperChatScope) {
  return getPaperChatScopeMeta(scope).caption;
}

function refreshPaperChatScopeControls() {
  if (!detailPaperChatScopes || !detailPaperChatHint || !paperChatScopeCaption) return;

  const options = getAvailablePaperChatScopes();
  if (!options.some(option => option.key === paperChatScope)) {
    paperChatScope = 'single';
  }

  const activeScope = getPaperChatScopeMeta();
  detailPaperChatScopes.innerHTML = options.map(option => `
    <button
      type="button"
      class="paper-chat-scope-btn ${option.key === paperChatScope ? 'active' : ''}"
      data-paper-chat-scope="${option.key}"
    >${escapeHtml(option.label)}</button>
  `).join('');

  detailPaperChatHint.textContent = activeScope.hint;
  paperChatScopeCaption.textContent = `当前范围：${activeScope.caption}`;
  renderPaperChatPinnedEntries();
}

function refreshPaperChatAfterScopeDataChange() {
  if (!currentEntry) return;
  const previousScope = paperChatScope;
  const previousIds = getPaperChatScopeIds(previousScope).join(',');
  refreshPaperChatScopeControls();
  const nextIds = getPaperChatScopeIds().join(',');
  if (previousScope !== paperChatScope || previousIds !== nextIds) {
    loadPaperChatMessages();
  }
}

function renderPaperChatMessages(messages, { loading = false, error = '' } = {}) {
  if (!detailPaperChatMessages) return;

  if (error) {
    detailPaperChatMessages.innerHTML = `<div class="paper-chat-empty detail-summary-error">${escapeHtml(error)}</div>`;
    return;
  }

  if (loading) {
    detailPaperChatMessages.innerHTML = '<div class="paper-chat-loading">正在加载文献对话…</div>';
    return;
  }

  if (!messages?.length) {
    detailPaperChatMessages.innerHTML = '<div class="paper-chat-empty">可以直接提问，例如“这篇文献的核心发现是什么？”“这几篇文献的结论一致吗？”。如果要手动拼一组文献，就在上面的“对话文献”里逐篇加入。</div>';
    return;
  }

  const allowAppend = paperChatScope === 'single' && !!currentEntry;
  detailPaperChatMessages.innerHTML = messages.map(message => {
    const isAssistant = message.role === 'assistant';
    const bodyHtml = isAssistant
      ? `<div class="paper-chat-message-body">${renderBriefingMarkdown(message.content || '')}</div>`
      : `<div class="paper-chat-message-body">${escapeHtml(message.content || '')}</div>`;
    const appendBtn = allowAppend && isAssistant
      ? `<div class="paper-chat-message-actions">
           <button
             type="button"
             class="btn-ghost btn-sm"
             data-paper-chat-append="${message.id}"
           >追加到笔记</button>
         </div>`
      : '';
    return `
      <div class="paper-chat-message ${message.role === 'user' ? 'user' : 'assistant'}">
        <div class="paper-chat-message-header">
          <div class="paper-chat-message-role">${message.role === 'user' ? '我' : 'AI'}</div>
          <div class="paper-chat-message-time">${escapeHtml(formatReadingNoteTime(message.created_at))}</div>
        </div>
        ${bodyHtml}
        ${appendBtn}
      </div>
    `;
  }).join('');
}

async function loadPaperChatMessages() {
  if (!currentEntry) return;
  refreshPaperChatScopeControls();
  const entryIds = getPaperChatScopeIds();
  if (!entryIds.length) {
    renderPaperChatMessages([]);
    return;
  }

  renderPaperChatMessages([], { loading: true });
  try {
    const requestSignature = getPaperChatRequestSignature();
    const messages = await invoke('list_paper_chat_messages', {
      entryIds,
      profileId: getPaperChatProfileId(),
    });
    const stillSameScope = currentEntry && requestSignature === getPaperChatRequestSignature();
    if (stillSameScope) renderPaperChatMessages(messages);
  } catch (e) {
    renderPaperChatMessages([], { error: `加载文献对话失败: ${String(e)}` });
  }
}

async function sendPaperChatQuestion() {
  if (!currentEntry || !paperChatInput || activePaperChatRequest) return;
  const activeProfile = getCurrentPaperChatProfile();
  const typedQuestion = paperChatInput.value.trim();
  const question = buildPaperChatQuestion(typedQuestion, activeProfile)
    || (paperChatAttachments.length ? '请分析本轮添加的附件，并总结关键内容、证据和局限。' : '');
  if (!question) {
    setGlobalStatus('请输入问题后再发送', 'error');
    paperChatInput.focus();
    return;
  }

  const entryIds = getPaperChatScopeIds();
  if (!entryIds.length) {
    setGlobalStatus('当前没有可用于对话的文献', 'error');
    return;
  }

  const draft = paperChatInput.value;
  const request = {
    id: createPaperChatRequestId(),
    signature: getPaperChatRequestSignature(),
    stopping: false,
  };
  activePaperChatRequest = request;
  paperChatInput.value = '';
  refreshPaperChatComposerState();
  renderPaperChatMessages([], { loading: true });
  setGlobalStatus(`正在生成文献回答：${getPaperChatScopeLabel()}`, 'progress');

  try {
    const messages = await invoke('ask_paper_chat', {
      entryIds,
      question,
      profileId: getPaperChatProfileId(),
      attachments: paperChatAttachments,
      requestId: request.id,
    });
    loadCostSummary();
    if (request.signature === getPaperChatRequestSignature()) {
      renderPaperChatMessages(messages);
    }
    setGlobalStatus(request.stopping ? '回答已完成，未能及时停止' : '文献对话已更新', 'success');
  } catch (e) {
    paperChatInput.value = draft;
    await loadPaperChatMessages();
    if (request.stopping || String(e).includes('文献对话已停止')) {
      setGlobalStatus('已停止生成回答', 'success');
    } else {
      setGlobalStatus('文献对话失败: ' + e, 'error');
    }
  } finally {
    if (activePaperChatRequest === request) activePaperChatRequest = null;
    refreshPaperChatComposerState();
  }
}

async function stopPaperChatAnswer() {
  const request = activePaperChatRequest;
  if (!request || request.stopping) return;
  request.stopping = true;
  refreshPaperChatComposerState();
  setGlobalStatus('正在停止当前回答…', 'progress');
  try {
    const stopped = await invoke('cancel_paper_chat', { requestId: request.id });
    if (!stopped && activePaperChatRequest === request) {
      setGlobalStatus('回答已经结束，正在读取结果', 'progress');
    }
  } catch (e) {
    request.stopping = false;
    refreshPaperChatComposerState();
    setGlobalStatus('停止回答失败: ' + e, 'error');
  }
}

function handlePaperChatPrimaryAction() {
  if (activePaperChatRequest) {
    stopPaperChatAnswer();
  } else {
    sendPaperChatQuestion();
  }
}

async function clearPaperChatMessages() {
  if (!currentEntry) return;
  const entryIds = getPaperChatScopeIds();
  if (!entryIds.length) return;
  if (!await confirmDialog(`确定清空“${getPaperChatScopeLabel()}”的对话记录吗？`, {
    okLabel: '清空',
    cancelLabel: '取消',
    danger: true,
  })) {
    return;
  }

  setGlobalStatus('正在清空文献对话…', 'progress');
  try {
    await invoke('clear_paper_chat', {
      entryIds,
      profileId: getPaperChatProfileId(),
    });
    renderPaperChatMessages([]);
    setGlobalStatus('文献对话已清空', 'success');
  } catch (e) {
    setGlobalStatus('清空文献对话失败: ' + e, 'error');
  }
}

async function appendPaperChatMessageToNote(messageId) {
  if (!currentEntry || paperChatScope !== 'single') return;

  const messages = await invoke('list_paper_chat_messages', {
    entryIds: [currentEntry.id],
    profileId: getPaperChatProfileId(),
  });
  const targetIndex = messages.findIndex(item => item.id === Number(messageId) && item.role === 'assistant');
  const target = targetIndex >= 0 ? messages[targetIndex] : null;
  if (!target) {
    setGlobalStatus('未找到要追加的回答', 'error');
    return;
  }

  const notes = await invoke('list_reading_notes', { entryId: currentEntry.id });
  const choice = await chooseReadingNoteTarget(notes);
  if (!choice) return;
  const question = findQuestionForAssistantMessage(messages, targetIndex);
  const content = buildPaperChatNoteExcerpt(question, target.content);

  setGlobalStatus('正在写入阅读笔记…', 'progress');
  try {
    await invoke('append_paper_chat_to_note', {
      entryId: currentEntry.id,
      noteId: choice.noteId,
      content,
    });
    await loadReadingNotes(currentEntry.id);
    applyEntryUpdate(currentEntry.id, x => { x.has_reading_note = true; });
    renderEntryList(allEntries);
    setGlobalStatus(choice.isNew ? '已新建对话摘录' : `已追加到「${choice.label}」`, 'success');
  } catch (e) {
    setGlobalStatus('追加到阅读笔记失败: ' + e, 'error');
  }
}

// ── Entry list ─────────────────────────────────
async function loadEntries(feedId) {
  try {
    clearEntrySelection({ render: false, syncPaperChat: false });
    allEntries = await invoke('list_entries', { feedId: feedId || null });
    refreshEntryTagFilterOptions(allEntries);
    syncEntryBulkActions();
    renderEntryList(allEntries);
    refreshPaperChatAfterScopeDataChange();
  } catch (e) {
    entryItemsEl.innerHTML = `<li class="entry-empty">加载文章失败: ${e}</li>`;
  }
}

function renderEntryList(entries, options = {}) {
  syncCompactFilterSummaries();
  if (mode === 'pubmed' || mode === 'kept' || mode !== 'search') {
    renderPubmedEntryList(entries, options);
    return;
  }
  syncEntryFilterControls();
  syncEntryMetricFilterControls();
  const stars = starredIds();
  const filtered = getFilteredEntries(entries);

  const selectedId = entryItemsEl.querySelector('.entry-item.selected')?.dataset?.entryId;
  entryItemsEl.innerHTML = '';

  if (filtered.length === 0) {
    let msg;
    if (mode === 'search') msg = `未找到与“${escapeHtml(literatureSearchInput?.value.trim() || '')}”匹配的文献`;
    else if (entryTagFilterValue !== 'all' && hasActiveEntryMetricFilters()) msg = '当前标签与分区筛选下没有文章';
    else if (entryTagFilterValue !== 'all') msg = '当前标签筛选下没有文章';
    else if (hasActiveEntryMetricFilters()) msg = '当前影响因子 / 分区筛选下没有文章';
    else if (entryFilterValue === 'unread') msg = '没有未读文章';
    else if (entryFilterValue === 'starred') msg = '尚未星标任何文章';
    else if (entryFilterValue === 'reading-notes') msg = '尚无带阅读笔记的文章';
    else msg = document.querySelector('.feed-item.selected')
      ? '该订阅源暂无文章，点击刷新获取'
      : '添加订阅源后点击刷新按钮获取文章';
    entryItemsEl.innerHTML = `<li class="entry-empty">${msg}</li>`;
    return;
  }

  scheduleFreeFulltextChecks(filtered);

  filtered.forEach(entry => {
    const li = document.createElement('li');
    li.className = `entry-item ${entry.is_read ? 'read' : 'unread'}`;
    li.dataset.entryId = entry.id;

    const isStarred = stars.has(entry.id);
    const hasReadingNote = !!entry.has_reading_note;
    const isBulkSelected = entrySelectionMode && selectedEntryIds.has(entry.id);
    const titles = displayTitles(entry);
    const timeStr = entry.published_at ? formatSlashDate(entry.published_at) : '';
    const source = shortJournalDisplayName(journalName(entry));

    // Visual translation status — spinner during work, small error pill on failure.
    // No "待翻译" tag — translation now runs automatically in the background, so
    // a pending state is the default; cluttering every entry with a tag would be noise.
    const isTranslating = entry._titleTranslating || entry._summaryTranslating;
    let tagHtml = '';
    if (entry._transError) tagHtml = ` <span class="entry-tag entry-tag-error">失败</span>`;

    let metaHtml = '';
    const metricHtml = renderMetricBadges(lookupJournalMetrics(entry), { compact: true });
    if (source || metricHtml) {
      metaHtml = `
        <div class="entry-meta-row">
          ${source ? `<span class="entry-source">《${escapeHtml(source)}》</span>` : ''}
          ${metricHtml ? `<span class="journal-metrics journal-metrics-inline">${metricHtml}</span>` : ''}
        </div>
      `;
	    }
	
	    const badges = [];
	    if (entry.summary_translated) {
	      badges.push(`<span class="pill pill-accent">已翻译</span>`);
	    }
	    if (isStarred) {
	      badges.push(`<span class="pill pill-star">已标星</span>`);
	    }
	    if (entry.has_reading_note) {
	      badges.push(`<span class="pill pill-note">阅读笔记</span>`);
	    }
	    if (entry.has_free_fulltext) {
	      badges.push(`<span class="pill pill-free">PMC全文</span>`);
	    }
	    badges.push(...renderEntryTagBadges(entry.tags));
    const badgesHtml = badges.length ? `<div class="entry-badges">${badges.join('')}</div>` : '';
    const selectionControlHtml = entrySelectionMode
      ? `<div class="entry-select-col"><span class="entry-select-checkbox ${isBulkSelected ? 'checked' : ''}" aria-hidden="true"></span></div>`
      : '';

    li.innerHTML = `
      ${selectionControlHtml}
      <div class="entry-body">
        <div class="entry-row-top">
          <div>
            <div class="entry-title">${escapeHtml(titles.primary)}${tagHtml}${isTranslating ? ' <span class="entry-spinner"></span>' : ''}</div>
            ${titles.secondary ? `<div class="entry-title-original">${escapeHtml(titles.secondary)}</div>` : ''}
          </div>
          <div class="entry-date">${timeStr}</div>
        </div>
        ${metaHtml}
        ${badgesHtml}
      </div>
    `;

    if (isBulkSelected) li.classList.add('bulk-selected');
    if (!entrySelectionMode && currentEntry && currentEntry.id === entry.id) li.classList.add('selected');
    if (!entrySelectionMode && selectedId && entry.id.toString() === selectedId) li.classList.add('selected');

    li.addEventListener('click', async (e) => {
      const wantsMultiSelect = entrySelectionMode || e.metaKey || e.ctrlKey || e.shiftKey;
      if (wantsMultiSelect) {
        handleEntryMultiSelect(entry, { shiftKey: e.shiftKey });
        return;
      }

      focusEntryList();
      document.querySelectorAll('.entry-item').forEach(el => el.classList.remove('selected'));
      li.classList.add('selected');
      showDetail(entry);
      if (!entry.is_read) await setEntryRead(entry, true);
    });
    li.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (e.ctrlKey) {
        handleEntryMultiSelect(entry, { shiftKey: e.shiftKey });
        return;
      }
      showEntryContextMenu(e.clientX, e.clientY, entry);
    });

  entryItemsEl.appendChild(li);
  });

  restoreEntryListScrollTop(options.preserveScrollTop);

  syncEntryBulkActions();
}

function renderPubmedEntryList(entries, options = {}) {
  syncEntryFilterControls();
  syncEntryMetricFilterControls();
  updateTopEntryFilterCounts(entries);
  const isPubmedList = mode === 'pubmed' || mode === 'kept';
  const filtered = isPubmedList ? getFilteredPubmedEntries(entries) : getFilteredEntries(entries);
  const visible = isPubmedList ? filtered.slice(0, pubmedRenderLimit) : filtered;
  scheduleFreeFulltextChecks(visible);
  entryItemsEl.innerHTML = '';
  if (!filtered.length) {
    let msg = '当前筛选条件下没有文献';
    if (!isPubmedList) {
      if (entryTagFilterValue !== 'all' && hasActiveEntryMetricFilters()) msg = '当前标签与分区筛选下没有文章';
      else if (entryTagFilterValue !== 'all') msg = '当前标签筛选下没有文章';
      else if (hasActiveEntryMetricFilters()) msg = '当前影响因子 / 分区筛选下没有文章';
      else if (entryFilterValue === 'unread') msg = '没有未读文章';
      else if (entryFilterValue === 'starred') msg = '尚未星标任何文章';
      else if (entryFilterValue === 'reading-notes') msg = '尚无带阅读笔记的文章';
      else msg = document.querySelector('.feed-item.selected')
        ? '该订阅源暂无文章，点击刷新获取'
        : '添加订阅源后点击刷新按钮获取文章';
    }
    entryItemsEl.innerHTML = `<li class="entry-empty">${msg}</li>`;
    syncEntryBulkActions();
    return;
  }

  visible.forEach((entry, index) => {
    const li = document.createElement('li');
    li.className = `pubmed-entry-item ${entry.is_read ? 'read' : 'unread'}`;
    li.dataset.entryId = entry.id;
    if (selectedEntryIds.has(entry.id)) li.classList.add('bulk-selected');
    if (currentEntry?.id === entry.id) li.classList.add('selected');
    const metrics = renderMetricBadges(lookupJournalMetrics(entry), { compact: true });
    const publication = isPubmedList
      ? formatPubmedPublicationDate(entry)
      : (entry.publication_date
        ? formatSlashDate(entry.publication_date)
        : (entry.published_at ? formatSlashDate(entry.published_at) : ''));
    const titles = displayTitles(entry);
    const isStarred = starredIds().has(entry.id);
    const source = shortJournalDisplayName(entry.journal || journalName(entry));
    const status = entry.screening_status || 'unreviewed';
    const badges = [];
    if (entry.summary_translated) {
      badges.push('<span class="pill pill-accent">已翻译</span>');
    }
    if (entry.has_reading_note) {
      badges.push('<span class="pill pill-note">阅读笔记</span>');
    }
    if (entry.has_free_fulltext) {
      badges.push('<span class="pill pill-free">PMC全文</span>');
    }
    badges.push(...renderEntryTagBadges(entry.tags, { limit: 6 }));
    li.innerHTML = `
      <input class="pubmed-entry-checkbox" type="checkbox" ${selectedEntryIds.has(entry.id) ? 'checked' : ''} aria-label="选择第 ${index + 1} 篇文献" />
      <span class="pubmed-entry-number">${index + 1}.</span>
      <div class="pubmed-entry-content">
        <div class="pubmed-entry-title-row">
          <div class="pubmed-entry-title">${escapeHtml(titles.primary)}${entry._titleTranslating ? ' <span class="entry-spinner"></span>' : ''}</div>
        </div>
        ${titles.secondary ? `<div class="pubmed-entry-original">${escapeHtml(titles.secondary)}</div>` : ''}
        <div class="pubmed-entry-info-row">
          <div class="pubmed-entry-meta">
            ${metrics ? `<span class="journal-metrics pubmed-entry-metrics">${metrics}</span>` : ''}
            ${source ? `<span>《${escapeHtml(source)}》</span>` : ''}
            ${publication ? `<span class="pubmed-entry-meta-sep">·</span><span>${escapeHtml(publication)}</span>` : ''}
            ${entry.pmid ? `<span class="pubmed-entry-meta-sep">·</span><span>PMID ${escapeHtml(entry.pmid)}</span>` : ''}
          </div>
          <button
            class="pubmed-star-button ${isStarred ? 'active' : ''}"
            type="button"
            aria-label="${isStarred ? '取消星标' : '标星'}"
            aria-pressed="${isStarred}"
            title="${isStarred ? '取消星标' : '标星'}"
          >${isStarred ? '★' : '☆'}</button>
          <select class="pubmed-status-select status-${escapeHtml(status)}" aria-label="筛选状态" ${mode === 'kept' ? 'disabled' : ''}>
            <option value="unreviewed" ${status === 'unreviewed' ? 'selected' : ''}>未筛选</option>
            <option value="keep" ${status === 'keep' ? 'selected' : ''}>保留</option>
            <option value="maybe" ${status === 'maybe' ? 'selected' : ''}>待定</option>
            <option value="exclude" ${status === 'exclude' ? 'selected' : ''}>排除</option>
          </select>
        </div>
        ${badges.length ? `<div class="entry-badges pubmed-entry-tags">${badges.join('')}</div>` : ''}
      </div>
    `;

    const checkbox = li.querySelector('.pubmed-entry-checkbox');
    checkbox.addEventListener('click', event => {
      event.stopPropagation();
      if (!entrySelectionMode) entrySelectionMode = true;
      toggleEntrySelection(entry.id, { shiftKey: event.shiftKey });
      renderEntryList(allEntries);
    });
    li.querySelector('.pubmed-star-button')?.addEventListener('click', event => {
      event.stopPropagation();
      toggleStar(entry.id);
      renderEntryList(allEntries);
      updateOverviewCounts();
    });
    li.querySelector('.pubmed-status-select')?.addEventListener('change', async event => {
      event.stopPropagation();
      if (isPubmedList) await updatePubmedScreeningStatus(entry, event.target.value);
      else await updateEntryScreeningStatus(entry, event.target.value);
    });
    li.addEventListener('click', async event => {
      if (event.target.closest('input, select, button')) return;
      showDetail(entry);
      if (!entry.is_read) await setEntryRead(entry, true);
      else renderEntryList(allEntries, { preserveScrollTop: entryItemsEl?.scrollTop ?? 0 });
    });
    li.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (event.ctrlKey) {
        handleEntryMultiSelect(entry, { shiftKey: event.shiftKey });
        return;
      }
      showEntryContextMenu(event.clientX, event.clientY, entry);
    });
    entryItemsEl.appendChild(li);
  });

  if (isPubmedList && visible.length < filtered.length) {
    const more = document.createElement('li');
    more.className = 'entry-empty';
    more.innerHTML = `<button class="btn btn-secondary btn-sm" type="button">继续显示（${visible.length}/${filtered.length}）</button>`;
    more.querySelector('button').addEventListener('click', () => {
      pubmedRenderLimit += 200;
      renderEntryList(allEntries);
    });
    entryItemsEl.appendChild(more);
  }
  restoreEntryListScrollTop(options.preserveScrollTop);
  syncEntryBulkActions();
}

function restoreEntryListScrollTop(scrollTop) {
  if (scrollTop == null || !entryItemsEl) return;
  entryItemsEl.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    if (entryItemsEl) entryItemsEl.scrollTop = scrollTop;
  });
}

function formatPubmedPublicationDate(entry) {
  if (entry.publication_date_precision === 'season' || entry.publication_date_precision === 'medline') {
    return entry.publication_date_raw || entry.publication_date || '';
  }
  const value = entry.publication_date || '';
  return formatSlashDate(value) || entry.publication_date_raw || value;
}

async function updatePubmedScreeningStatus(entry, status) {
  if (!currentPubmedSearch || mode !== 'pubmed') return;
  try {
    await invoke('set_pubmed_screening_status', {
      searchId: currentPubmedSearch.id,
      entryId: entry.id,
      status,
    });
    entry.screening_status = status;
    renderEntryList(allEntries);
    await loadPubmedSearches();
    setGlobalStatus(`已设为${pubmedStatusLabel(status)}`, 'success');
  } catch (e) {
    renderEntryList(allEntries);
    setGlobalStatus('更新筛选状态失败: ' + e, 'error');
  }
}

async function updateEntryScreeningStatus(entry, status) {
  try {
    await invoke('set_entry_screening_status', {
      entryId: entry.id,
      status,
    });
    entry.screening_status = status;
    renderEntryList(allEntries);
    setGlobalStatus(`已设为${pubmedStatusLabel(status)}`, 'success');
  } catch (e) {
    renderEntryList(allEntries);
    setGlobalStatus('更新筛选状态失败: ' + e, 'error');
  }
}

function pubmedStatusLabel(status) {
  return { unreviewed: '未筛选', keep: '保留', maybe: '待定', exclude: '排除' }[status] || status;
}

// ── Detail panel ───────────────────────────────
function showDetail(entry) {
  const entryChanged = currentEntry?.id !== entry.id;
  currentEntry = entry;
  if (entryChanged) {
    resetPaperGraph();
    detailPdfRequestId += 1;
    detailPdfUrl = '';
    setDetailViewMode('summary');
  }
  paperChatScope = 'single';
  detailEmpty.classList.add('hidden');
  detailContent.classList.remove('hidden');
  renderPaperChatPinnedEntries();

  renderDetailTitle(entry);
  renderDetailJournalMeta(entry);

  applyAffiliation(entry);
  renderDetailIdentifiers(entry);
  ensureAffiliationLoaded(entry);
  ensureAuthorsLoaded(entry);
  ensureEntryIdentifiersLoaded(entry);

  detailDateSub.textContent = formatPublicationDate(entry);

  const authorEl = document.getElementById('detail-author');
  const authorSep = document.getElementById('detail-author-sep');
  if (authorEl) {
    const formatted = formatAuthors(entry.author);
    if (formatted) {
      authorEl.textContent = formatted;
      authorSep?.classList.remove('hidden');
    } else {
      authorEl.textContent = '';
      authorSep?.classList.add('hidden');
    }
  }
  detailPublicationDate.textContent = formatPublicationDate(entry);

  if (entry.summary_translated) {
    detailSourceBadge.textContent = '已翻译';
    detailBadgeRow.classList.remove('hidden');
  } else {
    detailBadgeRow.classList.add('hidden');
  }

  const starBtn = document.getElementById('btn-star');
  if (starBtn) starBtn.classList.toggle('active', starredIds().has(entry.id));

  const aiFooter = document.getElementById('detail-ai-footer');
  const providerMeta = AI_PROVIDER_META[activeProviderId()] || AI_PROVIDER_META.deepseek;
  const modelName = activeModelDisplayName();
  document.getElementById('ai-model-name').textContent = `由 ${providerMeta.label} · ${modelName} 翻译`;
  if (entry.title_translated || entry.summary_translated) {
    aiFooter?.classList.remove('hidden');
  } else {
    aiFooter?.classList.add('hidden');
  }
  // In-progress title spinner appended after the title (cleared by updateDetailFromCurrent)
  refreshDetailTitleSpinner(entry);

  renderDetailTags(entry);
  if (detailTagInput) detailTagInput.value = '';
  abstractLang = 'zh';
  syncAbstractToggle();
  renderSummary(entry);
  loadReadingNotes(entry.id);
  refreshPaperChatScopeControls();
  loadPaperChatMessages();
  if (!entry.summary && !entry.summary_translated) loadAbstract(entry);

  btnOpenUrl.onclick = () => openUrl(entry.link);
  syncDetailExternalActions(entry);
}

function syncDetailExternalActions(entry) {
  syncDetailPdfAction(entry);

  const sciHubUrl = buildSciHubUrl(entry.doi);
  const publicationYear = entryPublicationYear(entry);
  const isTooRecent = publicationYear !== null
    && publicationYear > SCI_HUB_LAST_RELIABLE_PUBLICATION_YEAR;
  btnDetailSciHub.disabled = !sciHubUrl || isTooRecent;
  if (!sciHubUrl) {
    btnDetailSciHub.title = '缺少 DOI，无法打开 Sci-Hub';
  } else if (isTooRecent) {
    btnDetailSciHub.title = `${publicationYear} 年发表；Sci-Hub 自 2021 年起通常不再收录新论文`;
  } else {
    btnDetailSciHub.title = '通过 Sci-Hub 查找全文';
  }
  btnDetailSciHub.onclick = btnDetailSciHub.disabled ? null : () => openUrl(sciHubUrl);
}

function setDetailViewMode(view) {
  const showPdf = view === 'pdf' && !!detailPdfUrl;
  detailSummaryView?.classList.toggle('hidden', showPdf);
  detailPdfView?.classList.toggle('hidden', !showPdf);
  btnDetailViewSummary?.classList.toggle('active', !showPdf);
  btnDetailViewSummary?.setAttribute('aria-selected', String(!showPdf));
  btnDetailViewPdf?.classList.toggle('active', showPdf);
  btnDetailViewPdf?.setAttribute('aria-selected', String(showPdf));
  btnDetailPdf?.classList.toggle('active', showPdf);
}

function pdfReaderPageKey(entryId) {
  return `pdf-reader-page-v1-${entryId}`;
}

function restorePdfReaderPage(entryId) {
  try {
    return Math.max(1, Number(localStorage.getItem(pdfReaderPageKey(entryId))) || 1);
  } catch {
    return 1;
  }
}

function persistPdfReaderPage(entryId, pageNumber) {
  if (!entryId) return;
  try {
    localStorage.setItem(pdfReaderPageKey(entryId), String(pageNumber));
  } catch {}
}

async function ensureDetailPdfReader() {
  if (detailPdfReader) return detailPdfReader;
  const { PdfReader } = await import('./pdf_reader.js');
  detailPdfReader = new PdfReader({
    view: detailPdfView,
    stage: document.getElementById('detail-pdf-stage'),
    canvas: document.getElementById('detail-pdf-canvas'),
    status: document.getElementById('detail-pdf-status'),
    previous: document.getElementById('btn-pdf-previous'),
    next: document.getElementById('btn-pdf-next'),
    pageInput: document.getElementById('pdf-page-input'),
    pageCount: document.getElementById('pdf-page-count'),
    zoomOut: document.getElementById('btn-pdf-zoom-out'),
    zoomIn: document.getElementById('btn-pdf-zoom-in'),
    fitWidth: document.getElementById('btn-pdf-fit-width'),
    zoomLabel: document.getElementById('pdf-zoom-label'),
    searchInput: document.getElementById('pdf-search-input'),
    searchNext: document.getElementById('btn-pdf-search-next'),
    searchStatus: document.getElementById('pdf-search-status'),
  }, {
    onPageChange: persistPdfReaderPage,
  });
  return detailPdfReader;
}

async function openDetailPdfView() {
  if (!currentEntry || !detailPdfUrl) return;
  const entry = currentEntry;
  const requestId = ++detailPdfRequestId;
  setDetailViewMode('pdf');
  const reader = await ensureDetailPdfReader();
  if (reader.entryId === entry.id && reader.document) {
    reader.renderPage();
    return;
  }

  reader.setStatus('正在获取全文 PDF…', 'loading');
  try {
    const binary = await invoke('fetch_entry_pdf', { entryId: entry.id });
    if (requestId !== detailPdfRequestId || currentEntry?.id !== entry.id) return;
    await reader.load(binary, {
      entryId: entry.id,
      page: restorePdfReaderPage(entry.id),
    });
  } catch (error) {
    if (requestId !== detailPdfRequestId || currentEntry?.id !== entry.id) return;
    console.error('内置 PDF 阅读失败:', error);
    reader.setStatus(`无法在应用内读取 PDF：${error}`, 'error');
  }
}

function entryPdfIdentity(entry) {
  return [entry.id, entry.doi || '', entry.pmid || '', entry.pmcid || ''].join('|');
}

function syncDetailPdfAction(entry) {
  const identity = entryPdfIdentity(entry);
  const cached = entryPdfLinkCache.get(entry.id);
  if (cached?.identity === identity) {
    applyDetailPdfUrl(cached.url);
    return;
  }

  btnDetailPdf.disabled = true;
  btnDetailPdf.setAttribute('aria-busy', 'true');
  btnDetailPdf.title = '正在检查全文 PDF…';
  btnDetailPdf.onclick = null;
  if (btnDetailViewPdf) {
    btnDetailViewPdf.disabled = true;
    btnDetailViewPdf.title = '正在检查全文 PDF…';
  }
  ensureEntryPdfLink(entry, identity);
}

function applyDetailPdfUrl(url) {
  detailPdfUrl = url || '';
  btnDetailPdf.removeAttribute('aria-busy');
  btnDetailPdf.disabled = !url;
  btnDetailPdf.title = url ? '在详情中阅读 PDF' : '未找到可直接打开的全文 PDF';
  btnDetailPdf.onclick = url ? openDetailPdfView : null;
  if (btnDetailViewPdf) {
    btnDetailViewPdf.disabled = !url;
    btnDetailViewPdf.title = url ? '在详情中阅读 PDF' : '未找到可直接打开的全文 PDF';
  }
  if (!url) setDetailViewMode('summary');
}

async function ensureEntryPdfLink(entry, identity) {
  const existing = entryPdfLinkCheckInFlight.get(entry.id);
  if (existing?.identity === identity) return existing.promise;

  const promise = (async () => {
    let url = '';
    let failed = false;
    try {
      url = await invoke('resolve_entry_pdf_url', { entryId: entry.id }) || '';
      entryPdfLinkCache.set(entry.id, { identity, url });
    } catch (error) {
      failed = true;
      console.error('检查全文 PDF 失败:', error);
    } finally {
      const active = entryPdfLinkCheckInFlight.get(entry.id);
      if (active?.identity === identity) entryPdfLinkCheckInFlight.delete(entry.id);
      if (currentEntry?.id === entry.id && entryPdfIdentity(currentEntry) === identity) {
        applyDetailPdfUrl(url);
        if (failed) btnDetailPdf.title = '全文 PDF 检查失败，请重新打开文章后重试';
      }
    }
  })();
  entryPdfLinkCheckInFlight.set(entry.id, { identity, promise });
  try {
    await promise;
  } catch {}
}

function entryPublicationYear(entry) {
  for (const value of [entry?.publication_date, entry?.publication_date_raw, entry?.published_at]) {
    const match = String(value || '').match(/(?:19|20)\d{2}/);
    if (match) return Number(match[0]);
  }
  return null;
}

function buildSciHubUrl(value) {
  const doi = String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  if (!doi) return '';
  const encodedDoi = doi.split('/').map(part => encodeURIComponent(part)).join('/');
  return `${SCI_HUB_BASE_URL}${encodedDoi}`;
}

function resetPaperGraph() {
  paperGraphRequestToken += 1;
  currentPaperGraph = null;
  selectedPaperGraphNodeId = null;
  paperGraphHistory = [];
  paperGraphFilter = 'all';
  paperGraphViewport = { x: 0, y: 0, scale: 1 };
  detailPaperGraphSection?.classList.add('hidden');
  btnPaperGraph?.classList.remove('active');
  if (paperGraphStage) paperGraphStage.innerHTML = '';
  if (paperGraphNodeDetail) {
    paperGraphNodeDetail.innerHTML = '';
    paperGraphNodeDetail.classList.add('hidden');
  }
  syncPaperGraphControls();
}

function syncPaperGraphControls() {
  document.querySelectorAll('[data-graph-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.graphFilter === paperGraphFilter);
  });
  document.getElementById('btn-paper-graph-back')?.classList.toggle('hidden', !paperGraphHistory.length);
}

async function togglePaperGraph() {
  if (!currentEntry || !detailPaperGraphSection) return;
  const willShow = detailPaperGraphSection.classList.contains('hidden');
  detailPaperGraphSection.classList.toggle('hidden', !willShow);
  btnPaperGraph?.classList.toggle('active', willShow);
  if (!willShow) return;
  detailPaperGraphSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!currentPaperGraph) await loadPaperGraph({ entryId: currentEntry.id });
}

async function loadPaperGraph({ entryId = null, paperId = null, pushHistory = false } = {}) {
  if (!paperGraphStage) return;
  if (pushHistory && currentPaperGraph?.seed_id) {
    paperGraphHistory.push(currentPaperGraph.seed_id);
  }
  const token = ++paperGraphRequestToken;
  paperGraphStage.innerHTML = '<div class="paper-graph-loading"><span></span>正在构建关系图谱…</div>';
  paperGraphNodeDetail?.classList.add('hidden');
  document.getElementById('btn-paper-graph-reload')?.classList.add('is-loading');
  syncPaperGraphControls();
  try {
    const graph = await invoke('get_paper_graph', {
      entryId: entryId || null,
      paperId: paperId || null,
    });
    if (token !== paperGraphRequestToken) return;
    currentPaperGraph = graph;
    selectedPaperGraphNodeId = graph.seed_id;
    paperGraphViewport = { x: 0, y: 0, scale: 1 };
    renderPaperGraph();
  } catch (error) {
    if (token !== paperGraphRequestToken) return;
    currentPaperGraph = null;
    paperGraphStage.innerHTML = `
      <div class="paper-graph-error">
        <div>${escapeHtml(String(error))}</div>
        <button class="btn btn-secondary btn-sm" type="button" data-paper-graph-retry>重试</button>
      </div>
    `;
    paperGraphStage.querySelector('[data-paper-graph-retry]')?.addEventListener('click', () => {
      loadPaperGraph({ entryId: currentEntry?.id || null, paperId });
    });
    updatePaperGraphCounts();
  } finally {
    if (token === paperGraphRequestToken) {
      document.getElementById('btn-paper-graph-reload')?.classList.remove('is-loading');
    }
  }
}

function paperGraphRelation(node) {
  if (node.paper_id === currentPaperGraph?.seed_id) return 'seed';
  if (paperGraphFilter !== 'all' && node.relations?.includes(paperGraphFilter)) return paperGraphFilter;
  if (node.relations?.includes('reference')) return 'reference';
  if (node.relations?.includes('citation')) return 'citation';
  return 'similar';
}

function visiblePaperGraphNodes() {
  if (!currentPaperGraph) return [];
  return currentPaperGraph.nodes.filter(node => (
    node.paper_id === currentPaperGraph.seed_id
    || paperGraphFilter === 'all'
    || node.relations?.includes(paperGraphFilter)
  ));
}

function hashPaperGraphId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function truncatePaperGraphTitle(value, length = 22) {
  const text = String(value || '').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function layoutPaperGraphNodes(nodes) {
  const knownYears = nodes.map(node => node.year).filter(Number.isFinite);
  const currentYear = new Date().getFullYear();
  let minYear = knownYears.length ? Math.min(...knownYears) : currentYear - 1;
  let maxYear = knownYears.length ? Math.max(...knownYears) : currentYear;
  if (minYear === maxYear) {
    minYear -= 1;
    maxYear += 1;
  }
  const positions = new Map();
  nodes.forEach(node => {
    const year = Number.isFinite(node.year) ? node.year : maxYear;
    const x = 72 + ((year - minYear) / (maxYear - minYear)) * 756;
    const relation = paperGraphRelation(node);
    const hash = hashPaperGraphId(node.paper_id);
    let y = 210;
    if (relation === 'reference') y = 68 + (hash % 88);
    if (relation === 'similar') y = hash % 2 ? 178 - (hash % 34) : 236 + (hash % 34);
    if (relation === 'citation') y = 292 + (hash % 70);
    positions.set(node.paper_id, { x, y });
  });
  return { positions, minYear, maxYear };
}

function paperGraphYearTicks(minYear, maxYear) {
  const span = maxYear - minYear;
  const step = Math.max(1, Math.ceil(span / 5));
  const ticks = [];
  for (let year = minYear; year <= maxYear; year += step) ticks.push(year);
  if (ticks[ticks.length - 1] !== maxYear) ticks.push(maxYear);
  return ticks;
}

function applyPaperGraphViewport() {
  const group = paperGraphStage?.querySelector('[data-paper-graph-viewport]');
  if (!group) return;
  const { x, y, scale } = paperGraphViewport;
  group.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
}

function bindPaperGraphViewport(svg) {
  let pointer = null;
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const pointX = ((event.clientX - rect.left) / rect.width) * 900;
    const pointY = ((event.clientY - rect.top) / rect.height) * 410;
    const oldScale = paperGraphViewport.scale;
    const nextScale = Math.min(2.4, Math.max(0.72, oldScale * (event.deltaY < 0 ? 1.12 : 0.9)));
    paperGraphViewport.x = pointX - ((pointX - paperGraphViewport.x) * nextScale / oldScale);
    paperGraphViewport.y = pointY - ((pointY - paperGraphViewport.y) * nextScale / oldScale);
    paperGraphViewport.scale = nextScale;
    applyPaperGraphViewport();
  }, { passive: false });
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('[data-paper-node]')) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    svg.setPointerCapture?.(event.pointerId);
    svg.classList.add('is-panning');
  });
  svg.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const rect = svg.getBoundingClientRect();
    const dx = (event.clientX - pointer.x) * 900 / rect.width;
    const dy = (event.clientY - pointer.y) * 410 / rect.height;
    if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = true;
    paperGraphViewport.x += dx;
    paperGraphViewport.y += dy;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    applyPaperGraphViewport();
  });
  const finish = event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (pointer.moved) paperGraphSuppressClickUntil = Date.now() + 180;
    pointer = null;
    svg.classList.remove('is-panning');
    svg.releasePointerCapture?.(event.pointerId);
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
}

function renderPaperGraph() {
  if (!currentPaperGraph || !paperGraphStage) return;
  const nodes = visiblePaperGraphNodes();
  const nodeIds = new Set(nodes.map(node => node.paper_id));
  const edges = currentPaperGraph.edges.filter(edge => (
    nodeIds.has(edge.source)
    && nodeIds.has(edge.target)
    && (paperGraphFilter === 'all' || edge.relation === paperGraphFilter)
  ));
  const { positions, minYear, maxYear } = layoutPaperGraphNodes(nodes);
  const ticks = paperGraphYearTicks(minYear, maxYear);
  const edgeMarkup = edges.map(edge => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return '';
    const marker = edge.relation === 'similar' ? '' : 'marker-end="url(#paper-graph-arrow)"';
    return `<line class="paper-graph-edge ${edge.relation}" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" ${marker} />`;
  }).join('');
  const nodeMarkup = nodes.map(node => {
    const point = positions.get(node.paper_id);
    const relation = paperGraphRelation(node);
    const radius = relation === 'seed' ? 15 : Math.min(13, 6 + Math.log10(Math.max(1, node.citation_count + 1)) * 2.4);
    const selected = node.paper_id === selectedPaperGraphNodeId ? ' selected' : '';
    return `
      <g class="paper-graph-node ${relation}${selected}" data-paper-node data-paper-id="${escapeHtml(node.paper_id)}" transform="translate(${point.x} ${point.y})" tabindex="0" role="button" aria-label="${escapeHtml(node.title)}">
        <circle r="${radius}"><title>${escapeHtml(node.title)} · ${node.year || '年份未知'} · 被引 ${node.citation_count || 0}</title></circle>
        <text y="${radius + 15}" text-anchor="middle">${escapeHtml(truncatePaperGraphTitle(node.title))}</text>
      </g>
    `;
  }).join('');
  const tickMarkup = ticks.map(year => {
    const x = 72 + ((year - minYear) / (maxYear - minYear)) * 756;
    return `<g class="paper-graph-year" transform="translate(${x} 0)"><line y1="28" y2="382"/><text y="400" text-anchor="middle">${year}</text></g>`;
  }).join('');

  paperGraphStage.innerHTML = `
    <svg class="paper-graph-svg" viewBox="0 0 900 410" role="img" aria-label="文献引用关系图">
      <defs><marker id="paper-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
      <g data-paper-graph-viewport>
        ${tickMarkup}
        ${edgeMarkup}
        ${nodeMarkup}
      </g>
    </svg>
  `;
  const svg = paperGraphStage.querySelector('svg');
  applyPaperGraphViewport();
  bindPaperGraphViewport(svg);
  paperGraphStage.querySelectorAll('[data-paper-node]').forEach(group => {
    const select = () => {
      if (Date.now() < paperGraphSuppressClickUntil) return;
      selectPaperGraphNode(group.dataset.paperId);
    };
    group.addEventListener('click', select);
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
  });
  updatePaperGraphCounts();
  renderPaperGraphNodeDetail();
  syncPaperGraphControls();
}

function updatePaperGraphCounts() {
  if (!paperGraphCounts) return;
  if (!currentPaperGraph) {
    paperGraphCounts.textContent = '';
    return;
  }
  const count = relation => currentPaperGraph.nodes.filter(node => node.relations?.includes(relation)).length;
  paperGraphCounts.textContent = `更早 ${count('reference')} · 后续 ${count('citation')} · 相似 ${count('similar')}`;
}

function selectPaperGraphNode(paperId) {
  if (!currentPaperGraph?.nodes.some(node => node.paper_id === paperId)) return;
  selectedPaperGraphNodeId = paperId;
  paperGraphStage?.querySelectorAll('[data-paper-node]').forEach(node => {
    node.classList.toggle('selected', node.dataset.paperId === paperId);
  });
  renderPaperGraphNodeDetail();
}

function paperGraphNodeUrl(node) {
  if (node?.url) return node.url;
  if (node?.doi) return `https://doi.org/${encodeURIComponent(node.doi)}`;
  if (node?.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(node.pmid)}/`;
  return '';
}

function paperGraphRelationLabel(node) {
  const labels = [];
  if (node?.paper_id === currentPaperGraph?.seed_id) labels.push('当前中心');
  if (node?.relations?.includes('reference')) labels.push('更早工作');
  if (node?.relations?.includes('citation')) labels.push('后续工作');
  if (node?.relations?.includes('similar')) labels.push('相似文献');
  return labels.join(' · ');
}

function renderPaperGraphNodeDetail() {
  if (!paperGraphNodeDetail || !currentPaperGraph) return;
  const node = currentPaperGraph.nodes.find(item => item.paper_id === selectedPaperGraphNodeId);
  if (!node) {
    paperGraphNodeDetail.classList.add('hidden');
    return;
  }
  const authors = (node.authors || []).slice(0, 4).join(', ');
  const url = paperGraphNodeUrl(node);
  const isSeed = node.paper_id === currentPaperGraph.seed_id;
  paperGraphNodeDetail.innerHTML = `
    <div class="paper-graph-node-copy">
      <div class="paper-graph-node-kind">${escapeHtml(paperGraphRelationLabel(node))}</div>
      <div class="paper-graph-node-title">${escapeHtml(node.title)}</div>
      <div class="paper-graph-node-meta">${escapeHtml([node.year, authors, `被引 ${node.citation_count || 0}`].filter(Boolean).join(' · '))}</div>
      ${node.abstract_text ? `<div class="paper-graph-node-abstract">${escapeHtml(truncatePaperGraphTitle(node.abstract_text, 240))}</div>` : ''}
    </div>
    <div class="paper-graph-node-actions">
      <button class="btn btn-secondary btn-sm" type="button" data-paper-graph-open ${url ? '' : 'disabled'}>打开</button>
      <button class="btn btn-primary btn-sm" type="button" data-paper-graph-center ${isSeed ? 'disabled' : ''}>以此为中心</button>
    </div>
  `;
  paperGraphNodeDetail.classList.remove('hidden');
  paperGraphNodeDetail.querySelector('[data-paper-graph-open]')?.addEventListener('click', () => openUrl(url));
  paperGraphNodeDetail.querySelector('[data-paper-graph-center]')?.addEventListener('click', () => {
    loadPaperGraph({ paperId: node.paper_id, pushHistory: true });
  });
}

function setPaperGraphFilter(filter) {
  if (!['all', 'reference', 'citation', 'similar'].includes(filter)) return;
  paperGraphFilter = filter;
  paperGraphViewport = { x: 0, y: 0, scale: 1 };
  if (currentPaperGraph) {
    const selected = currentPaperGraph.nodes.find(node => node.paper_id === selectedPaperGraphNodeId);
    if (selected && selected.paper_id !== currentPaperGraph.seed_id && !selected.relations?.includes(filter) && filter !== 'all') {
      selectedPaperGraphNodeId = currentPaperGraph.seed_id;
    }
    renderPaperGraph();
  } else {
    syncPaperGraphControls();
  }
}

function reloadPaperGraph() {
  if (!currentEntry) return;
  if (currentPaperGraph?.seed_id && paperGraphHistory.length) {
    loadPaperGraph({ paperId: currentPaperGraph.seed_id });
  } else {
    loadPaperGraph({ entryId: currentEntry.id });
  }
}

function backPaperGraph() {
  const previous = paperGraphHistory.pop();
  if (!previous) return;
  loadPaperGraph({ paperId: previous });
}

function syncAbstractToggle() {
  document.querySelectorAll('.abstract-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === abstractLang);
  });
  const toggle = document.getElementById('abstract-toggle');
  if (!toggle) return;
  const e = currentEntry;
  const hasBoth = e && e.summary && e.summary_translated;
  toggle.style.visibility = hasBoth ? 'visible' : 'hidden';
}

function renderSummary(entry, state = 'ready') {
  syncAbstractToggle();
  const showRetry = abstractLang === 'zh'
    && entry.summary
    && !entry.summary_translated
    && !entry._summaryTranslating;
  if (detailSummaryRetry) detailSummaryRetry.classList.toggle('hidden', !showRetry);
  // 1) Currently being translated → spinner placeholder (only when zh tab selected
  //    and we don't yet have a translation; if EN tab is selected we still show the
  //    original text while translation runs in the background).
  if (entry._summaryTranslating && abstractLang === 'zh' && !entry.summary_translated) {
    detailSummaryContent.innerHTML = '<div class="detail-summary-translating">正在翻译摘要…</div>';
    return;
  }
  if (entry._transError && abstractLang === 'zh' && !entry.summary_translated) {
    const clean = stripSummaryIdentifierFooter(stripHtml(entry.summary || ''));
    detailSummaryContent.innerHTML = `
      <p class="detail-summary-error">摘要翻译失败：${escapeHtml(entry._transError)}</p>
      ${clean ? `<p class="detail-summary-original">${escapeHtml(clean)}</p>` : ''}
    `;
    return;
  }
  // 2) Translated text available, zh tab → show it
  if (entry.summary_translated && abstractLang === 'zh') {
    const clean = stripSummaryIdentifierFooter(entry.summary_translated);
    detailSummaryContent.innerHTML = `<p>${escapeHtml(clean)}</p>`;
    return;
  }
  // 3) Original summary available (any of: en tab; or zh tab without translation yet)
  if (entry.summary && (abstractLang === 'en' || !entry.summary_translated)) {
    const clean = stripSummaryIdentifierFooter(stripHtml(entry.summary));
    detailSummaryContent.innerHTML = `<p class="detail-summary-original">${escapeHtml(clean)}</p>`;
    return;
  }
  // 4) No summary yet — either still fetching (or we never will)
  if (state === 'loading') detailSummaryContent.innerHTML = '<p class="detail-summary-empty">正在获取 Abstract…</p>';
  else detailSummaryContent.innerHTML = '<p class="detail-summary-empty">未能自动获取 Abstract。可以打开原文查看。</p>';
}

function stripSummaryIdentifierFooter(text) {
  return String(text ?? '')
    .replace(/(?:\s*(?:[|｜]\s*)?(?:PMID|DOI)\s*[:：]\s*[^\s|｜]+){1,2}\s*$/iu, '')
    .trim();
}

function refreshDetailTitleSpinner(entry) {
  if (!detailTitle) return;
  let spin = document.getElementById('detail-title-spinner');
  if (entry._titleTranslating) {
    if (!spin) {
      spin = document.createElement('span');
      spin.id = 'detail-title-spinner';
      spin.className = 'detail-title-spinner';
      (detailTitle.querySelector('.detail-title-primary') || detailTitle).appendChild(spin);
    }
  } else if (spin) {
    spin.remove();
  }
}

function applyAffiliation(entry) {
  if (!detailAffiliation) return;
  const text = (entry?.affiliation || '').trim();
  if (text) {
    detailAffiliation.textContent = text;
    detailAffiliation.classList.remove('hidden');
  } else {
    detailAffiliation.textContent = '';
    detailAffiliation.classList.add('hidden');
  }
}

function displayPmcid(value) {
  return String(value || '').trim().replace(/^PMC/i, '');
}

function renderDetailIdentifiers(entry) {
  if (!detailIdentifierStrip) return;
  const items = [
    ['PMID', (entry?.pmid || '').trim(), entry?.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(entry.pmid.trim())}/` : ''],
    ['PMCID', displayPmcid(entry?.pmcid), entry?.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(entry.pmcid.trim())}/` : ''],
    ['DOI', (entry?.doi || '').trim(), entry?.doi ? `https://doi.org/${encodeURIComponent(entry.doi.trim())}` : ''],
  ].filter(([, value]) => value);

  if (!items.length) {
    detailIdentifierStrip.innerHTML = '';
    detailIdentifierStrip.classList.add('hidden');
    return;
  }

  detailIdentifierStrip.innerHTML = items
    .map(([label, value, url]) => `
      <span class="detail-identifier-chip">
        <button class="detail-identifier-main" type="button" data-url="${escapeHtml(url)}" title="打开 ${escapeHtml(label)}">
          <span class="detail-identifier-label">${escapeHtml(label)}</span>
          <span class="detail-identifier-value">${escapeHtml(value)}</span>
        </button>
        <button class="detail-identifier-copy" type="button" data-value="${escapeHtml(value)}" title="复制 ${escapeHtml(label)}">
          复制
        </button>
      </span>
    `)
    .join('');
  detailIdentifierStrip.querySelectorAll('.detail-identifier-main').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url || '';
      if (url) await openUrl(url);
    });
  });
  detailIdentifierStrip.querySelectorAll('.detail-identifier-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const value = btn.dataset.value || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
      } catch {}
      const original = btn.textContent || '复制';
      btn.textContent = '已复制';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1200);
    });
  });
  detailIdentifierStrip.classList.remove('hidden');
}

function renderDetailTags(entry) {
  if (!detailTagList) return;
  detailTagList.innerHTML = '';
  const tags = Array.isArray(entry?.tags) ? entry.tags : [];

  if (!tags.length) {
    detailTagList.innerHTML = '<div class="detail-tags-empty">暂未添加标签</div>';
    return;
  }

  tags.forEach(tag => {
    const chip = document.createElement('div');
    chip.className = 'detail-tag-chip';

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'detail-tag-name';
    nameBtn.textContent = tag;
    nameBtn.title = `按“${tag}”筛选`;
    nameBtn.addEventListener('click', () => {
      if (!entryTagFilter) return;
      entryTagFilterValue = tag;
      entryTagFilter.value = tag;
      persistCurrentFilterScope();
      clearEntrySelection({ render: false, syncPaperChat: false });
      renderEntryList(allEntries);
      refreshPaperChatAfterScopeDataChange();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'detail-tag-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `删除标签 ${tag}`;
    removeBtn.addEventListener('click', async () => {
      await removeTagFromEntry(entry, tag);
    });

    chip.appendChild(nameBtn);
    chip.appendChild(removeBtn);
    detailTagList.appendChild(chip);
  });
}

function parseTagInput(value) {
  return [...new Set(
    String(value || '')
      .split(/[\n,，;；]/)
      .map(tag => tag.trim().replace(/\s+/g, ' '))
      .filter(Boolean),
  )];
}

async function addTagsToCurrentEntry() {
  if (!currentEntry) return;
  const tags = parseTagInput(detailTagInput?.value || '');
  if (!tags.length) {
    setGlobalStatus('请输入至少一个标签', 'error');
    return;
  }

  try {
    let latestTags = currentEntry.tags || [];
    for (const tag of tags) {
      latestTags = await invoke('add_entry_tag', { entryId: currentEntry.id, tag });
    }
    applyEntryUpdate(currentEntry.id, entry => { entry.tags = latestTags; });
    refreshEntryTagFilterOptions(allEntries);
    renderEntryList(allEntries);
    renderDetailTags(currentEntry);
    if (detailTagInput) detailTagInput.value = '';
    setGlobalStatus(`已添加标签：${tags.join('、')}`, 'success');
  } catch (e) {
    setGlobalStatus('添加标签失败: ' + e, 'error');
  }
}

async function removeTagFromEntry(entry, tag) {
  try {
    const latestTags = await invoke('remove_entry_tag', { entryId: entry.id, tag });
    applyEntryUpdate(entry.id, item => { item.tags = latestTags; });
    refreshEntryTagFilterOptions(allEntries);
    renderEntryList(allEntries);
    if (currentEntry?.id === entry.id) renderDetailTags(currentEntry);
    setGlobalStatus(`已删除标签：${tag}`, 'success');
  } catch (e) {
    setGlobalStatus('删除标签失败: ' + e, 'error');
  }
}

async function ensureAffiliationLoaded(entry) {
  if (!entry || (entry.affiliation && entry.affiliation.trim())) return;
  if (!entry.link || !entry.link.includes('pubmed.ncbi.nlm.nih.gov')) return;
  if (entry._affiliationLoading) return;
  entry._affiliationLoading = true;
  try {
    const text = await invoke('fetch_affiliation', { entryId: entry.id });
    applyEntryUpdate(entry.id, x => { x.affiliation = text || ''; });
    if (currentEntry && currentEntry.id === entry.id) applyAffiliation(currentEntry);
  } catch (e) {
    console.warn('fetch_affiliation 失败:', e);
  } finally {
    entry._affiliationLoading = false;
  }
}

async function ensureAuthorsLoaded(entry) {
  if (!entry || entry._authorsLoaded || !entry.link?.includes('pubmed.ncbi.nlm.nih.gov')) return;
  if (entry._authorsLoading) return;
  entry._authorsLoading = true;
  try {
    const authors = await invoke('fetch_entry_authors', { entryId: entry.id });
    entry._authorsLoaded = true;
    if (authors) {
      applyEntryUpdate(entry.id, item => { item.author = authors; });
      if (currentEntry?.id === entry.id) {
        const authorEl = document.getElementById('detail-author');
        const authorSep = document.getElementById('detail-author-sep');
        const formatted = formatAuthors(authors);
        if (authorEl) authorEl.textContent = formatted;
        authorSep?.classList.toggle('hidden', !formatted);
      }
    }
  } catch (e) {
    console.warn('fetch_entry_authors 失败:', e);
  } finally {
    entry._authorsLoading = false;
  }
}

async function ensureEntryIdentifiersLoaded(entry) {
  if (!entry) return;
  const hasAll = !!(entry.pmid && entry.pmcid && entry.doi);
  if (hasAll) return;
  if (entry._identifiersLoading) return;
  entry._identifiersLoading = true;
  try {
    const ids = await invoke('fetch_entry_identifiers', { entryId: entry.id });
    applyEntryUpdate(entry.id, x => {
      x.pmid = ids?.pmid || '';
      x.pmcid = ids?.pmcid || '';
      x.doi = ids?.doi || '';
    });
    if (currentEntry && currentEntry.id === entry.id) {
      renderDetailIdentifiers(currentEntry);
      syncDetailExternalActions(currentEntry);
    }
  } catch (e) {
    console.warn('fetch_entry_identifiers 失败:', e);
  } finally {
    entry._identifiersLoading = false;
  }
}

async function loadAbstract(entry) {
  renderSummary(entry, 'loading');
  try {
    const text = await invoke('fetch_abstract', { entryId: entry.id });
    if (!currentEntry || currentEntry.id !== entry.id) return;
    if (text) {
      entry.summary = text;
      currentEntry.summary = text;
      renderSummary(entry);
    } else {
      renderSummary(entry, 'empty');
    }
  } catch (e) {
    if (!currentEntry || currentEntry.id !== entry.id) return;
    detailSummaryContent.innerHTML = `<p class="detail-summary-error">Abstract 获取失败: ${escapeHtml(String(e))}</p>`;
  }
}

async function retrySummaryTranslation() {
  if (!currentEntry) return;
  const entryId = currentEntry.id;
  if (btnRetrySummary) {
    btnRetrySummary.disabled = true;
    btnRetrySummary.setAttribute('aria-busy', 'true');
  }
  setGlobalStatus('正在翻译摘要…', 'progress');
  // Mirror translation-progress events: clear the error pill across all
  // entry collections so the middle-column badge disappears immediately.
  applyEntryUpdate(entryId, x => {
    x._summaryTranslating = true;
    x._transError = null;
  });
  updateRenderedTranslationEntry(entryId);
  if (currentEntry && currentEntry.id === entryId) renderSummary(currentEntry);
  try {
    const translated = await invoke('translate_summary', { entryId });
    applyEntryUpdate(entryId, x => {
      x.summary_translated = translated;
      x._summaryTranslating = false;
      x._transError = null;
    });
    addTranslationCost(translated.length);
    setGlobalStatus('摘要翻译完成', 'success');
  } catch (e) {
    const msg = (typeof e === 'string') ? e : (e && e.message) || '翻译失败';
    applyEntryUpdate(entryId, x => {
      x._summaryTranslating = false;
      x._transError = msg;
    });
    setGlobalStatus(`摘要翻译失败：${msg}`, 'error');
  } finally {
    if (btnRetrySummary) {
      btnRetrySummary.disabled = false;
      btnRetrySummary.removeAttribute('aria-busy');
    }
    updateRenderedTranslationEntry(entryId);
    updateOverviewCounts();
    if (currentEntry && currentEntry.id === entryId) renderSummary(currentEntry);
  }
}

async function openUrl(url) {
  if (!url) return;
  try {
    await invoke('open_url', { url });
  } catch (e) {
    console.error('打开链接失败，回退到浏览器默认打开:', e);
    try {
      window.open(url, '_blank', 'noopener');
    } catch (fallbackError) {
      console.error('浏览器回退打开失败:', fallbackError);
    }
  }
}

// ── Removed: translateSummary / ensureEntrySummary / translateAllTitles ──
// Title + summary translation is now driven entirely by the background
// pipeline in src-tauri/src/services/translation_pipeline.rs. The UI
// reacts to `translation-progress` events emitted by that pipeline.

// ── Translation progress events (from background pipeline) ────────
function applyEntryUpdate(entryId, mutate) {
  const inAll = allEntries.find(e => e.id === entryId);
  const inGlobal = globalEntries.find(e => e.id === entryId);
  if (inAll) mutate(inAll);
  if (inGlobal && inGlobal !== inAll) mutate(inGlobal);
  if (currentEntry && currentEntry.id === entryId && currentEntry !== inAll) mutate(currentEntry);
}

function findRenderedEntryItem(entryId) {
  const targetId = String(entryId);
  return Array.from(entryItemsEl?.querySelectorAll('[data-entry-id]') || [])
    .find(element => element.dataset.entryId === targetId) || null;
}

function syncRenderedTranslationTitle(item, entry) {
  const titleEl = item.querySelector('.pubmed-entry-title, .entry-title');
  if (!titleEl) return;

  const titles = displayTitles(entry);
  titleEl.replaceChildren(document.createTextNode(titles.primary));
  if (entry._titleTranslating || entry._summaryTranslating) {
    titleEl.append(' ');
    const spinner = document.createElement('span');
    spinner.className = 'entry-spinner';
    titleEl.appendChild(spinner);
  }

  const isPubmed = item.classList.contains('pubmed-entry-item');
  const originalSelector = isPubmed ? '.pubmed-entry-original' : '.entry-title-original';
  let originalEl = item.querySelector(originalSelector);
  if (!titles.secondary) {
    originalEl?.remove();
    return;
  }

  if (!originalEl) {
    originalEl = document.createElement('div');
    originalEl.className = originalSelector.slice(1);
    if (isPubmed) {
      const titleRow = item.querySelector('.pubmed-entry-title-row');
      titleRow?.insertAdjacentElement('afterend', originalEl);
    } else {
      titleEl.parentElement?.appendChild(originalEl);
    }
  }
  originalEl.textContent = titles.secondary;
}

function syncRenderedTranslationBadge(item, entry) {
  if (!entry.summary_translated) return;
  let badgesEl = item.querySelector('.entry-badges');
  if (!badgesEl) {
    const content = item.querySelector('.pubmed-entry-content, .entry-body');
    if (!content) return;
    badgesEl = document.createElement('div');
    badgesEl.className = item.classList.contains('pubmed-entry-item')
      ? 'entry-badges pubmed-entry-tags'
      : 'entry-badges';
    content.appendChild(badgesEl);
  }
  if (badgesEl.querySelector('.pill-accent')) return;
  const badge = document.createElement('span');
  badge.className = 'pill pill-accent';
  badge.textContent = '已翻译';
  badgesEl.prepend(badge);
}

function updateRenderedTranslationEntry(entryId) {
  const entry = allEntries.find(item => item.id === entryId);
  const item = findRenderedEntryItem(entryId);
  if (!entry || !item) return;
  syncRenderedTranslationTitle(item, entry);
  syncRenderedTranslationBadge(item, entry);
}

function loadPaperChatPanelWidth() {
  try {
    const raw = parseInt(localStorage.getItem(PAPER_CHAT_WIDTH_STORAGE_KEY) || '', 10);
    return Number.isFinite(raw) ? raw : PAPER_CHAT_DEFAULT_WIDTH;
  } catch {
    return PAPER_CHAT_DEFAULT_WIDTH;
  }
}

function loadSidebarWidth() {
  try {
    const raw = parseInt(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || '', 10);
    return Number.isFinite(raw) ? raw : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function saveSidebarWidth(width) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {}
}

function clampSidebarWidth(width) {
  const requested = Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH;
  const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
  const maxByViewport = viewportWidth > 0
    ? Math.max(SIDEBAR_MIN_WIDTH, viewportWidth - 640)
    : SIDEBAR_MAX_WIDTH;
  const maxWidth = Math.min(SIDEBAR_MAX_WIDTH, maxByViewport);
  return Math.round(Math.min(maxWidth, Math.max(SIDEBAR_MIN_WIDTH, requested)));
}

function applySidebarWidth(width, { persist = false } = {}) {
  const next = clampSidebarWidth(width);
  document.documentElement.style.setProperty('--sidebar-width', `${next}px`);
  if (persist) saveSidebarWidth(next);
  requestAnimationFrame(() => {
    applyPaperChatPanelWidth(loadPaperChatPanelWidth());
    syncPaperChatResizerVisibility();
  });
}

function loadListPanelWidth() {
  try {
    const raw = parseInt(localStorage.getItem(LIST_WIDTH_STORAGE_KEY) || '', 10);
    return Number.isFinite(raw) ? raw : LIST_DEFAULT_WIDTH;
  } catch {
    return LIST_DEFAULT_WIDTH;
  }
}

function saveListPanelWidth(width) {
  try {
    localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {}
}

function clampListPanelWidth(width) {
  const requested = Number.isFinite(width) ? width : LIST_DEFAULT_WIDTH;
  const containerWidth = contentArea?.clientWidth || 0;
  const detailMinWidth = mode === 'briefing' ? BRIEFING_DETAIL_MIN_WIDTH : DETAIL_PANEL_MIN_WIDTH;
  const reserveForPaperChat = isLiteratureMode() && !shouldHidePaperChatPanel()
    ? PAPER_CHAT_MIN_WIDTH + PANEL_RESIZER_WIDTH
    : 0;
  const maxByLayout = containerWidth > 0
    ? Math.max(
        LIST_MIN_WIDTH,
        containerWidth - detailMinWidth - reserveForPaperChat - PANEL_RESIZER_WIDTH,
      )
    : LIST_MAX_WIDTH;
  const maxWidth = Math.min(LIST_MAX_WIDTH, maxByLayout);
  return Math.round(Math.min(maxWidth, Math.max(LIST_MIN_WIDTH, requested)));
}

function applyListPanelWidth(width, { persist = false } = {}) {
  const next = clampListPanelWidth(width);
  document.documentElement.style.setProperty('--list-width', `${next}px`);
  if (persist) saveListPanelWidth(next);
  requestAnimationFrame(() => {
    applyPaperChatPanelWidth(loadPaperChatPanelWidth());
    syncPaperChatResizerVisibility();
  });
}

function savePaperChatPanelWidth(width) {
  try {
    localStorage.setItem(PAPER_CHAT_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {}
}

function loadPaperChatCollapsed() {
  try {
    return localStorage.getItem(PAPER_CHAT_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function savePaperChatCollapsed(collapsed) {
  try {
    localStorage.setItem(PAPER_CHAT_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {}
}

function clampPaperChatPanelWidth(width) {
  const requested = Number.isFinite(width) ? width : PAPER_CHAT_DEFAULT_WIDTH;
  const containerWidth = contentArea?.clientWidth || 0;
  const listWidth = entryListEl?.offsetWidth || briefingListEl?.offsetWidth || 416;
  const maxByLayout = containerWidth > 0
    ? Math.max(
        PAPER_CHAT_MIN_WIDTH,
        containerWidth - listWidth - DETAIL_PANEL_MIN_WIDTH - PANEL_RESIZER_WIDTH,
      )
    : 760;
  const maxWidth = Math.min(760, maxByLayout);
  return Math.round(Math.min(maxWidth, Math.max(PAPER_CHAT_MIN_WIDTH, requested)));
}

function shouldAutoHidePaperChatPanel() {
  if (!isLiteratureMode()) return true;
  const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
  if (viewportWidth > 0 && viewportWidth < PAPER_CHAT_MIN_APP_WIDTH) return true;
  const containerWidth = contentArea?.clientWidth || 0;
  if (containerWidth <= 0) return false;
  const listWidth = entryListEl?.offsetWidth || briefingListEl?.offsetWidth || 416;
  const minimumFeedLayoutWidth = listWidth + DETAIL_PANEL_MIN_WIDTH + PAPER_CHAT_MIN_WIDTH + PANEL_RESIZER_WIDTH;
  return containerWidth < minimumFeedLayoutWidth;
}

function shouldHidePaperChatPanel() {
  return shouldAutoHidePaperChatPanel() || paperChatCollapsed;
}

function isLiteratureMode() {
  return mode === 'feed' || mode === 'pubmed' || mode === 'kept' || mode === 'search';
}

function applyPaperChatPanelWidth(width, { persist = false } = {}) {
  if (!paperChatPanelEl) return;
  const next = clampPaperChatPanelWidth(width);
  paperChatPanelEl.style.flex = `0 0 ${next}px`;
  paperChatPanelEl.style.width = `${next}px`;
  paperChatPanelEl.style.maxWidth = `${next}px`;
  if (persist) savePaperChatPanelWidth(next);
}

function setPaperChatCollapsed(collapsed, { persist = true } = {}) {
  paperChatCollapsed = !!collapsed;
  if (persist) savePaperChatCollapsed(paperChatCollapsed);
  syncPaperChatResizerVisibility();
}

function syncPaperChatResizerVisibility() {
  const shouldHide = shouldHidePaperChatPanel();
  const autoHidden = shouldAutoHidePaperChatPanel();
  paperChatPanelEl?.classList.toggle('hidden', shouldHide);
  btnShowPaperChat?.classList.toggle('hidden', !isLiteratureMode() || !paperChatCollapsed || autoHidden);
  btnTogglePaperChatToolbar?.classList.toggle('hidden', !isLiteratureMode());
  btnTogglePaperChatToolbar?.classList.toggle('active', isLiteratureMode() && !shouldHide);
  if (btnTogglePaperChatToolbar) {
    btnTogglePaperChatToolbar.disabled = autoHidden;
    btnTogglePaperChatToolbar.title = autoHidden
      ? '当前窗口过窄，文献对话已自动隐藏'
      : (paperChatCollapsed ? '展开文献对话' : '折叠文献对话');
  }
  if (btnTogglePaperChat) {
    btnTogglePaperChat.textContent = paperChatCollapsed ? '已折叠' : '折叠';
    btnTogglePaperChat.disabled = autoHidden;
    btnTogglePaperChat.title = autoHidden ? '当前窗口过窄，文献对话已自动隐藏' : '折叠文献对话';
  }
  if (!paperChatResizerEl) return;
  paperChatResizerEl.classList.toggle('hidden', shouldHide);
}

function setupPaperChatResizer() {
  if (!paperChatResizerEl || !paperChatPanelEl || !contentArea) return;

  paperChatCollapsed = loadPaperChatCollapsed();
  applyPaperChatPanelWidth(loadPaperChatPanelWidth());
  syncPaperChatResizerVisibility();
  requestAnimationFrame(() => {
    applyPaperChatPanelWidth(loadPaperChatPanelWidth());
    syncPaperChatResizerVisibility();
  });

  let dragging = false;

  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    contentArea.classList.remove('is-resizing');
  };

  const handleMove = (event) => {
    if (!dragging) return;
    const rect = contentArea.getBoundingClientRect();
    const nextWidth = rect.right - event.clientX;
    applyPaperChatPanelWidth(nextWidth, { persist: true });
  };

  paperChatResizerEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    contentArea.classList.add('is-resizing');
    paperChatResizerEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  paperChatResizerEl.addEventListener('pointermove', handleMove);
  paperChatResizerEl.addEventListener('pointerup', (event) => {
    paperChatResizerEl.releasePointerCapture?.(event.pointerId);
    finishDrag();
  });
  paperChatResizerEl.addEventListener('pointercancel', finishDrag);
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('resize', () => {
    applyPaperChatPanelWidth(loadPaperChatPanelWidth());
    syncPaperChatResizerVisibility();
  });
}

function setupTranslationEvents() {
  const event = window.__TAURI__?.event;
  if (!event?.listen) return;
  event.listen('translation-progress', (e) => {
    const p = e.payload || {};
    const id = p.entry_id;
    if (!id) return;

    if (p.kind === 'start') {
      applyEntryUpdate(id, x => {
        if (p.field === 'title') x._titleTranslating = true;
        else if (p.field === 'summary') x._summaryTranslating = true;
        x._transError = null;
      });
    } else if (p.kind === 'done') {
      applyEntryUpdate(id, x => {
        if (p.field === 'title') {
          x.title_translated = p.text;
          x._titleTranslating = false;
        } else if (p.field === 'summary') {
          x.summary_translated = p.text;
          x._summaryTranslating = false;
        }
        x._transError = null;
      });
      if (p.text) addTranslationCost(p.text.length);
    } else if (p.kind === 'error') {
      applyEntryUpdate(id, x => {
        if (p.field === 'title') x._titleTranslating = false;
        else if (p.field === 'summary') x._summaryTranslating = false;
        x._transError = p.error || '翻译失败';
      });
    } else if (p.kind === 'summary_fetched') {
      applyEntryUpdate(id, x => {
        x.summary = p.summary;
        x.summary_source = p.source;
      });
    }

    updateRenderedTranslationEntry(id);
    updateOverviewCounts();
    if (currentEntry && currentEntry.id === id) {
      // Re-render only the parts that changed instead of resetting the panel
      renderDetailTitle(currentEntry);
      refreshDetailTitleSpinner(currentEntry);
      const aiFooter = document.getElementById('detail-ai-footer');
      if (currentEntry.title_translated || currentEntry.summary_translated) {
        aiFooter?.classList.remove('hidden');
      }
      if (currentEntry.summary_translated) {
        detailSourceBadge.textContent = '已翻译';
        detailBadgeRow.classList.remove('hidden');
      } else {
        detailBadgeRow.classList.add('hidden');
      }
      renderSummary(currentEntry);
    }
  });

  // Pipeline-level status: surfaces "needs API Key" / "API Key invalid"
  // as a persistent banner at the top of the main view. Cleared once a
  // healthy translation run finishes (status: "ok").
  event.listen('translation-status', (e) => {
    const p = e.payload || {};
    if (p.status === 'needs_key') {
      showTranslationBanner({
        kind: 'needs_key',
        text: `检测到 ${p.pending || ''} 篇待翻译文章，但未配置当前 AI 服务的 API Key。前往设置填写后会自动翻译。`,
      });
    } else if (p.status === 'auth_failed') {
      showTranslationBanner({
        kind: 'auth_failed',
        text: `当前 AI 服务的 API Key 无效或已过期，请打开设置重新填写并测试连接。${p.message ? `（${p.message}）` : ''}`,
      });
    } else if (p.status === 'ok') {
      hideTranslationBanner();
    }
  });
}

/// Persistent banner pinned to the top of the main view. We surface it from
/// pipeline-level translation status events — per-entry error pills are too
/// easy to miss when the user is browsing the list.
function showTranslationBanner({ kind, text }) {
  const banner = document.getElementById('translation-status-banner');
  if (!banner) return;
  banner.dataset.kind = kind;
  const textEl = banner.querySelector('.tsb-text');
  if (textEl) textEl.textContent = text;
  banner.classList.remove('hidden');
}
function hideTranslationBanner() {
  const banner = document.getElementById('translation-status-banner');
  if (!banner) return;
  banner.classList.add('hidden');
  banner.dataset.kind = '';
}

function wireTranslationBannerButtons() {
  const goSettings = document.getElementById('tsb-go-settings');
  const dismiss = document.getElementById('tsb-dismiss');
  goSettings?.addEventListener('click', () => {
    showSettings('translation');
    // Once the user lands in the right place, the banner has served its
    // purpose — clear it so they don't see two reminders.
    hideTranslationBanner();
  });
  dismiss?.addEventListener('click', hideTranslationBanner);
}

let latestUpdateInfo = null;
let downloadedUpdatePath = null;
let downloadedUpdateVersion = null;
let updateDownloadInFlight = false;

// ── Update channel (settings → 其他设置) ───────
// Loads the bundled version into the "关于 Cento" card and wires the
// "检查更新" button + auto-check toggle. The backend already runs a weekly
// check on its own — the UI here is for surfacing results and giving the
// user a manual override.
async function initUpdateChannel() {
  const versionEl = document.getElementById('about-version');
  const statusEl = document.getElementById('update-status');
  const metaEl = document.getElementById('update-meta');
  const btnCheck = document.getElementById('btn-check-update');
  const actionsEl = document.getElementById('update-actions');
  const btnDownload = document.getElementById('btn-download-update');
  const btnRelease = document.getElementById('btn-view-release');
  const toggleAuto = document.getElementById('update-auto-check');
  if (!versionEl) return;

  // Current version + last-check timestamp.
  try {
    const v = await invoke('get_app_version');
    versionEl.textContent = `v${v}`;
  } catch (e) {
    versionEl.textContent = '未知';
  }
  try {
    const prefs = await invoke('get_update_prefs');
    if (toggleAuto) toggleAuto.classList.toggle('on', prefs.auto_check_enabled);
    if (prefs.last_checked_at && metaEl) {
      metaEl.textContent = `上次检查：${formatLocalTime(prefs.last_checked_at)}`;
    }
  } catch (e) {
    // First-run with no settings row yet — toggle defaults to "on" via HTML.
  }

  btnCheck?.addEventListener('click', async () => {
    btnCheck.disabled = true;
    const orig = btnCheck.textContent;
    btnCheck.innerHTML = '<span class="spinner"></span> 检查中…';
    statusEl.classList.remove('has-update');
    statusEl.textContent = '正在访问 GitHub…';
    try {
      const info = await invoke('check_for_update');
      renderUpdateResult(info, { statusEl, actionsEl, btnDownload, btnRelease });
      if (metaEl) metaEl.textContent = `上次检查：${formatLocalTime(new Date().toISOString())}`;
    } catch (e) {
      const msg = (typeof e === 'string') ? e : (e && e.message) || String(e);
      statusEl.textContent = `检查失败：${msg}`;
      actionsEl?.classList.add('hidden');
    } finally {
      btnCheck.disabled = false;
      btnCheck.textContent = orig;
    }
  });

  btnDownload?.addEventListener('click', async () => {
    if (!latestUpdateInfo) return;

    if (downloadedUpdatePath && downloadedUpdateVersion === latestUpdateInfo.latest_version) {
      try {
        await invoke('open_downloaded_update', { path: downloadedUpdatePath });
      } catch (e) {
        downloadedUpdatePath = null;
        downloadedUpdateVersion = null;
        renderUpdateResult(latestUpdateInfo, { statusEl, actionsEl, btnDownload, btnRelease });
        const msg = (typeof e === 'string') ? e : (e && e.message) || String(e);
        statusEl.textContent = `打开安装包失败：${msg}`;
      }
      return;
    }

    if (!latestUpdateInfo.asset_url) {
      try {
        await invoke('open_url', { url: latestUpdateInfo.release_url });
      } catch (e) {
        const msg = (typeof e === 'string') ? e : (e && e.message) || String(e);
        statusEl.textContent = `无法打开发布页：${msg}`;
      }
      return;
    }

    updateDownloadInFlight = true;
    renderUpdateResult(latestUpdateInfo, { statusEl, actionsEl, btnDownload, btnRelease });
    statusEl.classList.remove('has-update');
    statusEl.textContent = '正在下载更新包…';
    try {
      const result = await invoke('download_update_installer');
      downloadedUpdatePath = result.local_path;
      downloadedUpdateVersion = latestUpdateInfo.latest_version;
      updateDownloadInFlight = false;
      renderUpdateResult(latestUpdateInfo, { statusEl, actionsEl, btnDownload, btnRelease });
      statusEl.textContent = `安装包已下载完成：${result.file_name}`;

      const shouldOpen = window.confirm(
        `更新包已下载完成：${result.file_name}\n\n现在打开安装包吗？`
      );
      if (shouldOpen) {
        await invoke('open_downloaded_update', { path: result.local_path });
      } else {
        await invoke('reveal_downloaded_update', { path: result.local_path });
      }
    } catch (e) {
      updateDownloadInFlight = false;
      renderUpdateResult(latestUpdateInfo, { statusEl, actionsEl, btnDownload, btnRelease });
      const msg = (typeof e === 'string') ? e : (e && e.message) || String(e);
      statusEl.textContent = `下载失败：${msg}`;
    }
  });

  toggleAuto?.addEventListener('click', async () => {
    // Optimistic toggle so the click feels instant; the backend round-trip
    // rolls it back only if saving fails.
    const wantOn = !toggleAuto.classList.contains('on');
    toggleAuto.classList.toggle('on', wantOn);
    try {
      await invoke('set_update_auto_check', { enabled: wantOn });
    } catch (e) {
      toggleAuto.classList.toggle('on', !wantOn);
      console.warn('保存自动检查偏好失败:', e);
    }
  });

  // Reflect background-checker results live without the user clicking.
  const evt = window.__TAURI__?.event;
  evt?.listen?.('update-download-progress', (e) => {
    if (!updateDownloadInFlight) return;
    const p = e.payload || {};
    const percent = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : null;
    if (btnDownload) {
      btnDownload.textContent = percent != null
        ? `下载中 ${Math.round(percent)}%`
        : '下载中…';
    }
    if (statusEl) {
      statusEl.textContent = percent != null
        ? `正在下载更新包… ${Math.round(percent)}%`
        : `正在下载更新包… ${formatBytes(p.downloaded_bytes || 0)}`;
    }
  });
  evt?.listen?.('update-checked', (e) => {
    const info = e.payload || {};
    renderUpdateResult(info, { statusEl, actionsEl, btnDownload, btnRelease });
    if (metaEl) metaEl.textContent = `上次检查：${formatLocalTime(new Date().toISOString())}`;
  });
}

function renderUpdateResult(info, { statusEl, actionsEl, btnDownload, btnRelease }) {
  if (!info || !statusEl) return;
  latestUpdateInfo = info;
  if (downloadedUpdateVersion && downloadedUpdateVersion !== info.latest_version) {
    downloadedUpdatePath = null;
    downloadedUpdateVersion = null;
  }
  if (info.source_available === false) {
    statusEl.classList.remove('has-update');
    statusEl.textContent = '更新源暂不可用，请稍后重试或检查发布仓库';
    actionsEl?.classList.add('hidden');
  } else if (info.has_update) {
    statusEl.classList.add('has-update');
    statusEl.textContent = `🎉 新版本 v${info.latest_version} 已发布（当前 v${info.current_version}）`;
    if (actionsEl) {
      actionsEl.classList.remove('hidden');
      if (btnDownload) {
        if (downloadedUpdatePath && downloadedUpdateVersion === info.latest_version) {
          btnDownload.textContent = '打开安装包';
        } else if (updateDownloadInFlight && info.asset_url) {
          btnDownload.textContent = '下载中…';
        } else {
          btnDownload.textContent = info.asset_url ? '下载安装包' : '前往下载页';
        }
        btnDownload.disabled = updateDownloadInFlight;
      }
      if (btnRelease) btnRelease.href = info.release_url;
    }
  } else {
    downloadedUpdatePath = null;
    downloadedUpdateVersion = null;
    statusEl.classList.remove('has-update');
    statusEl.textContent = `已是最新版（v${info.current_version}）`;
    actionsEl?.classList.add('hidden');
  }
}

function formatLocalTime(iso) {
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// macOS native notification via tauri-plugin-notification. Permission is
// requested lazily on first use; subsequent calls reuse the granted permission.
let notificationPermissionGranted = null;

// Proactively request notification permission once the webview is alive so
// the Rust-side scheduler can fire banners without first needing the user to
// click the "test notification" button. macOS won't deliver Rust-initiated
// notifications until the bundle has been authorized at least once.
async function ensureNotificationPermission() {
  const notif = window.__TAURI__?.notification;
  if (!notif) return false;
  try {
    if (await notif.isPermissionGranted()) {
      notificationPermissionGranted = true;
      return true;
    }
    const perm = await notif.requestPermission();
    notificationPermissionGranted = perm === 'granted';
    return notificationPermissionGranted;
  } catch (e) {
    console.warn('notification permission request failed:', e);
    return false;
  }
}
async function sendDesktopNotification(title, body) {
  const notif = window.__TAURI__?.notification;
  if (!notif) {
    console.warn('notification plugin unavailable');
    return { ok: false, reason: 'plugin-missing' };
  }
  try {
    if (notificationPermissionGranted === null) {
      notificationPermissionGranted = await notif.isPermissionGranted();
      if (!notificationPermissionGranted) {
        const perm = await notif.requestPermission();
        notificationPermissionGranted = perm === 'granted';
      }
    }
    if (!notificationPermissionGranted) {
      return { ok: false, reason: 'denied' };
    }
    await notif.sendNotification({ title, body });
    return { ok: true };
  } catch (e) {
    console.warn('notification failed:', e);
    return { ok: false, reason: String(e) };
  }
}

// ── Tray icon ───────────────────────────────────
function trayVisiblePref() {
  return localStorage.getItem('tray-visible') !== '0'; // default ON
}
function setTrayVisiblePref(on) {
  localStorage.setItem('tray-visible', on ? '1' : '0');
}
async function applyTrayVisibility(visible) {
  try { await invoke('set_tray_visible', { visible }); }
  catch (e) { console.warn('set_tray_visible failed:', e); }
}
async function pushTrayUnread() {
  const count = globalEntries.filter(e => !e.is_read).length;
  try { await invoke('update_tray_unread', { count }); }
  catch (e) { /* tray may be off, ignore */ }
}

// ── Refresh ────────────────────────────────────
async function refreshAll() {
  btnRefresh.disabled = true;
  refreshIcon.style.animation = 'spin 0.8s linear infinite';
  setGlobalStatus('正在刷新…', 'progress');
  try {
    const result = await invoke('fetch_all_feeds');
    let msg = `完成：${result.total_feeds} 个源`;
    if (result.new_entries > 0) msg += `，新增 ${result.new_entries} 篇 · 正在自动翻译…`;
    else msg += '，没有新文章';
    if (result.errors.length > 0) msg += `，${result.errors.length} 个问题`;
    setGlobalStatus(msg, 'success');

    // Notifications are fired by the Rust backend for any feed with notify=1,
    // so the frontend doesn't dispatch them here anymore.

    await loadFeeds();
    const query = literatureSearchInput?.value.trim() || '';
    if (mode === 'search' && query) await runLiteratureSearch(query);
    else await loadEntries(selectedFeedId);
  } catch (e) {
    setGlobalStatus('刷新失败: ' + e, 'error');
  } finally {
    btnRefresh.disabled = false;
    refreshIcon.style.animation = '';
  }
}

// Background refresh is handled by the Rust scheduler in src-tauri/src/services/scheduler.rs.
// It runs whenever the app process is alive — even when the window is hidden in the
// tray — and emits a `scheduler-refreshed` event when it picks up new entries.
function startSchedulerListener() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  listen('scheduler-refreshed', async () => {
    await loadFeeds();
    const query = literatureSearchInput?.value.trim() || '';
    if (mode === 'search' && query) await runLiteratureSearch(query);
    else await loadEntries(selectedFeedId);
  });
}

// ── Briefing mode ──────────────────────────────
// Mirrors `DEFAULT_BRIEFING_GUIDANCE` in src-tauri/src/services/briefing_service.rs.
// What the user sees in the Prompt editor matches what the backend would send if
// they hadn't customized it.  The JSON output-schema requirement isn't shown
// here — it's appended by the backend regardless, so the user can't accidentally
// break parsing by editing the prompt.
const DEFAULT_BRIEFING_PROMPT =
`你是一位资深的科技报道编辑，专长是把一周内的前沿学术文献整理成面向研究者的高质量中文综述。请阅读用户提供的文献（标题、来源期刊、摘要），把它们汇总成一份**结构清晰、信息密度高、可读性强**的中文文献简报，写作风格参考《Nature Briefing》《知社学术圈》等科技前沿报道。

## 整体结构

1. **开篇导语（2-3 句）**：概括本期主线 —— 哪些方向延续了上期的热度、出现了哪些值得关注的新动向、整体脉络是什么。简练有力，避免套话。

2. **按主题分组**：将文献按研究方向归类，例如「机器学习与预后建模」「生物标志物与诊断」「治疗策略与临床试验」「新机制与基础研究」「单细胞 / 空间转录组」等。每组 2-5 条 bullet，组数控制在 3-6 个。使用 \`## \` Markdown 标题。

3. **每条 bullet 40-80 字**，必须包含：
   - 一句话核心发现
   - **关键数值**：AUC、HR、95% CI、样本量、p-value、效应量等具体指标（如原文有则必须保留）
   - **方法 / 创新点**：使用了什么方法、相比已有研究有什么突破
   - 在 bullet 末尾用 \`[n]\` 标注对应文献编号

4. **💡 重点关注**（一个 \`### \` 小节）：选出本期最值得关注的 1-3 篇文献，每篇 100-150 字，按以下顺序展开：
   - 研究背景与目标（1 句）
   - 主要方法（1-2 句）
   - 关键结果（带具体数值，1-2 句）
   - 临床 / 学术意义（1 句）

5. **趋势与启发**（一个 \`## \` 小节）：从本期文献中提炼出 1-3 个跨研究的趋势或启发，比如：
   - 多篇论文是否都指向某个新兴方向？
   - 某个方法学（如单细胞测序、扩散模型、多模态学习）是否被多个团队同时采用？
   - 对临床转化或下一步研究的启发是什么？
   每点 1-2 句，给出**具体**判断而不是泛泛而谈。

6. **参考文献**（一个 \`## \` 小节，放在正文最末）：按 \`[n]\` 编号顺序列出本期被引用过的全部文献，使用 Markdown 链接 \`[原文标题](URL)\` 形式直跳原文。格式示例：
   - \`[1] [原文标题](https://...) — 期刊名\`
   每条 1 行，不要重复摘要内容。URL 严格使用用户提供数据中的"链接"字段，禁止编造或猜测。

## 风格要求

- 专业但不晦涩的中文，技术名词保留英文（PD-L1、CTLA-4、ResNet、GPT-4 等）
- 数据具体到数字，论断必须有文献支撑
- 避免「重要」「突破性」「划时代」「革命性」等空泛词；用具体的数值和对比代替
- 不添加原文没有的信息或主观评价
- Markdown 格式：\`##\` 主题分组、\`###\` 重点关注与趋势启发、\`-\` bullet、\`**加粗**\` 突出关键词与数值
- 整体长度 600-1200 字（取决于文献数量）`;

let BRIEFINGS = [];      // populated dynamically from backend or sample
let readBriefings = new Set(JSON.parse(localStorage.getItem('read-briefings') || '[]'));

function persistReadBriefings() {
  localStorage.setItem('read-briefings', JSON.stringify([...readBriefings]));
}

async function loadBriefings() {
  try {
    BRIEFINGS = await invoke('list_briefings');
  } catch {
    BRIEFINGS = [];
  }
  restoreBriefingSort();
  syncBriefingSortControl();
  renderBriefingList();
  updateOverviewCounts();
}

function enterBriefingMode(options = {}) {
  const preserveSearch = !!options.preserveSearch;
  if (!preserveSearch) cancelLiteratureSearchForNavigation();
  mode = 'briefing';
  currentPubmedSearch = null;
  document.body.classList.remove('pubmed-mode');
  pubmedBatchHeader?.classList.add('hidden');
  entryListEl.classList.add('hidden');
  detailPanelEl.classList.add('hidden');
  syncPaperChatResizerVisibility();
  briefingListEl.classList.remove('hidden');
  briefingDetailEl.classList.remove('hidden');
  applyListPanelWidth(loadListPanelWidth());
  document.querySelectorAll('.feed-item').forEach(el => el.classList.remove('selected'));
  syncEntryFilterControls();
  setToolbarSubtitle('briefing');
  renderBriefingList();
  const visibleBriefings = filteredBriefingsForCurrentQuery();
  if (visibleBriefings.length > 0) {
    const target = selectedBriefingId && visibleBriefings.find(b => b.id === selectedBriefingId)
      ? selectedBriefingId
      : visibleBriefings[0].id;
    selectBriefing(target);
  } else {
    showBriefingEmpty();
  }
}

function enterFeedMode() {
  mode = 'feed';
  currentPubmedSearch = null;
  document.body.classList.remove('pubmed-mode');
  pubmedBatchHeader?.classList.add('hidden');
  briefingListEl.classList.add('hidden');
  briefingDetailEl.classList.add('hidden');
  entryListEl.classList.remove('hidden');
  detailPanelEl.classList.remove('hidden');
  applyListPanelWidth(loadListPanelWidth());
  applyPaperChatPanelWidth(loadPaperChatPanelWidth());
  syncPaperChatResizerVisibility();
  syncEntryFilterControls();
  renderPubmedSearchList();
}

function briefingMatchesLiteratureSearchQuery(briefing, query) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [
    briefing.title,
    briefing.lead_in,
    briefing.leadIn,
    briefing.period,
    briefing.date,
    briefing.content,
  ].filter(Boolean).join('\n').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

function filteredBriefingsForCurrentQuery() {
  const query = literatureSearchInput?.value.trim() || '';
  const filtered = query ? BRIEFINGS.filter(briefing => briefingMatchesLiteratureSearchQuery(briefing, query)) : BRIEFINGS;
  const direction = briefingSortDirectionMode === 'asc' ? 1 : -1;
  return [...filtered].sort((left, right) => {
    if (briefingSortField === 'count') {
      return ((left.counts?.articles || 0) - (right.counts?.articles || 0)) * direction;
    }
    const leftDate = Date.parse(left.date || left.created_at || left.generated_at || '') || 0;
    const rightDate = Date.parse(right.date || right.created_at || right.generated_at || '') || 0;
    return (leftDate - rightDate) * direction;
  });
}

function persistBriefingSort() {
  try {
    localStorage.setItem(BRIEFING_SORT_STORAGE_KEY, `${briefingSortField}-${briefingSortDirectionMode}`);
  } catch (error) {
    console.warn('保存简报排序失败:', error);
  }
}

function restoreBriefingSort() {
  try {
    const [field, direction] = String(localStorage.getItem(BRIEFING_SORT_STORAGE_KEY) || 'date-desc').split('-');
    briefingSortField = ['date', 'count'].includes(field) ? field : 'date';
    briefingSortDirectionMode = direction === 'asc' ? 'asc' : 'desc';
  } catch {
    briefingSortField = 'date';
    briefingSortDirectionMode = 'desc';
  }
}

function syncBriefingSortControl() {
  if (briefingSortSelect) briefingSortSelect.value = briefingSortField;
  if (briefingSortDirection) {
    const isAscending = briefingSortDirectionMode === 'asc';
    briefingSortDirection.setAttribute('aria-pressed', String(isAscending));
    briefingSortDirection.title = isAscending ? '当前为升序，点击切换为降序' : '当前为降序，点击切换为升序';
    briefingSortDirection.querySelector('.entry-sort-direction-label').textContent = isAscending ? '↑' : '↓';
  }
}

function renderBriefingList() {
  if (!briefingItemsEl) return;
  syncBriefingSortControl();
  briefingItemsEl.innerHTML = '';

  const visibleBriefings = filteredBriefingsForCurrentQuery();
  const query = literatureSearchInput?.value.trim() || '';

  if (visibleBriefings.length === 0) {
    if (query && BRIEFINGS.length > 0) {
      briefingItemsEl.innerHTML = `
        <li class="entry-empty">
          未找到与“${escapeHtml(query)}”匹配的简报
        </li>`;
      return;
    }
    briefingItemsEl.innerHTML = `
      <li class="entry-empty">
        <div style="margin-bottom: 12px;">还没有生成简报</div>
        <div style="font-size: 11.5px; color: var(--text-tertiary); line-height: 1.6;">点击右上角「立即生成」按需创建，或在「设置 → AI 简报」配置自动生成频率。</div>
      </li>`;
    return;
  }

  visibleBriefings.forEach(b => {
    const li = document.createElement('li');
    const isRead = readBriefings.has(b.id);
    li.className = `briefing-item ${isRead ? 'read' : 'unread'}`;
    if (selectedBriefingId === b.id) li.classList.add('selected');
    li.dataset.briefingId = b.id;
    li.innerHTML = `
      <div class="briefing-dot-col"><span class="briefing-dot"></span></div>
      <div class="briefing-body">
        <div class="briefing-meta-top">
          <span class="briefing-period">${escapeHtml(b.period || '')}</span>
          <span class="briefing-counts">${(b.counts?.articles || 0)} 篇 · ${(b.counts?.feeds || 0)} 个来源</span>
        </div>
        <div class="briefing-title">${escapeHtml(b.title || '')}</div>
        <div class="briefing-leadin">${escapeHtml(b.lead_in || b.leadIn || '')}</div>
      </div>
    `;
    li.addEventListener('click', () => selectBriefing(b.id));
    li.addEventListener('contextmenu', e => {
      e.preventDefault();
      showBriefingContextMenu(e.clientX, e.clientY, b);
    });
    briefingItemsEl.appendChild(li);
  });

  // Footer
  const nextDate = computeNextBriefingDate();
  const footer = document.createElement('div');
  footer.className = 'briefing-list-footer';
  footer.innerHTML = `下次简报将在 <span class="briefing-next-date">${nextDate}</span> 自动生成`;
  briefingItemsEl.appendChild(footer);
}

// CommonMark/GFM-style Markdown renderer shared by briefings, reading notes,
// and paper-chat answers. Raw HTML is permitted, but always sanitized before
// insertion into the DOM.
function renderBriefingMarkdown(md) {
  if (!md) return '<div class="briefing-md"></div>';
  if (!markdownRenderer) {
    return `<div class="briefing-md"><p>${escapeHtml(md)}</p></div>`;
  }
  const rendered = markdownRenderer.render(md);
  return `<div class="briefing-md">${decorateMarkdownHtml(rendered)}</div>`;
}

function selectBriefing(id) {
  selectedBriefingId = id;
  const b = BRIEFINGS.find(x => x.id === id);
  if (!b) { showBriefingEmpty(); return; }

  // Mark as read on click (matches entry-list behavior).
  if (!readBriefings.has(id)) {
    readBriefings.add(id);
    persistReadBriefings();
    updateOverviewCounts();
  }

  // Re-render the list so both `.selected` and `.read` classes get applied
  // from the central `renderBriefingList`. The previous approach (manual
  // `classList.toggle` against `el.dataset.briefingId === id`) silently
  // failed: dataset values are strings ("1") but `id` is a number (1), so
  // `"1" === 1` is `false` — the floating-card styling was correct but
  // never actually applied.
  renderBriefingList();

  briefingDetailEmpty.classList.add('hidden');
  briefingDetailContent.classList.remove('hidden');

  document.getElementById('briefing-detail-date').textContent = b.date || '';
  document.getElementById('briefing-detail-eyebrow').innerHTML = `
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2"/></svg>
    <span>${escapeHtml(b.period || '')}</span>
    <span style="opacity:0.6">·</span>
    <span>${(b.counts?.articles || 0)} 篇文献</span>
  `;
  document.getElementById('briefing-detail-title').textContent = b.title || '';
  document.getElementById('briefing-detail-leadin').textContent = b.lead_in || b.leadIn || '';

  // Render the briefing body. The backend returns `content` as a Markdown
  // string per the new prompt format; this used to iterate `b.sections`,
  // which was a mock-data shape that never matched the live API. That's why
  // briefings were rendering as title + lead-in only with no body.
  const sectionsEl = document.getElementById('briefing-detail-sections');
  sectionsEl.innerHTML = renderBriefingMarkdown(b.content || '');
  // Delegate clicks on inline reference links so they open in the system
  // browser via `open_url`, matching how article links behave elsewhere.
  // Without this the Tauri webview either swallows the click or opens the
  // URL inside a new app window.
  if (!sectionsEl.dataset.linkDelegateBound) {
    sectionsEl.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-open-url]');
      if (!a) return;
      e.preventDefault();
      openUrl(a.dataset.openUrl);
    });
    sectionsEl.dataset.linkDelegateBound = '1';
  }

  const providerMeta = AI_PROVIDER_META[activeProviderId()] || AI_PROVIDER_META.deepseek;
  const modelName = activeModelDisplayName();
  document.getElementById('briefing-detail-footer-text').innerHTML =
    `<span class="ai-footer-strong">由 ${escapeHtml(providerMeta.label)} · ${escapeHtml(modelName)} 生成</span>，覆盖 ${(b.counts?.feeds || 0)} 个订阅源、${(b.counts?.articles || 0)} 篇文献。可在「AI 简报」设置调整频率与 Prompt。`;
}

function showBriefingEmpty() {
  briefingDetailEmpty.classList.remove('hidden');
  briefingDetailContent.classList.add('hidden');
}

async function jumpToArticle(articleId) {
  const article = allEntries.concat(globalEntries).find(e => e.id === articleId);
  if (!article) return;
  enterFeedMode();
  selectFeed(article.feed_id);
  await delay(80);
  const updated = allEntries.find(e => e.id === articleId) || article;
  showDetail(updated);
  if (!updated.is_read) await setEntryRead(updated, true);
}

function computeNextBriefingDate() {
  const freq = localStorage.getItem('briefing-frequency') || 'weekly';
  const hour = localStorage.getItem('briefing-hour') || '09:00';
  const day = localStorage.getItem('briefing-day') || 'mon';
  const now = new Date();
  const [hh, mm] = hour.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (freq === 'daily') {
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (freq === 'weekly') {
    const dayMap = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
    const target = dayMap[day] ?? 1;
    while (next.getDay() !== target || next <= now) next.setDate(next.getDate() + 1);
  } else if (freq === 'biweekly') {
    next.setDate(next.getDate() + 14);
  } else if (freq === 'monthly') {
    next.setMonth(next.getMonth() + 1);
  }
  return `${next.getFullYear()}/${next.getMonth()+1}/${next.getDate()} ${hour}`;
}

// Module-scoped flag so a generation in flight blocks both
//   (a) repeat clicks on the "立即生成" button, and
//   (b) a scheduler tick that fires while a manual run is mid-flight.
// The backend has its own AtomicBool guard which is the source of truth; this
// client-side flag is the UX layer that lets us toggle the button label.
let briefingInFlight = false;

async function generateBriefingNow() {
  if (briefingInFlight) {
    // User clicked again before the previous call finished. Silently no-op
    // rather than queueing — duplicate briefings were the original bug.
    return;
  }
  briefingInFlight = true;

  const btn = document.getElementById('btn-generate-briefing');
  const originalBtnHTML = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.innerHTML = '<span class="spinner"></span> 生成中…';
  }

  setGlobalStatus('正在生成简报…', 'progress');
  // Stamp last-attempt so the scheduler doesn't retry the same failure every
  // tick — wait at least an hour after a failure to try again.
  localStorage.setItem('briefing-last-attempt', String(Date.now()));
  // Pass the user's edited prompt through. The backend appends the JSON
  // output-schema part on its own, so the user can edit the editorial
  // direction freely without breaking parsing.
  const customPrompt = localStorage.getItem('briefing-prompt') || null;
  const expectedFrequency = localStorage.getItem('briefing-frequency') || 'weekly';
  try {
    const b = await invoke('generate_briefing', { customPrompt, expectedFrequency });
    loadCostSummary();
    setGlobalStatus('简报已生成', 'success');
    await loadBriefings();
    if (b) selectBriefing(b.id);
  } catch (e) {
    setGlobalStatus('简报生成失败: ' + e, 'error');
  } finally {
    briefingInFlight = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      if (originalBtnHTML != null) btn.innerHTML = originalBtnHTML;
    }
  }
}

// ── Briefing auto-scheduler ─────────────────────
// Briefing settings live in localStorage (briefing-enabled / -frequency /
// -day / -hour). This watcher reads them on a low-frequency timer and fires
// generateBriefingNow() when the most recent expected firing time is later
// than the most recent successful briefing.
//
// Why frontend instead of the Rust scheduler: the settings are in
// localStorage and migrating them to SQLite would be a bigger refactor.
// The Tauri webview keeps running in the background even when the window is
// hidden (it's a webview process, not a tab), so this fires reliably.
function computeMostRecentExpectedFiring(freq, hour, day) {
  const [hh, mm] = (hour || '09:00').split(':').map(Number);
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hh, mm, 0, 0);
  if (freq === 'daily') {
    if (candidate > now) candidate.setDate(candidate.getDate() - 1);
    return candidate;
  }
  if (freq === 'weekly') {
    const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const target = dayMap[day] ?? 1;
    // Walk backward to the most recent occurrence of `target` weekday at `hour`
    while (candidate.getDay() !== target || candidate > now) {
      candidate.setDate(candidate.getDate() - 1);
    }
    return candidate;
  }
  if (freq === 'biweekly') {
    // Same wall-clock + weekday as `weekly`, but require ≥14 days since last.
    // For "due" purposes we just use the most recent same-weekday/hour and
    // rely on the lastBriefingAt comparison to enforce the 14-day gap.
    const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const target = dayMap[day] ?? 1;
    while (candidate.getDay() !== target || candidate > now) {
      candidate.setDate(candidate.getDate() - 1);
    }
    return candidate;
  }
  if (freq === 'monthly') {
    // Most recent occurrence of the configured hour, no day-of-week constraint.
    if (candidate > now) candidate.setDate(candidate.getDate() - 1);
    return candidate;
  }
  return null;
}

// SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC with no
// timezone marker. JS would otherwise parse that as LOCAL time, making the
// stored timestamp look 8 hours stale in UTC+8 and causing the scheduler to
// "see" a just-generated briefing as still-overdue — the original duplicate
// bug. Force a UTC interpretation.
function parseDbUtc(s) {
  if (!s) return null;
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  return new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
}

// Mirrors `min_interval_secs` in briefing_service.rs. Keeps the scheduler
// from re-firing within the cadence window even if the wall-clock check
// above thinks it's "overdue".
function briefingMinIntervalMs(freq) {
  switch (freq) {
    case 'daily':    return 20 * 3600 * 1000;
    case 'weekly':   return 6 * 24 * 3600 * 1000;
    case 'biweekly': return 13 * 24 * 3600 * 1000;
    case 'monthly':  return 28 * 24 * 3600 * 1000;
    default:         return 6 * 24 * 3600 * 1000;
  }
}

function briefingSchedulerTick() {
  if (localStorage.getItem('briefing-enabled') === '0') return;
  // If a generation is already running (manual click or a previous tick that
  // hasn't returned), do not fire another one. Belt-and-suspenders: the
  // backend AtomicBool would reject the duplicate anyway, but bailing out
  // here keeps the spinner state coherent and avoids a misleading
  // "已有简报正在生成中" error in the status bar.
  if (briefingInFlight) return;

  const freq = localStorage.getItem('briefing-frequency') || 'weekly';
  const hour = localStorage.getItem('briefing-hour') || '09:00';
  const day  = localStorage.getItem('briefing-day')  || 'mon';

  const expected = computeMostRecentExpectedFiring(freq, hour, day);
  if (!expected) return;

  // Failure backoff: don't hammer the active provider after recent failures.
  const lastAttempt = parseInt(localStorage.getItem('briefing-last-attempt') || '0', 10);
  if (Date.now() - lastAttempt < 60 * 60 * 1000) return;

  const lastBriefingAt = parseDbUtc(BRIEFINGS[0]?.generated_at) || new Date(0);

  // Cadence guard: even if "expected" is in the past, refuse to fire if the
  // most recent briefing is younger than the cadence window. The backend
  // enforces this independently — this is the UX-side mirror so the user
  // doesn't see a confusing "距离上次生成不足" toast.
  const sinceLast = Date.now() - lastBriefingAt.getTime();
  if (sinceLast < briefingMinIntervalMs(freq)) return;

  if (lastBriefingAt < expected) {
    console.info('[briefing-scheduler] firing — last:', lastBriefingAt, 'expected:', expected);
    generateBriefingNow();
  }
}

function startBriefingScheduler() {
  // Run once on startup (after loadBriefings populates BRIEFINGS).
  // Then keep ticking every 5 minutes — briefings are heavyweight so we
  // don't need to check more often than that.
  setTimeout(briefingSchedulerTick, 8 * 1000);
  setInterval(briefingSchedulerTick, 5 * 60 * 1000);
}

// ── Feeds settings list (per-feed rows) ────────
function renderFeedSettingsList() {
  const body = document.getElementById('feeds-list-body');
  const header = document.getElementById('feeds-card-header');
  if (!body) return;
  header.textContent = `已订阅 · ${allFeeds.length}`;
  body.innerHTML = '';

  if (allFeeds.length === 0) {
    body.innerHTML = '<div style="font-size: 13px; color: var(--text-tertiary); padding: 8px 0;">暂无订阅源</div>';
    return;
  }

  allFeeds.forEach((feed, i) => {
    const row = document.createElement('div');
    row.className = 'feed-settings-row';
    row.dataset.feedId = feed.id;
    const emoji = feedEmoji(feed.id);
    const interval = feedInterval(feed.id);
    const notify = feedNotify(feed.id);
    const total = totalCountForFeed(feed.id);
    const pubmed = isPubmedFeed(feed);
    const source = feed.url.includes('pubmed') ? 'PubMed RSS' : 'RSS';

    row.innerHTML = `
      <button class="feed-settings-emoji" data-feed-id="${feed.id}" title="选择图标">${emoji}</button>
      <div class="feed-settings-info">
        <div class="feed-settings-name" data-feed-id="${feed.id}">${escapeHtml(feed.title || feed.url)}</div>
        <div class="feed-settings-source">${escapeHtml(source)} · ${total} 篇</div>
      </div>
      <select class="settings-select compact feed-settings-interval" data-feed-id="${feed.id}" title="刷新频率">
        <option value="15m">每 15 分钟</option>
        <option value="1h">每小时</option>
        <option value="12h">半天</option>
        <option value="1d">一天</option>
        <option value="3d">三天</option>
        <option value="1w">一周</option>
        <option value="manual">手动</option>
      </select>
      <button class="icon-btn feed-settings-notify ${notify ? 'active' : ''}" data-feed-id="${feed.id}" title="${notify ? '已开启该订阅源的桌面通知' : '该订阅源的桌面通知已关闭'}">
        ${notify
          ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 11.5h7.6L11 10.5V7.5a3 3 0 0 0-6 0v3z" fill="currentColor"/><path d="M6.8 13.2a1.2 1.2 0 0 0 2.4 0" fill="none"/></svg>`
          : `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 3.2 12.8 12.8"/><path d="M4.5 11.5h7L11 10.5V7.5a3 3 0 0 0-4.96-2.27"/><path d="M5 7.5v3L4.2 11.5"/><path d="M6.8 13.2a1.2 1.2 0 0 0 2.4 0"/></svg>`}
      </button>
      <button class="icon-btn feed-settings-rename-btn" data-feed-id="${feed.id}" title="${pubmed ? '编辑检索式和抓取数量' : '重命名'}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 2.8 2.7 2.7-7.8 7.8H2.7v-2.7Z"/><path d="m9.2 4.1 2.7 2.7"/></svg>
      </button>
      <button class="icon-btn danger feed-settings-delete" data-feed-id="${feed.id}" title="移除订阅">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.4 4.5V3.2h3.2v1.3M4.5 4.5l.6 8.2a.8.8 0 0 0 .8.7h4.2a.8.8 0 0 0 .8-.7l.6-8.2"/></svg>
      </button>
    `;

    body.appendChild(row);
    const sel = row.querySelector('.feed-settings-interval');
    sel.value = interval;
  });

  body.querySelectorAll('.feed-settings-emoji').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fid = parseInt(btn.dataset.feedId);
      openEmojiPicker(btn, fid, () => {
        renderFeedSettingsList();
        renderFeedList(allFeeds);
      });
    });
  });

  body.querySelectorAll('.feed-settings-interval').forEach(sel => {
    sel.addEventListener('change', async () => {
      const fid = parseInt(sel.dataset.feedId);
      const value = sel.value;
      try {
        await invoke('set_feed_interval', { id: fid, interval: value });
        const f = allFeeds.find(x => x.id === fid);
        if (f) f.refresh_interval = value;
      } catch (e) {
        console.warn('set_feed_interval failed:', e);
      }
    });
  });

  body.querySelectorAll('.feed-settings-notify').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fid = parseInt(btn.dataset.feedId);
      const next = !feedNotify(fid);
      try {
        await invoke('set_feed_notify', { id: fid, notify: next });
        const f = allFeeds.find(x => x.id === fid);
        if (f) f.notify = next;
      } catch (e) {
        console.warn('set_feed_notify failed:', e);
      }
      renderFeedSettingsList();
    });
  });

  body.querySelectorAll('.feed-settings-rename-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fid = parseInt(btn.dataset.feedId);
      const feed = allFeeds.find(x => x.id === fid);
      if (isPubmedFeed(feed)) {
        pubmedGeneratorApi?.beginEdit(feed);
        return;
      }
      const row = btn.closest('.feed-settings-row');
      const nameEl = row.querySelector('.feed-settings-name');
      if (!nameEl) return;
      const oldName = nameEl.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = oldName;
      input.className = 'feed-settings-rename';
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const finish = async (commit) => {
        const val = input.value.trim();
        if (commit && val && val !== oldName) {
          try { await invoke('rename_feed', { id: fid, name: val }); await loadFeeds(); }
          catch (err) { setGlobalStatus('重命名失败: ' + err, 'error'); }
        }
        renderFeedSettingsList();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    });
  });

  body.querySelectorAll('.feed-settings-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fid = parseInt(btn.dataset.feedId);
      if (await confirmDialog('确定删除该订阅源及其所有文章？')) deleteFeed(fid);
    });
  });
}

// ── PubMed RSS Generator ───────────────────────
function initPubmedGenerator() {
  const queryEl = document.getElementById('pubmed-query');
  const limitEl = document.getElementById('pubmed-limit');
  const nameEl  = document.getElementById('pubmed-feedname');
  const titleEl = document.getElementById('pubmed-card-title');
  const subtitleEl = document.getElementById('pubmed-card-subtitle');
  const legacyHintEl = document.getElementById('pubmed-query-legacy-hint');
  const previewLink    = document.getElementById('pubmed-preview-link');
  const idleEl   = document.getElementById('pubmed-actions-idle');
  const resultEl = document.getElementById('pubmed-result');
  const resultUrlEl = document.getElementById('pubmed-result-url');
  const resultEyebrow = document.getElementById('pubmed-result-eyebrow-text');
  const resultActionsEl = document.getElementById('pubmed-result-actions');
  const btnCancelEdit = document.getElementById('btn-pubmed-cancel-edit');
  const btnGenerate = document.getElementById('btn-pubmed-generate');
  const btnNl       = document.getElementById('btn-pubmed-nl');
  const btnCopy   = document.getElementById('btn-pubmed-copy');
  const btnAdd    = document.getElementById('btn-pubmed-add');
  if (!queryEl) return;

  let state = 'idle';
  let generatedUrl = '';
  let editingFeedId = null;
  let legacyQueryMissing = false;

  function generateButtonHtml() {
    const label = editingFeedId == null ? '生成 RSS 链接' : '重新生成 RSS 链接';
    return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2"/></svg> ${label}`;
  }

  function addButtonHtml() {
    const label = editingFeedId == null ? '添加到订阅源' : '保存修改';
    return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3.5" x2="8" y2="12.5" /><line x1="3.5" y1="8" x2="12.5" y2="8" /></svg> ${label}`;
  }

  function buildFullQuery() {
    return queryEl.value.trim();
  }

  function updatePreview() {
    const full = buildFullQuery();
    previewLink.href = full ? `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(full)}` : '#';
  }

  function syncLegacyQueryHint(config = null) {
    if (config && typeof config.missingStoredQuery === 'boolean') {
      legacyQueryMissing = config.missingStoredQuery;
    }
    if (!legacyHintEl) return;
    const show = !!(editingFeedId != null && legacyQueryMissing && !queryEl.value.trim());
    legacyHintEl.classList.toggle('hidden', !show);
  }

  function setLimitValue(limit) {
    const normalized = String(clampPubmedLimit(limit));
    limitEl.value = [...limitEl.options].some(opt => opt.value === normalized) ? normalized : '200';
  }

  function syncModeUi() {
    if (titleEl) {
      titleEl.innerHTML = editingFeedId == null
        ? 'PubMed RSS 生成器 <span class="pubmed-tag">NCBI</span>'
        : '编辑 PubMed 订阅 <span class="pubmed-tag">NCBI</span>';
    }
    if (subtitleEl) {
      subtitleEl.textContent = editingFeedId == null
        ? '用 PubMed 检索式生成 RSS 订阅链接，一键加入订阅列表'
        : '修改检索式或抓取数量后，重新生成并保存到当前订阅源';
    }
    if (btnCancelEdit) btnCancelEdit.classList.toggle('hidden', editingFeedId == null);
    btnGenerate.innerHTML = generateButtonHtml();
    btnAdd.innerHTML = addButtonHtml();
  }

  function reset() {
    state = 'idle';
    generatedUrl = '';
    resultEl.classList.add('hidden');
    resultEl.classList.remove('added');
    idleEl.style.display = 'flex';
    btnGenerate.disabled = false;
    resultActionsEl.style.display = 'none';
    syncModeUi();
    syncLegacyQueryHint();
  }

  function exitEditMode({ clearForm = false } = {}) {
    editingFeedId = null;
    legacyQueryMissing = false;
    if (clearForm) {
      queryEl.value = '';
      nameEl.value = '';
      setLimitValue(15);
      updatePreview();
    }
    reset();
  }

  function beginEdit(feed) {
    const config = parsePubmedFeedConfig(feed);
    if (!config) {
      setGlobalStatus('当前只支持编辑 PubMed RSS 订阅源的检索式和抓取数量', 'error');
      return;
    }

    editingFeedId = feed.id;
    queryEl.value = config.query;
    nameEl.value = config.title;
    setLimitValue(config.limit);
    updatePreview();
    reset();
    syncLegacyQueryHint(config);

    queryEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      queryEl.focus();
      queryEl.select();
    }, 80);
    setGlobalStatus(`已载入「${feed.title || 'PubMed 订阅'}」，修改后重新生成并保存`, 'success');
  }

  function currentPubmedLimit() {
    return clampPubmedLimit(limitEl.value);
  }

  queryEl.addEventListener('input', () => {
    updatePreview();
    syncLegacyQueryHint();
    if (state !== 'idle') reset();
  });
  limitEl.addEventListener('change', () => { if (state !== 'idle') reset(); });
  btnCancelEdit?.addEventListener('click', () => exitEditMode({ clearForm: true }));

  btnNl.addEventListener('click', async () => {
    const text = queryEl.value.trim();
    if (!text) {
      idleEl.style.display = 'none';
      resultEl.classList.remove('hidden');
      resultEl.classList.remove('added');
      resultUrlEl.style.color = 'var(--text-tertiary)';
      resultUrlEl.textContent = '请先在检索式输入框中输入检索需求描述';
      resultEyebrow.textContent = '提示';
      resultActionsEl.style.display = 'none';
      return;
    }
    const origHTML = btnNl.innerHTML;
    btnNl.disabled = true;
    btnNl.innerHTML = `<span class="spinner"></span> AI 生成中…`;
    try {
      const query = await invoke('natural_to_pubmed_query', { text });
      loadCostSummary();
      queryEl.value = query;
      updatePreview();
      state = 'idle';
      resultEl.classList.add('hidden');
      idleEl.style.display = 'flex';
    } catch (e) {
      idleEl.style.display = 'none';
      resultEl.classList.remove('hidden');
      resultEl.classList.remove('added');
      resultUrlEl.style.color = 'var(--text-secondary)';
      const msg = (typeof e === 'string') ? e : (e && e.message) || String(e);
      resultUrlEl.textContent = msg;
      resultEyebrow.textContent = 'AI 生成失败';
      resultActionsEl.style.display = 'none';
    } finally {
      btnNl.disabled = false;
      btnNl.innerHTML = origHTML;
    }
  });

  btnGenerate.addEventListener('click', async () => {
    const q = queryEl.value.trim();
    if (!q) {
      idleEl.style.display = 'none';
      resultEl.classList.remove('hidden');
      resultEl.classList.remove('added');
      resultUrlEl.style.color = 'var(--text-tertiary)';
      resultUrlEl.textContent = '请输入检索关键词';
      resultEyebrow.textContent = '提示';
      resultActionsEl.style.display = 'none';
      return;
    }
    state = 'generating';
    btnGenerate.disabled = true;
    btnGenerate.innerHTML = `<span class="spinner"></span> 生成中…`;
    try {
      const url = await invoke('build_pubmed_rss_url', {
        query: buildFullQuery(),
        limit: currentPubmedLimit(),
      });
      generatedUrl = url;
      state = 'ready';
      idleEl.style.display = 'none';
      resultEl.classList.remove('hidden');
      resultEl.classList.remove('added');
      resultUrlEl.style.color = '';
      resultUrlEl.textContent = url;
      resultActionsEl.style.display = 'flex';
      resultEyebrow.textContent = editingFeedId == null ? 'RSS 链接已生成' : '新 RSS 链接已生成';
    } catch (e) {
      generatedUrl = '';
      state = 'idle';
      idleEl.style.display = 'none';
      resultEl.classList.remove('hidden');
      resultEl.classList.remove('added');
      resultUrlEl.style.color = 'var(--text-secondary)';
      const msg = (typeof e === 'string') ? e : (e && e.message) || String(e);
      resultUrlEl.textContent = msg;
      resultEyebrow.textContent = '生成失败';
      resultActionsEl.style.display = 'none';
    } finally {
      btnGenerate.disabled = false;
      btnGenerate.innerHTML = generateButtonHtml();
    }
  });

  btnCopy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(generatedUrl); }
    catch {}
    btnCopy.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.3 6.5 11 12.5 4.8"/></svg> 已复制`;
    setTimeout(() => { btnCopy.textContent = '复制链接'; }, 1500);
  });

  btnAdd.addEventListener('click', async () => {
    if (!generatedUrl) return;
    btnAdd.disabled = true;
    try {
      const query = buildFullQuery();
      const desiredName = nameEl.value.trim();
      const pubmedLimit = currentPubmedLimit();

      if (editingFeedId != null) {
        const currentFeed = allFeeds.find(f => f.id === editingFeedId);
        if (!currentFeed) throw new Error('当前订阅源不存在，可能已被删除');
        await invoke('update_feed', {
          id: editingFeedId,
          url: generatedUrl,
          title: desiredName || currentFeed.title || null,
          pubmedQuery: query || null,
          pubmedLimit,
        });
      } else {
        await invoke('add_feed', { url: generatedUrl });
        const list = await invoke('list_feeds');
        const added = list.find(f => f.url === generatedUrl);
        if (added) {
          await invoke('update_feed', {
            id: added.id,
            url: generatedUrl,
            title: desiredName || null,
            pubmedQuery: query || null,
            pubmedLimit,
          });
        }
      }

      state = 'added';
      resultEl.classList.add('added');
      resultEyebrow.innerHTML = editingFeedId == null
        ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.3 6.5 11 12.5 4.8"/></svg> 已添加至订阅源`
        : `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.3 6.5 11 12.5 4.8"/></svg> 已保存修改`;
      resultActionsEl.style.display = 'none';
      await loadFeeds();
      renderFeedSettingsList();
      setTimeout(() => {
        if (editingFeedId == null) {
          queryEl.value = '';
          nameEl.value = '';
          setLimitValue(15);
          updatePreview();
          reset();
        } else {
          exitEditMode({ clearForm: true });
        }
      }, 2200);
    } catch (e) {
      setGlobalStatus((editingFeedId == null ? '保存失败: ' : '保存失败: ') + e, 'error');
    } finally {
      btnAdd.disabled = false;
      btnAdd.innerHTML = addButtonHtml();
    }
  });

  updatePreview();
  syncModeUi();
  pubmedGeneratorApi = { beginEdit, exitEditMode };
}

// ── Briefing settings card ─────────────────────
function initBriefingSettings() {
  const toggle = document.getElementById('briefing-enabled-toggle');
  const body = document.getElementById('briefing-card-body');
  const freqCtl = document.getElementById('briefing-frequency-control');
  const dayRow = document.getElementById('briefing-day-row');
  const daySel = document.getElementById('briefing-day');
  const hourInp = document.getElementById('briefing-hour');
  const promptInp = document.getElementById('briefing-prompt');
  const promptLen = document.getElementById('briefing-prompt-len');
  const promptHint = document.getElementById('briefing-prompt-hint');
  const btnExpand = document.getElementById('btn-briefing-expand');
  const btnReset = document.getElementById('btn-briefing-reset');
  const nextDateEl = document.getElementById('briefing-next-date');

  if (!toggle) return;

  // One-time migration: users whose localStorage still has the original 0.1.0
  // default ("医学文献编辑..." bullet-style prompt) get bumped to the new
  // "前沿进展" style. Detected by the unique opening phrase of the old default.
  const stored = localStorage.getItem('briefing-prompt');
  if (stored && stored.startsWith('你是一位资深的医学文献编辑')) {
    localStorage.removeItem('briefing-prompt');
  }

  // Load state
  const enabled = localStorage.getItem('briefing-enabled') !== '0';
  const frequency = localStorage.getItem('briefing-frequency') || 'weekly';
  const day = localStorage.getItem('briefing-day') || 'mon';
  const hour = localStorage.getItem('briefing-hour') || '09:00';
  const prompt = localStorage.getItem('briefing-prompt') || DEFAULT_BRIEFING_PROMPT;

  toggle.classList.toggle('on', enabled);
  body.classList.toggle('disabled', !enabled);
  freqCtl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.value === frequency));
  dayRow.style.display = frequency === 'weekly' ? 'flex' : 'none';
  daySel.value = day;
  hourInp.value = hour;
  promptInp.value = prompt;
  promptLen.textContent = `${prompt.length} 字符`;
  promptHint.textContent = prompt === DEFAULT_BRIEFING_PROMPT ? '当前使用推荐默认 Prompt' : '已自定义 Prompt';
  nextDateEl.textContent = computeNextBriefingDate();

  // Any settings change clears the "don't retry within 1 hour" guard and
  // immediately re-evaluates whether a briefing is due — so if you set the
  // hour to "now", a briefing fires within a few seconds instead of waiting
  // for the next 5-minute tick.
  const settingsChanged = () => {
    localStorage.removeItem('briefing-last-attempt');
    setTimeout(briefingSchedulerTick, 500);
  };

  toggle.addEventListener('click', () => {
    const next = !toggle.classList.contains('on');
    toggle.classList.toggle('on', next);
    body.classList.toggle('disabled', !next);
    localStorage.setItem('briefing-enabled', next ? '1' : '0');
    if (next) settingsChanged();
  });

  freqCtl.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      freqCtl.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      const v = b.dataset.value;
      localStorage.setItem('briefing-frequency', v);
      dayRow.style.display = v === 'weekly' ? 'flex' : 'none';
      nextDateEl.textContent = computeNextBriefingDate();
      settingsChanged();
    });
  });

  daySel.addEventListener('change', () => {
    localStorage.setItem('briefing-day', daySel.value);
    nextDateEl.textContent = computeNextBriefingDate();
    settingsChanged();
  });

  hourInp.addEventListener('change', () => {
    localStorage.setItem('briefing-hour', hourInp.value);
    nextDateEl.textContent = computeNextBriefingDate();
    settingsChanged();
  });

  promptInp.addEventListener('input', () => {
    const v = promptInp.value;
    localStorage.setItem('briefing-prompt', v);
    promptLen.textContent = `${v.length} 字符`;
    promptHint.textContent = v === DEFAULT_BRIEFING_PROMPT ? '当前使用推荐默认 Prompt' : '已自定义 Prompt';
  });

  btnExpand.addEventListener('click', () => {
    const expanded = promptInp.style.minHeight === '220px';
    promptInp.style.minHeight = expanded ? '90px' : '220px';
    promptInp.rows = expanded ? 4 : 12;
    btnExpand.textContent = expanded ? '展开' : '收起';
  });

  btnReset.addEventListener('click', () => {
    promptInp.value = DEFAULT_BRIEFING_PROMPT;
    localStorage.setItem('briefing-prompt', DEFAULT_BRIEFING_PROMPT);
    promptLen.textContent = `${DEFAULT_BRIEFING_PROMPT.length} 字符`;
    promptHint.textContent = '当前使用推荐默认 Prompt';
  });
}

// ── Reading stats ───────────────────────────────
// Stats run off a dedicated `get_reading_stats` backend command that aggregates
// the entire `entries` table in SQL — NOT off `globalEntries`, which is capped
// at LIMIT 200 by `list_entries` and would silently undercount once the DB
// holds more than 200 rows.
let heatmapDayCounts = new Map();
let fetchedDayCounts = new Map();
let readHourCounts = new Array(24).fill(0);
let heatmapYear = new Date().getFullYear();
let statsPeriod = 'all'; // 'all' | '30d' | '7d'
let cachedReadingStats = null;

async function renderReadingStats() {
  let stats;
  try {
    stats = await invoke('get_reading_stats');
  } catch (e) {
    console.error('get_reading_stats 失败:', e);
    return;
  }

  cachedReadingStats = stats;
  heatmapDayCounts = new Map(stats.day_counts || []);
  fetchedDayCounts = new Map(stats.fetched_day_counts || []);
  readHourCounts = Array.isArray(stats.read_hour_counts) && stats.read_hour_counts.length === 24
    ? stats.read_hour_counts.slice()
    : new Array(24).fill(0);

  setupStatsPeriodSwitch();
  setupHeatmapYearSelect();
  applyStatsPeriod();
  setupLiteratureGrowthFilter();
  renderLiteratureGrowth(stats.growth_sources || []);
  renderFeedPrefsFromCounts(stats.feed_read_counts || []);

  // Easter-egg copy refresh runs detached so a slow provider round trip never
  // blocks the stats render — local pool always paints first.
  maybeRefreshFlavorPool();
}

function setupLiteratureGrowthFilter() {
  const filter = document.getElementById('literature-growth-filter');
  if (!filter || filter.dataset.bound) return;
  filter.dataset.bound = '1';
  filter.addEventListener('change', () => {
    renderLiteratureGrowth(cachedReadingStats?.growth_sources || []);
  });
}

function literatureGrowthTrend(source) {
  const current = Number(source.last_7_days || 0);
  const previous = Number(source.previous_7_days || 0);
  if (current === 0) return { label: '近期无发表', className: 'idle' };
  if (previous === 0) return { label: '开始发表', className: 'accelerating' };
  const change = (current - previous) / previous;
  if (change >= 0.25) return { label: '发表加快', className: 'accelerating' };
  if (change <= -0.25) return { label: '发表放缓', className: 'slowing' };
  return { label: '发表平稳', className: 'stable' };
}

function parseSqliteTimestamp(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLiteratureGrowthLastAdded(value) {
  const date = parseSqliteTimestamp(value);
  if (!date) return '尚无记录';
  const elapsedDays = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  if (elapsedDays === 0) return '今天';
  if (elapsedDays === 1) return '昨天';
  if (elapsedDays < 30) return `${elapsedDays} 天前`;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function formatLiteratureGrowthDayLabel(value) {
  const [, month, day] = String(value || '').split('-');
  if (!month || !day) return value || '';
  return `${Number(month)}/${Number(day)}`;
}

function renderLiteratureGrowthSparkline(dayCounts) {
  const counts = new Map(dayCounts || []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let offset = 29; offset >= 0; offset--) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const key = ymdLocal(day);
    days.push({ key, count: Number(counts.get(key) || 0) });
  }
  const max = Math.max(1, ...days.map(day => day.count));
  return days.map(day => {
    const height = day.count ? Math.max(12, Math.round(day.count / max * 100)) : 4;
    const dateLabel = formatLiteratureGrowthDayLabel(day.key);
    return `
      <div class="literature-growth-point" title="${day.key}: ${day.count} 篇" aria-label="${dateLabel}，${day.count} 篇">
        <span class="literature-growth-count${day.count ? ' has-value' : ''}">${day.count}</span>
        <span class="literature-growth-bar-track">
          <span class="literature-growth-bar${day.count ? ' has-value' : ''}" style="height:${height}%"></span>
        </span>
        <time class="literature-growth-day" datetime="${day.key}">${dateLabel}</time>
      </div>`;
  }).join('');
}

function renderLiteratureGrowth(sources) {
  const list = document.getElementById('literature-growth-list');
  const summary = document.getElementById('literature-growth-summary');
  if (!list || !summary) return;
  const filter = document.getElementById('literature-growth-filter')?.value || 'all';
  const visible = (sources || [])
    .filter(source => filter === 'all' || source.source_kind === filter)
    .sort((left, right) => (
      Number(right.last_7_days || 0) - Number(left.last_7_days || 0)
      || Number(right.last_30_days || 0) - Number(left.last_30_days || 0)
      || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
    ));

  const last7 = visible.reduce((total, source) => total + Number(source.last_7_days || 0), 0);
  const last30 = visible.reduce((total, source) => total + Number(source.last_30_days || 0), 0);
  summary.textContent = `${visible.length} 个来源 · 近 7 天发表 ${last7.toLocaleString('zh-CN')} 篇 · 近 30 天 ${last30.toLocaleString('zh-CN')} 篇`;

  if (!visible.length) {
    list.innerHTML = '<div class="literature-growth-empty">当前分类还没有可统计的来源</div>';
    return;
  }

  list.innerHTML = visible.map(source => {
    const trend = literatureGrowthTrend(source);
    const kindLabel = source.source_kind === 'pubmed' ? 'PubMed' : '订阅源';
    return `
      <div class="literature-growth-row">
        <div class="literature-growth-heading">
          <div class="literature-growth-title-wrap">
            <span class="literature-growth-kind ${source.source_kind}">${kindLabel}</span>
            <span class="literature-growth-name" title="${escapeHtml(source.name || '')}">${escapeHtml(source.name || '未命名来源')}</span>
          </div>
          <span class="literature-growth-trend ${trend.className}">${trend.label}</span>
        </div>
        <div class="literature-growth-metrics">
          <div><span>近 7 天发表</span><strong>${Number(source.last_7_days || 0).toLocaleString('zh-CN')}</strong></div>
          <div><span>前 7 天发表</span><strong>${Number(source.previous_7_days || 0).toLocaleString('zh-CN')}</strong></div>
          <div><span>近 30 天发表</span><strong>${Number(source.last_30_days || 0).toLocaleString('zh-CN')}</strong></div>
          <div><span>周均发表</span><strong>${Number(source.weekly_average || 0).toFixed(1)}</strong></div>
          <div><span>最后新增</span><strong>${formatLiteratureGrowthLastAdded(source.last_added_at)}</strong></div>
        </div>
        <div class="literature-growth-sparkline" aria-label="${escapeHtml(source.name || '')} 近 30 天发表趋势">
          <div class="literature-growth-series">
            ${renderLiteratureGrowthSparkline(source.day_counts)}
          </div>
        </div>
      </div>`;
  }).join('');
}

function setupStatsPeriodSwitch() {
  const wrap = document.getElementById('stats-period-switch');
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.stats-period-btn');
    if (!btn) return;
    const period = btn.dataset.period;
    if (!period || period === statsPeriod) return;
    statsPeriod = period;
    for (const b of wrap.querySelectorAll('.stats-period-btn')) {
      b.classList.toggle('is-active', b.dataset.period === period);
    }
    applyStatsPeriod();
  });
}

// Local YYYY-MM-DD key — matches the SQL `date(..., 'localtime')` aggregation
// so day_counts keys line up with the user's wall clock.
function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Sum a (date → count) map within a window of `days` days ending today,
// also counting how many distinct days had any activity.
function sumWindow(counts, days) {
  if (!days || days <= 0) {
    let total = 0, active = 0;
    for (const v of counts.values()) {
      total += v;
      if (v > 0) active += 1;
    }
    return { total, active };
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let total = 0, active = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const c = counts.get(ymdLocal(d)) || 0;
    if (c > 0) { total += c; active += 1; }
  }
  return { total, active };
}

function periodDays(period) {
  if (period === '7d') return 7;
  if (period === '30d') return 30;
  return 0; // ALL
}

function computePeriodStats(period) {
  const days = periodDays(period);
  const read = sumWindow(heatmapDayCounts, days);
  const fetched = sumWindow(fetchedDayCounts, days);
  // Peak hour is identity-level — same across periods to keep the card stable.
  let peakHour = -1, peakCount = 0;
  for (let h = 0; h < 24; h++) {
    if (readHourCounts[h] > peakCount) { peakCount = readHourCounts[h]; peakHour = h; }
  }
  return {
    fetched: fetched.total,
    read: read.total,
    activeDays: read.active,
    peakHour,
    peakCount,
  };
}

function formatHour(h) {
  if (h < 0) return '—';
  if (h === 0) return '凌晨 12 点';
  if (h < 6) return `凌晨 ${h} 点`;
  if (h < 12) return `上午 ${h} 点`;
  if (h === 12) return '中午 12 点';
  if (h < 18) return `下午 ${h - 12} 点`;
  return `晚上 ${h - 12} 点`;
}

function applyStatsPeriod() {
  if (!cachedReadingStats) return;
  const ps = computePeriodStats(statsPeriod);
  const el = (id) => document.getElementById(id);
  el('stat-total-crawled').textContent = ps.fetched;
  el('stat-total-read').textContent = ps.read;
  el('stat-active-days').textContent = ps.activeDays;
  el('stat-peak-hour').textContent = formatHour(ps.peakHour);

  // Year selector is only meaningful for the full-year grid.
  const yearSel = document.getElementById('heatmap-year');
  if (yearSel) yearSel.style.visibility = statsPeriod === 'all' ? 'visible' : 'hidden';

  if (statsPeriod === 'all') {
    renderHeatmap(heatmapDayCounts);
  } else {
    renderHeatmapStrip(heatmapDayCounts, periodDays(statsPeriod));
  }

  renderStatsFlavor(ps);
}

function setupHeatmapYearSelect() {
  const sel = document.getElementById('heatmap-year');
  if (!sel) return;
  const currentYear = new Date().getFullYear();
  let minYear = currentYear;
  for (const k of heatmapDayCounts.keys()) {
    const y = parseInt(k.slice(0, 4), 10);
    if (!Number.isNaN(y) && y < minYear) minYear = y;
  }
  if (heatmapYear < minYear || heatmapYear > currentYear) heatmapYear = currentYear;

  const years = [];
  for (let y = currentYear; y >= minYear; y--) years.push(y);
  sel.innerHTML = years.map(y => `<option value="${y}">${y} 年</option>`).join('');
  sel.value = String(heatmapYear);

  if (!sel.dataset.bound) {
    sel.addEventListener('change', () => {
      heatmapYear = parseInt(sel.value, 10) || currentYear;
      renderHeatmap(heatmapDayCounts);
    });
    sel.dataset.bound = '1';
  }
}

function renderHeatmap(dayCounts) {
  const container = document.getElementById('heatmap');
  if (!container) return;
  container.classList.remove('is-strip');

  const year = heatmapYear;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Grid window: from the Monday on/before Jan 1 to the Sunday on/after Dec 31,
  // so the cells line up with the existing 一/三/五/日 weekday labels (Mon-first).
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const startDow = (yearStart.getDay() + 6) % 7; // Mon=0..Sun=6
  const gridStart = new Date(yearStart);
  gridStart.setDate(yearStart.getDate() - startDow);
  const endDow = (yearEnd.getDay() + 6) % 7;
  const gridEnd = new Date(yearEnd);
  gridEnd.setDate(yearEnd.getDate() + (6 - endDow));
  const totalDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
  const weeks = Math.round(totalDays / 7);

  // Local YYYY-MM-DD (avoid UTC drift from .toISOString()).
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let html = '<div class="heatmap-body"><div class="heatmap-weekdays"><div>一</div><div></div><div>三</div><div></div><div>五</div><div></div><div>日</div></div><div class="heatmap-weeks">';
  const monthMarks = [];
  let lastMonth = -1;

  for (let w = 0; w < weeks; w++) {
    html += '<div class="heatmap-week">';
    for (let d = 0; d < 7; d++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + w * 7 + d);
      // Cells outside the selected year are hidden so the year-edge stays clean.
      // Future days inside the year render as empty cells (no count) so the
      // full 12-month grid is always visible.
      if (day.getFullYear() !== year) {
        html += '<div class="heatmap-cell" style="visibility:hidden"></div>';
        continue;
      }
      const k = ymd(day);
      const c = day > today ? 0 : (dayCounts.get(k) || 0);
      let cls = '';
      if (c >= 8) cls = 'l4';
      else if (c >= 4) cls = 'l3';
      else if (c >= 2) cls = 'l2';
      else if (c >= 1) cls = 'l1';
      html += `<div class="heatmap-cell ${cls}" title="${k}: ${c}"></div>`;
      if (d === 0 && day.getMonth() !== lastMonth) {
        monthMarks.push({ idx: w, label: (day.getMonth() + 1) + '月' });
        lastMonth = day.getMonth();
      }
    }
    html += '</div>';
  }
  html += '</div></div>';

  let monthHeader = '<div class="heatmap-months">';
  for (let i = 0; i < monthMarks.length; i++) {
    const cur = monthMarks[i];
    const next = monthMarks[i + 1];
    const span = ((next ? next.idx : weeks) - cur.idx) * 13;
    monthHeader += `<div class="heatmap-month" style="width:${span}px">${cur.label}</div>`;
  }
  monthHeader += '</div>';
  container.innerHTML = monthHeader + html;
}

// 30d / 7d view: single row of larger cells, oldest → newest, today on the
// right. Same intensity ramp as the year grid so the visual language carries
// across periods.
function renderHeatmapStrip(dayCounts, days) {
  const container = document.getElementById('heatmap');
  if (!container) return;
  container.classList.add('is-strip');

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let html = '';
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const k = ymdLocal(d);
    const c = dayCounts.get(k) || 0;
    let cls = '';
    if (c >= 8) cls = 'l4';
    else if (c >= 4) cls = 'l3';
    else if (c >= 2) cls = 'l2';
    else if (c >= 1) cls = 'l1';
    html += `<div class="heatmap-strip-cell ${cls}" title="${k}: ${c}"></div>`;
  }
  const label = days === 7 ? '近 7 天' : '近 30 天';
  html += `<div class="heatmap-strip-label">${label} · 右侧为今天</div>`;
  container.innerHTML = html;
}

// ── Stats easter-egg flavor copy ──────────────────────────────────
// A small local template pool is the load-bearing source — renders instantly,
// works offline. The active AI provider tops it up in the background weekly
// for novelty; if it fails or hasn't run yet, the local pool alone is enough.

const FLAVOR_LOCAL_POOL = [
  // {read} / {fetched} / {activeDays} / {hour} / {hourBand} are filled at render
  '已读 {read} 篇，相当于半本《三体》的字数密度 ✦',
  '过去这段时间，你在 {activeDays} 天里翻开了 Cento',
  '{hourBand}的灵感最配你 — 高峰时段：{hour}',
  '抓取 {fetched} 篇里，你挑出了 {read} 篇，眼光不错',
  '{activeDays} 天活跃，像一首慢慢谱出的节奏',
  '你最爱在{hour}阅读，世界正安静',
  '{read} 篇文章读完，思绪也走过了 {activeDays} 个清晨与黄昏',
  '抓取 {fetched} 篇 · 这是你最近的信息地平线',
  '保持节奏就是胜利 — 已读 {read} 篇',
  '{hourBand}的 Cento，是属于你的专属频段',
  '在 {activeDays} 天里，你和 {read} 篇文字相遇',
  '今天也别忘了喂养你的好奇心 ✿',
  '阅读不是任务，是一种节律',
  '抓取与阅读的比例，是你筛选世界的尺度',
  '{hour}的你，比清晨的自己更专注一点',
  '已读 {read} 篇 · 字里行间藏着你的轨迹',
  '世界很吵，Cento 帮你留住安静的 {activeDays} 天',
  '{hourBand}总有惊喜，比如这条彩蛋',
  '抓取 {fetched} 篇，{read} 篇被你选中，剩下的也算见过',
  '保持好奇，世界就保持新鲜 ❀',
];

const FLAVOR_STORAGE_KEY = 'cento.flavor.state.v1';
const FLAVOR_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FLAVOR_RECENT_MAX = 5;

function loadFlavorState() {
  try {
    const raw = localStorage.getItem(FLAVOR_STORAGE_KEY);
    if (!raw) return { pool: [], recent: [], generatedAt: 0 };
    const obj = JSON.parse(raw);
    return {
      pool: Array.isArray(obj.pool) ? obj.pool : [],
      recent: Array.isArray(obj.recent) ? obj.recent : [],
      generatedAt: typeof obj.generatedAt === 'number' ? obj.generatedAt : 0,
    };
  } catch {
    return { pool: [], recent: [], generatedAt: 0 };
  }
}

function saveFlavorState(state) {
  try { localStorage.setItem(FLAVOR_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function hourBand(h) {
  if (h < 0) return '某个时分';
  if (h < 5) return '深夜';
  if (h < 9) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '正午';
  if (h < 18) return '午后';
  if (h < 22) return '夜晚';
  return '深夜';
}

function fillFlavorTemplate(tpl, ps) {
  return tpl
    .replaceAll('{read}', String(ps.read))
    .replaceAll('{fetched}', String(ps.fetched))
    .replaceAll('{activeDays}', String(ps.activeDays))
    .replaceAll('{hour}', formatHour(ps.peakHour))
    .replaceAll('{hourBand}', hourBand(ps.peakHour));
}

function pickFlavorTemplate(state) {
  const all = FLAVOR_LOCAL_POOL.concat(state.pool || []);
  if (all.length === 0) return null;
  const recent = new Set(state.recent || []);
  // Filter out templates we've shown recently; if everything is in the
  // recent set, fall through to the full pool so we never end up empty.
  const fresh = all.filter(t => !recent.has(t));
  const pool = fresh.length > 0 ? fresh : all;
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderStatsFlavor(ps) {
  const el = document.getElementById('stats-flavor');
  if (!el) return;
  // If the user has no activity at all, skip the flourish — empty stats
  // shouldn't get cheerleading copy.
  if (ps.read === 0 && ps.fetched === 0) {
    el.textContent = '';
    el.classList.remove('is-visible');
    return;
  }
  const state = loadFlavorState();
  const tpl = pickFlavorTemplate(state);
  if (!tpl) return;
  const text = fillFlavorTemplate(tpl, ps);

  // Track recent template IDs (the raw template, not the filled string) so
  // variable swaps don't count as "different" content.
  const recent = (state.recent || []).filter(t => t !== tpl);
  recent.unshift(tpl);
  saveFlavorState({ ...state, recent: recent.slice(0, FLAVOR_RECENT_MAX) });

  el.classList.remove('is-visible');
  el.textContent = text;
  // Next paint → opacity 1, fades the swap in smoothly.
  requestAnimationFrame(() => el.classList.add('is-visible'));
}

// Fire-and-forget weekly refresh of the AI-generated pool. All errors
// are swallowed — the local pool guarantees the UI never goes blank. The
// actual provider call lives in Rust (entry_service::generate_flavor_pool)
// so it shares the timeout/error handling pattern used by briefing and
// translation, and avoids CORS issues with the vendor API.
async function maybeRefreshFlavorPool() {
  const state = loadFlavorState();
  const stale = Date.now() - (state.generatedAt || 0) > FLAVOR_REFRESH_INTERVAL_MS;
  if (!stale) return;

  const ps = cachedReadingStats ? computePeriodStats('all') : null;
  if (!ps) return;

  try {
    const fresh = await invoke('generate_stats_flavor_pool', {
      fetched: ps.fetched,
      read: ps.read,
      activeDays: ps.activeDays,
      peakHour: ps.peakHour,
    });
    loadCostSummary();
    if (Array.isArray(fresh) && fresh.length > 0) {
      saveFlavorState({
        ...state,
        pool: fresh.slice(0, 20),
        generatedAt: Date.now(),
      });
    } else {
      // Mark the attempt anyway so we don't hammer the API on every render
      // when the provider returns nothing useful.
      saveFlavorState({ ...state, generatedAt: Date.now() });
    }
  } catch (e) {
    // Swallow silently — local pool is the source of truth, this is enrichment.
    console.warn('[flavor] AI refresh skipped:', e?.message || e);
  }
}

function renderFeedPrefsFromCounts(feedReadCounts) {
  const wrap = document.getElementById('feed-pref-bars');
  if (!wrap) return;
  // Each row is [feed_id, snapshot_title, count] — snapshot lets us still name
  // feeds the user has since deleted, so the ranking doesn't lose entries.
  const total = feedReadCounts.reduce((sum, row) => sum + row[2], 0) || 1;
  const ranked = feedReadCounts.slice(0, 5);
  wrap.innerHTML = ranked.map(([fid, snapshot, n]) => {
    const feed = allFeeds.find(f => f.id === fid);
    const liveName = feed ? (feed.title || feed.url) : null;
    const name = liveName || snapshot || `#${fid}`;
    const isDeleted = !feed;
    const emoji = feedEmoji(fid);
    const pct = Math.round(n / total * 100);
    return `
      <div class="feed-pref-row">
        <div class="feed-pref-emoji">${emoji}</div>
        <div class="feed-pref-info">
          <div class="feed-pref-name">${escapeHtml(name)}${isDeleted ? ' <span class="feed-pref-tag">已删除</span>' : ''}</div>
          <div class="feed-pref-track"><div class="feed-pref-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="feed-pref-pct">${pct}%</div>
      </div>
    `;
  }).join('') || '<div class="srow-hint">暂无阅读记录</div>';
}

// ── Utils ──────────────────────────────────────
function formatSlashDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  // Date-only values are formatted from their components to avoid timezone shifts.
  const match = text.match(/^(\d{4})[-\/](\d{1,2})(?:[-\/](\d{1,2}))?/);
  if (match) {
    const [, year, month, day] = match;
    return `${year}/${Number(month)}${day ? `/${Number(day)}` : ''}`;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text == null ? '' : String(text);
  return d.innerHTML;
}

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || '';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatAuthors(authorStr) {
  if (!authorStr) return '';
  const authors = authorStr.split(',').map(s => s.trim()).filter(Boolean);
  return authors.join(', ');
}

// entry.source is the journal name parsed from the RSS description by
// article_service::extract_source on the Rust side (already trimmed to just
// the journal). NOT to be confused with feed.title, which is the user's
// custom RSS feed name (e.g. a PubMed search query).
function journalName(entry) {
  return (entry?.source || '').trim();
}

function formatPublicationDate(entry) {
  if (entry.publication_date) return formatSlashDate(entry.publication_date);
  if (!entry.published_at) return '';
  return formatSlashDate(entry.published_at);
}

// ── Init ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Default the appshell to settings-mode (sidebar tucked away) so the
  // first paint doesn't show an empty 252-px gap on the left before
  // `loadSettings()` decides which view to surface. `showMain()` /
  // `showSettings()` toggle this class authoritatively below.
  document.body.classList.add('settings-mode');

  // Layout
  settingsView = document.getElementById('settings-view');
  mainView     = document.getElementById('main-view');
  contentArea  = document.getElementById('content-area');
  toolbarSubtitle = document.getElementById('toolbar-subtitle');
  toolbarApiPicker = document.getElementById('toolbar-api-picker');
  toolbarApiButton = document.getElementById('toolbar-api-button');
  toolbarApiLabel = document.getElementById('toolbar-api-label');
  toolbarApiMenu = document.getElementById('toolbar-api-menu');
  toolbarApiList = document.getElementById('toolbar-api-list');
  btnManageApiTokens = document.getElementById('btn-manage-api-tokens');
  const sidebarAiTools = document.getElementById('sidebar-ai-tools');
  const costMeter = document.getElementById('cost-meter');
  if (sidebarAiTools && toolbarApiPicker && costMeter) {
    toolbarApiPicker.classList.add('sidebar-api-picker');
    costMeter.classList.remove('toolbar-cost-meter');
    const costMeterBot = costMeter.querySelector('.cost-meter-bot');
    document.getElementById('cost-model')?.remove();
    costMeter.remove();
    costMeterBot?.append(toolbarApiPicker);
    sidebarAiTools.append(costMeter);
  }

  // Toolbar
  btnSettings = document.getElementById('btn-settings');
  btnSidebar  = document.getElementById('btn-sidebar');
  btnTogglePaperChatToolbar = document.getElementById('btn-toggle-paper-chat-toolbar');
  btnRefresh  = document.getElementById('btn-refresh');
  refreshIcon = document.getElementById('refresh-icon');

  // Settings inputs
  providerSelect    = document.getElementById('ai-provider');
  apiKeyInput       = document.getElementById('api-key');
  baseUrlInput      = document.getElementById('base-url');
  modelInput        = document.getElementById('model');
  modelPresetSelect = document.getElementById('api-model-preset');
  customModelInput  = document.getElementById('custom-model');
  modelDisplayNameInput = document.getElementById('model-display-name');
  modelDisplayNameCount = document.getElementById('model-display-name-count');
  contextInputTokensInput = document.getElementById('context-input-tokens');
  contextOutputTokensInput = document.getElementById('context-output-tokens');
  toolCallRoundsInput = document.getElementById('tool-call-rounds');
  btnApiModeProvider = document.getElementById('api-mode-provider');
  btnApiModeCustom = document.getElementById('api-mode-custom');
  apiProviderPanel = document.getElementById('api-provider-panel');
  apiCustomPanel = document.getElementById('api-custom-panel');
  systemPromptInput = document.getElementById('system-prompt');
  retentionSelect   = document.getElementById('read-retention');
  titleDisplaySelect = document.getElementById('title-display-mode');
  btnToggleApiKey   = document.getElementById('btn-toggle-api-key');
  btnTest           = document.getElementById('btn-test');
  btnSaveSettings   = document.getElementById('btn-save-settings');
  aiModelList       = document.getElementById('ai-model-list');
  aiModelEmpty      = document.getElementById('ai-model-empty');
  aiModelEditor     = document.getElementById('ai-model-editor');
  aiModelEditorTitle = document.getElementById('ai-model-editor-title');
  aiModelStatus     = document.getElementById('ai-model-status');
  btnAddAiModel     = document.getElementById('btn-add-ai-model');
  btnCancelAiModel  = document.getElementById('btn-cancel-ai-model');
  apiTokenProfileSelect = document.getElementById('api-token-profile');
  apiTokenProfileNameInput = document.getElementById('api-token-profile-name');
  btnNewApiToken = document.getElementById('btn-new-api-token');
  btnDeleteApiToken = document.getElementById('btn-delete-api-token');
  btnSaveGeneral    = document.getElementById('btn-save-general');
  settingsStatus    = document.getElementById('settings-status');
  generalStatus     = document.getElementById('general-status');
  themeControl      = document.getElementById('theme-control');
  accentSwatches    = document.getElementById('accent-swatches');
  fontscaleControl  = document.getElementById('fontscale-control');

  // Feeds
  feedUrlInput  = document.getElementById('feed-url');
  btnAddFeed    = document.getElementById('btn-add-feed');
  addFeedRow    = document.getElementById('add-feed-row');
  addFeedIcon   = document.getElementById('add-feed-icon');
  literatureSearchInput = document.getElementById('literature-search');
  btnClearLiteratureSearch = document.getElementById('btn-clear-literature-search');
  literatureSearchRow = document.getElementById('literature-search-row');
  feedListEl    = document.getElementById('feed-list');
  globalStatusEl = document.getElementById('global-status');
  pubmedSearchListEl = document.getElementById('pubmed-search-list');

  // Entry list
  entryListEl     = document.getElementById('entry-list');
  entryItemsEl    = document.getElementById('entry-items');
  entryFilter     = document.getElementById('entry-filter');
  entrySortSelect = document.getElementById('entry-sort');
  entrySortDirection = document.getElementById('entry-sort-direction');
  briefingSortSelect = document.getElementById('briefing-sort');
  briefingSortDirection = document.getElementById('briefing-sort-direction');
  entryBulkActions = document.getElementById('entry-bulk-actions');
  entryBulkCount = document.getElementById('entry-bulk-count');
  btnEntrySelectMode = document.getElementById('btn-entry-select-mode');
  btnEntryBulkSelectAll = document.getElementById('btn-entry-bulk-select-all');
  btnEntryBulkSelectUnnoted = document.getElementById('btn-entry-bulk-select-unnoted');
  btnEntryBulkSelectNoted = document.getElementById('btn-entry-bulk-select-noted');
  btnEntryBulkInvert = document.getElementById('btn-entry-bulk-invert');
  btnEntryBulkDeselect = document.getElementById('btn-entry-bulk-deselect');
  entryBulkExportFormat = document.getElementById('entry-bulk-export-format');
  btnEntryBulkExport = document.getElementById('btn-entry-bulk-export');
  entryBulkExistingMode = document.getElementById('entry-bulk-existing-mode');
  btnEntryBulkGenerate = document.getElementById('btn-entry-bulk-generate');
  btnEntryBulkClear = document.getElementById('btn-entry-bulk-clear');
  entryMetricIfFilter = document.getElementById('entry-metric-if-filter');
  entryMetricQFilter = document.getElementById('entry-metric-q-filter');
  entryMetricBFilter = document.getElementById('entry-metric-b-filter');
  entryMetricTopFilter = document.getElementById('entry-metric-top-filter');
  entryTagFilter = document.getElementById('entry-tag-filter');
  entryMetricFilterSummaryCount = document.getElementById('entry-metric-filter-summary-count');
  pubmedBatchHeader = document.getElementById('pubmed-batch-header');
  pubmedBatchMeta = document.getElementById('pubmed-batch-meta');
  pubmedStatusFilter = document.getElementById('pubmed-status-filter');
  pubmedSort = document.getElementById('pubmed-sort');
  pubmedStarFilter = document.getElementById('pubmed-star-filter');
  pubmedDateFilters = document.getElementById('pubmed-date-filters');
  pubmedPublishedFrom = document.getElementById('pubmed-published-from');
  pubmedPublishedTo = document.getElementById('pubmed-published-to');
  pubmedAddedFrom = document.getElementById('pubmed-added-from');
  pubmedAddedTo = document.getElementById('pubmed-added-to');
  pubmedProgressEl = document.getElementById('pubmed-search-progress');
  pubmedProgressFill = document.getElementById('pubmed-progress-fill');
  pubmedProgressLabel = document.getElementById('pubmed-progress-label');
  btnRunPubmedSearch = document.getElementById('btn-run-pubmed-search');
  btnCancelPubmedRun = document.getElementById('btn-cancel-pubmed-run');
  pubmedExportFormat = document.getElementById('pubmed-export-format');
  btnExportPubmed = document.getElementById('btn-export-pubmed');
  pubmedSnapshotSelect = document.getElementById('pubmed-snapshot-select');
  btnSavePubmedSnapshot = document.getElementById('btn-save-pubmed-snapshot');
  btnDeletePubmedSnapshot = document.getElementById('btn-delete-pubmed-snapshot');
  pubmedBulkStatus = document.getElementById('pubmed-bulk-status');
  btnPubmedAiScreen = document.getElementById('btn-pubmed-ai-screen');
  restoreEntryFilter();
  restoreEntryMetricFilters();
  restoreEntrySortMode();
  restoreCurrentFilterScope({ useCurrentAsFallback: true });

  // Briefing list
  briefingListEl  = document.getElementById('briefing-list');
  briefingItemsEl = document.getElementById('briefing-items');

  // Detail
  detailPanelEl        = document.getElementById('detail-panel');
  sidebarResizerEl     = document.getElementById('sidebar-resizer');
  listResizerEl        = document.getElementById('list-resizer');
  paperChatResizerEl   = document.getElementById('paper-chat-resizer');
  paperChatPanelEl     = document.getElementById('paper-chat-panel');
  briefingDetailEl     = document.getElementById('briefing-detail');
  detailEmpty          = document.getElementById('detail-empty');
  detailContent        = document.getElementById('detail-content');
  detailTitle          = document.getElementById('detail-title');
  detailJournal        = document.getElementById('detail-journal');
  detailAffiliation    = document.getElementById('detail-affiliation');
  detailIdentifierStrip = document.getElementById('detail-identifier-strip');
  detailPublicationDate = document.getElementById('detail-publication-date');
  detailDateSub        = document.getElementById('detail-date-sub');
  detailSummaryContent = document.getElementById('detail-summary-content');
  detailSummarySection = document.getElementById('detail-summary-section');
  detailSummaryRetry  = document.getElementById('detail-summary-retry');
  detailSummaryView = document.getElementById('detail-summary-view');
  detailPdfView = document.getElementById('detail-pdf-view');
  btnDetailViewSummary = document.getElementById('btn-detail-view-summary');
  btnDetailViewPdf = document.getElementById('btn-detail-view-pdf');
  btnPdfOpenExternal = document.getElementById('btn-pdf-open-external');
  btnPdfDownload = document.getElementById('btn-pdf-download');
  detailReadingNotesContent = document.getElementById('detail-reading-notes-content');
  detailPaperChatHint = document.getElementById('detail-paper-chat-hint');
  detailPaperChatMessages = document.getElementById('detail-paper-chat-messages');
  detailPaperChatScopes = document.getElementById('detail-paper-chat-scopes');
  paperChatInput       = document.getElementById('paper-chat-input');
  paperChatComposer    = document.querySelector('.detail-paper-chat-composer');
  paperChatScopeCaption = document.getElementById('paper-chat-scope-caption');
  paperChatPickedList = document.getElementById('paper-chat-picked-list');
  paperChatPickedLabel = document.getElementById('paper-chat-picked-label');
  paperChatProfileSelect = document.getElementById('paper-chat-profile-select');
  paperChatAttachmentsEl = document.getElementById('paper-chat-attachments');
  paperChatAttachmentList = document.getElementById('paper-chat-attachment-list');
  btnPaperChatAddFiles = document.getElementById('btn-paper-chat-add-files');
  btnPaperChatAddFolder = document.getElementById('btn-paper-chat-add-folder');
  btnClearPaperChatAttachments = document.getElementById('btn-clear-paper-chat-attachments');
  readingProfileSortSelect = document.getElementById('reading-profiles-sort');
  btnReadingProfilesSort = document.getElementById('reading-profiles-apply-sort');
  detailBadgeRow       = document.getElementById('detail-badge-row');
  detailSourceBadge    = document.getElementById('detail-source-badge');
  btnOpenUrl           = document.getElementById('btn-open-url');
  btnPaperGraph        = document.getElementById('btn-paper-graph');
  btnDetailPdf         = document.getElementById('btn-detail-pdf');
  btnDetailSciHub      = document.getElementById('btn-detail-scihub');
  btnRetrySummary      = document.getElementById('btn-retry-summary');
  btnSendPaperChat     = document.getElementById('btn-send-paper-chat');
  btnClearPaperChat    = document.getElementById('btn-clear-paper-chat');
  btnTogglePaperChat   = document.getElementById('btn-toggle-paper-chat');
  btnShowPaperChat     = document.getElementById('btn-show-paper-chat');
  btnPaperChatAddCurrent = document.getElementById('btn-paper-chat-add-current');
  btnPaperChatClearPicked = document.getElementById('btn-paper-chat-clear-picked');
  detailTagList        = document.getElementById('detail-tag-list');
  detailTagInput       = document.getElementById('detail-tag-input');
  btnDetailAddTag      = document.getElementById('btn-detail-add-tag');
  detailPaperGraphSection = document.getElementById('detail-paper-graph-section');
  paperGraphStage      = document.getElementById('paper-graph-stage');
  paperGraphNodeDetail = document.getElementById('paper-graph-node-detail');
  paperGraphCounts     = document.getElementById('paper-graph-counts');
  briefingDetailEmpty  = document.getElementById('briefing-detail-empty');
  briefingDetailContent = document.getElementById('briefing-detail-content');

  setupSidebarResizer();
  setupSidebarSectionToggles();
  setupListResizer();
  setupPaperChatResizer();
  setupPaperChatAttachmentDrop();

  // Wire events
  btnSettings.addEventListener('click', () => {
    if (!mainView.classList.contains('hidden')) showSettings('feeds');
    else showMain();
  });

  btnSidebar.addEventListener('click', () => {
    if (!mainView.classList.contains('hidden')) toggleSidebar();
    else showMain();
  });
  btnTogglePaperChatToolbar?.addEventListener('click', () => {
    if (!isLiteratureMode() || shouldAutoHidePaperChatPanel()) return;
    setPaperChatCollapsed(!paperChatCollapsed);
  });

  btnRefresh.addEventListener('click', refreshAll);
  providerSelect?.addEventListener('change', () => {
    lastPresetProvider = activeProviderId();
    syncProviderUi();
    loadProviderSettings(activeProviderId());
  });
  baseUrlInput?.addEventListener('input', syncProviderUi);
  modelPresetSelect?.addEventListener('change', () => {
    if (modelInput) modelInput.value = modelPresetSelect.value;
    syncProviderUi();
  });
  customModelInput?.addEventListener('input', () => {
    if (modelInput) modelInput.value = customModelInput.value;
    syncProviderUi();
  });
  modelDisplayNameInput?.addEventListener('input', () => {
    updateModelDisplayNameCount();
    syncModelControls();
    syncProviderUi();
  });
  btnApiModeProvider?.addEventListener('click', () => selectApiConfigMode('provider'));
  btnApiModeCustom?.addEventListener('click', () => selectApiConfigMode('custom'));
  btnAddAiModel?.addEventListener('click', beginAddAiModel);
  btnCancelAiModel?.addEventListener('click', () => setAiModelEditorVisible(false));
  aiModelList?.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    const row = button?.closest('[data-model-id]');
    if (!button || !row) return;
    if (button.dataset.action === 'edit') editAiModel(row.dataset.modelId);
    if (button.dataset.action === 'activate') activateAiModel(row.dataset.modelId);
    if (button.dataset.action === 'delete') deleteAiModel(row.dataset.modelId);
  });
  apiTokenProfileSelect?.addEventListener('change', () => {
    activateApiTokenProfile(apiTokenProfileSelect.value);
  });
  toolbarApiButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleToolbarApiMenu();
  });
  toolbarApiList?.addEventListener('click', (event) => {
    const option = event.target.closest('.toolbar-api-option');
    if (!option) return;
    closeToolbarApiMenu();
    activateApiTokenProfile(
      option.dataset.profileId,
      option.dataset.provider,
      { fromToolbar: true }
    );
  });
  btnManageApiTokens?.addEventListener('click', () => {
    closeToolbarApiMenu();
    showSettings('translation');
  });
  document.addEventListener('click', (event) => {
    if (!toolbarApiPicker?.contains(event.target)) closeToolbarApiMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeToolbarApiMenu();
  });
  btnNewApiToken?.addEventListener('click', beginNewApiTokenProfile);
  btnDeleteApiToken?.addEventListener('click', deleteCurrentApiTokenProfile);
  btnToggleApiKey.addEventListener('click', toggleApiKeyVisibility);
  btnTest.addEventListener('click', testConnection);
  btnSaveSettings.addEventListener('click', saveTranslationSettings);
  btnSaveGeneral?.addEventListener('click', saveGeneralSettings);
  if (titleDisplaySelect) {
    titleDisplaySelect.value = titleDisplayMode();
    titleDisplaySelect.addEventListener('change', () => {
      const next = TITLE_DISPLAY_MODES.has(titleDisplaySelect.value)
        ? titleDisplaySelect.value
        : 'both';
      localStorage.setItem(TITLE_DISPLAY_STORAGE_KEY, next);
      renderEntryList(allEntries);
      if (currentEntry) {
        renderDetailTitle(currentEntry);
        refreshDetailTitleSpinner(currentEntry);
      }
    });
  }
  btnRetrySummary?.addEventListener('click', retrySummaryTranslation);
  btnPaperGraph?.addEventListener('click', togglePaperGraph);
  document.getElementById('btn-paper-graph-close')?.addEventListener('click', togglePaperGraph);
  document.getElementById('btn-paper-graph-reload')?.addEventListener('click', reloadPaperGraph);
  document.getElementById('btn-paper-graph-back')?.addEventListener('click', backPaperGraph);
  document.getElementById('paper-graph-filters')?.addEventListener('click', event => {
    const button = event.target.closest('[data-graph-filter]');
    if (button) setPaperGraphFilter(button.dataset.graphFilter);
  });
  document.getElementById('btn-refresh-balance')?.addEventListener('click', () => refreshDeepSeekBalance());
  document.getElementById('btn-reading-profile-new')?.addEventListener('click', () => {
    fillReadingProfileEditor(null);
    setReadingProfileStatus('已切换到新建模式');
  });
  btnReadingProfilesSort?.addEventListener('click', applyReadingProfileSort);
  document.getElementById('btn-reading-profile-import-skill')?.addEventListener('click', importReadingSkillProfile);
  document.getElementById('btn-reading-profile-save')?.addEventListener('click', saveReadingProfile);
  document.getElementById('btn-reading-profile-delete')?.addEventListener('click', () => deleteReadingProfile());
  btnSendPaperChat?.addEventListener('click', handlePaperChatPrimaryAction);
  btnClearPaperChat?.addEventListener('click', clearPaperChatMessages);
  btnTogglePaperChat?.addEventListener('click', () => setPaperChatCollapsed(true));
  btnShowPaperChat?.addEventListener('click', () => setPaperChatCollapsed(false));
  btnPaperChatAddCurrent?.addEventListener('click', () => addCurrentEntryToPaperChat());
  btnPaperChatClearPicked?.addEventListener('click', () => clearPaperChatPinnedEntries());
  btnPaperChatAddFiles?.addEventListener('click', () => choosePaperChatAttachments());
  btnPaperChatAddFolder?.addEventListener('click', () => choosePaperChatAttachments({ directory: true }));
  btnClearPaperChatAttachments?.addEventListener('click', () => {
    paperChatAttachments = [];
    renderPaperChatAttachments();
  });
  paperChatAttachmentList?.addEventListener('click', e => {
    const button = e.target.closest('[data-paper-chat-attachment-remove]');
    if (!button) return;
    const index = Number(button.dataset.paperChatAttachmentRemove);
    if (!Number.isInteger(index) || !paperChatAttachments[index]) return;
    paperChatAttachments.splice(index, 1);
    renderPaperChatAttachments();
  });
  paperChatProfileSelect?.addEventListener('change', async () => {
    currentPaperChatProfileId = normalizePaperChatProfileId(paperChatProfileSelect.value);
    refreshPaperChatComposerState();
    if (currentEntry) {
      await loadPaperChatMessages();
    } else {
      renderPaperChatMessages([]);
    }
  });
  paperChatInput?.addEventListener('input', refreshPaperChatComposerState);
  paperChatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !activePaperChatRequest) {
      e.preventDefault();
      sendPaperChatQuestion();
    }
  });
  refreshPaperChatComposerState();
  renderPaperChatAttachments();
  detailPaperChatScopes?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-paper-chat-scope]');
    if (!btn) return;
    const nextScope = btn.dataset.paperChatScope;
    if (!nextScope || nextScope === paperChatScope) return;
    paperChatScope = nextScope;
    refreshPaperChatScopeControls();
    await loadPaperChatMessages();
  });
  detailPaperChatMessages?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-paper-chat-append]');
    if (btn) {
      e.preventDefault();
      await appendPaperChatMessageToNote(btn.dataset.paperChatAppend);
      return;
    }

    const a = e.target.closest('a[data-open-url]');
    if (!a) return;
    e.preventDefault();
    openUrl(a.dataset.openUrl);
  });
  paperChatPickedList?.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-paper-chat-remove-entry]');
    if (removeBtn) {
      e.preventDefault();
      removeEntryFromPaperChat(Number(removeBtn.dataset.paperChatRemoveEntry));
      return;
    }

    const focusBtn = e.target.closest('[data-paper-chat-focus-entry]');
    if (!focusBtn) return;
    e.preventDefault();
    const entry = findEntryById(Number(focusBtn.dataset.paperChatFocusEntry));
    if (!entry) {
      setGlobalStatus('这篇文献当前不在列表里，先切回对应订阅源再定位', 'error');
      return;
    }
    showDetail(entry);
  });

  // Settings rail
  document.querySelectorAll('.settings-rail-item').forEach(btn => {
    btn.addEventListener('click', () => activateSettingsSection(btn.dataset.section));
  });

  // Sidebar overview rows
  document.querySelectorAll('.sidebar-row').forEach(row => {
    row.addEventListener('click', () => {
      const view = row.dataset.view;
      const query = literatureSearchInput?.value.trim() || '';
      if (view === 'briefing') {
        enterBriefingMode({ preserveSearch: !!query });
        return;
      }
      if (view === 'kept') {
        enterKeptMode({ preserveSearch: !!query });
        return;
      }
      enterFeedMode();
      document.querySelectorAll('.feed-item').forEach(el => el.classList.remove('selected'));
      selectedFeedId = null;
      restoreCurrentFilterScope();
      entryFilterValue = normalizeEntryFilterValue(view);
      persistEntryFilter();
      syncEntryFilterControls();
      setToolbarSubtitle('main');
      if (query) {
        runLiteratureSearch(query);
        return;
      }
      cancelLiteratureSearchForNavigation();
      loadEntries(null);
    });
  });

  // Toggle switches in general settings — sync from localStorage on load,
  // persist + react on click. Pref key = data-pref attribute.
  document.querySelectorAll('.toggle-switch[data-pref]').forEach(btn => {
    const pref = btn.dataset.pref;
    const lsKey = `pref-${pref}`;
    let on;
    if (pref === 'tray-visible') {
      on = trayVisiblePref();
    } else {
      const v = localStorage.getItem(lsKey);
      on = v === null ? btn.classList.contains('on') : v === '1';
    }
    btn.classList.toggle('on', on);
    btn.addEventListener('click', () => {
      const next = !btn.classList.contains('on');
      btn.classList.toggle('on', next);
      if (pref === 'tray-visible') {
        setTrayVisiblePref(next);
        applyTrayVisibility(next);
      } else {
        localStorage.setItem(lsKey, next ? '1' : '0');
      }
    });
  });

  // OPML import/export
  document.getElementById('btn-export-opml')?.addEventListener('click', exportOpml);
  document.getElementById('btn-import-opml')?.addEventListener('click', importOpml);

  // Test notification — go through the Rust backend so we exercise exactly
  // the same NotificationExt path the scheduler uses. If this banner shows,
  // background-refresh banners will too.
  document.getElementById('btn-test-notification')?.addEventListener('click', async () => {
    const status = document.getElementById('general-status');
    if (status) { status.textContent = '正在发送测试通知…'; status.className = 'settings-status progress'; }
    try {
      await invoke('send_test_notification');
      if (status) {
        status.textContent = '已发送测试通知，请查看 macOS 通知中心';
        status.className = 'settings-status success';
      }
    } catch (e) {
      if (status) {
        status.textContent = String(e);
        status.className = 'settings-status error';
      }
    }
  });

  // Apply initial tray visibility on launch.
  applyTrayVisibility(trayVisiblePref());

  // Star button on detail
  document.getElementById('btn-star')?.addEventListener('click', () => {
    if (!currentEntry) return;
    toggleStar(currentEntry.id);
    const isStarred = starredIds().has(currentEntry.id);
    document.getElementById('btn-star').classList.toggle('active', isStarred);
    renderEntryList(allEntries);
    updateOverviewCounts();
  });

  // Abstract toggle
  btnDetailViewSummary?.addEventListener('click', () => setDetailViewMode('summary'));
  btnDetailViewPdf?.addEventListener('click', openDetailPdfView);
  btnPdfOpenExternal?.addEventListener('click', () => {
    if (detailPdfUrl) openUrl(detailPdfUrl);
  });
  btnPdfDownload?.addEventListener('click', () => {
    if (currentEntry) downloadEntriesWithNature([currentEntry]);
  });

  document.querySelectorAll('.abstract-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      abstractLang = btn.dataset.lang;
      syncAbstractToggle();
      if (currentEntry) renderSummary(currentEntry);
    });
  });

  // Entry filter
  if (entryFilter) {
    entryFilter.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        clearEntrySelection({ render: false, syncPaperChat: false });
        entryFilterValue = normalizeEntryFilterValue(btn.dataset.filter);
        persistEntryFilter();
        syncEntryFilterControls();
        renderEntryList(allEntries);
        refreshPaperChatAfterScopeDataChange();
      });
    });
  }

  entryTagFilter?.addEventListener('change', () => {
    clearEntrySelection({ render: false, syncPaperChat: false });
    entryTagFilterValue = entryTagFilter.value || 'all';
    persistCurrentFilterScope();
    renderEntryList(allEntries);
    refreshPaperChatAfterScopeDataChange();
  });

  entrySortSelect?.addEventListener('change', () => {
    clearEntrySelection({ render: false, syncPaperChat: false });
    entrySortField = entrySortSelect.value || 'default';
    entrySortDirectionMode = defaultEntrySortDirection(entrySortField);
    syncEntrySortMode();
    persistEntrySortMode();
    syncEntrySortControl();
    renderEntryList(allEntries);
    refreshPaperChatAfterScopeDataChange();
  });

  entrySortDirection?.addEventListener('click', () => {
    if (entrySortField === 'default') return;
    clearEntrySelection({ render: false, syncPaperChat: false });
    entrySortDirectionMode = entrySortDirectionMode === 'asc' ? 'desc' : 'asc';
    syncEntrySortMode();
    persistEntrySortMode();
    syncEntrySortControl();
    renderEntryList(allEntries);
    refreshPaperChatAfterScopeDataChange();
  });

  briefingSortSelect?.addEventListener('change', () => {
    briefingSortField = briefingSortSelect.value || 'date';
    briefingSortDirectionMode = 'desc';
    persistBriefingSort();
    syncBriefingSortControl();
    renderBriefingList();
  });
  briefingSortDirection?.addEventListener('click', () => {
    briefingSortDirectionMode = briefingSortDirectionMode === 'asc' ? 'desc' : 'asc';
    persistBriefingSort();
    syncBriefingSortControl();
    renderBriefingList();
  });

  btnDetailAddTag?.addEventListener('click', () => addTagsToCurrentEntry());
  detailTagInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTagsToCurrentEntry();
    }
  });

  btnEntrySelectMode?.addEventListener('click', () => {
    if (entrySelectionMode) clearEntrySelection();
    else {
      entrySelectionMode = true;
      syncEntryBulkActions();
      renderEntryList(allEntries);
    }
    focusEntryList();
  });

  btnEntryBulkSelectAll?.addEventListener('click', () => {
    if (!entrySelectionMode) {
      entrySelectionMode = true;
    }
    toggleSelectAllVisibleEntries();
    focusEntryList();
  });

  btnEntryBulkSelectUnnoted?.addEventListener('click', () => {
    if (!entrySelectionMode) {
      entrySelectionMode = true;
    }
    selectVisibleEntriesWithoutNotes();
    focusEntryList();
  });

  btnEntryBulkSelectNoted?.addEventListener('click', () => {
    if (!entrySelectionMode) {
      entrySelectionMode = true;
    }
    selectVisibleEntriesWithNotes();
    focusEntryList();
  });

  btnEntryBulkInvert?.addEventListener('click', () => {
    if (!entrySelectionMode) {
      entrySelectionMode = true;
    }
    invertVisibleEntrySelection();
    focusEntryList();
  });

  btnEntryBulkDeselect?.addEventListener('click', () => {
    clearSelectedEntriesOnly();
    focusEntryList();
  });

  entryBulkExistingMode?.addEventListener('change', () => {
    entryBulkExistingStrategy = entryBulkExistingMode.value === 'force' ? 'force' : 'skip';
    syncEntryBulkActions();
  });

  btnEntryBulkClear?.addEventListener('click', () => {
    clearEntrySelection();
    focusEntryList();
  });

  btnEntryBulkGenerate?.addEventListener('click', () => {
    const entries = getSelectedEntries();
    if (!entries.length) {
      setGlobalStatus('请先选择要批量生成笔记的文章', 'error');
      return;
    }
    if (!readingProfiles.length) {
      setGlobalStatus('当前没有可用的阅读模板', 'error');
      return;
    }
    const rect = btnEntryBulkGenerate.getBoundingClientRect();
    showReadingProfilePickerMenu(rect.left, rect.bottom + 6, (profileId) => generateReadingNotesForEntries(entries, profileId));
  });

  document.addEventListener('keydown', (e) => {
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && canHandleEntryArrowShortcut(e)) {
      e.preventDefault();
      navigateEntryList(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && key === 'a' && canHandleEntrySelectAllShortcut(e.target)) {
      e.preventDefault();
      if (!entrySelectionMode) {
        entrySelectionMode = true;
      }
      focusEntryList();
      selectAllVisibleEntries();
      return;
    }
    if (e.key === 'Escape' && entrySelectionMode) {
      clearEntrySelection();
    }
  });

  [
    ['if', entryMetricIfFilter],
    ['q', entryMetricQFilter],
    ['b', entryMetricBFilter],
    ['top', entryMetricTopFilter],
  ].forEach(([key, el]) => {
    if (!el) return;
    el.addEventListener('change', () => {
      clearEntrySelection({ render: false, syncPaperChat: false });
      entryMetricFilters[key] = normalizeEntryMetricFilterValue(key, el.value);
      persistEntryMetricFilters();
      syncEntryMetricFilterControls();
      renderEntryList(allEntries);
      refreshPaperChatAfterScopeDataChange();
    });
  });

  // Add feed input
  feedUrlInput.addEventListener('input', () => {
    const hasText = feedUrlInput.value.trim().length > 0;
    addFeedRow.classList.toggle('active', hasText);
    btnAddFeed.classList.toggle('hidden', !hasText);
  });
  feedUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFeed(); });
  btnAddFeed.addEventListener('click', addFeed);

  literatureSearchInput?.addEventListener('input', scheduleLiteratureSearch);
  literatureSearchInput?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearLiteratureSearch();
    }
  });
  btnClearLiteratureSearch?.addEventListener('click', () => {
    clearLiteratureSearch();
    literatureSearchInput?.focus();
  });

  document.getElementById('btn-new-pubmed-search')?.addEventListener('click', () => openPubmedSearchModal());
  document.getElementById('btn-new-feed')?.addEventListener('click', openFeedAddModal);
  document.querySelectorAll('[data-feed-add-modal-close]').forEach(element => {
    element.addEventListener('click', closeFeedAddModal);
  });
  document.querySelectorAll('[data-feed-add-mode]').forEach(button => {
    button.addEventListener('click', () => setFeedAddMode(button.dataset.feedAddMode));
  });
  document.getElementById('feed-add-url')?.addEventListener('input', syncFeedAddModalState);
  document.getElementById('feed-add-url')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || document.getElementById('btn-create-feed')?.disabled) return;
    event.preventDefault();
    createFeedFromModal();
  });
  document.getElementById('feed-author-name')?.addEventListener('input', syncFeedAddModalState);
  document.getElementById('btn-create-feed')?.addEventListener('click', createFeedFromModal);
  document.querySelectorAll('[data-pubmed-modal-close]').forEach(element => {
    element.addEventListener('click', closePubmedSearchModal);
  });
  document.getElementById('btn-generate-pubmed-query')?.addEventListener('click', generatePubmedQuery);
  document.getElementById('btn-build-pubmed-author-query')?.addEventListener('click', buildPubmedAuthorQuery);
  document.querySelectorAll('[data-pubmed-search-mode]').forEach(button => {
    button.addEventListener('click', () => setPubmedSearchBuilderMode(button.dataset.pubmedSearchMode));
  });
  document.getElementById('btn-open-pubmed-query')?.addEventListener('click', openPubmedQueryInBrowser);
  document.getElementById('btn-preview-pubmed-search')?.addEventListener('click', previewPubmedSearch);
  document.getElementById('btn-create-pubmed-search')?.addEventListener('click', createAndRunPubmedSearch);
  document.querySelectorAll('input[name="pubmed-retrieval-scope"]').forEach(input => {
    input.addEventListener('change', updatePubmedRetrievalUi);
  });
  document.getElementById('pubmed-retrieval-limit')?.addEventListener('input', updatePubmedRetrievalUi);
  ['pubmed-retrieval-date-from', 'pubmed-retrieval-date-to', 'pubmed-retrieval-sort'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', updatePubmedRetrievalUi);
  });
  document.getElementById('pubmed-batch-query-input')?.addEventListener('input', () => {
    invalidatePubmedPreview();
  });
  btnRunPubmedSearch?.addEventListener('click', runCurrentPubmedSearch);
  btnExportPubmed?.addEventListener('click', () => exportCurrentPubmedEntries());
  btnEntryBulkExport?.addEventListener('click', () => {
    exportCurrentPubmedEntries(entryBulkExportFormat?.value, btnEntryBulkExport);
  });
  pubmedSnapshotSelect?.addEventListener('change', () => activatePubmedSnapshot(pubmedSnapshotSelect.value));
  btnSavePubmedSnapshot?.addEventListener('click', saveCurrentPubmedSnapshot);
  btnDeletePubmedSnapshot?.addEventListener('click', deleteCurrentPubmedSnapshot);
  if (pubmedDateFilters) pubmedDateFilters.open = false;
  setupPubmedMonthPicker(pubmedPublishedFrom);
  setupPubmedMonthPicker(pubmedPublishedTo);
  [pubmedAddedFrom, pubmedAddedTo].forEach(element => {
    element?.addEventListener('click', () => {
      try {
        element.showPicker?.();
      } catch (_) {
        // The native input remains usable when this WebView does not expose showPicker().
      }
    });
  });
  btnCancelPubmedRun?.addEventListener('click', async () => {
    if (!activePubmedRunId) return;
    try {
      await invoke('cancel_pubmed_search_run', { runId: activePubmedRunId });
      pubmedProgressLabel.textContent = '正在取消…';
    } catch (e) {
      setGlobalStatus('取消失败: ' + e, 'error');
    }
  });
  [
    [pubmedStatusFilter, 'status'],
    [pubmedSort, 'sort'],
    [pubmedStarFilter, 'star'],
    [pubmedPublishedFrom, 'publishedFrom'],
    [pubmedPublishedTo, 'publishedTo'],
    [pubmedAddedFrom, 'addedFrom'],
    [pubmedAddedTo, 'addedTo'],
  ].forEach(([element, key]) => {
    element?.addEventListener('change', () => {
      pubmedFilters[key] = element.value || (key === 'status' || key === 'star' ? 'all' : (key === 'sort' ? 'publication-desc' : ''));
      persistCurrentFilterScope();
      pubmedRenderLimit = 200;
      clearEntrySelection({ render: false, syncPaperChat: false });
      renderEntryList(allEntries);
    });
  });
  pubmedBulkStatus?.addEventListener('change', async () => {
    const status = pubmedBulkStatus.value;
    pubmedBulkStatus.value = '';
    await applyBulkPubmedStatus(status);
  });
  btnPubmedAiScreen?.addEventListener('click', startPubmedAiScreening);

  // Generate briefing
  document.getElementById('btn-generate-briefing')?.addEventListener('click', generateBriefingNow);

  // Initialize sub-modules
  setupWindowDragFallback();
  initAppearanceControls();
  initPubmedGenerator();
  initBriefingSettings();
  syncAppearanceFromStorage();
  loadJournalMetrics();
  loadReadingProfiles();
  renderPaperChatProfileOptions();
  refreshPaperChatScopeControls();
  renderPaperChatMessages([]);
  renderPaperChatPinnedEntries();

  // Restore sidebar state
  sidebarCollapsed = localStorage.getItem('sidebar-collapsed') === '1';
  applyCollapsedState();

  setupCostEvents();
  loadCostSummary();
  syncEntryBulkActions();
  setupTranslationEvents();
  setupPubmedSearchEvents();
  wireTranslationBannerButtons();
  initUpdateChannel();
  ensureNotificationPermission();
  loadSettings();
  loadBriefings().then(() => startBriefingScheduler());
  // Backfill: catch up on any pre-existing entries that still need translation.
  // The pipeline itself is idempotent; if everything is already translated it
  // just returns immediately.
  invoke('start_translation_pipeline').catch(() => {});
});
