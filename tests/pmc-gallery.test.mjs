import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  groupPmcFiguresByArticle,
  isPmcFigureNumber,
  mergePmcGalleryResults,
  sortPmcArticleGroupsByQuality,
} from '../src/pmc_gallery.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const command = await readFile(new URL('../src-tauri/src/commands/pmc_gallery_cmd.rs', import.meta.url), 'utf8');
const service = await readFile(new URL('../src-tauri/src/services/pmc_gallery_service.rs', import.meta.url), 'utf8');
const searchService = await readFile(new URL('../src-tauri/src/services/pmc_gallery_search_service.rs', import.meta.url), 'utf8');
const migrations = await readFile(new URL('../src-tauri/src/db_migrations.rs', import.meta.url), 'utf8');

test('PMC gallery has a dedicated sidebar entry and bounded search dialog', () => {
  assert.match(html, /data-sidebar-source-section="pmc-gallery"/);
  assert.match(html, /id="pmc-gallery-search-list"/);
  assert.match(html, /id="btn-new-pmc-gallery-search"/);
  assert.match(html, /id="pmc-gallery-modal"/);
  assert.match(html, /id="pmc-gallery-query"/);
  assert.match(html, /PubMed 检索式/);
  assert.match(html, /<option value="20">20 篇<\/option>/);
  assert.match(main, /view === 'pmc-gallery'[\s\S]*openPmcGalleryModal/);
});

