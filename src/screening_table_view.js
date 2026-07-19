import { calculateScreeningTableWindow } from './screening_table_window.js';
import { reorderScreeningTableColumns } from './screening_table_state.js';

const statusLabels = { unreviewed: '未筛选', keep: '保留', maybe: '待定', exclude: '排除' };

export function renderScreeningTable(container, page, config, options = {}) {
  const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
  const rows = page?.rows || [];
  const columns = (config.columns || []).filter(column => column.visible !== false);
  const rowHeight = Math.max(34, Math.min(140, Number(config.rowHeight) || 48));
  container.innerHTML = '';
  container.className = `screening-table-shell density-${config.rowDensity || 'compact'}`;
  container.style.setProperty('--screening-row-height', `${rowHeight}px`);

  const toolbar = document.createElement('div');
  toolbar.className = 'screening-table-toolbar';
  toolbar.innerHTML = `<label class="screening-table-search"><span aria-hidden="true">⌕</span><input type="search" value="${escapeHtml(options.searchQuery || '')}" placeholder="搜索标题、作者、期刊、PMID、DOI、标签" aria-label="搜索初筛结果"></label>
    <span class="screening-table-result-count">共 ${page?.total || 0} 篇</span>
    <span class="screening-table-file-actions"><button type="button" class="btn btn-secondary btn-sm" data-screening-action="export">导出 Excel</button><button type="button" class="btn btn-secondary btn-sm" data-screening-action="import">导入 Excel</button></span>
    <details class="screening-table-columns-menu">
      <summary class="btn btn-secondary btn-sm">列设置</summary>
      <div class="screening-table-columns-panel">
        ${(config.columns || []).map((column, index) => `<div class="screening-table-column-option" data-column-key="${escapeHtml(column.key)}" data-column-option>
          <span class="screening-table-column-drag-handle" data-column-drag-handle title="拖动调整顺序" aria-label="拖动调整顺序">⠿</span><label><input type="checkbox" data-column-visible="${column.key}" ${column.visible !== false ? 'checked' : ''}> ${escapeHtml(column.label)}</label>
          <span class="screening-table-column-tools"><input type="number" min="48" max="720" step="8" value="${column.width}" data-column-width="${column.key}" aria-label="${escapeHtml(column.label)}列宽"><button type="button" class="btn-icon" data-column-move="up" data-column-index="${index}" title="上移">↑</button><button type="button" class="btn-icon" data-column-move="down" data-column-index="${index}" title="下移">↓</button></span>
        </div>`).join('')}
        <label class="screening-table-row-height"><span>行高</span><input type="number" min="34" max="140" step="4" value="${rowHeight}" data-row-height aria-label="表格行高"></label>
      </div>
    </details>
    <span class="screening-table-page">${page?.total ? `${(page.offset || 0) + 1}-${Math.min((page.offset || 0) + rows.length, page.total)}` : '0-0'}</span>
    <button type="button" class="btn-icon" data-screening-page="prev" title="上一页" ${(page?.offset || 0) <= 0 ? 'disabled' : ''}>‹</button>
    <button type="button" class="btn-icon" data-screening-page="next" title="下一页" ${!page || (page.offset || 0) + rows.length >= page.total ? 'disabled' : ''}>›</button>`;
  container.appendChild(toolbar);

  const viewport = document.createElement('div');
  viewport.className = 'screening-table-viewport';
  viewport.tabIndex = 0;
  const table = document.createElement('table');
  table.className = 'screening-table';
  const colgroup = document.createElement('colgroup');
  columns.forEach(column => {
    const col = document.createElement('col');
    col.style.width = `${column.width}px`;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  columns.forEach((column, columnIndex) => {
    const th = document.createElement('th');
    th.draggable = true;
    th.dataset.columnKey = column.key;
    th.dataset.columnIndex = String(columnIndex);
    const activeSort = config.sorts?.[0]?.field === column.sortField;
    th.innerHTML = `<button type="button" class="screening-table-sort" data-sort-field="${escapeHtml(column.sortField || column.key)}">${escapeHtml(column.label)}${activeSort ? ` <span>${config.sorts[0].direction === 'asc' ? '↑' : '↓'}</span>` : ''}</button><span class="screening-table-column-resizer" data-column-resize="${escapeHtml(column.key)}" title="拖动调整列宽" aria-label="调整${escapeHtml(column.label)}列宽"></span>`;
    header.appendChild(th);
  });
  thead.appendChild(header);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const windowState = calculateScreeningTableWindow(rows.length, viewport.scrollTop, viewport.clientHeight || 520, rowHeight);
  tbody.style.position = 'relative';
  tbody.innerHTML = `<tr class="screening-table-spacer"><td colspan="${columns.length}" style="height:${windowState.top}px"></td></tr>`;
  rows.slice(windowState.first, windowState.last).forEach(row => {
    const tr = document.createElement('tr');
    tr.dataset.entryId = row.entryId;
    tr.className = row.isRead ? 'is-read' : 'is-unread';
    columns.forEach(column => {
      const td = document.createElement('td');
      td.className = `screening-table-cell screening-table-cell-${column.key}`;
      td.innerHTML = `<div class="screening-table-cell-content">${cellValue(row, column.key, escapeHtml)}</div>`;
      tr.appendChild(td);
    });
    tr.addEventListener('click', () => options.onSelect?.(row));
    tbody.appendChild(tr);
    tr.querySelector('[data-screening-action="star"]')?.addEventListener('click', event => {
      event.stopPropagation();
      options.onStar?.(row);
    });
    tr.querySelector('[data-screening-action="status"]')?.addEventListener('change', event => {
      event.stopPropagation();
      options.onStatus?.(row, event.target.value);
    });
  });
  const bottomSpacer = document.createElement('tr');
  bottomSpacer.className = 'screening-table-spacer';
  bottomSpacer.innerHTML = `<td colspan="${columns.length}" style="height:${windowState.bottom}px"></td>`;
  tbody.appendChild(bottomSpacer);
  table.appendChild(tbody);
  viewport.appendChild(table);
  container.appendChild(viewport);
  viewport.addEventListener('scroll', () => options.onScroll?.(viewport.scrollTop));
  container.querySelectorAll('[data-sort-field]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      options.onSort?.(button.dataset.sortField);
    });
  });
  let draggedHeaderKey = '';
  container.querySelectorAll('.screening-table th[draggable="true"]').forEach(th => {
    th.addEventListener('dragstart', event => {
      if (event.target.closest('[data-column-resize]')) {
        event.preventDefault();
        return;
      }
      draggedHeaderKey = th.dataset.columnKey || '';
      th.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedHeaderKey);
    });
    th.addEventListener('dragover', event => {
      if (!draggedHeaderKey || draggedHeaderKey === th.dataset.columnKey) return;
      event.preventDefault();
      container.querySelectorAll('.screening-table th').forEach(item => item.classList.remove('is-drag-over'));
      th.classList.add('is-drag-over');
    });
    th.addEventListener('drop', event => {
      event.preventDefault();
      const targetKey = th.dataset.columnKey || '';
      const next = reorderScreeningTableColumns(config, draggedHeaderKey, targetKey);
      draggedHeaderKey = '';
      container.querySelectorAll('.screening-table th').forEach(item => item.classList.remove('is-dragging', 'is-drag-over'));
      options.onConfigChange?.(next);
    });
    th.addEventListener('dragend', () => {
      draggedHeaderKey = '';
      container.querySelectorAll('.screening-table th').forEach(item => item.classList.remove('is-dragging', 'is-drag-over'));
    });
  });
  container.querySelectorAll('[data-column-resize]').forEach(handle => {
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const column = config.columns.find(item => item.key === handle.dataset.columnResize);
      const col = table.querySelectorAll('col')[columns.findIndex(item => item.key === handle.dataset.columnResize)];
      if (!column || !col) return;
      const startX = event.clientX;
      const startWidth = Number(column.width) || 120;
      const onMove = moveEvent => {
        const width = Math.max(48, Math.min(720, startWidth + moveEvent.clientX - startX));
        col.style.width = `${width}px`;
      };
      const onUp = upEvent => {
        const width = Math.max(48, Math.min(720, startWidth + upEvent.clientX - startX));
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        options.onConfigChange?.({
          ...config,
          columns: config.columns.map(item => item.key === column.key ? { ...item, width } : item),
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });
  });
  container.querySelectorAll('[data-column-visible]').forEach(input => {
    input.addEventListener('change', () => {
      const columns = (config.columns || []).map(column => column.key === input.dataset.columnVisible
        ? { ...column, visible: input.checked }
        : column);
      options.onConfigChange?.({ ...config, columns });
    });
  });
  container.querySelectorAll('[data-column-width]').forEach(input => {
    input.addEventListener('change', () => {
      const width = Math.max(48, Math.min(720, Number(input.value) || 120));
      const columns = (config.columns || []).map(column => column.key === input.dataset.columnWidth
        ? { ...column, width }
        : column);
      options.onConfigChange?.({ ...config, columns });
    });
  });
  container.querySelector('[data-row-height]')?.addEventListener('change', event => {
    const rowHeight = Math.max(34, Math.min(140, Number(event.target.value) || 48));
    options.onConfigChange?.({ ...config, rowHeight });
  });
  const searchInput = container.querySelector('.screening-table-search input');
  searchInput?.addEventListener('input', () => options.onSearch?.(searchInput.value));
  container.querySelector('[data-screening-action="export"]')?.addEventListener('click', () => options.onExport?.());
  container.querySelector('[data-screening-action="import"]')?.addEventListener('click', () => options.onImport?.());
  container.querySelector('[data-screening-page="prev"]')?.addEventListener('click', () => options.onPageChange?.(Math.max(0, (page.offset || 0) - rows.length)));
  container.querySelector('[data-screening-page="next"]')?.addEventListener('click', () => options.onPageChange?.((page.offset || 0) + rows.length));
  container.querySelectorAll('[data-column-move]').forEach(button => {
    button.addEventListener('click', () => {
      const columns = [...(config.columns || [])];
      const index = Number(button.dataset.columnIndex);
      const target = button.dataset.columnMove === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= columns.length) return;
      [columns[index], columns[target]] = [columns[target], columns[index]];
      options.onConfigChange?.({ ...config, columns });
    });
  });

  let draggedColumnKey = '';
  let dropTargetRow = null;
  const clearColumnDragState = () => {
    draggedColumnKey = '';
    dropTargetRow = null;
    container.querySelectorAll('[data-column-option]').forEach(row => {
      row.classList.remove('is-dragging', 'is-drag-over');
    });
  };
  const setDropTarget = row => {
    if (dropTargetRow === row) return;
    dropTargetRow?.classList.remove('is-drag-over');
    dropTargetRow = row && row.dataset.columnKey !== draggedColumnKey ? row : null;
    dropTargetRow?.classList.add('is-drag-over');
  };
  const finishColumnDrag = () => {
    const targetKey = dropTargetRow?.dataset.columnKey || '';
    const draggedKey = draggedColumnKey;
    clearColumnDragState();
    if (draggedKey && targetKey && draggedKey !== targetKey) {
      options.onConfigChange?.(reorderScreeningTableColumns(config, draggedKey, targetKey));
    }
  };
  container.querySelectorAll('[data-column-drag-handle]').forEach(handle => {
    const row = handle.closest('[data-column-option]');
    handle.addEventListener('pointerdown', event => {
      if (!row) return;
      draggedColumnKey = row.dataset.columnKey || '';
      row.classList.add('is-dragging');
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!draggedColumnKey) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-column-option]');
      setDropTarget(target?.closest?.('[data-column-option]') || null);
    });
    handle.addEventListener('pointerup', finishColumnDrag);
    handle.addEventListener('pointercancel', clearColumnDragState);
    handle.addEventListener('lostpointercapture', () => {
      if (draggedColumnKey) finishColumnDrag();
    });
  });
}

