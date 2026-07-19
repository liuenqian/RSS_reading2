use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalMetric {
    pub journal: Option<String>,
    pub abbr: Option<String>,
    #[serde(rename = "if")]
    pub impact_factor: Option<String>,
    pub q: Option<String>,
    pub b: Option<String>,
    pub top: Option<String>,
}

static INDEX: OnceLock<HashMap<String, JournalMetric>> = OnceLock::new();

pub fn normalize_journal_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .replace('&', "and")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect()
}

pub fn lookup(value: &str) -> Option<JournalMetric> {
    let key = normalize_journal_key(value);
    if key.is_empty() {
        return None;
    }
    index().get(&key).cloned()
}

fn index() -> &'static HashMap<String, JournalMetric> {
    INDEX.get_or_init(|| {
        let source = include_str!("../../../src/journal-metrics.json");
        serde_json::from_str(source).expect("journal-metrics.json must be valid JSON")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_journal_keys_like_the_frontend() {
        assert_eq!(
            normalize_journal_key("CA: a cancer journal & clinic"),
            "caacancerjournalandclinic"
        );
        assert_eq!(
            normalize_journal_key("  Journal Name (Print)  "),
            "journalnameprint"
        );
    }

    #[test]
    fn looks_up_metrics_and_preserves_missing_values() {
        let metric = lookup("CA: a cancer journal for clinicians").unwrap();
        assert_eq!(metric.impact_factor.as_deref(), Some("232.4"));
        assert_eq!(metric.q.as_deref(), Some("Q1"));
        assert!(lookup("not a real journal").is_none());
    }
}
