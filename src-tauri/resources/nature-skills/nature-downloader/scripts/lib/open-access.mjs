import path from "node:path";

const LOOKUP_TIMEOUT_MS = 12000;

function lookupSignal() {
  return AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
}

export function normalizeTitle(title = "") {
  return String(title).replace(/\s+/g, " ").trim().toLowerCase();
}

export function exactTitleMatch(candidate, expected) {
  return normalizeTitle(candidate) === normalizeTitle(expected);
}

export function normalizeDoi(value = "") {
  const raw = String(value).trim();
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  const text = decoded
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .trim();
  const match = text.match(/10\.\d{4,9}\/\S+/i);
  return match ? match[0].replace(/[\s.,;:]+$/, "") : "";
}

export function normalizePmid(value = "") {
  const match = String(value).match(/(?:PMID\s*:?\s*)?(\d{1,12})/i);
  return match ? match[1] : "";
}

export function normalizePmcid(value = "") {
  const match = String(value).match(/(?:PMC\s*)?(\d{1,12})/i);
  return match ? `PMC${match[1]}` : "";
}

export function normalizeArxivId(value = "") {
  const text = String(value).trim();
  const match = text.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?/i);
  if (!match) return "";
  return `${match[1]}${match[2] || ""}`;
}

export function arxivPdfUrl(id) {
  const normalized = normalizeArxivId(id);
  if (!normalized) return "";
  return `https://arxiv.org/pdf/${normalized}`;
}

