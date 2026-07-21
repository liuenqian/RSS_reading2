use crate::db::DbState;
use crate::models::{
    SciReviewJournalRecommendation, SciReviewJournalRecommendationInput, SciReviewStageArtifact,
    SciReviewStageInput, SciReviewWritingSection, SciReviewWritingSectionInput,
};
use crate::services::{cost_service, sci_review_service, settings_service};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

fn safe_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || ['-', '_'].contains(&character) {
                character
            } else {
                '_'
            }
        })
        .take(100)
        .collect()
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn write_text(path: &Path, content: &str) -> Result<String, String> {
    fs::write(path, content).map_err(|error| format!("写入 Skill 产物失败：{}", error))?;
    Ok(path.to_string_lossy().to_string())
}

fn save_writing_outputs(
    root: PathBuf,
    project_id: &str,
    section: &SciReviewWritingSection,
) -> Result<Vec<String>, String> {
    let (folder, draft_name, citation_name) = match section.section_id.as_str() {
        "introduction" => (
            "11-SCI综述全文第一章撰写器",
            "第一章初稿.md",
            "第一章引用证据表.csv",
        ),
        "body" => (
            "12-SCI综述全文第二章撰写器",
            "第二章初稿.md",
            "第二章引用证据表.csv",
        ),
        "synthesis" => (
            "13-SCI综述后续全文撰写器",
            "后续章节初稿.md",
            "全文引用证据汇总表.csv",
        ),
        _ => return Err("不支持的写作产物目录".to_string()),
    };
    let output_dir = root
        .join("sci-review-projects")
        .join(safe_segment(project_id))
        .join(folder)
        .join("输出");
    let quality_dir = output_dir.parent().unwrap_or(&output_dir).join("质量核查");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("创建 Skill 输出目录失败：{}", error))?;
    fs::create_dir_all(&quality_dir).map_err(|error| format!("创建质量核查目录失败：{}", error))?;

    let mut csv = "段落ID,关键论点,证据标识符,证据基础\n".to_string();
    for item in &section.citations {
        csv.push_str(&format!(
            "{},{},{},{}\n",
            csv_cell(&item.paragraph_id),
            csv_cell(&item.claim),
            csv_cell(&item.identifiers.join("; ")),
            csv_cell(&item.basis)
        ));
    }
    let manual = format!(
        "# 需要人工核查清单\n\n{}\n",
        section
            .manual_checks
            .iter()
            .map(|item| format!("- [ ] {}", item))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let handoff = format!(
        "# 下一步交接记录\n\n- 当前 Skill：{}\n- Skill 版本：{}\n- 完成状态：{}\n- 下一步：{}\n",
        section.skill_id,
        section.skill_version,
        section.completion_state,
        match section.section_id.as_str() {
            "introduction" => "12-SCI综述全文第二章撰写器",
            "body" => "13-SCI综述后续全文撰写器",
            _ => "14-SCI目标期刊选择器",
        }
    );
    let quality = format!(
        "# Skill 质量门槛核查\n\n- Skill：{}\n- 版本：{}\n- 状态：未逐条人工确认，禁止标记完成\n\n{}\n",
        section.skill_id,
        section.skill_version,
        section
            .quality_gates
            .iter()
            .map(|item| format!("- [ ] {}", item))
            .collect::<Vec<_>>()
            .join("\n")
    );
    Ok(vec![
        write_text(&output_dir.join(draft_name), &section.markdown)?,
        write_text(&output_dir.join(citation_name), &csv)?,
        write_text(&output_dir.join("需要人工核查清单.md"), &manual)?,
        write_text(&output_dir.join("下一步交接记录.md"), &handoff)?,
        write_text(&quality_dir.join("Skill质量门槛核查.md"), &quality)?,
    ])
}

fn writing_folder(section_id: &str) -> Result<&'static str, String> {
    match section_id {
        "introduction" => Ok("11-SCI综述全文第一章撰写器"),
        "body" => Ok("12-SCI综述全文第二章撰写器"),
        "synthesis" => Ok("13-SCI综述后续全文撰写器"),
        _ => Err("不支持的写作章节".to_string()),
    }
}

#[tauri::command]
pub fn confirm_sci_review_writing_quality_gates(
    app: AppHandle,
    project_id: String,
    section_id: String,
    skill_id: String,
    skill_version: String,
) -> Result<String, String> {
    let expected_skill = match section_id.as_str() {
        "introduction" => "sci-review-chapter-one-writer",
        "body" => "sci-review-chapter-two-writer",
        "synthesis" => "sci-review-subsequent-chapters-writer",
        _ => return Err("不支持的写作章节".to_string()),
    };
    if skill_id != expected_skill {
        return Err(format!(
            "Skill 身份不匹配：当前章节必须由 {} 生成",
            expected_skill
        ));
    }
    if skill_version.trim().is_empty() || skill_version == "missing" {
        return Err("Skill 版本无效，不能确认质量门槛".to_string());
    }

    let confirmed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let quality_dir = root
        .join("sci-review-projects")
        .join(safe_segment(&project_id))
        .join(writing_folder(&section_id)?)
        .join("质量核查");
    fs::create_dir_all(&quality_dir).map_err(|error| format!("创建质量核查目录失败：{}", error))?;
    let content = format!(
        "# Skill 质量门槛确认\n\n- Skill：{}\n- 版本：{}\n- 章节：{}\n- 确认时间（Unix）：{}\n- 状态：已由用户确认逐项核查，允许进入下一 Skill\n",
        skill_id, skill_version, section_id, confirmed_at
    );
    write_text(&quality_dir.join("Skill质量门槛确认.md"), &content)
}

#[tauri::command]
pub async fn run_sci_review_stage(
    state: State<'_, DbState>,
    input: SciReviewStageInput,
) -> Result<SciReviewStageArtifact, String> {
    let settings = {
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        settings_service::get_settings(&conn)
    };
    if settings.api_key.trim().is_empty() {
        return Err("请先在设置中配置当前 AI 服务的 API Key".to_string());
    }
    let (artifact, usage) = sci_review_service::run_stage(&settings, input).await?;
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    Ok(artifact)
}

#[tauri::command]
pub async fn write_sci_review_section(
    app: AppHandle,
    state: State<'_, DbState>,
    input: SciReviewWritingSectionInput,
) -> Result<SciReviewWritingSection, String> {
    let project_id = input.project_id.clone();
    let settings = {
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        settings_service::get_settings(&conn)
    };
    if settings.api_key.trim().is_empty() {
        return Err("请先在设置中配置当前 AI 服务的 API Key".to_string());
    }
    let (mut section, usage) = sci_review_service::write_section(&settings, input).await?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    section.output_files = save_writing_outputs(root, &project_id, &section)?;
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    Ok(section)
}

#[tauri::command]
pub async fn recommend_sci_review_journals(
    state: State<'_, DbState>,
    input: SciReviewJournalRecommendationInput,
) -> Result<SciReviewJournalRecommendation, String> {
    let settings = {
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        settings_service::get_settings(&conn)
    };
    if settings.api_key.trim().is_empty() {
        return Err("请先在设置中配置当前 AI 服务的 API Key".to_string());
    }
    let (recommendation, usage) = sci_review_service::recommend_journals(&settings, input).await?;
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let _ = cost_service::record_usage(&conn, &settings.provider, &settings.model, &usage);
    Ok(recommendation)
}
