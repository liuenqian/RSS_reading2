const PUBMED_SEARCH_URL = 'https://pubmed.ncbi.nlm.nih.gov/';

export function buildPubmedSearchUrl(query) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return '';
  const url = new URL(PUBMED_SEARCH_URL);
  url.searchParams.set('term', normalizedQuery);
  return url.toString();
}

export function feedSourceLink(feed) {
  const feedUrl = String(feed?.url || '').trim();
  let query = String(feed?.pubmed_query || '').trim();

  if (!query && feedUrl.includes('pubmed.ncbi.nlm.nih.gov/rss/search')) {
    try {
      query = new URL(feedUrl).searchParams.get('term')?.trim() || '';
    } catch {
      query = '';
    }
  }

  const pubmedUrl = buildPubmedSearchUrl(query);
  return pubmedUrl
    ? { label: '在 PubMed 打开', url: pubmedUrl }
    : { label: '打开订阅源', url: feedUrl };
}