function decodeXml(text = "") {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function decodeXmlAttribute(text = "") {
  return decodeXml(text).replace(/&#x27;/gi, "'");
}

function httpsNcbiUrl(value = "") {
  return String(value).replace(/^ftp:\/\/ftp\.ncbi\.nlm\.nih\.gov\//i, "https://ftp.ncbi.nlm.nih.gov/");
}

export function parsePmcOaLinks(xml) {
  const links = [];
  for (const tag of String(xml).match(/<link\b[^>]*>/gi) || []) {
    const format = decodeXmlAttribute((tag.match(/\bformat=["']([^"']+)["']/i) || [])[1] || "");
    const href = decodeXmlAttribute((tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || "");
    if (format.toLowerCase() === "pdf" && href) links.push(httpsNcbiUrl(href));
  }
  return [...new Set(links)];
}

export function parseEuropePmcSearch(data) {
  const results = data?.resultList?.result || [];
  return results.map((result) => ({
    pmid: normalizePmid(result.pmid || result.id || ""),
    pmcid: normalizePmcid(result.pmcid || ""),
    doi: normalizeDoi(result.doi || ""),
    title: String(result.title || "").trim(),
  }));
}

export function parseOpenAlexCandidates(data) {
  const locations = [data?.best_oa_location, data?.primary_location, ...(data?.locations || [])];
  const candidates = [];
  for (const location of locations) {
    const url = location?.pdf_url || "";
    if (!/^https?:\/\//i.test(url)) continue;
    candidates.push({ url, source: "OpenAlex", priority: 30 });
  }
  return candidates;
}

export function parseSemanticScholarCandidates(data) {
  const url = data?.openAccessPdf?.url || "";
  return /^https?:\/\//i.test(url)
    ? [{ url, source: "Semantic Scholar", priority: 40 }]
    : [];
}

export function parseDoajCandidates(data) {
  const candidates = [];
  for (const item of data?.results || []) {
    for (const link of item?.bibjson?.link || []) {
      if (link?.type === "fulltext" && /^https?:\/\//i.test(link.url || "")) {
        candidates.push({ url: link.url, source: "DOAJ", priority: 50 });
      }
    }
  }
  return candidates;
}

export function parseUnpaywallCandidates(data) {
  const locations = [data?.best_oa_location, ...(data?.oa_locations || [])];
  return locations
    .map((location) => location?.url_for_pdf || "")
    .filter((url) => /^https?:\/\//i.test(url))
    .map((url) => ({ url, source: "Unpaywall", priority: 25 }));
}

export function parseBiorxivCandidates(data, server) {
  const versions = data?.collection || [];
  const latest = versions[versions.length - 1];
  const doi = normalizeDoi(latest?.doi || "");
  if (!doi || !["biorxiv", "medrxiv"].includes(server)) return [];
  const version = Math.max(1, Number(latest?.version || 1));
  return [{
    url: `https://www.${server}.org/content/${doi}v${version}.full.pdf`,
    source: "bioRxiv/medRxiv",
    priority: 25,
  }];
}

export function dedupeOpenAccessCandidates(candidates) {
  const seen = new Set();
  return candidates
    .filter((candidate) => candidate && /^https?:\/\//i.test(candidate.url || ""))
    .sort((a, b) => (a.priority || 999) - (b.priority || 999))
    .filter((candidate) => {
      const key = candidate.url.replace(/^http:/i, "https:").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function parseArxivAtom(xml, expectedTitle) {
  const entries = String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const entry of entries) {
    const title = decodeXml((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").replace(/\s+/g, " ").trim();
    if (!exactTitleMatch(title, expectedTitle)) continue;
    const rawId = decodeXml((entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "");
    const id = normalizeArxivId(rawId);
    if (!id) continue;
    return { id, title, pdfUrl: arxivPdfUrl(id) };
  }
  return null;
}

export async function findArxivByTitle(title, { fetchImpl = fetch } = {}) {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `ti:"${title}"`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "5");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`arXiv lookup failed: HTTP ${response.status}`);
  }
  return parseArxivAtom(await response.text(), title);
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "Cento/1.0 academic PDF resolver" },
    signal: lookupSignal(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function resolveEuropePmcIdentifiers({ doi, pmid, pmcid }, fetchImpl) {
  if (pmcid) return { doi, pmid, pmcid };
  const query = pmid ? `EXT_ID:${pmid} AND SRC:MED` : doi ? `DOI:${JSON.stringify(doi)}` : "";
  if (!query) return { doi, pmid, pmcid };
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", "3");
  const hits = parseEuropePmcSearch(await fetchJson(url, fetchImpl));
  const exact = hits.find((hit) => (pmid && hit.pmid === pmid) || (doi && hit.doi.toLowerCase() === doi.toLowerCase()));
  return exact || hits[0] || { doi, pmid, pmcid };
}

async function findPmcCandidates(identifiers, fetchImpl) {
  const resolved = await resolveEuropePmcIdentifiers(identifiers, fetchImpl);
  if (!resolved.pmcid) return { candidates: [], identifiers: resolved };
  const url = new URL("https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi");
  url.searchParams.set("id", resolved.pmcid);
  const response = await fetchImpl(url, { signal: lookupSignal() });
  if (!response.ok) throw new Error(`PMC OA HTTP ${response.status}`);
  const candidates = parsePmcOaLinks(await response.text()).map((pdfUrl) => ({
    url: pdfUrl,
    source: "PMC OA",
    priority: 10,
    pmcid: resolved.pmcid,
  }));
  if (!candidates.length) {
    candidates.push({
      url: `https://europepmc.org/articles/${resolved.pmcid}?pdf=render`,
      source: "Europe PMC",
      priority: 20,
      pmcid: resolved.pmcid,
    });
  }
  return { candidates, identifiers: resolved };
}

async function findOpenAlex(doi, title, fetchImpl) {
  let data;
  if (doi) {
    data = await fetchJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`, fetchImpl);
  } else if (title) {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", title);
    url.searchParams.set("per-page", "5");
    const payload = await fetchJson(url, fetchImpl);
    data = (payload.results || []).find((work) => exactTitleMatch(work.title || "", title));
  }
  if (!data) return { candidates: [], doi: "" };
  return {
    candidates: parseOpenAlexCandidates(data),
    doi: normalizeDoi(data.doi || data.ids?.doi || ""),
  };
}

async function findSemanticScholar(doi, fetchImpl) {
  if (!doi) return [];
  const fields = "title,openAccessPdf,externalIds";
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${encodeURIComponent(fields)}`;
  return parseSemanticScholarCandidates(await fetchJson(url, fetchImpl));
}

async function findDoaj(doi, fetchImpl) {
  if (!doi) return [];
  const data = await fetchJson(`https://doaj.org/api/search/articles/doi:${encodeURIComponent(doi)}?pageSize=3`, fetchImpl);
  return parseDoajCandidates(data);
}

async function findUnpaywall(doi, fetchImpl, email) {
  if (!doi || !email) return [];
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  return parseUnpaywallCandidates(await fetchJson(url, fetchImpl));
}

async function findBiorxiv(doi, fetchImpl) {
  if (!/^10\.1101\//i.test(doi)) return [];
  const results = await Promise.allSettled(["biorxiv", "medrxiv"].map(async (server) => {
    const data = await fetchJson(`https://api.biorxiv.org/details/${server}/${doi}`, fetchImpl);
    return parseBiorxivCandidates(data, server);
  }));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export async function discoverOpenAccessCandidates(
  { doi = "", pmid = "", pmcid = "", title = "" } = {},
  { fetchImpl = fetch, unpaywallEmail = process.env.UNPAYWALL_EMAIL || "" } = {}
) {
  const identifiers = {
    doi: normalizeDoi(doi),
    pmid: normalizePmid(pmid),
    pmcid: normalizePmcid(pmcid),
  };
  const openAlexPromise = findOpenAlex(identifiers.doi, title, fetchImpl);
  const pmcPromise = findPmcCandidates(identifiers, fetchImpl);
  const initial = await Promise.allSettled([openAlexPromise, pmcPromise]);
  const openAlex = initial[0].status === "fulfilled" ? initial[0].value : { candidates: [], doi: "" };
  const pmc = initial[1].status === "fulfilled" ? initial[1].value : { candidates: [], identifiers };
  const resolvedDoi = identifiers.doi || openAlex.doi || pmc.identifiers?.doi || "";

  const secondary = await Promise.allSettled([
    findSemanticScholar(resolvedDoi, fetchImpl),
    findDoaj(resolvedDoi, fetchImpl),
    findUnpaywall(resolvedDoi, fetchImpl, unpaywallEmail),
    findBiorxiv(resolvedDoi, fetchImpl),
    title ? findArxivByTitle(title, { fetchImpl }) : Promise.resolve(null),
  ]);
  const candidates = [...pmc.candidates, ...openAlex.candidates];
  if (secondary[0].status === "fulfilled") candidates.push(...secondary[0].value);
  if (secondary[1].status === "fulfilled") candidates.push(...secondary[1].value);
  if (secondary[2].status === "fulfilled") candidates.push(...secondary[2].value);
  if (secondary[3].status === "fulfilled") candidates.push(...secondary[3].value);
  if (secondary[4].status === "fulfilled" && secondary[4].value?.pdfUrl) {
    candidates.push({
      url: secondary[4].value.pdfUrl,
      source: "arXiv",
      priority: 60,
      arxiv: secondary[4].value.id,
    });
  }
  return {
    candidates: dedupeOpenAccessCandidates(candidates),
    identifiers: {
      doi: resolvedDoi,
      pmid: identifiers.pmid || pmc.identifiers?.pmid || "",
      pmcid: identifiers.pmcid || pmc.identifiers?.pmcid || "",
    },
  };
}

export function filenameForPdfUrl(url, title = "") {
  if (title) {
    const safeTitle = title
      .trim()
      .replace(/[\/:*?"<>|]+/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 120);
    if (safeTitle) return `${safeTitle}.pdf`;
  }
  const base = path.basename(new URL(url).pathname) || "paper.pdf";
  return base.endsWith(".pdf") ? base : `${base}.pdf`;
}
