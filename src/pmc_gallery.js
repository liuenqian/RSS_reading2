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
        journal: String(figure.journal || '').trim(),
        publication_year: Number(figure.publication_year) || null,
        impact_factor: figure.impact_factor || null,
        jcr_quartile: figure.jcr_quartile || null,
        cas_partition: figure.cas_partition || null,
        is_top: figure.is_top === true,
        figures: [],
      });
    }
    groups.get(key).figures.push(figure);
  }
  return [...groups.values()];
}

function metricNumber(value) {
  const match = String(value || '').match(/[0-9]+(?:\.[0-9]+)?/);
  return match ? Number(match[0]) : -1;
}

function partitionRank(value, prefix) {
  const match = String(value || '').toUpperCase().match(new RegExp(`^${prefix}([1-4])$`));
  return match ? 5 - Number(match[1]) : 0;
}

export function sortPmcArticleGroupsByQuality(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group, index) => ({ group, index }))
    .sort((left, right) => {
      const a = left.group;
      const b = right.group;
      return Number(b.is_top) - Number(a.is_top)
        || partitionRank(b.cas_partition, 'B') - partitionRank(a.cas_partition, 'B')
        || partitionRank(b.jcr_quartile, 'Q') - partitionRank(a.jcr_quartile, 'Q')
        || metricNumber(b.impact_factor) - metricNumber(a.impact_factor)
        || Number(b.publication_year || 0) - Number(a.publication_year || 0)
        || left.index - right.index;
    })
    .map(item => item.group);
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
