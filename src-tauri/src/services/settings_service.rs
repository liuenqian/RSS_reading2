use crate::models::{
    AiModelSummary, ApiTokenProfileList, ApiTokenProfileSummary, DeepSeekSettings,
    ReadingPromptProfile, DEFAULT_CONTEXT_INPUT_TOKENS, DEFAULT_CONTEXT_OUTPUT_TOKENS,
    DEFAULT_TOOL_CALL_ROUNDS,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_MODEL: &str = "deepseek-v4-flash";
const AI_MODEL_CONFIGS_KEY: &str = "ai_model_configs";
const ACTIVE_AI_MODEL_ID_KEY: &str = "active_ai_model_id";
const DEFAULT_PROMPT: &str = "你是一个专业的学术与新闻翻译助手。你的任务是将英文 RSS 标题和摘要翻译成简洁、准确的中文。\n\n翻译规则：\n1. 准确优先：专业术语必须使用学术界通用的中文译法。如果某个术语没有公认译法，保留英文原文并用括号简要解释。\n2. 人名不翻译：所有人名保留英文原文，不做音译。\n3. 机构与期刊名：优先使用官方中文名（如 \"Nature\" → \"《自然》\"）。没有官方中文名则保留英文。\n4. 简洁：标题翻译控制在 30 个汉字以内。摘要翻译保留所有关键信息，但删除冗余的修饰语、套话和背景铺垫。\n5. 语体风格：学术内容使用正式学术语言；新闻内容使用标准新闻语言。不添加任何原文中没有的意见、评价或补充说明。\n6. HTML 标签：如果原文包含 HTML 标签（如 <p>、<a>、<em>），移除它们，只翻译纯文本内容。\n7. 仅返回翻译结果：不要在回复中包含原文、解释、备注或任何其他内容。只输出翻译后的中文文本。";

fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .ok()
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        [key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn normalize_provider_id(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "openai" => "openai",
        "anthropic" => "anthropic",
        "gemini" => "gemini",
        "openai_compatible" => "openai_compatible",
        _ => "deepseek",
    }
}

fn provider_defaults(provider: &str) -> (&'static str, &'static str) {
    match normalize_provider_id(provider) {
        "openai" => ("https://api.openai.com/v1", "gpt-5.4-mini"),
        "anthropic" => ("https://api.anthropic.com/v1", "claude-sonnet-5"),
        "gemini" => (
            "https://generativelanguage.googleapis.com/v1beta",
            "gemini-3.5-flash",
        ),
        "openai_compatible" => ("", ""),
        _ => (DEFAULT_BASE_URL, DEFAULT_MODEL),
    }
}

fn provider_setting_key(provider: &str, field: &str) -> String {
    format!("ai_provider.{}.{}", normalize_provider_id(provider), field)
}

fn positive_provider_setting(conn: &Connection, provider: &str, field: &str, default: i64) -> i64 {
    get_setting(conn, &provider_setting_key(provider, field))
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn sanitized_model_display_name(value: &str) -> String {
    value.trim().chars().take(32).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredApiTokenProfile {
    id: String,
    name: String,
    api_key: String,
}

fn load_token_profiles(conn: &Connection, provider: &str) -> Vec<StoredApiTokenProfile> {
    get_setting(conn, &provider_setting_key(provider, "token_profiles"))
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn save_token_profiles(
    conn: &Connection,
    provider: &str,
    profiles: &[StoredApiTokenProfile],
) -> Result<(), String> {
    let value = serde_json::to_string(profiles)
        .map_err(|error| format!("序列化 API Key 列表失败: {}", error))?;
    set_setting(
        conn,
        &provider_setting_key(provider, "token_profiles"),
        &value,
    )
}

fn stored_provider_api_key(conn: &Connection, provider: &str) -> String {
    get_setting(conn, &provider_setting_key(provider, "api_key"))
        .or_else(|| {
            (provider == "deepseek")
                .then(|| get_setting(conn, "api_key"))
                .flatten()
        })
        .unwrap_or_default()
}

fn set_active_provider_api_key(
    conn: &Connection,
    provider: &str,
    api_key: &str,
) -> Result<(), String> {
    set_setting(conn, &provider_setting_key(provider, "api_key"), api_key)?;
    if provider == "deepseek" {
        set_setting(conn, "api_key", api_key)?;
    }
    let active_id = get_setting(conn, ACTIVE_AI_MODEL_ID_KEY);
    let mut models = load_ai_model_configs(conn);
    if let Some(model) = models.iter_mut().find(|model| {
        model.config_id.as_deref() == active_id.as_deref()
            && normalize_provider_id(&model.provider) == provider
    }) {
        model.api_key = api_key.to_string();
        save_ai_model_configs(conn, &models)?;
    }
    Ok(())
}

fn ensure_token_profiles(
    conn: &Connection,
    provider: &str,
) -> Result<(Vec<StoredApiTokenProfile>, Option<String>), String> {
    let provider = normalize_provider_id(provider);
    let mut profiles = load_token_profiles(conn, provider);
    let mut active_id = get_setting(
        conn,
        &provider_setting_key(provider, "active_token_profile"),
    )
    .filter(|id| profiles.iter().any(|profile| profile.id == *id));

    if profiles.is_empty() {
        let api_key = stored_provider_api_key(conn, provider);
        if !api_key.trim().is_empty() {
            profiles.push(StoredApiTokenProfile {
                id: "default".to_string(),
                name: "默认 API Key".to_string(),
                api_key,
            });
            save_token_profiles(conn, provider, &profiles)?;
        }
    }

    if active_id.is_none() {
        active_id = profiles.first().map(|profile| profile.id.clone());
        if let Some(id) = active_id.as_deref() {
            set_setting(
                conn,
                &provider_setting_key(provider, "active_token_profile"),
                id,
            )?;
        }
    }

    Ok((profiles, active_id))
}

fn mask_api_key(api_key: &str) -> String {
    let suffix: String = api_key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if suffix.is_empty() {
        "未填写".to_string()
    } else {
        format!("••••{}", suffix)
    }
}

fn token_profile_list(
    provider: &str,
    profiles: &[StoredApiTokenProfile],
    active_id: Option<&str>,
) -> ApiTokenProfileList {
    ApiTokenProfileList {
        provider: normalize_provider_id(provider).to_string(),
        active_id: active_id.map(str::to_string),
        profiles: profiles
            .iter()
            .map(|profile| ApiTokenProfileSummary {
                id: profile.id.clone(),
                name: profile.name.clone(),
                masked_key: mask_api_key(&profile.api_key),
                active: active_id == Some(profile.id.as_str()),
            })
            .collect(),
    }
}

pub fn list_api_token_profiles(
    conn: &Connection,
    provider: &str,
) -> Result<ApiTokenProfileList, String> {
    let provider = normalize_provider_id(provider);
    let (profiles, active_id) = ensure_token_profiles(conn, provider)?;
    Ok(token_profile_list(
        provider,
        &profiles,
        active_id.as_deref(),
    ))
}

pub fn upsert_api_token_profile(
    conn: &Connection,
    provider: &str,
    profile_id: Option<&str>,
    name: &str,
    api_key: &str,
) -> Result<ApiTokenProfileList, String> {
    let provider = normalize_provider_id(provider);
    let name = name.trim();
    let api_key = api_key.trim();
    if name.is_empty() {
        return Err("请填写 API Key 名称".to_string());
    }
    if api_key.is_empty() {
        return Err("请填写 API Key".to_string());
    }

    let (mut profiles, _) = ensure_token_profiles(conn, provider)?;
    let id = match profile_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            let profile = profiles
                .iter_mut()
                .find(|profile| profile.id == id)
                .ok_or_else(|| "API Key 不存在".to_string())?;
            profile.name = name.to_string();
            profile.api_key = api_key.to_string();
            id.to_string()
        }
        None => {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos();
            let id = format!("token-{}", timestamp);
            profiles.push(StoredApiTokenProfile {
                id: id.clone(),
                name: name.to_string(),
                api_key: api_key.to_string(),
            });
            id
        }
    };

    save_token_profiles(conn, provider, &profiles)?;
    set_setting(
        conn,
        &provider_setting_key(provider, "active_token_profile"),
        &id,
    )?;
    set_setting(conn, "active_ai_provider", provider)?;
    set_active_provider_api_key(conn, provider, api_key)?;
    Ok(token_profile_list(provider, &profiles, Some(&id)))
}

pub fn activate_api_token_profile(
    conn: &Connection,
    provider: &str,
    profile_id: &str,
) -> Result<ApiTokenProfileList, String> {
    let provider = normalize_provider_id(provider);
    let (profiles, _) = ensure_token_profiles(conn, provider)?;
    let profile = profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "API Key 不存在".to_string())?;

    set_setting(
        conn,
        &provider_setting_key(provider, "active_token_profile"),
        &profile.id,
    )?;
    set_setting(conn, "active_ai_provider", provider)?;
    set_active_provider_api_key(conn, provider, &profile.api_key)?;
    Ok(token_profile_list(provider, &profiles, Some(&profile.id)))
}

pub fn delete_api_token_profile(
    conn: &Connection,
    provider: &str,
    profile_id: &str,
) -> Result<ApiTokenProfileList, String> {
    let provider = normalize_provider_id(provider);
    let (mut profiles, active_id) = ensure_token_profiles(conn, provider)?;
    let previous_len = profiles.len();
    profiles.retain(|profile| profile.id != profile_id);
    if profiles.len() == previous_len {
        return Err("API Key 不存在".to_string());
    }

    let next_active_id = if active_id.as_deref() == Some(profile_id) {
        profiles.first().map(|profile| profile.id.clone())
    } else {
        active_id.filter(|id| profiles.iter().any(|profile| profile.id == *id))
    };
    let next_key = next_active_id
        .as_deref()
        .and_then(|id| profiles.iter().find(|profile| profile.id == id))
        .map(|profile| profile.api_key.as_str())
        .unwrap_or_default();

    save_token_profiles(conn, provider, &profiles)?;
    set_setting(
        conn,
        &provider_setting_key(provider, "active_token_profile"),
        next_active_id.as_deref().unwrap_or_default(),
    )?;
    set_active_provider_api_key(conn, provider, next_key)?;
    Ok(token_profile_list(
        provider,
        &profiles,
        next_active_id.as_deref(),
    ))
}

fn builtin_reading_profile(
    id: &str,
    name: &str,
    description: &str,
    prompt: &str,
    source_label: &str,
) -> ReadingPromptProfile {
    ReadingPromptProfile {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        prompt: prompt.to_string(),
        source_label: source_label.to_string(),
        reading_mode: "quick".to_string(),
        source_kind: "prompt".to_string(),
        skill_dir: None,
        skill_context: None,
    }
}

fn builtin_reading_profile_with_mode(
    id: &str,
    name: &str,
    description: &str,
    prompt: &str,
    source_label: &str,
    reading_mode: &str,
) -> ReadingPromptProfile {
    ReadingPromptProfile {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        prompt: prompt.to_string(),
        source_label: source_label.to_string(),
        reading_mode: reading_mode.to_string(),
        source_kind: "prompt".to_string(),
        skill_dir: None,
        skill_context: None,
    }
}

fn default_reading_profiles() -> Vec<ReadingPromptProfile> {
    vec![
        builtin_reading_profile_with_mode(
            "leq-read-fast-note",
            "快速笔记｜摘要速读",
            "继续只基于摘要，快速判断值不值得精读。",
            r#"请按“快速笔记”模式输出 Markdown，目标是在最短时间内做出是否继续精读的判断。

## 1. 一句话判断
- 这篇文献值不值得继续读？直接回答，并写一句理由。

## 2. 你现在真正知道的
- 只提炼从标题、摘要、基础元数据中能稳定成立的 3-5 条信息。

## 3. 这篇文献可能重要的原因
- 这篇工作最可能有价值的点是什么？
- 哪些只是“可能”，不能说成已被证明？

## 4. 现在还不能下的判断
- 明确列出基于摘要无法可靠判断的内容。
- 如果缺少全文/图表/方法细节，直接写“需要全文验证”。

## 5. 下一步
- 给出 2-4 条最省时间的下一步动作。

要求：
- 不要把摘要改写成长摘要。
- 只能基于现有信息，不要脑补 figure、样本量、方法细节。 "#,
            "内置 leq-read · quick",
            "quick",
        ),
        builtin_reading_profile_with_mode(
            "leq-read-deep-note",
            "深度笔记｜全文优先",
            "优先读 PMC 免费全文；拿不到全文时明确回退到摘要。",
            r#"请按“深度笔记”模式输出 Markdown。若提供了全文内容，优先基于全文作判断；若没有拿到全文，只能基于摘要，并必须显式标明结论受限。

## 1. 研究问题与结论
- 作者真正想回答什么问题？
- 核心结论是什么？

## 2. 研究设计与证据强度
- 研究对象/模型/主要方法是什么？
- 证据最强的结果在哪里？
- 哪些结论只是相关性，哪些更接近因果？

## 3. 真正的新意
- 哪些地方有真实增量？
- 哪些只是已有结论换体系、换模型或换包装？

## 4. 最重要的局限
- 只列最影响结论成立的 2-4 个局限。
- 如果全文未获取，必须把“仅基于摘要”列为首要限制。

## 5. 值不值得继续追
- 对相关研究者，这篇文献最值得继续追的点是什么？
- 如果不值得精读，也明确说出来。

## 6. 一句话结论
- 用一句话给出最终建议。

要求：
- 全文可用时，优先利用方法、结果、讨论中的具体信息。
- 全文不可用时，不得假装看过全文，必须明确写“未获取全文，仅基于摘要”。"#,
            "内置 leq-read · deep",
            "deep",
        ),
        builtin_reading_profile(
            "leq-read-reviewer",
            "leq-read｜苛刻审稿人",
            "像严苛审稿人一样拆问题、看创新、抓最能拒稿的漏洞。",
            r#"你要像一个苛刻但专业的审稿人来读这篇文献。不要写泛泛总结，必须输出结构化阅读笔记，并用 Markdown 标题组织：

## 1. 具体问题
- 这篇文献真正回答的、可证伪的具体问题是什么？
- 这个问题是机制问题、描述问题，还是资源型工作？

## 2. 真正的新意
- 哪些结果是真的新？
- 哪些只是技术堆叠、资源整理、或已有结论的重复包装？
- 给出一个你认可的最高创新等级（S/A/B/C/D）并说明理由。

## 3. 最能拒稿的理由
- 如果你必须拒稿，最站得住脚的理由是什么？
- 优先检查：因果链是否闭合、是否缺 rescue、是否只做了相关性、是否 scope 不匹配。

## 4. 30 分钟阅读优先级
- 哪些 figure / result 最值得看？
- 哪些部分可以先跳过？

## 5. 对我研究的价值
- 对缺血性心肌病/心肌梗死/心衰方向最直接可复用的点是什么？
- 哪些结论不能直接拿来用？

约束：
- 只基于提供的信息作答；证据不足时必须明确写“需要原文验证”。
- 输出不要套话，不要写成普通摘要。
- 最后补一个“直接行动”小节，给出 2-4 条可执行后续动作。"#,
            "内置 leq-read · reviewer",
        ),
        builtin_reading_profile(
            "leq-read-innovation",
            "leq-read｜创新性判断",
            "只聚焦创新点、证据层级和最容易被高估的结论。",
            r#"请把这篇文献当作“创新性评审”来读，输出 Markdown：

## 核心 claim
- 作者最想成立的 1-2 个核心 claim 是什么？

## 创新拆解
- 逐条列出关键结果。
- 对每条结果判断：真正新 / 组合式新 / 已知事实换场景 / 仅资源性贡献。
- 给每条结果一个等级（S/A/B/C/D）并写理由。

## 证据塔位置
- 这些关键结论分别处于什么证据层级？
- 哪些是机制，哪些只是现象描述或相关性？

## 最容易被高估的部分
- 哪些表述听起来很大，但证据并不够？
- 哪些地方存在“从 what 说成 how”的问题？

## 是否值得追
- 如果我是相关领域研究者，这篇文献最值得继续追踪的 1-3 个点是什么？
- 如果时间有限，为什么它可能不值得精读？

要求：
- 输出简洁、判断明确。
- 如果信息不足，直接指出缺口，不要脑补。 "#,
            "内置 leq-read · innovation",
        ),
        builtin_reading_profile(
            "leq-read-priority",
            "leq-read｜30分钟导读",
            "快速决定这篇文献该精读哪里、跳过哪里、值不值得追。",
            r#"请为“只有 30 分钟阅读时间”的场景生成一份 Markdown 导读笔记，结构如下：

## 一句话判断
- 这篇文献值不值得读？一句话说明。

## 必看内容
- 按优先级列出最值得看的结果/figure/部分，并说明为什么。

## 可跳过内容
- 哪些部分暂时可以跳过？

## 先看什么后看什么
- 给出一个 30 分钟阅读顺序。

## 读完要记住什么
- 提炼 3-5 条最值得留下的关键信息。

## 下一步动作
- 如果继续深入，下一步该去验证什么、补读什么、对照什么文献？

要求：
- 结论要果断，不要写成长摘要。
- 如果原始信息不够支撑 figure 级建议，就明确说明需要看原文图表验证。 "#,
            "内置 leq-read · template",
        ),
        builtin_reading_profile(
            "leq-read-problem",
            "leq-read｜问题拆解",
            "只追问这篇文献真正回答的具体问题是否足够清晰、可证伪。",
            r#"请严格按照“问题拆解”模板生成 Markdown 阅读笔记，重点不是总结内容，而是拆清楚这篇文献真正回答的问题。

## 1. 论文声称的问题
- 用 1 句话概括作者声称要解决的 gap / hypothesis。

## 2. 审稿人式重述
- 改写成一个可证伪的具体问题：
  这篇论文是在问：[具体分子/机制] 是否在 [具体条件] 下导致 [可测量结果]。

## 3. 具体性检查
- 分别判断以下四项是否足够具体：分子实体、生物过程、上下文条件、可测量结果。
- 对每项写“具体 / 不具体”，并说明原因。

## 4. 三个深挖问题
- 这个 gap 是真实存在，还是人为包装出来的？
- 这个问题本质上是描述性问题还是机制性问题？
- 作者提问的层级对不对，还是问错了层级？

## 5. 最终判断
- 问题性质：假设检验 / 资源构建 / 工具开发 / 描述性图谱
- 是否可证伪：是 / 否
- 具体性等级：高 / 中 / 低
- 如果不可证伪，明确指出它为什么更像资源型文章而不是机制型文章

要求：
- 判断必须明确。
- 不允许把背景写成长摘要。
- 证据不足时明确写“需要原文验证”。"#,
            "内置 leq-read · template",
        ),
        builtin_reading_profile(
            "leq-read-rejection",
            "leq-read｜拒稿理由",
            "只找最站得住脚、最难被编辑驳回的单一拒稿理由。",
            r#"请按照“拒稿理由”模板输出 Markdown，目标是找出一条最能成立的拒稿理由，而不是罗列很多小问题。

## 1. 一句话拒稿结论
- 用一句话写：这篇论文应被拒稿，因为 [致命缺陷] 导致 [核心结论] 无法成立。

## 2. 致命缺陷类别
- 从以下类别中选最核心的一项：内部逻辑失败 / 缺因果证据 / 创新性膨胀 / 技术设计缺陷 / scope 不匹配。
- 解释为什么这是“致命缺陷”而不是一般性小问题。

## 3. 逻辑链拆解
- 论文核心 claim 是什么？
- 作者给了哪些证据？
- 缺了哪一步关键证据？
- 缺了这一步后，claim 实际只剩下什么程度？

## 4. 为什么不能靠小修解决
- 解释这个问题为什么不能靠补一两个小实验就修复。
- 如果其实只够“大修”，要明确写出并说明。

## 5. 编辑可能的反驳与回应
- 预判 2-3 条编辑常见反驳。
- 对每条给出简短回应，说明为什么这不是风格问题，而是逻辑问题。

## 6. 最终裁定
- 拒稿 / 大修 / 降格为资源型文章
- 给出一句最简洁的处理建议

要求：
- 只保留最强的一条主线，不要平均用力。
- 不要引用外部标准压人，优先使用论文自身数据和逻辑。"#,
            "内置 leq-read · template",
        ),
        builtin_reading_profile(
            "leq-read-relevance",
            "leq-read｜研究相关性",
            "从你的缺血性心肌病/心梗/心衰研究视角判断这篇文献到底能拿来做什么。",
            r#"请从“研究相关性”角度生成 Markdown 阅读笔记，默认用户研究方向是缺血性心肌病 / 心肌梗死 / 心衰，常用方法包括转录组、功能遗传学、小鼠 MI 模型、临床样本。

## 1. 一句话相关性判断
- 直接给出：核心相关 / 间接相关 / 边缘相关
- 用一句话解释原因

## 2. 可复用资产
- 按类别列出这篇文献最值得复用的资产：
  数据集 / 方法 / marker / 探针 / 动物模型 / 临床线索
- 每项都写清楚可以怎么用

## 3. 行动优先级表
- 列出 P0 / P1 / P2 三档动作
- 每个动作写：要做什么、预计耗时、难度、预期产出、依赖条件

## 4. 不该照搬的地方
- 这篇文献有哪些结论、推理或实验路径不适合直接照搬到我的研究里？
- 哪些地方容易造成“抄了结论而不是抄分析框架”的误用？

## 5. 是否值得继续追
- 如果只允许继续追 1-3 个点，应该追什么？
- 如果不值得精读，也明确写出来

要求：
- 以“我能拿来做什么”为中心，不写泛泛背景。
- 判断务必可执行，避免空泛建议。"#,
            "内置 leq-read · template",
        ),
        builtin_reading_profile(
            "leq-read-evidence",
            "leq-read｜证据塔对位",
            "把每个关键结论放到证据层级上，快速识别 overclaim。",
            r#"请按照“证据塔对位”方式输出 Markdown，核心任务是判断：论文结论和证据层级是否匹配。

## 1. 核心结论列表
- 列出 2-5 条作者最重要的结论。

## 2. 证据层级判断
- 对每条结论标注证据层级，并解释原因：
  Level 1 描述性
  Level 2 相关性
  Level 3 体外功能扰动
  Level 4 体内功能扰动
  Level 5 体外纯化机制
  Level 6 带特异性对照的体内因果
  Level 7 人体机制验证

## 3. 结论是否 overclaim
- 判断每条结论是：匹配 / 轻度高估 / 明显高估
- 明确指出“只是相关性却说成因果”“只是 what 却说成 how”等问题

## 4. 最缺的一步
- 如果要让这篇文章的核心机制 claim 更成立，最缺的一个实验或证据是什么？

## 5. 最终可信度
- 用 3-5 句话总结：这篇文章最可信的部分、最不可信的部分、是否值得继续引用

要求：
- 用审稿人口吻，但保持具体。
- 不要做普通摘要。"#,
            "内置 leq-read · rule",
        ),
    ]
}

fn merge_builtin_reading_profiles(
    profiles: Vec<ReadingPromptProfile>,
) -> Vec<ReadingPromptProfile> {
    if profiles.is_empty() {
        return default_reading_profiles();
    }

    let profiles = sanitize_reading_profiles(profiles);
    let mut merged = Vec::new();
    let mut seen = HashSet::new();

    for profile in profiles {
        if seen.insert(profile.id.clone()) {
            merged.push(profile);
        }
    }

    for builtin in default_reading_profiles() {
        if seen.insert(builtin.id.clone()) {
            merged.push(builtin);
        }
    }

    merged
}

fn sanitize_reading_profiles(profiles: Vec<ReadingPromptProfile>) -> Vec<ReadingPromptProfile> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for mut profile in profiles {
        profile.id = profile.id.trim().to_string();
        profile.name = profile.name.trim().to_string();
        profile.description = profile.description.trim().to_string();
        profile.prompt = profile.prompt.trim().to_string();
        profile.source_label = profile.source_label.trim().to_string();
        profile.reading_mode = profile.reading_mode.trim().to_ascii_lowercase();
        profile.source_kind = profile.source_kind.trim().to_ascii_lowercase();
        profile.skill_dir = profile
            .skill_dir
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        profile.skill_context = profile
            .skill_context
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if profile.id.is_empty() || profile.name.is_empty() || profile.prompt.is_empty() {
            continue;
        }
        if !seen.insert(profile.id.clone()) {
            continue;
        }
        if profile.source_label.is_empty() {
            profile.source_label = "自定义".to_string();
        }
        if profile.reading_mode != "deep" {
            profile.reading_mode = "quick".to_string();
        }
        if profile.source_kind != "skill" {
            profile.source_kind = "prompt".to_string();
            profile.skill_dir = None;
            profile.skill_context = None;
        }
        out.push(profile);
    }
    out
}

