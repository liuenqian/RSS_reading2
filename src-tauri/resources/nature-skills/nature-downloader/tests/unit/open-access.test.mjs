import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  arxivPdfUrl,
  dedupeOpenAccessCandidates,
  exactTitleMatch,
  filenameForPdfUrl,
  normalizeArxivId,
  normalizeDoi,
  normalizePmcid,
  normalizePmid,
  parseDoajCandidates,
  parseBiorxivCandidates,
  parseEuropePmcSearch,
  parseOpenAlexCandidates,
  parsePmcOaLinks,
  parseSemanticScholarCandidates,
  parseUnpaywallCandidates,
  parseArxivAtom,
} from "../../scripts/lib/open-access.mjs";

describe("open access helpers", () => {
  test("normalizes arXiv ids from ids and URLs", () => {
    assert.equal(normalizeArxivId("1706.03762"), "1706.03762");
    assert.equal(normalizeArxivId("1706.03762v7"), "1706.03762v7");
    assert.equal(normalizeArxivId("https://arxiv.org/abs/1706.03762"), "1706.03762");
    assert.equal(normalizeArxivId("https://arxiv.org/pdf/1706.03762.pdf"), "1706.03762");
  });

  test("builds canonical arXiv PDF URL", () => {
    assert.equal(arxivPdfUrl("1706.03762"), "https://arxiv.org/pdf/1706.03762");
  });

  test("matches exact titles with whitespace and case tolerance", () => {
    assert.equal(exactTitleMatch("Attention Is All You Need", "attention is all you need"), true);
    assert.equal(exactTitleMatch("Attention\nIs   All You Need", "Attention Is All You Need"), true);
    assert.equal(exactTitleMatch("Getting the attention you need", "Attention Is All You Need"), false);
  });

  test("parses exact arXiv Atom result", () => {
    const xml = `<?xml version="1.0"?>
      <feed>
        <entry>
          <id>http://arxiv.org/abs/1706.03762v7</id>
          <title>Attention Is All You Need</title>
        </entry>
        <entry>
          <id>http://arxiv.org/abs/0000.00000</id>
          <title>Getting the attention you need</title>
        </entry>
      </feed>`;
    assert.deepEqual(parseArxivAtom(xml, "Attention Is All You Need"), {
      id: "1706.03762v7",
      title: "Attention Is All You Need",
      pdfUrl: "https://arxiv.org/pdf/1706.03762v7",
    });
  });

  test("creates readable PDF filenames", () => {
    assert.equal(
      filenameForPdfUrl("https://arxiv.org/pdf/1706.03762", "Attention Is All You Need"),
      "Attention_Is_All_You_Need.pdf"
    );
    assert.equal(
      filenameForPdfUrl("https://example.org/papers/a/b/c.pdf"),
      "c.pdf"
    );
  });

  test("normalizes biomedical identifiers", () => {
    assert.equal(normalizeDoi("https://doi.org/10.1016/j.cell.2024.01.001."), "10.1016/j.cell.2024.01.001");
    assert.equal(normalizePmid("PMID: 12345678"), "12345678");
    assert.equal(normalizePmcid("pmc 12069115"), "PMC12069115");
  });

  test("parses PMC OA links and upgrades NCBI FTP URLs", () => {
    const xml = `<record id="PMC12069115"><link format="pdf" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/x/paper.pdf"/><link format="tgz" href="ftp://example/t.tgz"/></record>`;
    assert.deepEqual(parsePmcOaLinks(xml), ["https://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/x/paper.pdf"]);
  });

  test("parses Europe PMC identifiers", () => {
    assert.deepEqual(parseEuropePmcSearch({ resultList: { result: [{ pmid: "42", pmcid: "PMC99", doi: "10.1000/test", title: "Paper" }] } }), [
      { pmid: "42", pmcid: "PMC99", doi: "10.1000/test", title: "Paper" },
    ]);
  });

  test("parses OA candidates from public indexes", () => {
    assert.deepEqual(parseOpenAlexCandidates({ best_oa_location: { pdf_url: "https://repo.test/a.pdf" } }), [
      { url: "https://repo.test/a.pdf", source: "OpenAlex", priority: 30 },
    ]);
    assert.deepEqual(parseSemanticScholarCandidates({ openAccessPdf: { url: "https://repo.test/b.pdf" } }), [
      { url: "https://repo.test/b.pdf", source: "Semantic Scholar", priority: 40 },
    ]);
    assert.deepEqual(parseDoajCandidates({ results: [{ bibjson: { link: [{ type: "fulltext", url: "https://repo.test/c" }] } }] }), [
      { url: "https://repo.test/c", source: "DOAJ", priority: 50 },
    ]);
    assert.deepEqual(parseUnpaywallCandidates({ best_oa_location: { url_for_pdf: "https://repo.test/d.pdf" } }), [
      { url: "https://repo.test/d.pdf", source: "Unpaywall", priority: 25 },
    ]);
    assert.deepEqual(parseBiorxivCandidates({ collection: [{ doi: "10.1101/2026.01.01.123456", version: "3" }] }, "biorxiv"), [
      {
        url: "https://www.biorxiv.org/content/10.1101/2026.01.01.123456v3.full.pdf",
        source: "bioRxiv/medRxiv",
        priority: 25,
      },
    ]);
  });

  test("sorts and deduplicates OA candidates", () => {
    assert.deepEqual(dedupeOpenAccessCandidates([
      { url: "http://repo.test/a.pdf?download=1", source: "slow", priority: 50 },
      { url: "https://repo.test/a.pdf", source: "fast", priority: 10 },
      { url: "https://repo.test/b.pdf", source: "middle", priority: 30 },
    ]), [
      { url: "https://repo.test/a.pdf", source: "fast", priority: 10 },
      { url: "https://repo.test/b.pdf", source: "middle", priority: 30 },
    ]);
  });
});
