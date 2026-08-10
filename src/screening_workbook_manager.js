function workbookTimestamp(workbook) {
  const values = [
    workbook.lastImportedAt && `同步 ${new Date(workbook.lastImportedAt).toLocaleString('zh-CN')}`,
    workbook.lastExportedAt && `导出 ${new Date(workbook.lastExportedAt).toLocaleString('zh-CN')}`,
  ].filter(Boolean);
  return values.join(' · ') || '尚未同步';
}

function scopeKey(scope) {
  return `${scope.scopeKind}:${Number(scope.scopeId)}`;
}

export function renderScreeningWorkbookManager(container, options = {}) {
  const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
  const workbooks = Array.isArray(options.workbooks) ? options.workbooks : [];
  const scopes = Array.isArray(options.scopes) ? options.scopes : [];
  const activeScopeKey = options.activeScopeKey || scopeKey(scopes[0] || {});
  const automaticCount = workbooks.filter(workbook => workbook.managed === 'cento').length;
  const rows = workbooks.map((workbook, index) => ({ workbook, index })).sort((left, right) => {
    const scopeOrder = scopeKey(left.workbook).localeCompare(scopeKey(right.workbook));
    if (scopeOrder) return scopeOrder;
    return Number(right.workbook.managed === 'cento') - Number(left.workbook.managed === 'cento');
  });
  container.className = 'screening-workbook-manager';
  container.innerHTML = `<header class="screening-workbook-manager-header">
    <div><h2>所有检索工作簿</h2><p>${escapeHtml(options.scopeLabel || '集中管理初筛 Excel')}</p><div class="screening-workbook-summary"><span><strong>${scopes.filter(scope => scope.scopeKind === 'pubmed').length}</strong> 个 PubMed 检索</span><span><strong>${workbooks.length}</strong> 个已登记工作簿</span><span><strong>${automaticCount}</strong> 个自动工作簿</span></div></div>
    <div class="screening-workbook-manager-header-actions"><button type="button" class="btn btn-secondary" data-workbook-action="return-current">返回当前检索</button><label class="screening-workbook-target"><span>操作范围</span><select data-workbook-target>${scopes.map(scope => `<option value="${escapeHtml(scopeKey(scope))}" ${scopeKey(scope) === activeScopeKey ? 'selected' : ''}>${escapeHtml(scope.label)}</option>`).join('')}</select></label><button type="button" class="btn btn-secondary" data-workbook-action="import">导入 Excel</button><button type="button" class="btn btn-primary" data-workbook-action="create">新建副本</button></div>
  </header>
  ${options.initializationError ? `<div class="screening-workbook-notice">${escapeHtml(options.initializationError)}</div>` : ''}
  <label class="screening-workbook-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="搜索检索词、文件名或路径" aria-label="搜索 Excel 工作簿"></label>
  <div class="screening-workbook-list">${workbooks.length ? `<div class="screening-workbook-list-heading"><span>检索词</span><span>工作簿</span><span>文献数</span><span>最近操作</span><span>操作</span></div>${rows.map(({ workbook, index }) => `<article class="screening-workbook-row" data-workbook-index="${index}" data-workbook-search="${escapeHtml(`${workbook.scopeLabel} ${workbook.name} ${workbook.path}`.toLowerCase())}">
    <div class="screening-workbook-row-scope"><strong>${escapeHtml(workbook.scopeLabel || '未知初筛范围')}</strong><em class="screening-workbook-kind">${workbook.managed === 'cento' ? '自动管理' : '手动登记'}</em></div>
    <div class="screening-workbook-row-main"><strong title="${escapeHtml(workbook.path)}">${escapeHtml(workbook.name)}</strong></div>
    <div class="screening-workbook-row-count">${Number(workbook.articleCount || 0)} 篇</div>
    <div class="screening-workbook-row-meta">${escapeHtml(workbookTimestamp(workbook))}</div>
    <div class="screening-workbook-row-actions"><button type="button" class="btn btn-secondary btn-sm" data-workbook-action="table" data-workbook-index="${index}">文献表</button><button type="button" class="btn btn-secondary btn-sm" data-workbook-action="open" data-workbook-index="${index}">打开</button><button type="button" class="btn btn-secondary btn-sm" data-workbook-action="sync" data-workbook-index="${index}">同步</button><button type="button" class="btn btn-secondary btn-sm" data-workbook-action="export" data-workbook-index="${index}">另存</button>${workbook.managed === 'cento' ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-workbook-action="remove" data-workbook-index="${index}">移除</button>`}</div>
  </article>`).join('')}` : '<div class="screening-workbook-empty">尚未登记 Excel 工作簿</div>'}<div class="screening-workbook-search-empty hidden">未找到匹配的 Excel 工作簿</div></div>`;
  const selectedScope = () => scopes.find(scope => scopeKey(scope) === container.querySelector('[data-workbook-target]')?.value) || null;
  container.querySelector('[data-workbook-action="return-current"]')?.addEventListener('click', () => options.onReturnToCurrent?.());
  container.querySelector('[data-workbook-action="create"]')?.addEventListener('click', () => options.onCreate?.(selectedScope()));
  container.querySelector('[data-workbook-action="import"]')?.addEventListener('click', () => options.onImport?.(selectedScope()));
  const workbookAt = button => workbooks[Number(button.dataset.workbookIndex)];
  container.querySelectorAll('[data-workbook-action="table"]').forEach(button => button.addEventListener('click', () => options.onOpenTable?.(workbookAt(button))));
  container.querySelectorAll('[data-workbook-action="open"]').forEach(button => button.addEventListener('click', () => options.onOpen?.(workbookAt(button))));
  container.querySelectorAll('[data-workbook-action="sync"]').forEach(button => button.addEventListener('click', () => options.onSync?.(workbookAt(button))));
  container.querySelectorAll('[data-workbook-action="export"]').forEach(button => button.addEventListener('click', () => options.onExport?.(workbookAt(button))));
  container.querySelectorAll('[data-workbook-action="remove"]').forEach(button => button.addEventListener('click', () => options.onRemove?.(workbookAt(button))));
  container.querySelector('.screening-workbook-search input')?.addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    let visible = 0;
    container.querySelectorAll('.screening-workbook-row').forEach(row => {
      const matches = !query || row.dataset.workbookSearch?.includes(query);
      row.classList.toggle('hidden', !matches);
      if (matches) visible += 1;
    });
    container.querySelector('.screening-workbook-search-empty')?.classList.toggle('hidden', visible > 0);
  });
}