fn load_ai_model_configs(conn: &Connection) -> Vec<DeepSeekSettings> {
    get_setting(conn, AI_MODEL_CONFIGS_KEY)
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn save_ai_model_configs(conn: &Connection, models: &[DeepSeekSettings]) -> Result<(), String> {
    let value =
        serde_json::to_string(models).map_err(|error| format!("序列化模型配置失败: {}", error))?;
    set_setting(conn, AI_MODEL_CONFIGS_KEY, &value)
}

fn next_ai_model_id() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("model-{}", stamp)
}

fn model_summary_name(settings: &DeepSeekSettings) -> String {
    let display_name = sanitized_model_display_name(&settings.model_display_name);
    if display_name.is_empty() {
        settings.model.trim().to_string()
    } else {
        display_name
    }
}

fn model_summary_provider(settings: &DeepSeekSettings) -> String {
    if normalize_provider_id(&settings.provider) == "deepseek"
        && settings
            .base_url
            .trim()
            .starts_with("https://token.sensenova.cn")
    {
        "sensenova".to_string()
    } else {
        settings.provider.clone()
    }
}

fn apply_global_settings(conn: &Connection, settings: &mut DeepSeekSettings) {
    settings.system_prompt =
        get_setting(conn, "system_prompt").unwrap_or_else(|| DEFAULT_PROMPT.to_string());
    settings.read_retention_days = get_setting(conn, "read_retention_days")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
}

