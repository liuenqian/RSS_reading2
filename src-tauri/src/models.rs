use serde::{Deserialize, Serialize};

pub const DEFAULT_CONTEXT_INPUT_TOKENS: i64 = 1_140_000;
pub const DEFAULT_CONTEXT_OUTPUT_TOKENS: i64 = 16_000;
pub const DEFAULT_TOOL_CALL_ROUNDS: i64 = 500;

fn default_context_input_tokens() -> i64 {
    DEFAULT_CONTEXT_INPUT_TOKENS
}

fn default_context_output_tokens() -> i64 {
    DEFAULT_CONTEXT_OUTPUT_TOKENS
}

fn default_tool_call_rounds() -> i64 {
    DEFAULT_TOOL_CALL_ROUNDS
}

fn default_reading_mode() -> String {
    "quick".to_string()
}

fn default_reading_source_kind() -> String {
    "prompt".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feed {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub created_at: String,
    pub refresh_interval: String,
    pub notify: bool,
    pub last_fetched_at: Option<String>,
    #[serde(default)]
    pub pubmed_query: Option<String>,
    #[serde(default)]
    pub pubmed_limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: i64,
    pub feed_id: Option<i64>,
    pub guid: String,
    pub title: String,
    pub link: String,
    pub summary: Option<String>,
    pub summary_source: Option<String>,
    pub author: Option<String>,
    pub published_at: Option<String>,
    pub publication_date: Option<String>,
    pub source: Option<String>,
    pub pmid: Option<String>,
    pub pmcid: Option<String>,
    pub doi: Option<String>,
    pub affiliation: Option<String>,
    pub fetched_at: String,
    pub is_read: bool,
    pub read_at: Option<String>,
    pub title_translated: Option<String>,
    pub summary_translated: Option<String>,
    #[serde(default = "default_screening_status")]
    pub screening_status: String,
    pub has_reading_note: bool,
    pub tags: Vec<String>,
    pub has_free_fulltext: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WordFrequencyItem {
    pub term: String,
    pub count: usize,
    pub document_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WordFrequencyResult {
    pub items: Vec<WordFrequencyItem>,
    pub document_count: usize,
    pub pdf_document_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WordFrequencyTranslation {
    pub term: String,
    pub translated: String,
}

fn default_screening_status() -> String {
    "unreviewed".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EntryIdentifiers {
    pub pmid: Option<String>,
    pub pmcid: Option<String>,
    pub doi: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaperGraphNode {
    pub paper_id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub citation_count: i64,
    pub url: Option<String>,
    pub doi: Option<String>,
    pub pmid: Option<String>,
    pub abstract_text: Option<String>,
    pub relations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaperGraphEdge {
    pub source: String,
    pub target: String,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaperGraph {
    pub seed_id: String,
    pub nodes: Vec<PaperGraphNode>,
    pub edges: Vec<PaperGraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PubmedAuthorRecord {
    pub author_order: usize,
    pub last_name: Option<String>,
    pub fore_name: Option<String>,
    pub initials: Option<String>,
    pub collective_name: Option<String>,
    pub display_name: String,
    pub orcid: Option<String>,
    pub affiliations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PubmedArticleRecord {
    pub pmid: String,
    pub pmcid: Option<String>,
    pub doi: Option<String>,
    pub title: String,
    pub abstract_text: Option<String>,
    pub authors: Option<String>,
    #[serde(default)]
    pub structured_authors: Vec<PubmedAuthorRecord>,
    pub journal: Option<String>,
    pub affiliation: Option<String>,
    pub publication_date: Option<String>,
    pub publication_date_raw: Option<String>,
    pub publication_date_precision: Option<String>,
    pub publication_sort_key: Option<i64>,
    pub has_free_fulltext: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedSearchPreview {
    pub query: String,
    pub total_count: usize,
    pub pmids: Vec<String>,
    pub entries: Vec<PubmedArticleRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewTermEvidence {
    pub chinese_concept: String,
    pub concept_breakdown: String,
    pub recommended_terms: Vec<String>,
    pub term_type: String,
    pub variants: Vec<String>,
    pub mesh_evidence: String,
    pub pubmed_evidence: String,
    pub wos_evidence: String,
    pub inclusion_decision: String,
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewQueryOption {
    pub id: String,
    pub label: String,
    pub pubmed_query: String,
    pub wos_query: String,
    pub purpose: String,
    pub recall: String,
    pub precision: String,
    pub use_case: String,
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewSearchStrategy {
    #[serde(default)]
    pub skill_id: String,
    #[serde(default)]
    pub skill_version: String,
    #[serde(default)]
    pub quality_gates: Vec<String>,
    pub direction: String,
    pub keywords: String,
    pub target_tier: String,
    pub core_concepts: Vec<String>,
    pub manual_checks: Vec<String>,
    pub term_evidence: Vec<SciReviewTermEvidence>,
    pub options: Vec<SciReviewQueryOption>,
    pub recommended_option: String,
    pub recommendation_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewLiteratureRecord {
    pub entry_id: i64,
    pub title: String,
    pub abstract_text: Option<String>,
    pub authors: Option<String>,
    pub journal: Option<String>,
    pub publication_date: Option<String>,
    pub pmid: Option<String>,
    pub pmcid: Option<String>,
    pub doi: Option<String>,
    pub screening_status: String,
    pub has_free_fulltext: bool,
    pub has_reading_note: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewStageInput {
    pub stage: String,
    pub project_name: String,
    pub direction: String,
    pub keywords: String,
    pub target_tier: String,
    pub linked_search_name: Option<String>,
    pub pubmed_query: Option<String>,
    pub total_records: usize,
    pub records: Vec<SciReviewLiteratureRecord>,
    pub upstream_artifacts: Vec<String>,
    pub target_journal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewStageArtifact {
    pub stage: String,
    pub skill_id: String,
    pub skill_version: String,
    pub skill_name: String,
    pub title: String,
    pub summary: String,
    pub markdown: String,
    pub completion_state: String,
    pub input_record_count: usize,
    pub total_record_count: usize,
    pub manual_checks: Vec<String>,
    pub quality_gates: Vec<String>,
    pub next_stage: String,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewJournalFrequency {
    pub journal_name: String,
    pub article_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewJournalRecommendationInput {
    pub project_name: String,
    pub direction: String,
    pub keywords: String,
    pub target_tier: String,
    pub article_type: String,
    pub oa_preference: String,
    pub apc_preference: String,
    pub timeline_preference: String,
    pub draft_excerpt: String,
    pub journal_distribution: Vec<SciReviewJournalFrequency>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewJournalCandidate {
    pub journal_name: String,
    pub tier: String,
    pub fit_score: u8,
    pub evidence_count: usize,
    pub reason: String,
    pub risk: String,
    pub verification_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewJournalRecommendation {
    #[serde(default)]
    pub skill_id: String,
    #[serde(default)]
    pub skill_version: String,
    #[serde(default)]
    pub quality_gates: Vec<String>,
    pub summary: String,
    pub candidates: Vec<SciReviewJournalCandidate>,
    pub recommended_journal: String,
    pub manual_checks: Vec<String>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewWritingEvidence {
    pub entry_id: i64,
    pub title: String,
    pub abstract_text: Option<String>,
    pub pmid: Option<String>,
    pub doi: Option<String>,
    pub note_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewWritingSectionInput {
    pub project_id: String,
    pub section_id: String,
    pub project_name: String,
    pub direction: String,
    pub keywords: String,
    pub framework: String,
    pub figure_plan: String,
    pub previous_sections: Vec<String>,
    pub evidence: Vec<SciReviewWritingEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewCitationEvidence {
    pub paragraph_id: String,
    pub claim: String,
    pub identifiers: Vec<String>,
    pub basis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciReviewWritingSection {
    pub skill_id: String,
    pub skill_version: String,
    pub section_id: String,
    pub title: String,
    pub markdown: String,
    pub citations: Vec<SciReviewCitationEvidence>,
    pub evidence_record_count: usize,
    pub reading_note_count: usize,
    pub manual_checks: Vec<String>,
    pub quality_gates: Vec<String>,
    pub completion_state: String,
    pub output_files: Vec<String>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SciSkillSpec {
    pub step: u8,
    pub skill_id: String,
    pub skill_name: String,
    pub description: String,
    pub skill_path: String,
    pub skill_version: String,
    pub available: bool,
    pub required_inputs: Vec<String>,
    pub core_workflow: Vec<String>,
    pub outputs: Vec<String>,
    pub quality_gates: Vec<String>,
    pub prohibited_actions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PubmedAuthorQueryCandidate {
    pub label: String,
    pub query: String,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PubmedAuthorQueryResult {
    pub query: String,
    pub candidates: Vec<PubmedAuthorQueryCandidate>,
    pub author_name: String,
    pub affiliation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PubmedPreviewEntryAssessment {
    pub pmid: String,
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PubmedPreviewAssessment {
    pub verdict: String,
    pub summary: String,
    pub sample_size: usize,
    pub abstract_count: usize,
    pub relevant_count: usize,
    pub maybe_count: usize,
    pub irrelevant_count: usize,
    pub precision_percent: f64,
    pub precision_low_percent: f64,
    pub precision_high_percent: f64,
    pub recall_risk: String,
    pub recall_assessment: String,
    pub coverage_gaps: Vec<String>,
    pub suggested_query: Option<String>,
    pub entries: Vec<PubmedPreviewEntryAssessment>,
}

#[derive(Debug, Clone)]
pub struct PubmedSearchPage {
    pub total_count: usize,
    pub pmids: Vec<String>,
    pub web_env: Option<String>,
    pub query_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedSearch {
    pub id: i64,
    pub name: String,
    pub question: Option<String>,
    pub query: String,
    pub retrieval_scope: String,
    pub retrieval_limit: Option<i64>,
    pub retrieval_date_from: Option<String>,
    pub retrieval_date_to: Option<String>,
    pub retrieval_sort: String,
    pub created_at: String,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_result_count: i64,
    pub last_added_count: i64,
    pub total_entries: i64,
    pub unreviewed_count: i64,
    pub keep_count: i64,
    pub maybe_count: i64,
    pub exclude_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PmcGallerySearch {
    pub id: i64,
    pub name: String,
    pub mode: String,
    pub question: Option<String>,
    pub author_name: Option<String>,
    pub affiliation: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub query: String,
    pub article_limit: i64,
    pub journal_filter: String,
    pub impact_factor_filter: String,
    pub jcr_quartile_filter: String,
    pub cas_partition_filter: String,
    pub top_filter: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_success_at: Option<String>,
    pub last_result_count: i64,
    pub last_scanned_articles: i64,
    pub last_figure_count: i64,
    pub last_next_offset: i64,
    pub last_has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PubmedRetrievalOptions {
    #[serde(default = "default_pubmed_retrieval_scope")]
    pub scope: String,
    pub limit: Option<usize>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    #[serde(default = "default_pubmed_retrieval_sort")]
    pub sort: String,
}

impl Default for PubmedRetrievalOptions {
    fn default() -> Self {
        Self {
            scope: default_pubmed_retrieval_scope(),
            limit: None,
            date_from: None,
            date_to: None,
            sort: default_pubmed_retrieval_sort(),
        }
    }
}

fn default_pubmed_retrieval_scope() -> String {
    "all".to_string()
}

fn default_pubmed_retrieval_sort() -> String {
    "most_recent".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedSearchRunResult {
    pub run_id: i64,
    pub search_id: i64,
    pub status: String,
    pub matched_count: usize,
    pub added_count: usize,
    pub reused_count: usize,
    pub failed_count: usize,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedSearchEntry {
    pub entry_id: i64,
    pub search_id: i64,
    pub screening_status: String,
    pub first_seen_at: String,
    pub last_seen_at: String,
    pub is_current_match: bool,
    pub pubmed_rank: Option<i64>,
    pub title: String,
    pub title_translated: Option<String>,
    pub summary: Option<String>,
    pub summary_translated: Option<String>,
    pub authors: Option<String>,
    #[serde(default)]
    pub structured_authors: Vec<PubmedAuthorRecord>,
    pub journal: Option<String>,
    pub publication_date: Option<String>,
    pub publication_date_raw: Option<String>,
    pub publication_date_precision: Option<String>,
    pub publication_sort_key: Option<i64>,
    pub published_at: Option<String>,
    pub pmid: Option<String>,
    pub pmcid: Option<String>,
    pub doi: Option<String>,
    pub affiliation: Option<String>,
    pub has_free_fulltext: bool,
    pub is_read: bool,
    pub read_at: Option<String>,
    pub has_reading_note: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedSearchMembershipLabel {
    pub search_id: i64,
    pub search_name: String,
    pub screening_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PubmedScreeningSuggestion {
    pub entry_id: i64,
    pub pmid: Option<String>,
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedScreeningSuggestionResult {
    pub raw_answer: String,
    pub suggestions: Vec<PubmedScreeningSuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeptPubmedEntry {
    #[serde(flatten)]
    pub entry: PubmedSearchEntry,
    pub searches: Vec<PubmedSearchMembershipLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedExportMetric {
    pub entry_id: i64,
    pub impact_factor: Option<String>,
    pub jcr_quartile: Option<String>,
    pub cas_partition: Option<String>,
    pub is_top: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NatureDownloadItem {
    pub title: String,
    pub doi: Option<String>,
    pub pmid: Option<String>,
    pub pmcid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NatureDownloadReport {
    pub total: usize,
    pub downloaded: usize,
    pub needs_user_action: usize,
    pub output_dir: String,
    pub results: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubmedSearchProgress {
    pub run_id: i64,
    pub search_id: i64,
    pub processed: usize,
    pub total: usize,
    pub added: usize,
    pub reused: usize,
    pub failed: usize,
    pub current_pmid: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepSeekSettings {
    #[serde(default)]
    pub config_id: Option<String>,
    #[serde(default)]
    pub api_token_profile_id: Option<String>,
    #[serde(default = "default_ai_provider")]
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub model_display_name: String,
    #[serde(default = "default_context_input_tokens")]
    pub context_input_tokens: i64,
    #[serde(default = "default_context_output_tokens")]
    pub context_output_tokens: i64,
    #[serde(default = "default_tool_call_rounds")]
    pub tool_call_rounds: i64,
    pub system_prompt: String,
    pub read_retention_days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiModelSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiTokenProfileSummary {
    pub id: String,
    pub name: String,
    pub masked_key: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiTokenProfileList {
    pub provider: String,
    pub active_id: Option<String>,
    pub profiles: Vec<ApiTokenProfileSummary>,
}

fn default_ai_provider() -> String {
    "deepseek".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingPromptProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub source_label: String,
    #[serde(default = "default_reading_mode")]
    pub reading_mode: String,
    #[serde(default = "default_reading_source_kind")]
    pub source_kind: String,
    #[serde(default)]
    pub skill_dir: Option<String>,
    #[serde(default)]
    pub skill_context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingNote {
    pub id: i64,
    pub entry_id: i64,
    pub profile_id: String,
    pub profile_name: String,
    pub content: String,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperChatMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperChatAttachment {
    pub path: String,
    pub name: String,
    pub content: String,
    pub char_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperChatAttachmentImport {
    pub attachments: Vec<PaperChatAttachment>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepSeekBalanceInfo {
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeepSeekBalance {
    pub is_available: bool,
    pub balance_infos: Vec<DeepSeekBalanceInfo>,
}

/// Provider-normalized token usage for one successful AI request.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_cache_hit_tokens: i64,
    pub prompt_cache_miss_tokens: i64,
    pub completion_tokens: i64,
}

/// One row of the per-model cost breakdown returned by `get_cost_summary`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostBreakdownRow {
    pub provider: String,
    pub model: String,
    pub prompt_cache_hit_tokens: i64,
    pub prompt_cache_miss_tokens: i64,
    pub completion_tokens: i64,
    pub cny: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostSummary {
    pub month: String,
    pub total_cny: Option<f64>,
    pub breakdown: Vec<CostBreakdownRow>,
}

// AI briefing payloads — surfaced via `commands::briefing_cmd`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BriefingCounts {
    pub articles: i64,
    pub feeds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Briefing {
    pub id: i64,
    pub period: String,
    pub title: String,
    pub lead_in: String,
    pub content: String,
    pub counts: BriefingCounts,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiteratureGrowthSource {
    pub source_kind: String,
    pub source_id: i64,
    pub name: String,
    pub total_entries: i64,
    pub last_7_days: i64,
    pub previous_7_days: i64,
    pub last_30_days: i64,
    pub weekly_average: f64,
    pub last_added_at: Option<String>,
    pub day_counts: Vec<(String, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadingStats {
    pub total_entries: i64,
    pub total_read: i64,
    pub day_counts: Vec<(String, i64)>,
    /// Per-day fetched counts. Lets the frontend slice "抓取" by period
    /// (ALL / 30d / 7d) without an extra round trip.
    pub fetched_day_counts: Vec<(String, i64)>,
    /// 24-bucket histogram of read events by local hour-of-day, used to
    /// surface the user's peak reading hour. Global across all history —
    /// peak hour is treated as identity-level, not period-dependent.
    pub read_hour_counts: Vec<i64>,
    /// Per-feed read counts. Tuple: (feed_id, snapshot_title, count). The
    /// snapshot lets the UI still show a name for feeds the user has since
    /// deleted — the frontend prefers the live feed title when available and
    /// falls back to the snapshot otherwise.
    pub feed_read_counts: Vec<(i64, Option<String>, i64)>,
    pub growth_sources: Vec<LiteratureGrowthSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedFetchResult {
    pub feed_id: i64,
    pub feed_title: String,
    pub new_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    #[serde(default = "default_update_source_available")]
    pub source_available: bool,
    pub release_url: String,
    pub release_notes: Option<String>,
    pub asset_name: Option<String>,
    /// First `.dmg` asset attached to the release, if any. Frontend uses it
    /// for the "下载安装包" direct link; missing → fall back to `release_url`.
    pub asset_url: Option<String>,
}

fn default_update_source_available() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDownloadResult {
    pub local_path: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResult {
    pub total_feeds: usize,
    pub new_entries: usize,
    pub translated_titles: usize,
    pub fetched_summaries: usize,
    pub translated_summaries: usize,
    pub errors: Vec<String>,
    pub feeds: Vec<FeedFetchResult>,
}
