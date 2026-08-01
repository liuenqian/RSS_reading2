const PUBMED_SEARCH_URL = 'https://pubmed.ncbi.nlm.nih.gov/';
const MEDCITE_SEARCH_URL = 'https://medcite.cn/home';
const MEDREADING_SEARCH_URL = 'https://www.medreading.cn/query';

export function buildPubmedSearchUrl(query) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return '';
  const url = new URL(PUBMED_SEARCH_URL);
  url.searchParams.set('term', normalizedQuery);
  return url.toString();
}

export function buildMedciteSearchUrl(query) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return '';
  const url = new URL(MEDCITE_SEARCH_URL);
  url.searchParams.set('tab', 'search');
  url.searchParams.set('q', normalizedQuery);
  return url.toString();
}

export function buildMedreadingSearchUrl(query) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return '';
  const url = new URL(MEDREADING_SEARCH_URL);
  url.searchParams.set('search_type', 'title');
  url.searchParams.set('search_value', normalizedQuery);
  url.searchParams.set('is_subject', '');
  url.searchParams.set('source', '');
  url.searchParams.set('tk', '');
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