fn ensure_ai_model_configs(conn: &Connection) -> Vec<DeepSeekSettings> {
    let models = load_ai_model_configs(conn);
    if !models.is_empty() {
        return models;
    }

    let provider =
        get_setting(conn, "active_ai_provider").unwrap_or_else(|| "deepseek".to_string());
    let mut legacy = get_provider_settings(conn, &provider);
    let id = next_ai_model_id();
    legacy.config_id = Some(id.clone());
    let models = vec![legacy];
    let _ = save_ai_model_configs(conn, &models);
    let _ = set_setting(conn, ACTIVE_AI_MODEL_ID_KEY, &id);
    models
}

pub fn list_ai_models(conn: &Connection) -> Vec<AiModelSummary> {
    let models = ensure_ai_model_configs(conn);
    let active_id = get_setting(conn, ACTIVE_AI_MODEL_ID_KEY);
    models
        .into_iter()
        .filter_map(|settings| {
            let id = settings.config_id.clone()?;
            Some(AiModelSummary {
                active: active_id.as_deref() == Some(id.as_str()),
                id,
                name: model_summary_name(&settings),
                provider: model_summary_provider(&settings),
                model: settings.model,
            })
        })
        .collect()
}

pub fn get_ai_model(conn: &Connection, config_id: &str) -> Result<DeepSeekSettings, String> {
    let mut settings = ensure_ai_model_configs(conn)
        .into_iter()
        .find(|settings| settings.config_id.as_deref() == Some(config_id))
        .ok_or_else(|| "模型配置不存在".to_string())?;
    apply_global_settings(conn, &mut settings);
    Ok(settings)
}

