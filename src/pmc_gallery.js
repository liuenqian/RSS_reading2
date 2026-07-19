export function isPmcFigureNumber(figure, figureNumber) {
  const label = String(figure?.label || '')
    .trim()
    .toLowerCase()
    .replace(/[.:：]+$/, '')
    .replace(/\s+/g, ' ');
  const target = Math.max(1, Math.min(99, Math.trunc(Number(figureNumber) || 1)));
  return new RegExp(`^(?:fig(?:ure)?\\.?\\s*|图\\s*)0*${target}(?:\\s*[a-z])?$`).test(label);
}

export function groupPmcFiguresByArticle(figures) {
  const groups = new Map();
  for (const figure of Array.isArray(figures) ? figures : []) {
    const key = String(figure?.pmcid || figure?.article_url || '').trim();
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        pmcid: String(figure.pmcid || '').trim(),
        article_title: String(figure.article_title || figure.pmcid || '未命名 PMC 文献').trim(),
        article_url: String(figure.article_url || '').trim(),
        figures: [],
      });
    }
    groups.get(key).figures.push(figure);
  }
  return [...groups.values()];
}

export function mergePmcGalleryResults(current, next) {
  const figures = [...(current?.figures || [])];
  const seen = new Set(figures.map(figure => figure.image_url));
  for (const figure of next?.figures || []) {
    if (!figure?.image_url || seen.has(figure.image_url)) continue;
    seen.add(figure.image_url);
    figures.push(figure);
  }
  return {
    ...next,
    scanned_articles: Number(current?.scanned_articles || 0) + Number(next?.scanned_articles || 0),
    skipped_articles: Number(current?.skipped_articles || 0) + Number(next?.skipped_articles || 0),
    filtered_articles: Number(current?.filtered_articles || 0) + Number(next?.filtered_articles || 0),
    figures,
  };
}
