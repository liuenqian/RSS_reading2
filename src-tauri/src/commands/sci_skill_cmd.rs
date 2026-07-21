use crate::models::SciSkillSpec;
use crate::services::sci_skill_service;

#[tauri::command]
pub fn list_sci_skill_specs() -> Vec<SciSkillSpec> {
    sci_skill_service::list_specs()
}

#[tauri::command]
pub fn get_sci_skill_spec(skill_id: String) -> Result<SciSkillSpec, String> {
    sci_skill_service::get_spec(&skill_id)
}