pub fn save_ai_model(
    conn: &Connection,
    settings: &DeepSeekSettings,
) -> Result<DeepSeekSettings, String> {
    if settings.base_url.trim().is_empty() {
        return Err("请填写 Base URL".to_string());
    }
    if settings.model.trim().is_empty() {
        return Err("请填写 Model ID".to_string());
    }

    let mut saved = settings.clone();
    let id = saved.config_id.clone().unwrap_or_else(next_ai_model_id);
    saved.config_id = Some(id.clone());
    saved.provider = normalize_provider_id(&saved.provider).to_string();
    saved.model_display_name = sanitized_model_display_name(&saved.model_display_name);
    saved.context_input_tokens = saved.context_input_tokens.max(1);
    saved.context_output_tokens = saved.context_output_tokens.max(1);
    saved.tool_call_rounds = saved.tool_call_rounds.max(1);

    save_settings(conn, &saved)?;
    let mut models = load_ai_model_configs(conn);
    if let Some(existing) = models
        .iter_mut()
        .find(|model| model.config_id.as_deref() == Some(id.as_str()))
    {
        *existing = saved.clone();
    } else {
        models.push(saved.clone());
    }
    save_ai_model_configs(conn, &models)?;
    set_setting(conn, ACTIVE_AI_MODEL_ID_KEY, &id)?;
    Ok(saved)
}

