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
let toolbarSubtitle;
let apiKeyInput, baseUrlInput, modelInput, systemPromptInput;
let btnToggleApiKey, btnTest, btnSaveSettings, btnSaveGeneral;
let settingsStatus, generalStatus;
let retentionSelect, themeControl, accentSwatches, fontscaleControl;
let feedUrlInput, btnAddFeed, addFeedRow, addFeedIcon, feedListEl, globalStatusEl;
let entryListEl, briefingListEl, briefingItemsEl;
let entryItemsEl, entryFilter;
let entryMetricIfFilter, entryMetricQFilter, entryMetricBFilter, entryMetricTopFilter, entryTagFilter;
let entryBulkActions, entryBulkCount, btnEntrySelectMode, btnEntryBulkSelectAll, btnEntryBulkSelectUnnoted, btnEntryBulkSelectNoted, btnEntryBulkInvert, btnEntryBulkDeselect, entryBulkExistingMode, btnEntryBulkGenerate, btnEntryBulkClear;
let detailPanelEl, paperChatPanelEl, briefingDetailEl;
let paperChatResizerEl;
let detailEmpty, detailContent, detailTitle, detailJournal, detailAffiliation;
let detailIdentifierStrip;
let detailPublicationDate, detailDateSub;
let detailSummaryContent, detailSummarySection, detailSummaryRetry;
let detailReadingNotesContent;
let detailPaperChatHint, detailPaperChatMessages, detailPaperChatScopes, paperChatInput;
let paperChatScopeCaption, btnSendPaperChat, btnClearPaperChat, btnTogglePaperChat, btnShowPaperChat;
let paperChatPickedList, btnPaperChatAddCurrent, btnPaperChatClearPicked;
let paperChatPickedLabel;
let paperChatProfileSelect;
let readingProfileSortSelect, btnReadingProfilesSort;
let detailBadgeRow, detailSourceBadge, btnOpenUrl, btnRetrySummary;
let detailTagList, detailTagInput, btnDetailAddTag;
let briefingDetailEmpty, briefingDetailContent;

// ── App state ────────────────────────────────────
let currentEntry = null;
let allEntries = [];
let globalEntries = [];
let allFeeds = [];
let contextMenu = null;
let renamingFeedId = null;
let pubmedGeneratorApi = null;
let hasConfiguredApiKey = false;
let sidebarCollapsed = false;
let entryFilterValue = 'all';   // 'all' | 'unread' | 'starred' | 'reading-notes'
let entryTagFilterValue = 'all';
let currentTheme = 'light';
let currentAccent = 'coral';
let currentFontScale = 'md';
let selectedFeedId = null;
let abstractLang = 'zh';
let mode = 'feed';              // 'feed' | 'briefing'
let selectedBriefingId = null;
let journalMetricsIndex = null;
let journalMetricsLoadPromise = null;
let readingProfiles = [];
let editingReadingProfileId = null;
let editingReadingNoteId = null;
const entryMetricFilters = { if: 'all', q: 'all', b: 'all', top: 'all' };
const freeFulltextCheckInFlight = new Set();
let entrySelectionMode = false;
let selectedEntryIds = new Set();
let entrySelectionAnchorId = null;
let entryBulkExistingStrategy = 'skip';
let paperChatScope = 'single';
let paperChatPinnedEntries = [];
let currentPaperChatProfileId = '';
let paperChatCollapsed = false;
const PAPER_CHAT_MULTI_LIMIT = 5;
const PAPER_CHAT_WIDTH_STORAGE_KEY = 'paper-chat-width-v1';
const PAPER_CHAT_COLLAPSED_STORAGE_KEY = 'paper-chat-collapsed-v1';
const PAPER_CHAT_DEFAULT_WIDTH = 430;
const PAPER_CHAT_MIN_WIDTH = 320;
const PAPER_CHAT_MIN_APP_WIDTH = 1420;
const DETAIL_PANEL_MIN_WIDTH = 420;
const PANEL_RESIZER_WIDTH = 12;
const ENTRY_FILTER_STORAGE_KEY = 'entry-filter-v1';
const ENTRY_FILTER_OPTIONS = ['all', 'unread', 'starred', 'reading-notes'];
const ENTRY_METRIC_FILTER_STORAGE_KEY = 'entry-metric-filters-v1';
const ENTRY_METRIC_FILTER_OPTIONS = {
  if: ['all', 'ge5', 'ge10', 'ge20', 'na'],
  q: ['all', 'Q1', 'Q2', 'Q3', 'Q4', 'na'],
  b: ['all', 'B1', 'B2', 'B3', 'B4', 'na'],
  top: ['all', 'top', 'non-top', 'na'],
};

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