test('PMC gallery follows the PubMed builder and preview flow before fetching images', () => {
  assert.match(html, /data-pmc-search-mode="topic"/);
  assert.match(html, /data-pmc-search-mode="author"/);
  assert.match(html, /id="btn-generate-pmc-query"/);
  assert.match(html, /id="btn-build-pmc-author-query"/);
  assert.match(html, /id="btn-preview-pmc-gallery"/);
  assert.match(main, /async function generatePmcGalleryQuery[\s\S]*invoke\('natural_to_pubmed_query'/);
  assert.match(main, /async function buildPmcGalleryAuthorQuery[\s\S]*invoke\('build_pubmed_author_query'/);
  assert.match(main, /async function previewPmcGallerySearch[\s\S]*invoke\('preview_pmc_gallery_search'/);
  assert.match(command, /pub async fn preview_pmc_gallery_search/);
  assert.match(service, /pub async fn preview_gallery/);
  assert.match(service, /open_access_count/);
  assert.match(lib, /pmc_gallery_cmd::preview_pmc_gallery_search/);
  assert.match(main, /pmcGalleryPreviewQuery !== query[\s\S]*请先预览当前检索式/);
  const previewBlock = main.slice(
    main.indexOf('async function previewPmcGallerySearch'),
    main.indexOf('function readPmcGalleryMetricFilters'),
  );
  assert.doesNotMatch(previewBlock, /preview_pubmed_search|pmc\[filter\]/);
  assert.match(previewBlock, /PMC 全文命中/);
  const generateBlock = main.slice(
    main.indexOf('async function generatePmcGalleryQuery'),
    main.indexOf('async function buildPmcGalleryAuthorQuery'),
  );
  assert.doesNotMatch(generateBlock, /search_pmc_gallery/);
});

test('PMC gallery preserves independent local search history', () => {
  assert.match(html, /id="pmc-gallery-name"[^>]*list="pmc-gallery-name-history"/);
  assert.match(html, /id="pmc-gallery-name-history"/);
  assert.match(html, /id="btn-save-pmc-gallery-search"/);
  assert.match(main, /PMC_GALLERY_HISTORY_KEY = 'pmc-gallery-search-history-v1'/);
  assert.match(main, /invoke\('list_pmc_gallery_searches'/);
  assert.match(main, /invoke\('create_pmc_gallery_search'/);
  assert.match(main, /\? 'update_pmc_gallery_search'[\s\S]*: 'create_pmc_gallery_search'/);
  assert.match(main, /function restorePmcGalleryHistory/);
  assert.match(main, /impactFactorFilter/);
  assert.match(main, /pmcGalleryHistory = \(await invoke\('list_pmc_gallery_searches'\)\)/);
  assert.match(main, /function renderPmcGallerySidebarList/);
  assert.match(main, /function renderPmcGalleryNameHistory/);
  assert.match(main, /async function restorePmcGallerySearchByName/);
  assert.match(main, /restorePmcGallerySearchByName\(event\.currentTarget\.value\)/);
  assert.match(main, /dataset\.pmcGalleryHistoryId = record\.id/);
  assert.match(main, /last_result_count/);
  assert.match(main, /openPmcGalleryModal\(record\.id\)/);
  assert.match(main, /invoke\('load_pmc_gallery_cache'/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS pmc_gallery_searches/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS pmc_gallery_figures/);
  assert.match(command, /pub fn create_pmc_gallery_search/);
  assert.match(command, /pub fn update_pmc_gallery_search/);
  assert.match(command, /pub fn delete_pmc_gallery_search/);
  assert.match(searchService, /pub fn cache_result/);
  assert.match(migrations, /UNIQUE\(search_id, image_url\)/);
  assert.match(lib, /pmc_gallery_cmd::load_pmc_gallery_cache/);
});

test('PMC gallery invokes the registered backend command and renders separate figure sections', () => {
  assert.match(main, /invoke\('search_pmc_gallery'/);
  assert.match(html, /id="pmc-gallery-graphical-grid"/);
  assert.match(html, /id="pmc-gallery-figure-grid"/);
  assert.match(main, /renderPmcGallerySection\(\s*'graphical_abstract'/);
  assert.match(main, /renderPmcGallerySection\(\s*'figure'/);
  assert.match(main, /data-pmc-gallery-open/);
  assert.match(command, /pub async fn search_pmc_gallery/);
  assert.match(lib, /pmc_gallery_cmd::search_pmc_gallery/);
});

test('PMC gallery defaults to high-quality graphical abstracts and preserves other views', () => {
  assert.match(html, /class="seg-btn active"[^>]*data-pmc-gallery-view="graphical">图形摘要/);
  assert.match(html, /data-pmc-gallery-view="all">全部图片/);
  assert.match(main, /let pmcGalleryView = 'graphical'/);
  assert.match(main, /sortPmcArticleGroupsByQuality\(groupPmcFiguresByArticle\(figures\)\)/);
  assert.match(main, /figureSection\?\.classList\.toggle\('hidden', pmcGalleryView === 'graphical'\)/);
  assert.match(main, /pmc-gallery-quality-badge/);
  assert.match(main, />原文<\/button>/);

  const sorted = sortPmcArticleGroupsByQuality([
    { pmcid: 'PMC-low', impact_factor: '18.0', jcr_quartile: 'Q1', cas_partition: 'B1', is_top: false, publication_year: 2026 },
    { pmcid: 'PMC-top', impact_factor: '8.0', jcr_quartile: 'Q1', cas_partition: 'B1', is_top: true, publication_year: 2024 },
    { pmcid: 'PMC-q2', impact_factor: '30.0', jcr_quartile: 'Q2', cas_partition: 'B2', is_top: false, publication_year: 2026 },
  ]);
  assert.deepEqual(sorted.map(group => group.pmcid), ['PMC-top', 'PMC-low', 'PMC-q2']);
});

test('PMC gallery filters journal metrics before fetching figures', () => {
  assert.match(html, /<input id="pmc-gallery-journal-filter"[^>]*list="pmc-gallery-journal-options"[^>]*disabled/);
  assert.match(html, /<datalist id="pmc-gallery-journal-options"><\/datalist>/);
  assert.match(html, /id="pmc-gallery-if-filter"/);
  assert.match(html, /id="pmc-gallery-q-filter"/);
  assert.match(html, /id="pmc-gallery-b-filter"/);
  assert.match(html, /id="pmc-gallery-top-filter"/);
  assert.match(main, /articleOffset,/);
  assert.match(main, /metricFilters,/);
  assert.match(service, /filter_ids_by_metrics/);
  assert.match(service, /matches_journal_filter/);
  assert.match(service, /pub async fn list_journal_options/);
  assert.match(service, /fulljournalname/);
  assert.match(service, /ESUMMARY_URL/);
  assert.match(service, /journal_metrics_service::lookup/);
  assert.match(main, /journal: document\.getElementById\('pmc-gallery-journal-filter'\)/);
  assert.match(main, /invoke\('list_pmc_gallery_journals'/);
  assert.match(main, /populatePmcGalleryJournalOptions/);
  assert.match(lib, /pmc_gallery_cmd::list_pmc_gallery_journals/);
  assert.match(styles, /\.pmc-gallery-metric-filters input,[\s\S]*\.pmc-gallery-metric-filters select/);
  assert.match(styles, /\.pmc-gallery-metric-filters select[\s\S]*appearance: none/);
  assert.match(migrations, /journal_filter\s+TEXT NOT NULL DEFAULT 'all'/);
  assert.match(searchService, /pub journal_filter: &'a str/);
  assert.match(service, /pub impact_factor: Option<String>/);
  assert.match(service, /compare_article_quality/);
  assert.match(searchService, /publication_year, impact_factor, jcr_quartile, cas_partition/);
  assert.match(migrations, /const PUBMED_SCHEMA_VERSION: i64 = 12/);
  assert.match(migrations, /ensure_pmc_gallery_figure_metric_columns/);
});

test('PMC gallery can batch isolate any requested figure number', () => {
  assert.match(html, /data-pmc-gallery-view="figure-number">按图号提取/);
  assert.match(html, /id="pmc-gallery-figure-number"[^>]*min="1"[^>]*max="99"/);
  assert.match(main, /isPmcFigureNumber\(figure, pmcGalleryFigureNumber\)/);
  assert.match(main, /const figureLabel/);
  assert.match(main, /setPmcGalleryFigureNumber\(event\.currentTarget\.value\)/);
  assert.match(main, /setPmcGalleryView\(button\.dataset\.pmcGalleryView\)/);
  assert.equal(isPmcFigureNumber({ label: 'Figure 2' }, 2), true);
  assert.equal(isPmcFigureNumber({ label: 'Fig. 2.' }, 2), true);
  assert.equal(isPmcFigureNumber({ label: '图 2' }, 2), true);
  assert.equal(isPmcFigureNumber({ label: 'Figure 2A' }, 2), true);
  assert.equal(isPmcFigureNumber({ label: 'Figure 20' }, 2), false);
});

test('PMC gallery keeps figures from the same article together', () => {
  const groups = groupPmcFiguresByArticle([
    { pmcid: 'PMC1', article_title: 'First paper', article_url: 'https://example.test/1', label: 'Figure 1' },
    { pmcid: 'PMC2', article_title: 'Second paper', article_url: 'https://example.test/2', label: 'Figure 1' },
    { pmcid: 'PMC1', article_title: 'First paper', article_url: 'https://example.test/1', label: 'Figure 2' },
  ]);
  assert.deepEqual(groups.map(group => group.pmcid), ['PMC1', 'PMC2']);
  assert.deepEqual(groups[0].figures.map(figure => figure.label), ['Figure 1', 'Figure 2']);
  assert.equal(groups[1].figures.length, 1);
  assert.match(main, /groupPmcFiguresByArticle\(figures\)/);
  assert.match(main, /pmc-gallery-article-group/);
});

test('PMC gallery shows one figure per article with previous and next controls', () => {
  assert.match(main, /pmcGalleryFigureIndexes = new Map/);
  assert.match(main, /data-pmc-gallery-nav="-1"/);
  assert.match(main, /data-pmc-gallery-nav="1"/);
  assert.match(main, /pmcGalleryCardMarkup\(figure\)/);
  assert.doesNotMatch(main, /group\.figures\.map\(pmcGalleryCardMarkup\)/);
  assert.match(styles, /\.pmc-gallery-carousel[\s\S]*width: min\(720px, 100%\)/);
  assert.match(styles, /\.pmc-gallery-carousel-arrow\.is-previous/);
  assert.match(styles, /\.pmc-gallery-carousel-arrow\.is-next/);
});

test('PMC gallery loads later pages and deduplicates accumulated figures', () => {
  const merged = mergePmcGalleryResults(
    {
      scanned_articles: 2,
      skipped_articles: 1,
      filtered_articles: 3,
      figures: [{ image_url: 'one.jpg' }],
    },
    {
      scanned_articles: 4,
      skipped_articles: 2,
      filtered_articles: 5,
      figures: [{ image_url: 'one.jpg' }, { image_url: 'two.jpg' }],
      next_offset: 28,
      has_more: true,
    },
  );
  assert.equal(merged.scanned_articles, 6);
  assert.equal(merged.skipped_articles, 3);
  assert.equal(merged.filtered_articles, 8);
  assert.deepEqual(merged.figures.map(figure => figure.image_url), ['one.jpg', 'two.jpg']);
  assert.match(html, /id="btn-load-more-pmc-gallery"[^>]*>继续加载 20 篇/);
  assert.match(main, /searchPmcGallery\(true\)/);
  assert.match(main, /pmcGalleryNextOffset/);
});

test('PMC gallery only searches open access records and keeps the scan bounded', () => {
  const previewBlock = service.slice(
    service.indexOf('pub async fn preview_gallery'),
    service.indexOf('async fn filter_ids_by_metrics'),
  );
  assert.match(service, /open_access\[filter\]/);
  assert.doesNotMatch(previewBlock, /let search_term = format!\(\"\(\{\}\) AND open_access\[filter\]/);
  assert.match(previewBlock, /open_access_search_term/);
  assert.match(service, /const MAX_ARTICLE_LIMIT: usize = 20/);
  assert.match(service, /const MAX_FIGURES: usize = 120/);
  assert.match(service, /pmc-oa-opendata\.s3\.amazonaws\.com/);
  assert.match(styles, /\.pmc-gallery-carousel[\s\S]*position: relative/);
  assert.match(styles, /\.pmc-gallery-image-button[\s\S]*aspect-ratio: 4 \/ 3/);
});