pub fn activate_ai_model(conn: &Connection, config_id: &str) -> Result<DeepSeekSettings, String> {
    let mut settings = get_ai_model(conn, config_id)?;
    set_setting(conn, ACTIVE_AI_MODEL_ID_KEY, config_id)?;
    set_setting(
        conn,
        "active_ai_provider",
        normalize_provider_id(&settings.provider),
    )?;
    apply_global_settings(conn, &mut settings);
    Ok(settings)
}

pub fn delete_ai_model(conn: &Connection, config_id: &str) -> Result<Vec<AiModelSummary>, String> {
    if get_setting(conn, ACTIVE_AI_MODEL_ID_KEY).as_deref() == Some(config_id) {
        return Err("当前正在使用的模型不能删除，请先启用其他模型".to_string());
    }
    let mut models = load_ai_model_configs(conn);
    let original_len = models.len();
    models.retain(|model| model.config_id.as_deref() != Some(config_id));
    if models.len() == original_len {
        return Err("模型配置不存在".to_string());
    }
    save_ai_model_configs(conn, &models)?;
    Ok(list_ai_models(conn))
}

pub fn get_settings(conn: &Connection) -> DeepSeekSettings {
    let models = load_ai_model_configs(conn);
    if !models.is_empty() {
        let active_id = get_setting(conn, ACTIVE_AI_MODEL_ID_KEY);
        let mut settings = models
            .iter()
            .find(|settings| settings.config_id.as_deref() == active_id.as_deref())
            .cloned()
            .unwrap_or_else(|| models[0].clone());
        apply_global_settings(conn, &mut settings);
        return settings;
    }
    let provider =
        get_setting(conn, "active_ai_provider").unwrap_or_else(|| "deepseek".to_string());
    get_provider_settings(conn, &provider)
}