function persistEntryFilter() {
  try {
    localStorage.setItem(ENTRY_FILTER_STORAGE_KEY, normalizeEntryFilterValue(entryFilterValue));
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

function syncEntryFilterControls() {
  entryFilterValue = normalizeEntryFilterValue(entryFilterValue);

  if (entryFilter) {
    entryFilter.querySelectorAll('.seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === entryFilterValue);
    });
  }

  const activeSidebarView = mode === 'briefing'
    ? 'briefing'
    : (selectedFeedId ? null : entryFilterValue);
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

// ── Translation cost meter (real DeepSeek token usage) ─────────────
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
  const total = summary?.total_cny ?? 0;
  const tokens = (summary?.breakdown || []).reduce((acc, row) =>
    acc + row.prompt_cache_hit_tokens + row.prompt_cache_miss_tokens + row.completion_tokens,
  0);
  el('cost-value').textContent = formatCny(total);
  // Tokens accumulate visibly with every translation — much more responsive
  // than the ¥ value for tracking "did my translations register". For
  // Chinese output, one token ≈ one Chinese character, so the count also
  // reads naturally to the user.
  el('cost-chars').textContent = `${tokens.toLocaleString()} tokens`;
  // The progress bar is now scaled against a 20 ¥/month soft cap — a
  // reasonable monthly budget for a heavy reader. Adjust if needed; this
  // ratio is presentation-only and doesn't affect billing.
  const pct = Math.min(100, total / 20 * 100);
  el('cost-fill').style.width = pct + '%';
  const breakdown = summary?.breakdown || [];
  el('cost-model').textContent = breakdown.length > 0
    ? breakdown[0].model
    : ((modelInput?.value || 'deepseek-chat').trim() || 'deepseek-chat');
  // Detailed hover-tooltip so curious users can see the full breakdown
  // (cache hit/miss/output tokens per model).
  const meter = document.getElementById('cost-meter');
  if (meter) {
    if (breakdown.length === 0) {
      meter.title = '本月暂无翻译用量';
    } else {
      meter.title = breakdown
        .map(b =>
          `${b.model}: 缓存命中 ${b.prompt_cache_hit_tokens.toLocaleString()} · `
          + `缓存未命中 ${b.prompt_cache_miss_tokens.toLocaleString()} · `
          + `输出 ${b.completion_tokens.toLocaleString()} = ${formatCny(b.cny)}`
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

async function loadSettings() {
  try {
    const s = await invoke('get_settings');
    apiKeyInput.value = s.api_key || '';
    baseUrlInput.value = s.base_url || '';
    modelInput.value = s.model || '';
    systemPromptInput.value = s.system_prompt || '';
    retentionSelect.value = String(s.read_retention_days ?? 0);
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
  const settings = {
    api_key: apiKeyInput.value.trim(),
    base_url: baseUrlInput.value.trim(),
    model: modelInput.value.trim(),
    system_prompt: systemPromptInput.value.trim(),
    read_retention_days: parseInt(retentionSelect?.value, 10) || 0,
  };
  try {
    await invoke('save_settings', { settings });
    showSettingsStatus('设置已保存', 'success');
    updateView(!!settings.api_key);
    // If the user just configured (or updated) the API key, kick the pipeline so
    // any entries that were waiting for a key start translating immediately,
    // and refresh the balance card with the new credentials.
    if (settings.api_key) {
      invoke('start_translation_pipeline').catch(() => {});
      refreshDeepSeekBalance({ silent: true });
    }
  } catch (e) {
    showSettingsStatus('保存失败: ' + e, 'error');
  }
}

async function saveGeneralSettings() {
  const settings = {
    api_key: apiKeyInput.value.trim(),
    base_url: baseUrlInput.value.trim(),
    model: modelInput.value.trim(),
    system_prompt: systemPromptInput.value.trim(),
    read_retention_days: parseInt(retentionSelect?.value, 10) || 0,
  };
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
  const settings = {
    api_key: apiKeyInput.value.trim(),
    base_url: baseUrlInput.value.trim() || 'https://api.deepseek.com',
    model: modelInput.value.trim() || 'deepseek-v4-flash',
    system_prompt: systemPromptInput.value.trim(),
    read_retention_days: parseInt(retentionSelect?.value, 10) || 0,
  };
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
  setToolbarSubtitle(mode === 'briefing' ? 'briefing' : 'main');
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
  mainView.classList.toggle('sidebar-hidden', sidebarCollapsed);
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  btnSidebar.classList.toggle('active', !sidebarCollapsed);
  requestAnimationFrame(() => {
    applyPaperChatPanelWidth(loadPaperChatPanelWidth());
    syncPaperChatResizerVisibility();
  });
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
  // Keep the macOS tray badge in sync with the unread count.
  pushTrayUnread();
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
  mode = 'feed';
  enterFeedMode();
  document.querySelectorAll('.feed-item').forEach(el => el.classList.toggle('selected', parseInt(el.dataset.feedId) === feedId));
  selectedFeedId = feedId;
  syncEntryFilterControls();
  const feed = allFeeds.find(f => f.id === feedId);
  if (feed) updateToolbarFeedInfo(feed);
  loadEntries(feedId);
}

function updateToolbarFeedInfo(feed) {
  if (!toolbarSubtitle) return;
  if (!settingsView.classList.contains('hidden')) return;
  if (mode === 'briefing') { setToolbarSubtitle('briefing'); return; }
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

// ── Add Feed input (pill with animated states) ─
async function addFeed() {
  const url = feedUrlInput.value.trim();
  if (!url) { setGlobalStatus('请输入 RSS URL', 'error'); return; }
  setGlobalStatus('');
  btnAddFeed.disabled = true;
  addFeedRow.classList.add('adding');
  feedUrlInput.placeholder = '正在拉取…';
  try {
    await invoke('add_feed', { url });
    addFeedRow.classList.remove('adding');
    addFeedRow.classList.add('added');
    if (addFeedIcon) addFeedIcon.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.3 6.5 11 12.5 4.8"/></svg>`;
    feedUrlInput.value = '';
    feedUrlInput.placeholder = '订阅源已添加';
    btnAddFeed.classList.add('hidden');
    setTimeout(() => {
      addFeedRow.classList.remove('added');
      feedUrlInput.placeholder = '添加订阅源 · 粘贴 RSS URL';
      if (addFeedIcon) addFeedIcon.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3.5" x2="8" y2="12.5"/><line x1="3.5" y1="8" x2="12.5" y2="8"/></svg>`;
    }, 1400);
    await loadFeeds();
    if (!document.getElementById('section-feeds').classList.contains('hidden')) renderFeedSettingsList();
  } catch (e) {
    addFeedRow.classList.remove('adding');
    feedUrlInput.placeholder = '添加订阅源 · 粘贴 RSS URL';
    setGlobalStatus('添加失败: ' + e, 'error');
  } finally {
    btnAddFeed.disabled = false;
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
function showContextMenu(x, y, feed) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.innerHTML = `
    <div class="context-item" data-action="refresh">更新订阅源</div>
    <div class="context-separator"></div>
    <div class="context-item" data-action="rename">重命名</div>
    <div class="context-separator"></div>
    <div class="context-item context-item-danger" data-action="delete">删除</div>
  `;
  menu.addEventListener('click', async e => {
    const action = e.target.dataset.action;
    if (!action) return;
    hideContextMenu();
    if (action === 'refresh') {
      await refreshFeed(feed);
    } else if (action === 'rename') {
      startRenameFeed(feed.id);
    } else if (action === 'delete') {
      if (await confirmDialog('确定删除该订阅源及其所有文章？')) deleteFeed(feed.id);
    }
  });
  document.body.appendChild(menu);
  contextMenu = menu;
  document.addEventListener('click', hideContextMenu, { once: true });
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
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
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
  document.body.appendChild(menu);
  contextMenu = menu;
  document.addEventListener('click', hideContextMenu, { once: true });
}

function showEntryContextMenu(x, y, entry) {
  const targetEntries = getContextMenuEntries(entry);
  const isBatch = targetEntries.length > 1;
  const translatableEntries = targetEntries.filter(entryNeedsManualTranslation);

  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  let items = '';
  if (translatableEntries.length) {
    items += `<div class="context-item" data-action="translate">${isBatch ? `翻译所选 ${translatableEntries.length} 篇` : '翻译'}</div>`;
  }
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
    if (action === 'translate') {
      await translateEntries(targetEntries);
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
  document.body.appendChild(menu);
  contextMenu = menu;
  document.addEventListener('click', hideContextMenu, { once: true });
}

function hideContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
}

function getFilteredEntries(entries = allEntries) {
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
  return filtered;
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
  entryBulkExistingMode.classList.toggle('hidden', !entrySelectionMode);
  entryBulkExistingMode.value = entryBulkExistingStrategy;
  btnEntryBulkGenerate.classList.toggle('hidden', !entrySelectionMode);
  btnEntryBulkGenerate.disabled = count === 0 || !readingProfiles.length;
  btnEntryBulkClear.classList.toggle('hidden', !entrySelectionMode);
  btnEntrySelectMode.textContent = entrySelectionMode ? '退出多选' : '多选';
  btnEntrySelectMode.classList.toggle('active', entrySelectionMode);
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

function entryNeedsManualTranslation(entry) {
  return !entry.title_translated || !entry.summary_translated;
}

async function translateEntries(entries) {
  const targetEntries = entries.filter(entryNeedsManualTranslation);
  if (!targetEntries.length) {
    setGlobalStatus('所选文章都已有翻译', 'success');
    return;
  }

  const failures = [];
  for (let index = 0; index < targetEntries.length; index += 1) {
    const entry = targetEntries[index];
    const title = entry.title_translated || entry.title || `文献 ${entry.id}`;
    setGlobalStatus(`正在翻译（${index + 1}/${targetEntries.length}）：${title}`, 'progress');
    try {
      await invoke('translate_entry_missing', { entryId: entry.id });
    } catch (e) {
      failures.push({
        entry,
        message: typeof e === 'string' ? e : (e && e.message) || '翻译失败',
      });
    }
  }

  if (!failures.length) {
    setGlobalStatus(`已完成 ${targetEntries.length} 篇文章的翻译`, 'success');
    return;
  }

  const preview = failures
    .slice(0, 3)
    .map(item => item.entry.title_translated || item.entry.title || `文献 ${item.entry.id}`)
    .join('；');
  const suffix = failures.length > 3 ? ` 等 ${failures.length} 篇` : '';
  setGlobalStatus(
    `翻译完成：成功 ${targetEntries.length - failures.length} 篇，失败 ${failures.length} 篇。${preview}${suffix}`,
    'error',
  );
}

function showReadingProfilePickerMenu(x, y, onSelect) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

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

  document.body.appendChild(menu);
  contextMenu = menu;
  document.addEventListener('click', hideContextMenu, { once: true });
}

async function setEntryRead(entry, isRead) {
  const prev = entry.is_read;
  entry.is_read = isRead;
  const g = globalEntries.find(e => e.id === entry.id);
  if (g) {
    g.is_read = isRead;
    if (isRead && !g.read_at) g.read_at = new Date().toISOString();
  }
  renderEntryList(allEntries);
  updateOverviewCounts();
  renderFeedList(allFeeds);
  const feed = allFeeds.find(f => f.id === entry.feed_id);
  if (feed) updateToolbarFeedInfo(feed);
  try {
    await invoke('set_entry_read', { entryId: entry.id, isRead });
  } catch (e) {
    entry.is_read = prev;
    if (g) g.is_read = prev;
    renderEntryList(allEntries);
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

function normalizeEntryMetricFilterValue(key, value) {
  const options = ENTRY_METRIC_FILTER_OPTIONS[key] || ['all'];
  return options.includes(value) ? value : 'all';
}

function persistEntryMetricFilters() {
  try {
    localStorage.setItem(ENTRY_METRIC_FILTER_STORAGE_KEY, JSON.stringify(entryMetricFilters));
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
  const journal = journalName(entry);
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
  const typedQuestion = paperChatInput?.value.trim() || '';
  const activeProfile = getCurrentPaperChatProfile();
  const usesSkillTemplate = activeProfile?.source_kind === 'skill';
  btnSendPaperChat.textContent = usesSkillTemplate
    ? (typedQuestion ? '模板+要求发送' : '按模板发送')
    : '发送';
  btnSendPaperChat.title = usesSkillTemplate
    ? (typedQuestion
      ? `当前将按 ${activeProfile.name} 的默认模板并合并你的附加要求发送`
      : `当前将按 ${activeProfile.name} 的默认模板直接发送`)
    : '';
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
    renderEntryList(allEntries);
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
    const title = entry.title_translated || entry.title;
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
      items: paperChatPinnedEntries
        .slice(0, PAPER_CHAT_MULTI_LIMIT)
        .map(item => ({
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

  const overflowNote = meta.totalCount > items.length
    ? `<div class="paper-chat-picked-note">当前范围共 ${meta.totalCount} 篇，本轮展示并使用前 ${items.length} 篇。</div>`
    : '';

  paperChatPickedList.innerHTML = `
    ${overflowNote}
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
    const effective = Math.min(pinnedEntries.length, PAPER_CHAT_MULTI_LIMIT);
    return {
      key: 'manual',
      label: pinnedEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `手动已选 ${pinnedEntries.length} 篇（取前 ${effective}）`
        : `手动已选 ${effective} 篇`,
      caption: pinnedEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `手动已选 ${pinnedEntries.length} 篇，本轮取前 ${effective} 篇`
        : `手动已选 ${effective} 篇文献`,
      hint: pinnedEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `当前按右侧手动加入的文献回答。本轮只使用前 ${effective} 篇。`
        : '当前按右侧手动加入的文献回答。可持续增减文献后继续追问。',
      entries: pinnedEntries
        .slice(0, PAPER_CHAT_MULTI_LIMIT)
        .map(item => item._entry || { id: item.id }),
      totalCount: pinnedEntries.length,
    };
  }

  if (scope === 'selection' && selectedEntries.length > 1) {
    const effective = Math.min(selectedEntries.length, PAPER_CHAT_MULTI_LIMIT);
    return {
      key: 'selection',
      label: selectedEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `已选 ${selectedEntries.length} 篇（取前 ${effective}）`
        : `已选 ${effective} 篇`,
      caption: selectedEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `已选 ${selectedEntries.length} 篇，本轮取前 ${effective} 篇`
        : `已选 ${effective} 篇文献`,
      hint: selectedEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `当前按已选文献联合回答。为控制速度与长度，本轮只使用前 ${effective} 篇。`
        : '当前按已选文献联合回答。',
      entries: selectedEntries.slice(0, PAPER_CHAT_MULTI_LIMIT),
      totalCount: selectedEntries.length,
    };
  }

  if (scope === 'feed' && selectedFeedId && sourceEntries.length > 1) {
    const effective = Math.min(sourceEntries.length, PAPER_CHAT_MULTI_LIMIT);
    return {
      key: 'feed',
      label: sourceEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `当前订阅源 ${sourceEntries.length} 篇（取前 ${effective}）`
        : `当前订阅源 ${effective} 篇`,
      caption: sourceEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `当前订阅源共 ${sourceEntries.length} 篇，本轮取前 ${effective} 篇`
        : `当前订阅源 ${effective} 篇文献`,
      hint: sourceEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `当前按所选订阅源中的多篇文献联合回答。本轮只使用列表前 ${effective} 篇。`
        : '当前按所选订阅源中的多篇文献联合回答。',
      entries: sourceEntries.slice(0, PAPER_CHAT_MULTI_LIMIT),
      totalCount: sourceEntries.length,
    };
  }

  if (scope === 'tag' && tagEntries.length > 1) {
    const effective = Math.min(tagEntries.length, PAPER_CHAT_MULTI_LIMIT);
    const tagLabel = `标签“${entryTagFilterValue}”`;
    return {
      key: 'tag',
      label: tagEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `${tagLabel} ${tagEntries.length} 篇（取前 ${effective}）`
        : `${tagLabel} ${effective} 篇`,
      caption: tagEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `${tagLabel}共 ${tagEntries.length} 篇，本轮取前 ${effective} 篇`
        : `${tagLabel}${effective} 篇文献`,
      hint: tagEntries.length > PAPER_CHAT_MULTI_LIMIT
        ? `当前按标签“${entryTagFilterValue}”的文献联合回答。本轮只使用前 ${effective} 篇。`
        : `当前按标签“${entryTagFilterValue}”的文献联合回答。`,
      entries: tagEntries.slice(0, PAPER_CHAT_MULTI_LIMIT),
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
  if (!currentEntry || !paperChatInput) return;
  const activeProfile = getCurrentPaperChatProfile();
  const typedQuestion = paperChatInput.value.trim();
  const question = buildPaperChatQuestion(typedQuestion, activeProfile);
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
  paperChatInput.value = '';
  refreshPaperChatComposerState();
  if (btnSendPaperChat) btnSendPaperChat.disabled = true;
  renderPaperChatMessages([], { loading: true });
  setGlobalStatus(`正在生成文献回答：${getPaperChatScopeLabel()}`, 'progress');

  try {
    const messages = await invoke('ask_paper_chat', {
      entryIds,
      question,
      profileId: getPaperChatProfileId(),
    });
    renderPaperChatMessages(messages);
    setGlobalStatus('文献对话已更新', 'success');
  } catch (e) {
    paperChatInput.value = draft;
    refreshPaperChatComposerState();
    await loadPaperChatMessages();
    setGlobalStatus('文献对话失败: ' + e, 'error');
  } finally {
    if (btnSendPaperChat) btnSendPaperChat.disabled = false;
    refreshPaperChatComposerState();
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

function renderEntryList(entries) {
  syncEntryFilterControls();
  syncEntryMetricFilterControls();
  const stars = starredIds();
  const filtered = getFilteredEntries(entries);

  const selectedId = entryItemsEl.querySelector('.entry-item.selected')?.dataset?.entryId;
  entryItemsEl.innerHTML = '';

  if (filtered.length === 0) {
    let msg;
    if (entryTagFilterValue !== 'all' && hasActiveEntryMetricFilters()) msg = '当前标签与分区筛选下没有文章';
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
    const title = entry.title_translated || entry.title;
    const timeStr = entry.published_at ? timeAgo(entry.published_at) : '';
    const source = journalName(entry);

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
	    if (entry.title_translated && entry.summary_translated) {
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
    const leadMarkerHtml = entrySelectionMode
      ? `<span class="entry-select-checkbox ${isBulkSelected ? 'checked' : ''}" aria-hidden="true"></span>`
      : '<span class="entry-read-dot"></span>';

    li.innerHTML = `
      <div class="entry-dot-col">${leadMarkerHtml}</div>
      <div class="entry-body">
        <div class="entry-row-top">
          <div class="entry-title">${escapeHtml(title)}${tagHtml}${isTranslating ? ' <span class="entry-spinner"></span>' : ''}</div>
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

  syncEntryBulkActions();
}

// ── Detail panel ───────────────────────────────
function showDetail(entry) {
  currentEntry = entry;
  paperChatScope = 'single';
  detailEmpty.classList.add('hidden');
  detailContent.classList.remove('hidden');
  renderPaperChatPinnedEntries();

  detailTitle.textContent = entry.title_translated || entry.title;
  renderDetailJournalMeta(entry);

  applyAffiliation(entry);
  renderDetailIdentifiers(entry);
  ensureAffiliationLoaded(entry);
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

  if (entry.title_translated && entry.summary_translated) {
    detailSourceBadge.textContent = '已翻译';
    detailBadgeRow.classList.remove('hidden');
  } else {
    detailBadgeRow.classList.add('hidden');
  }

  const starBtn = document.getElementById('btn-star');
  if (starBtn) starBtn.classList.toggle('active', starredIds().has(entry.id));

  const aiFooter = document.getElementById('detail-ai-footer');
  const modelName = (modelInput?.value || 'DeepSeek').trim() || 'DeepSeek';
  document.getElementById('ai-model-name').textContent = `由 ${modelName} 翻译`;
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
  // 2) Translated text available, zh tab → show it
  if (entry.summary_translated && abstractLang === 'zh') {
    detailSummaryContent.innerHTML = `<p>${escapeHtml(entry.summary_translated)}</p>`;
    return;
  }
  // 3) Original summary available (any of: en tab; or zh tab without translation yet)
  if (entry.summary && (abstractLang === 'en' || !entry.summary_translated)) {
    const clean = stripHtml(entry.summary);
    detailSummaryContent.innerHTML = `<p class="detail-summary-original">${escapeHtml(clean)}</p>`;
    return;
  }
  // 4) No summary yet — either still fetching (or we never will)
  if (state === 'loading') detailSummaryContent.innerHTML = '<p class="detail-summary-empty">正在获取 Abstract…</p>';
  else detailSummaryContent.innerHTML = '<p class="detail-summary-empty">未能自动获取 Abstract。可以打开原文查看。</p>';
}

function refreshDetailTitleSpinner(entry) {
  if (!detailTitle) return;
  let spin = document.getElementById('detail-title-spinner');
  if (entry._titleTranslating) {
    if (!spin) {
      spin = document.createElement('span');
      spin.id = 'detail-title-spinner';
      spin.className = 'detail-title-spinner';
      detailTitle.appendChild(spin);
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
    if (currentEntry && currentEntry.id === entry.id) renderDetailIdentifiers(currentEntry);
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
  // Mirror translation-progress events: clear the error pill across all
  // entry collections so the middle-column badge disappears immediately.
  applyEntryUpdate(entryId, x => {
    x._summaryTranslating = true;
    x._transError = null;
  });
  renderEntryList(allEntries);
  if (currentEntry && currentEntry.id === entryId) renderSummary(currentEntry);
  try {
    const translated = await invoke('translate_summary', { entryId });
    applyEntryUpdate(entryId, x => {
      x.summary_translated = translated;
      x._summaryTranslating = false;
      x._transError = null;
    });
    addTranslationCost(translated.length);
  } catch (e) {
    const msg = (typeof e === 'string') ? e : (e && e.message) || '翻译失败';
    applyEntryUpdate(entryId, x => {
      x._summaryTranslating = false;
      x._transError = msg;
    });
  } finally {
    renderEntryList(allEntries);
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

function loadPaperChatPanelWidth() {
  try {
    const raw = parseInt(localStorage.getItem(PAPER_CHAT_WIDTH_STORAGE_KEY) || '', 10);
    return Number.isFinite(raw) ? raw : PAPER_CHAT_DEFAULT_WIDTH;
  } catch {
    return PAPER_CHAT_DEFAULT_WIDTH;
  }
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
  if (mode !== 'feed') return true;
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
  btnShowPaperChat?.classList.toggle('hidden', mode !== 'feed' || !paperChatCollapsed || autoHidden);
  btnTogglePaperChatToolbar?.classList.toggle('hidden', mode !== 'feed');
  btnTogglePaperChatToolbar?.classList.toggle('active', mode === 'feed' && !shouldHide);
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

    renderEntryList(allEntries);
    updateOverviewCounts();
    if (currentEntry && currentEntry.id === id) {
      // Re-render only the parts that changed instead of resetting the panel
      detailTitle.textContent = currentEntry.title_translated || currentEntry.title;
      refreshDetailTitleSpinner(currentEntry);
      const aiFooter = document.getElementById('detail-ai-footer');
      if (currentEntry.title_translated || currentEntry.summary_translated) {
        aiFooter?.classList.remove('hidden');
      }
      if (currentEntry.title_translated && currentEntry.summary_translated) {
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
        text: `检测到 ${p.pending || ''} 篇待翻译文章，但未配置 DeepSeek API Key。前往设置填写后会自动翻译。`,
      });
    } else if (p.status === 'auth_failed') {
      showTranslationBanner({
        kind: 'auth_failed',
        text: `DeepSeek API Key 无效或已过期，请打开设置重新填写并测试连接。${p.message ? `（${p.message}）` : ''}`,
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
  evt?.listen?.('update-checked', (e) => {
    const info = e.payload || {};
    renderUpdateResult(info, { statusEl, actionsEl, btnDownload, btnRelease });
    if (metaEl) metaEl.textContent = `上次检查：${formatLocalTime(new Date().toISOString())}`;
  });
}

function renderUpdateResult(info, { statusEl, actionsEl, btnDownload, btnRelease }) {
  if (!info || !statusEl) return;
  if (info.has_update) {
    statusEl.classList.add('has-update');
    statusEl.textContent = `🎉 新版本 v${info.latest_version} 已发布（当前 v${info.current_version}）`;
    if (actionsEl) {
      actionsEl.classList.remove('hidden');
      // Prefer the direct .dmg asset; fall back to the release page if the
      // tag doesn't have an attached installer yet.
      if (btnDownload) {
        btnDownload.href = info.asset_url || info.release_url;
        btnDownload.textContent = info.asset_url ? '下载安装包' : '前往下载页';
      }
      if (btnRelease) btnRelease.href = info.release_url;
    }
  } else {
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
    await loadEntries(selectedFeedId);
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
    await loadEntries(selectedFeedId);
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
  renderBriefingList();
  updateOverviewCounts();
}

function enterBriefingMode() {
  mode = 'briefing';
  entryListEl.classList.add('hidden');
  detailPanelEl.classList.add('hidden');
  syncPaperChatResizerVisibility();
  briefingListEl.classList.remove('hidden');
  briefingDetailEl.classList.remove('hidden');
  document.querySelectorAll('.feed-item').forEach(el => el.classList.remove('selected'));
  syncEntryFilterControls();
  setToolbarSubtitle('briefing');
  renderBriefingList();
  if (BRIEFINGS.length > 0) {
    const target = selectedBriefingId && BRIEFINGS.find(b => b.id === selectedBriefingId)
      ? selectedBriefingId
      : BRIEFINGS[0].id;
    selectBriefing(target);
  } else {
    showBriefingEmpty();
  }
}

function enterFeedMode() {
  mode = 'feed';
  briefingListEl.classList.add('hidden');
  briefingDetailEl.classList.add('hidden');
  entryListEl.classList.remove('hidden');
  detailPanelEl.classList.remove('hidden');
  applyPaperChatPanelWidth(loadPaperChatPanelWidth());
  syncPaperChatResizerVisibility();
  syncEntryFilterControls();
}

function renderBriefingList() {
  if (!briefingItemsEl) return;
  briefingItemsEl.innerHTML = '';

  if (BRIEFINGS.length === 0) {
    briefingItemsEl.innerHTML = `
      <li class="entry-empty">
        <div style="margin-bottom: 12px;">还没有生成简报</div>
        <div style="font-size: 11.5px; color: var(--text-tertiary); line-height: 1.6;">点击右上角「立即生成」按需创建，或在「设置 → AI 简报」配置自动生成频率。</div>
      </li>`;
    return;
  }

  BRIEFINGS.forEach(b => {
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

  document.getElementById('briefing-detail-footer-text').innerHTML =
    `<span class="ai-footer-strong">由 deepseek-v4-pro 生成</span>，覆盖 ${(b.counts?.feeds || 0)} 个订阅源、${(b.counts?.articles || 0)} 篇文献。可在「AI 简报」设置调整频率与 Prompt。`;
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

  // Failure backoff: don't hammer DeepSeek if recent attempts failed.
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
  renderFeedPrefsFromCounts(stats.feed_read_counts || []);

  // Easter-egg copy refresh runs detached so a slow DeepSeek round trip never
  // blocks the stats render — local pool always paints first.
  maybeRefreshFlavorPool();
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
// works offline. DeepSeek tops the pool up in the background on a weekly cadence
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

// Fire-and-forget weekly refresh of the DeepSeek-generated pool. All errors
// are swallowed — the local pool guarantees the UI never goes blank. The
// actual DeepSeek call lives in Rust (entry_service::generate_flavor_pool)
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
    if (Array.isArray(fresh) && fresh.length > 0) {
      saveFlavorState({
        ...state,
        pool: fresh.slice(0, 20),
        generatedAt: Date.now(),
      });
    } else {
      // Mark the attempt anyway so we don't hammer the API on every render
      // when DeepSeek returns nothing useful.
      saveFlavorState({ ...state, generatedAt: Date.now() });
    }
  } catch (e) {
    // Swallow silently — local pool is the source of truth, this is enrichment.
    console.warn('[flavor] DeepSeek refresh skipped:', e?.message || e);
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
function timeAgo(dateStr) {
  const now = Date.now(), then = new Date(dateStr).getTime();
  if (isNaN(then)) return '';
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + ' 天前';
  return new Date(dateStr).toLocaleDateString('zh-CN');
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
  if (authors.length === 0) return '';
  if (authors.length === 1) return authors[0];
  const first = authors[0];
  const last = authors[authors.length - 1];
  if (first === last) return first;
  return `${first}, ⋆ ${last}`;
}

// entry.source is the journal name parsed from the RSS description by
// article_service::extract_source on the Rust side (already trimmed to just
// the journal). NOT to be confused with feed.title, which is the user's
// custom RSS feed name (e.g. a PubMed search query).
function journalName(entry) {
  return (entry?.source || '').trim();
}

function formatPublicationDate(entry) {
  if (entry.publication_date) return entry.publication_date;
  if (!entry.published_at) return '';
  const d = new Date(entry.published_at);
  if (Number.isNaN(d.getTime())) return entry.published_at;
  return d.toLocaleDateString('zh-CN');
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

  // Toolbar
  btnSettings = document.getElementById('btn-settings');
  btnSidebar  = document.getElementById('btn-sidebar');
  btnTogglePaperChatToolbar = document.getElementById('btn-toggle-paper-chat-toolbar');
  btnRefresh  = document.getElementById('btn-refresh');
  refreshIcon = document.getElementById('refresh-icon');

  // Settings inputs
  apiKeyInput       = document.getElementById('api-key');
  baseUrlInput      = document.getElementById('base-url');
  modelInput        = document.getElementById('model');
  systemPromptInput = document.getElementById('system-prompt');
  retentionSelect   = document.getElementById('read-retention');
  btnToggleApiKey   = document.getElementById('btn-toggle-api-key');
  btnTest           = document.getElementById('btn-test');
  btnSaveSettings   = document.getElementById('btn-save-settings');
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
  feedListEl    = document.getElementById('feed-list');
  globalStatusEl = document.getElementById('global-status');

  // Entry list
  entryListEl     = document.getElementById('entry-list');
  entryItemsEl    = document.getElementById('entry-items');
  entryFilter     = document.getElementById('entry-filter');
  entryBulkActions = document.getElementById('entry-bulk-actions');
  entryBulkCount = document.getElementById('entry-bulk-count');
  btnEntrySelectMode = document.getElementById('btn-entry-select-mode');
  btnEntryBulkSelectAll = document.getElementById('btn-entry-bulk-select-all');
  btnEntryBulkSelectUnnoted = document.getElementById('btn-entry-bulk-select-unnoted');
  btnEntryBulkSelectNoted = document.getElementById('btn-entry-bulk-select-noted');
  btnEntryBulkInvert = document.getElementById('btn-entry-bulk-invert');
  btnEntryBulkDeselect = document.getElementById('btn-entry-bulk-deselect');
  entryBulkExistingMode = document.getElementById('entry-bulk-existing-mode');
  btnEntryBulkGenerate = document.getElementById('btn-entry-bulk-generate');
  btnEntryBulkClear = document.getElementById('btn-entry-bulk-clear');
  entryMetricIfFilter = document.getElementById('entry-metric-if-filter');
  entryMetricQFilter = document.getElementById('entry-metric-q-filter');
  entryMetricBFilter = document.getElementById('entry-metric-b-filter');
  entryMetricTopFilter = document.getElementById('entry-metric-top-filter');
  entryTagFilter = document.getElementById('entry-tag-filter');
  restoreEntryFilter();
  syncEntryFilterControls();
  restoreEntryMetricFilters();
  syncEntryMetricFilterControls();

  // Briefing list
  briefingListEl  = document.getElementById('briefing-list');
  briefingItemsEl = document.getElementById('briefing-items');

  // Detail
  detailPanelEl        = document.getElementById('detail-panel');
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
  detailReadingNotesContent = document.getElementById('detail-reading-notes-content');
  detailPaperChatHint = document.getElementById('detail-paper-chat-hint');
  detailPaperChatMessages = document.getElementById('detail-paper-chat-messages');
  detailPaperChatScopes = document.getElementById('detail-paper-chat-scopes');
  paperChatInput       = document.getElementById('paper-chat-input');
  paperChatScopeCaption = document.getElementById('paper-chat-scope-caption');
  paperChatPickedList = document.getElementById('paper-chat-picked-list');
  paperChatPickedLabel = document.getElementById('paper-chat-picked-label');
  paperChatProfileSelect = document.getElementById('paper-chat-profile-select');
  readingProfileSortSelect = document.getElementById('reading-profiles-sort');
  btnReadingProfilesSort = document.getElementById('reading-profiles-apply-sort');
  detailBadgeRow       = document.getElementById('detail-badge-row');
  detailSourceBadge    = document.getElementById('detail-source-badge');
  btnOpenUrl           = document.getElementById('btn-open-url');
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
  briefingDetailEmpty  = document.getElementById('briefing-detail-empty');
  briefingDetailContent = document.getElementById('briefing-detail-content');

  setupPaperChatResizer();

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
    if (mode !== 'feed' || shouldAutoHidePaperChatPanel()) return;
    setPaperChatCollapsed(!paperChatCollapsed);
  });

  btnRefresh.addEventListener('click', refreshAll);
  btnToggleApiKey.addEventListener('click', toggleApiKeyVisibility);
  btnTest.addEventListener('click', testConnection);
  btnSaveSettings.addEventListener('click', saveTranslationSettings);
  btnSaveGeneral?.addEventListener('click', saveGeneralSettings);
  btnRetrySummary?.addEventListener('click', retrySummaryTranslation);
  document.getElementById('btn-refresh-balance')?.addEventListener('click', () => refreshDeepSeekBalance());
  document.getElementById('btn-reading-profile-new')?.addEventListener('click', () => {
    fillReadingProfileEditor(null);
    setReadingProfileStatus('已切换到新建模式');
  });
  btnReadingProfilesSort?.addEventListener('click', applyReadingProfileSort);
  document.getElementById('btn-reading-profile-import-skill')?.addEventListener('click', importReadingSkillProfile);
  document.getElementById('btn-reading-profile-save')?.addEventListener('click', saveReadingProfile);
  document.getElementById('btn-reading-profile-delete')?.addEventListener('click', () => deleteReadingProfile());
  btnSendPaperChat?.addEventListener('click', sendPaperChatQuestion);
  btnClearPaperChat?.addEventListener('click', clearPaperChatMessages);
  btnTogglePaperChat?.addEventListener('click', () => setPaperChatCollapsed(true));
  btnShowPaperChat?.addEventListener('click', () => setPaperChatCollapsed(false));
  btnPaperChatAddCurrent?.addEventListener('click', () => addCurrentEntryToPaperChat());
  btnPaperChatClearPicked?.addEventListener('click', () => clearPaperChatPinnedEntries());
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPaperChatQuestion();
    }
  });
  refreshPaperChatComposerState();
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
      if (view === 'briefing') { enterBriefingMode(); return; }
      enterFeedMode();
      document.querySelectorAll('.feed-item').forEach(el => el.classList.remove('selected'));
      selectedFeedId = null;
      entryFilterValue = normalizeEntryFilterValue(view);
      persistEntryFilter();
      syncEntryFilterControls();
      setToolbarSubtitle('main');
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
    renderEntryList(allEntries);
    refreshPaperChatAfterScopeDataChange();
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