function cellValue(row, key, escapeHtml) {
  switch (key) {
    case 'position': return escapeHtml(row.position || '');
    case 'titleTranslated': return escapeHtml(row.titleTranslated || '');
    case 'title': return escapeHtml(row.title || '');
    case 'summaryTranslated': return escapeHtml(row.summaryTranslated || '');
    case 'summary': return escapeHtml(row.summary || '');
    case 'authors': return escapeHtml(row.authors || '');
    case 'journal': return escapeHtml(row.journal || '');
    case 'publicationDate': return escapeHtml(row.publicationDate || row.publishedAt || '');
    case 'publicationDateRaw': return escapeHtml(row.publicationDateRaw || '');
    case 'firstSeenAt': return escapeHtml(row.firstSeenAt || '');
    case 'pmid': return escapeHtml(row.pmid || '');
    case 'pmcid': return escapeHtml(row.pmcid || '');
    case 'doi': return escapeHtml(row.doi || '');
    case 'affiliation': return escapeHtml(row.affiliation || '');
    case 'hasFreeFulltext': return row.hasFreeFulltext ? '是' : '否';
    case 'impactFactor': return escapeHtml(row.metrics?.if || row.metrics?.impactFactor || '');
    case 'q': return escapeHtml(row.metrics?.q || '');
    case 'b': return escapeHtml(row.metrics?.b || '');
    case 'top': return row.metrics?.top === '1' ? '是' : (row.metrics?.top === '0' ? '否' : '');
    case 'screeningStatus': return `<select class="screening-status-select" data-screening-action="status" aria-label="筛选状态">${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${value === row.screeningStatus ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    case 'exclusionReason': return escapeHtml(row.exclusionReason || '');
    case 'screeningNote': return escapeHtml(row.screeningNote || '');
    case 'isRead': return row.isRead ? '是' : '否';
    case 'isStarred': return `<button type="button" class="screening-star-button ${row.isStarred ? 'active' : ''}" data-screening-action="star" aria-label="${row.isStarred ? '取消星标' : '标星'}">${row.isStarred ? '★' : '☆'}</button>`;
    case 'tags': return escapeHtml((row.tags || []).join('; '));
    case 'hasReadingNote': return row.hasReadingNote ? '有' : '无';
    default: return '';
  }
}