pub fn get_provider_settings(conn: &Connection, provider: &str) -> DeepSeekSettings {
    let provider = normalize_provider_id(provider).to_string();
    let (default_base_url, default_model) = provider_defaults(&provider);
    let legacy_api_key = (provider == "deepseek")
        .then(|| get_setting(conn, "api_key"))
        .flatten();
    let legacy_base_url = (provider == "deepseek")
        .then(|| get_setting(conn, "base_url"))
        .flatten();
    let legacy_model = (provider == "deepseek")
        .then(|| get_setting(conn, "model"))
        .flatten();

    let active_profile_id = get_setting(
        conn,
        &provider_setting_key(&provider, "active_token_profile"),
    );
    let profile_api_key = load_token_profiles(conn, &provider)
        .into_iter()
        .find(|profile| active_profile_id.as_deref() == Some(profile.id.as_str()))
        .map(|profile| profile.api_key);

    DeepSeekSettings {
        config_id: None,
        api_token_profile_id: active_profile_id,
        provider: provider.clone(),
        api_key: profile_api_key
            .or_else(|| get_setting(conn, &provider_setting_key(&provider, "api_key")))
            .or(legacy_api_key)
            .unwrap_or_default(),
        base_url: get_setting(conn, &provider_setting_key(&provider, "base_url"))
            .filter(|value| !value.trim().is_empty())
            .or(legacy_base_url)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default_base_url.to_string()),
        model: get_setting(conn, &provider_setting_key(&provider, "model"))
            .filter(|value| !value.trim().is_empty())
            .or(legacy_model)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default_model.to_string()),
        model_display_name: get_setting(
            conn,
            &provider_setting_key(&provider, "model_display_name"),
        )
        .map(|value| sanitized_model_display_name(&value))
        .unwrap_or_default(),
        context_input_tokens: positive_provider_setting(
            conn,
            &provider,
            "context_input_tokens",
            DEFAULT_CONTEXT_INPUT_TOKENS,
        ),
        context_output_tokens: positive_provider_setting(
            conn,
            &provider,
            "context_output_tokens",
            DEFAULT_CONTEXT_OUTPUT_TOKENS,
        ),
        tool_call_rounds: positive_provider_setting(
            conn,
            &provider,
            "tool_call_rounds",
            DEFAULT_TOOL_CALL_ROUNDS,
        ),
        system_prompt: get_setting(conn, "system_prompt")
            .unwrap_or_else(|| DEFAULT_PROMPT.to_string()),
        read_retention_days: get_setting(conn, "read_retention_days")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    }
}

