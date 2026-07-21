use crate::models::SciSkillSpec;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const SKILL_REGISTRY: &[(&str, &str, u8)] = &[
    ("sci-project-initializer", "SCI 项目初始化", 1),
    ("sci-search-query-generator", "SCI 检索式生成器", 2),
    ("sci-literature-search-exporter", "SCI 文献检索导出器", 3),
    ("sci-topic-gap-identifier", "SCI 选题与研究空白识别", 4),
    (
        "sci-benchmark-review-library-deep-learning",
        "SCI 建立综述对标库并深度学习",
        5,
    ),
    (
        "sci-literature-screening-organizer",
        "SCI 文献筛选分类器",
        6,
    ),
    (
        "sci-pdf-literature-acquisition-organizer",
        "SCI 导入 Zotero 并获取文献 PDF",
        7,
    ),
    ("sci-literature-intensive-reader", "SCI 文献精读器", 8),
    ("sci-review-framework-builder", "文献综述框架的搭建", 9),
    (
        "sci-review-figure-layout-citation-planner",
        "SCI 综述图片排版与图表引用器",
        10,
    ),
    (
        "sci-review-chapter-one-writer",
        "SCI 综述全文第一章撰写器",
        11,
    ),
    (
        "sci-review-chapter-two-writer",
        "SCI 综述全文第二章撰写器",
        12,
    ),
    (
        "sci-review-subsequent-chapters-writer",
        "SCI 综述后续全文撰写器",
        13,
    ),
    ("sci-target-journal-selector", "SCI 目标期刊选择器", 14),
    (
        "sci-target-journal-deep-learner",
        "SCI 目标期刊深度学习器",
        15,
    ),
    ("sci-review-deep-polisher", "SCI 综述深度润色器", 16),
    (
        "sci-figure-permission-requester",
        "SCI 图片引用权限申请器",
        17,
    ),
    ("sci-cover-letter-writer", "Cover Letter 撰写器", 18),
    ("sci-submission-guide", "SCI 投稿指导器", 19),
    ("sci-reviewer-response-writer", "审稿人意见回复器", 20),
];

fn skills_root() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".codex")
        .join("skills")
}

fn section_lines(body: &str, heading: &str) -> Vec<String> {
    let mut active = false;
    let mut result = Vec::new();
    for line in body.lines() {
        if line.trim_start().starts_with("## ") {
            active = line.trim() == heading;
            continue;
        }
        if active {
            let item = line
                .trim()
                .trim_start_matches(|character: char| {
                    character.is_ascii_digit()
                        || character == '.'
                        || character == '-'
                        || character == '*'
                })
                .trim()
                .trim_matches('`')
                .trim();
            if !item.is_empty() && !item.starts_with("<!--") {
                result.push(item.to_string());
            }
        }
    }
    result
}

fn description_from_header(raw: &str) -> String {
    raw.lines()
        .find_map(|line| line.trim().strip_prefix("description:"))
        .unwrap_or_default()
        .trim()
        .trim_matches('"')
        .to_string()
}

fn version_for(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn list_specs() -> Vec<SciSkillSpec> {
    SKILL_REGISTRY
        .iter()
        .map(|(skill_id, fallback_name, step)| load_spec(skill_id, fallback_name, *step))
        .collect()
}

pub fn get_spec(skill_id: &str) -> Result<SciSkillSpec, String> {
    let (id, fallback_name, step) = SKILL_REGISTRY
        .iter()
        .find(|(id, _, _)| *id == skill_id)
        .ok_or_else(|| "不允许加载未登记的 Skill".to_string())?;
    let spec = load_spec(id, fallback_name, *step);
    if !spec.available {
        return Err(format!("缺少 Skill 原文：{}", spec.skill_path));
    }
    Ok(spec)
}

pub fn get_skill_text(skill_id: &str) -> Result<String, String> {
    let spec = get_spec(skill_id)?;
    fs::read_to_string(&spec.skill_path).map_err(|error| format!("读取 Skill 原文失败：{}", error))
}

fn load_spec(skill_id: &str, fallback_name: &str, step: u8) -> SciSkillSpec {
    let path = skills_root().join(skill_id).join("SKILL.md");
    match fs::read_to_string(&path) {
        Ok(raw) => SciSkillSpec {
            step,
            skill_id: skill_id.to_string(),
            skill_name: fallback_name.to_string(),
            description: description_from_header(&raw),
            skill_path: path.to_string_lossy().to_string(),
            skill_version: version_for(&path),
            available: true,
            required_inputs: section_lines(&raw, "## Required Inputs"),
            core_workflow: section_lines(&raw, "## Core Workflow"),
            outputs: section_lines(&raw, "## Outputs"),
            quality_gates: section_lines(&raw, "## Quality Gates"),
            prohibited_actions: section_lines(&raw, "## Prohibited Actions"),
        },
        Err(_) => SciSkillSpec {
            step,
            skill_id: skill_id.to_string(),
            skill_name: fallback_name.to_string(),
            description: "未找到 Skill 原文，不能严格执行".to_string(),
            skill_path: path.to_string_lossy().to_string(),
            skill_version: "missing".to_string(),
            available: false,
            required_inputs: Vec::new(),
            core_workflow: Vec::new(),
            outputs: Vec::new(),
            quality_gates: Vec::new(),
            prohibited_actions: Vec::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::list_specs;

    #[test]
    fn registry_keeps_the_numerical_workflow_order() {
        let specs = list_specs();
        assert_eq!(specs.first().map(|item| item.step), Some(1));
        assert_eq!(specs.last().map(|item| item.step), Some(20));
        assert!(specs.windows(2).all(|items| items[0].step < items[1].step));
    }
}
