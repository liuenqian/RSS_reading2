export function calculateScreeningTableWindow(total, scrollTop, viewportHeight, rowHeight = 42, overscan = 8) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeHeight = Math.max(1, Number(viewportHeight) || 1);
  const safeRowHeight = Math.max(1, Number(rowHeight) || 1);
  const first = Math.max(0, Math.floor(Math.max(0, Number(scrollTop) || 0) / safeRowHeight) - overscan);
  const visibleCount = Math.ceil(safeHeight / safeRowHeight) + overscan * 2;
  const last = Math.min(safeTotal, first + visibleCount);
  return { first, last, top: first * safeRowHeight, bottom: Math.max(0, (safeTotal - last) * safeRowHeight) };
}