pub fn save_settings(conn: &Connection, settings: &DeepSeekSettings) -> Result<(), String> {
    let provider = normalize_provider_id(&settings.provider);
    set_setting(conn, "active_ai_provider", provider)?;
    set_setting(
        conn,
        &provider_setting_key(provider, "api_key"),
        &settings.api_key,
    )?;
    set_setting(
        conn,
        &provider_setting_key(provider, "base_url"),
        &settings.base_url,
    )?;
    set_setting(
        conn,
        &provider_setting_key(provider, "model"),
        &settings.model,
    )?;
    set_setting(
        conn,
        &provider_setting_key(provider, "model_display_name"),
        &sanitized_model_display_name(&settings.model_display_name),
    )?;
    set_setting(
        conn,
        &provider_setting_key(provider, "context_input_tokens"),
        &settings.context_input_tokens.max(1).to_string(),
    )?;
    set_setting(
        conn,
        &provider_setting_key(provider, "context_output_tokens"),
        &settings.context_output_tokens.max(1).to_string(),
    )?;
    set_setting(
        conn,
        &provider_setting_key(provider, "tool_call_rounds"),
        &settings.tool_call_rounds.max(1).to_string(),
    )?;
    if provider == "deepseek" {
        set_setting(conn, "api_key", &settings.api_key)?;
        set_setting(conn, "base_url", &settings.base_url)?;
        set_setting(conn, "model", &settings.model)?;
    }
    set_setting(conn, "system_prompt", &settings.system_prompt)?;
    set_setting(
        conn,
        "read_retention_days",
        &settings.read_retention_days.to_string(),
    )?;
    Ok(())
}

pub fn get_reading_profiles(conn: &Connection) -> Vec<ReadingPromptProfile> {
    let raw = get_setting(conn, "reading_prompt_profiles");
    let parsed = raw
        .as_deref()
        .and_then(|value| serde_json::from_str::<Vec<ReadingPromptProfile>>(value).ok())
        .unwrap_or_default();
    merge_builtin_reading_profiles(parsed)
}

pub fn save_reading_profiles(
    conn: &Connection,
    profiles: &[ReadingPromptProfile],
) -> Result<(), String> {
    let sanitized = sanitize_reading_profiles(profiles.to_vec());
    let json =
        serde_json::to_string(&sanitized).map_err(|e| format!("序列化阅读提示词失败: {}", e))?;
    set_setting(conn, "reading_prompt_profiles", &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_profile(id: &str) -> ReadingPromptProfile {
        ReadingPromptProfile {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            prompt: "p".to_string(),
            source_label: "自定义".to_string(),
            reading_mode: "quick".to_string(),
            source_kind: "prompt".to_string(),
            skill_dir: None,
            skill_context: None,
        }
    }

    #[test]
    fn sanitize_reading_profiles_defaults_unknown_mode_to_quick() {
        let profiles = vec![ReadingPromptProfile {
            id: "x".to_string(),
            name: "n".to_string(),
            description: "".to_string(),
            prompt: "p".to_string(),
            source_label: "".to_string(),
            reading_mode: "something-else".to_string(),
            source_kind: "weird".to_string(),
            skill_dir: Some("".to_string()),
            skill_context: None,
        }];
        let out = sanitize_reading_profiles(profiles);
        assert_eq!(out[0].reading_mode, "quick");
        assert_eq!(out[0].source_label, "自定义");
        assert_eq!(out[0].source_kind, "prompt");
        assert!(out[0].skill_dir.is_none());
    }

    #[test]
    fn merge_builtin_reading_profiles_keeps_saved_order() {
        let out = merge_builtin_reading_profiles(vec![
            test_profile("custom-top"),
            test_profile("leq-read-reviewer"),
            test_profile("leq-read-fast-note"),
        ]);

        assert_eq!(out[0].id, "custom-top");
        assert_eq!(out[1].id, "leq-read-reviewer");
        assert_eq!(out[2].id, "leq-read-fast-note");
        assert!(out.iter().any(|profile| profile.id == "leq-read-deep-note"));
        let deep_index = out
            .iter()
            .position(|profile| profile.id == "leq-read-deep-note")
            .unwrap();
        assert!(deep_index > 2);
    }

    #[test]
    fn provider_settings_are_stored_independently() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        let mut deepseek = get_provider_settings(&conn, "deepseek");
        deepseek.api_key = "deepseek-key".to_string();
        deepseek.model_display_name = "DeepSeek 论文翻译".to_string();
        deepseek.context_input_tokens = 1_140_000;
        deepseek.context_output_tokens = 16_000;
        deepseek.tool_call_rounds = 500;
        save_settings(&conn, &deepseek).unwrap();

        let mut openai = get_provider_settings(&conn, "openai");
        openai.api_key = "openai-key".to_string();
        openai.model_display_name = "OpenAI 摘要".to_string();
        openai.context_input_tokens = 200_000;
        save_settings(&conn, &openai).unwrap();

        assert_eq!(
            get_provider_settings(&conn, "deepseek").api_key,
            "deepseek-key"
        );
        assert_eq!(get_provider_settings(&conn, "openai").api_key, "openai-key");
        assert_eq!(
            get_provider_settings(&conn, "deepseek").model_display_name,
            "DeepSeek 论文翻译"
        );
        assert_eq!(
            get_provider_settings(&conn, "deepseek").context_input_tokens,
            1_140_000
        );
        assert_eq!(
            get_provider_settings(&conn, "deepseek").tool_call_rounds,
            500
        );
        assert_eq!(
            get_provider_settings(&conn, "openai").model_display_name,
            "OpenAI 摘要"
        );
        assert_eq!(
            get_provider_settings(&conn, "openai").context_input_tokens,
            200_000
        );
        assert_eq!(get_settings(&conn).provider, "openai");
    }

    #[test]
    fn new_model_capability_settings_use_requested_defaults() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();

        let settings = get_provider_settings(&conn, "deepseek");

        assert!(settings.model_display_name.is_empty());
        assert_eq!(settings.context_input_tokens, 1_140_000);
        assert_eq!(settings.context_output_tokens, 16_000);
        assert_eq!(settings.tool_call_rounds, 500);
    }

    #[test]
    fn model_registry_supports_multiple_models_and_active_switching() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();

        let mut first = get_provider_settings(&conn, "openai_compatible");
        first.base_url = "https://one.example/v1".to_string();
        first.model = "model-one".to_string();
        first.model_display_name = "模型一".to_string();
        let first = save_ai_model(&conn, &first).unwrap();

        let mut second = first.clone();
        second.config_id = None;
        second.base_url = "https://two.example/v1".to_string();
        second.model = "model-two".to_string();
        second.model_display_name = "模型二".to_string();
        let second = save_ai_model(&conn, &second).unwrap();

        let models = list_ai_models(&conn);
        assert_eq!(models.len(), 2);
        assert_eq!(get_settings(&conn).model, "model-two");
        assert!(delete_ai_model(&conn, second.config_id.as_deref().unwrap()).is_err());

        activate_ai_model(&conn, first.config_id.as_deref().unwrap()).unwrap();
        assert_eq!(get_settings(&conn).model, "model-one");
        let models = delete_ai_model(&conn, second.config_id.as_deref().unwrap()).unwrap();
        assert_eq!(models.len(), 1);
        assert!(models[0].active);
    }

    #[test]
    fn activating_a_model_uses_its_own_key_instead_of_a_legacy_profile_key() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();

        let profile = upsert_api_token_profile(
            &conn,
            "openai_compatible",
            None,
            "旧版 Key 档案",
            "legacy-profile-key",
        )
        .unwrap();
        let mut model = get_provider_settings(&conn, "openai_compatible");
        model.api_key = "model-specific-key".to_string();
        model.api_token_profile_id = profile.active_id;
        model.base_url = "https://example.com/v1".to_string();
        model.model = "model-with-own-key".to_string();
        let model = save_ai_model(&conn, &model).unwrap();

        activate_ai_model(&conn, model.config_id.as_deref().unwrap()).unwrap();

        assert_eq!(get_settings(&conn).api_key, "model-specific-key");
    }

    #[test]
    fn legacy_api_key_becomes_a_masked_default_profile() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        set_setting(&conn, "api_key", "legacy-secret-1234").unwrap();

        let list = list_api_token_profiles(&conn, "deepseek").unwrap();

        assert_eq!(list.active_id.as_deref(), Some("default"));
        assert_eq!(list.profiles.len(), 1);
        assert_eq!(list.profiles[0].name, "默认 API Key");
        assert_eq!(list.profiles[0].masked_key, "••••1234");
        assert_eq!(get_settings(&conn).api_key, "legacy-secret-1234");
    }

    #[test]
    fn switching_profiles_changes_the_key_used_by_services() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        let first = upsert_api_token_profile(&conn, "deepseek", None, "主账号", "key-one").unwrap();
        let first_id = first.active_id.unwrap();
        upsert_api_token_profile(&conn, "deepseek", None, "备用账号", "key-two").unwrap();
        assert_eq!(get_settings(&conn).api_key, "key-two");

        activate_api_token_profile(&conn, "deepseek", &first_id).unwrap();

        assert_eq!(get_settings(&conn).api_key, "key-one");
    }

    #[test]
    fn deleting_the_active_profile_falls_back_to_the_next_profile() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        let first = upsert_api_token_profile(&conn, "openai", None, "A", "key-a").unwrap();
        let first_id = first.active_id.unwrap();
        let second = upsert_api_token_profile(&conn, "openai", None, "B", "key-b").unwrap();
        let second_id = second.active_id.unwrap();

        let list = delete_api_token_profile(&conn, "openai", &second_id).unwrap();

        assert_eq!(list.active_id.as_deref(), Some(first_id.as_str()));
        assert_eq!(get_settings(&conn).api_key, "key-a");
    }
}
