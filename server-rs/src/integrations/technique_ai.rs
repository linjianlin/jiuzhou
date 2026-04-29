use std::collections::BTreeSet;
use std::time::Duration;

use crate::integrations::generated_image_storage::persist_generated_image_result;
use crate::integrations::image_model_client::{call_image_model, request_from_config};
use crate::integrations::image_model_config::{
    ImageModelConfigSnapshot, ImageModelScope, require_image_model_config,
};
use crate::integrations::text_model_client::{TextModelCallRequest, call_configured_text_model};
use crate::integrations::text_model_config::{
    TextModelConfigSnapshot, TextModelScope, require_text_model_config,
};
use crate::shared::error::AppError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TechniqueAiDraft {
    pub model_name: String,
    pub suggested_name: String,
    pub description: String,
    pub long_desc: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedTechniqueCandidate {
    pub model_name: String,
    pub technique: TechniqueCandidateTechnique,
    pub skills: Vec<TechniqueCandidateSkill>,
    pub layers: Vec<TechniqueCandidateLayer>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueCandidateTechnique {
    pub name: String,
    pub r#type: String,
    pub quality: String,
    pub max_layer: i64,
    pub required_realm: String,
    pub attribute_type: String,
    pub attribute_element: String,
    pub tags: Vec<String>,
    pub description: String,
    pub long_desc: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueCandidateSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub source_type: String,
    pub cost_lingqi: i64,
    pub cost_lingqi_rate: f64,
    pub cost_qixue: i64,
    pub cost_qixue_rate: f64,
    pub cooldown: i64,
    pub target_type: String,
    pub target_count: i64,
    pub damage_type: Option<String>,
    pub element: String,
    pub effects: Vec<serde_json::Value>,
    pub trigger_type: String,
    pub ai_priority: i64,
    pub upgrades: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueCandidateCostMaterial {
    pub item_id: String,
    pub qty: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TechniqueCandidatePassive {
    pub key: String,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueCandidateLayer {
    pub layer: i64,
    pub cost_spirit_stones: i64,
    pub cost_exp: i64,
    pub cost_materials: Vec<TechniqueCandidateCostMaterial>,
    pub passives: Vec<TechniqueCandidatePassive>,
    pub unlock_skill_ids: Vec<String>,
    pub upgrade_skill_ids: Vec<String>,
    pub layer_desc: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedTechniqueCandidateResult {
    pub candidate: GeneratedTechniqueCandidate,
    pub model_name: String,
    pub prompt_snapshot: String,
    pub attempt_count: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TechniqueCandidatePayload {
    technique: TechniqueCandidateTechnique,
    skills: Vec<TechniqueCandidateSkill>,
    layers: Vec<TechniqueCandidateLayer>,
}

const TECHNIQUE_GENERATION_MAX_ATTEMPTS: i32 = 3;

pub async fn generate_technique_ai_draft(
    state: &AppState,
    technique_type: &str,
    quality: &str,
    burning_word_prompt: &str,
) -> Result<TechniqueAiDraft, AppError> {
    let config = require_text_model_config(TextModelScope::Technique)?;
    let system_message = "You generate concise xianxia technique draft metadata. Return JSON with fields suggestedName, description, longDesc. suggestedName must be 2-12 Chinese characters. description max 40 Chinese chars. longDesc max 120 Chinese chars.";
    let user_message = format!(
        "quality={quality}; type={}; burningWord={}. Create one Chinese xianxia technique draft.",
        technique_type.trim(),
        burning_word_prompt.trim()
    );
    let result = call_configured_text_model(
        state,
        &config,
        TextModelCallRequest {
            system_message: system_message.to_string(),
            user_message,
            response_format: Some(serde_json::json!({"type": "json_object"})),
            seed: None,
            timeout: None,
            temperature: Some(0.7),
        },
    )
    .await
    .map_err(|error| AppError::config(format!("功法 AI 请求失败: {error}")))?;
    parse_and_validate_technique_ai_draft(&result.content, &result.model_name)
}

pub async fn generate_technique_candidate(
    state: &AppState,
    technique_type: &str,
    quality: &str,
    max_layer: i64,
    burning_word_prompt: Option<&str>,
    prompt_context: Option<serde_json::Value>,
) -> Result<GeneratedTechniqueCandidateResult, AppError> {
    let config = require_text_model_config(TextModelScope::Technique)?;
    let system_message =
        "你是修仙游戏的功法生成器。只返回一个合法 JSON 对象，不要 Markdown，不要解释文字。";
    let mut last_failure_reason = String::new();
    let mut last_prompt_snapshot = String::new();
    let mut last_model_name = config.model_name.clone();

    for attempt in 1..=TECHNIQUE_GENERATION_MAX_ATTEMPTS {
        let attempt_prompt_context = build_technique_generation_retry_prompt_context(
            prompt_context.clone(),
            (!last_failure_reason.trim().is_empty()).then_some(last_failure_reason.clone()),
        );
        let user_message = build_technique_candidate_user_prompt(
            technique_type,
            quality,
            max_layer,
            burning_word_prompt,
            attempt_prompt_context,
        )?;
        last_prompt_snapshot = build_technique_candidate_request_prompt_snapshot(
            &config,
            system_message,
            &user_message,
        );
        let result = match call_configured_text_model(
            state,
            &config,
            TextModelCallRequest {
                system_message: system_message.to_string(),
                user_message,
                response_format: Some(serde_json::json!({"type": "json_object"})),
                seed: None,
                timeout: Some(Duration::from_secs(300)),
                temperature: Some(0.7),
            },
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                last_failure_reason = format!("功法 AI candidate 请求失败: {error}");
                continue;
            }
        };

        last_prompt_snapshot = result.prompt_snapshot.clone();
        last_model_name = result.model_name.clone();
        match parse_and_validate_generated_technique_candidate(
            &result.content,
            &result.model_name,
            technique_type,
            quality,
            max_layer,
        ) {
            Ok(candidate) => {
                return Ok(GeneratedTechniqueCandidateResult {
                    candidate,
                    model_name: result.model_name,
                    prompt_snapshot: result.prompt_snapshot,
                    attempt_count: attempt,
                });
            }
            Err(error) => {
                last_failure_reason = error.to_string();
            }
        }
    }

    Err(AppError::config(format!(
        "功法 AI candidate 连续生成失败: {last_failure_reason}; model={last_model_name}; promptSnapshot={last_prompt_snapshot}"
    )))
}

fn build_technique_skill_icon_prompt(
    candidate: &GeneratedTechniqueCandidate,
    skill: &TechniqueCandidateSkill,
) -> String {
    [
        format!(
            "生成修仙游戏功法技能图标，功法「{}」",
            candidate.technique.name
        ),
        format!("功法类型：{}", candidate.technique.r#type),
        format!("功法品质：{}", candidate.technique.quality),
        format!("元素：{}", candidate.technique.attribute_element),
        format!("技能名：{}", skill.name),
        format!("技能描述：{}", skill.description),
        format!("技能效果 JSON：{}", serde_json::json!(skill.effects)),
        "方形技能图标，主体清晰，适合 64x64 到 128x128 使用".to_string(),
        "不要文字、边框、水印、UI 按钮底板".to_string(),
    ]
    .join("\n")
}

pub fn should_bypass_technique_skill_image_generation(node_env: Option<&str>) -> bool {
    matches!(node_env, Some("development"))
}

fn missing_skill_icon_indexes(
    candidate: &GeneratedTechniqueCandidate,
    max_skills: usize,
) -> Vec<usize> {
    candidate
        .skills
        .iter()
        .enumerate()
        .filter_map(|(index, skill)| {
            let has_icon = skill
                .icon
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some();
            (!has_icon).then_some(index)
        })
        .take(max_skills)
        .collect()
}

async fn generate_technique_skill_icon_with_config(
    state: &AppState,
    config: &ImageModelConfigSnapshot,
    candidate: &GeneratedTechniqueCandidate,
    skill: &TechniqueCandidateSkill,
) -> Result<String, AppError> {
    let result = call_image_model(
        &state.outbound_http,
        config,
        &request_from_config(build_technique_skill_icon_prompt(candidate, skill), config),
    )
    .await
    .map_err(|error| AppError::config(format!("技能图标生成失败: {error}")))?;
    persist_generated_image_result(state, &result)
        .await
        .map_err(|error| AppError::config(format!("技能图标保存失败: {error}")))
}

pub async fn ensure_generated_candidate_skill_icons(
    state: &AppState,
    candidate: &mut GeneratedTechniqueCandidate,
) -> Result<(), AppError> {
    if should_bypass_technique_skill_image_generation(std::env::var("NODE_ENV").ok().as_deref()) {
        return Ok(());
    }

    let missing_indexes = missing_skill_icon_indexes(candidate, candidate.skills.len());
    if missing_indexes.is_empty() {
        return Ok(());
    }

    let config = require_image_model_config(ImageModelScope::Technique)?;
    let snapshot = candidate.clone();
    for index in missing_indexes.into_iter().take(config.max_skills) {
        let skill_snapshot = candidate.skills[index].clone();
        let icon =
            generate_technique_skill_icon_with_config(state, &config, &snapshot, &skill_snapshot)
                .await?;
        candidate.skills[index].icon = Some(icon);
    }
    Ok(())
}

pub fn parse_and_validate_technique_ai_draft(
    raw: &str,
    model_name: &str,
) -> Result<TechniqueAiDraft, AppError> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::config(format!("功法 AI JSON 解析失败: {error}")))?;
    let suggested_name = extract_bounded_chinese_text(&value, "suggestedName", 2, 12)?;
    let description = extract_bounded_text(&value, "description", 6, 40)?;
    let long_desc = extract_bounded_text(&value, "longDesc", 16, 120)?;
    Ok(TechniqueAiDraft {
        model_name: model_name.trim().to_string(),
        suggested_name,
        description,
        long_desc,
    })
}

pub fn parse_and_validate_generated_technique_candidate(
    raw: &str,
    model_name: &str,
    expected_type: &str,
    expected_quality: &str,
    expected_max_layer: i64,
) -> Result<GeneratedTechniqueCandidate, AppError> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::config(format!("功法 candidate JSON 解析失败: {error}")))?;
    validate_candidate_top_level(&value)?;
    let payload: TechniqueCandidatePayload = serde_json::from_value(value)
        .map_err(|error| AppError::config(format!("功法 candidate 字段结构非法: {error}")))?;
    let candidate = GeneratedTechniqueCandidate {
        model_name: model_name.trim().to_string(),
        technique: payload.technique,
        skills: payload.skills,
        layers: payload.layers,
    };
    validate_generated_technique_candidate(
        &candidate,
        expected_type,
        expected_quality,
        expected_max_layer,
    )?;
    Ok(candidate)
}

fn validate_candidate_top_level(value: &serde_json::Value) -> Result<(), AppError> {
    let Some(object) = value.as_object() else {
        return Err(AppError::config("功法 candidate 顶层必须是 JSON 对象"));
    };
    if object.contains_key("candidate")
        || object.contains_key("data")
        || object.contains_key("result")
        || object.contains_key("payload")
    {
        return Err(AppError::config(
            "功法 candidate 顶层必须直接包含 technique/skills/layers，不能使用 wrapper",
        ));
    }
    if !object.contains_key("technique")
        || !object.contains_key("skills")
        || !object.contains_key("layers")
    {
        return Err(AppError::config(
            "功法 candidate 顶层必须直接包含 technique/skills/layers",
        ));
    }
    Ok(())
}

fn validate_generated_technique_candidate(
    candidate: &GeneratedTechniqueCandidate,
    expected_type: &str,
    expected_quality: &str,
    expected_max_layer: i64,
) -> Result<(), AppError> {
    let technique = &candidate.technique;
    ensure_non_empty("technique.name", &technique.name)?;
    ensure_non_empty("technique.requiredRealm", &technique.required_realm)?;
    ensure_non_empty("technique.attributeType", &technique.attribute_type)?;
    ensure_non_empty("technique.attributeElement", &technique.attribute_element)?;
    ensure_non_empty("technique.description", &technique.description)?;
    ensure_non_empty("technique.longDesc", &technique.long_desc)?;
    if technique.r#type.trim() != expected_type.trim() {
        return Err(AppError::config("AI结果功法类型与目标类型不一致"));
    }
    if technique.quality.trim() != expected_quality.trim() {
        return Err(AppError::config("AI结果品质与目标品质不一致"));
    }
    if technique.max_layer != expected_max_layer {
        return Err(AppError::config("AI结果最大层数非法"));
    }
    if candidate.skills.is_empty() {
        return Err(AppError::config("AI结果未生成技能"));
    }

    let mut skill_ids = BTreeSet::new();
    for skill in &candidate.skills {
        ensure_non_empty("skill.id", &skill.id)?;
        ensure_non_empty("skill.name", &skill.name)?;
        ensure_non_empty("skill.description", &skill.description)?;
        ensure_non_empty("skill.targetType", &skill.target_type)?;
        ensure_non_empty("skill.element", &skill.element)?;
        ensure_non_empty("skill.triggerType", &skill.trigger_type)?;
        if skill.source_type.trim() != "technique" {
            return Err(AppError::config("AI结果技能来源非法"));
        }
        if !matches!(skill.trigger_type.trim(), "active" | "passive") {
            return Err(AppError::config("AI结果技能触发类型非法"));
        }
        if !skill_ids.insert(skill.id.trim().to_string()) {
            return Err(AppError::config("AI结果技能ID重复"));
        }
    }

    if candidate.layers.len() != expected_max_layer as usize {
        return Err(AppError::config("AI结果层级数量非法"));
    }
    let mut layer_numbers = BTreeSet::new();
    for layer in &candidate.layers {
        if layer.layer < 1 || layer.layer > expected_max_layer {
            return Err(AppError::config("AI结果层级序号非法"));
        }
        if !layer_numbers.insert(layer.layer) {
            return Err(AppError::config("AI结果层级序号重复"));
        }
        ensure_non_empty("layer.layerDesc", &layer.layer_desc)?;
        for skill_id in layer
            .unlock_skill_ids
            .iter()
            .chain(layer.upgrade_skill_ids.iter())
        {
            if !skill_ids.contains(skill_id.trim()) {
                return Err(AppError::config("AI结果层级技能ID不存在"));
            }
        }
    }
    for layer in 1..=expected_max_layer {
        if !layer_numbers.contains(&layer) {
            return Err(AppError::config("AI结果层级不完整"));
        }
    }
    Ok(())
}

fn ensure_non_empty(field: &str, value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::config(format!(
            "功法 candidate 缺少字段: {field}"
        )));
    }
    Ok(())
}

fn build_technique_candidate_user_prompt(
    technique_type: &str,
    quality: &str,
    max_layer: i64,
    burning_word_prompt: Option<&str>,
    prompt_context: Option<serde_json::Value>,
) -> Result<String, AppError> {
    let payload = serde_json::json!({
        "task": "generate_complete_technique_candidate",
        "requiredTopLevelKeys": ["technique", "skills", "layers"],
        "forbiddenTopLevelWrappers": ["candidate", "data", "result", "payload"],
        "target": {
            "type": technique_type.trim(),
            "quality": quality.trim(),
            "maxLayer": max_layer,
            "burningWordPrompt": burning_word_prompt.map(str::trim).filter(|value| !value.is_empty()),
        },
        "context": prompt_context,
        "schemaRules": [
            "顶层必须直接输出 technique、skills、layers 三个字段，不要多包 candidate/data/result/payload。",
            "technique 必须包含 name/type/quality/maxLayer/requiredRealm/attributeType/attributeElement/tags/description/longDesc。",
            "technique.type、technique.quality、technique.maxLayer 必须严格等于 target。",
            "skills 至少 1 个；每个技能必须包含 id/name/description/icon/sourceType/costLingqi/costLingqiRate/costQixue/costQixueRate/cooldown/targetType/targetCount/damageType/element/effects/triggerType/aiPriority/upgrades。",
            "skills[].sourceType 必须是 technique；triggerType 只能是 active 或 passive。",
            "layers 必须完整覆盖 1..maxLayer；每层必须包含 layer/costSpiritStones/costExp/costMaterials/passives/unlockSkillIds/upgradeSkillIds/layerDesc。",
            "layers[].unlockSkillIds 和 upgradeSkillIds 只能引用本次 skills[].id 中存在的 id。",
            "costMaterials 输出数组；没有材料时输出空数组。effects、upgrades、passives 也必须输出数组。",
            "attributeType 使用 physical 或 magic；attributeElement 使用 none/wood/fire/water/metal/earth/lightning/ice/wind 等短英文元素。",
            "只输出 JSON 对象本体，不要 Markdown 代码块，不要解释。"
        ]
    });
    serde_json::to_string(&payload)
        .map_err(|error| AppError::config(format!("功法 candidate prompt 序列化失败: {error}")))
}

fn build_technique_candidate_request_prompt_snapshot(
    config: &TextModelConfigSnapshot,
    system_message: &str,
    user_message: &str,
) -> String {
    serde_json::json!({
        "provider": config.provider.to_string(),
        "model": config.model_name.clone(),
        "systemMessage": system_message,
        "userMessage": user_message,
    })
    .to_string()
}

fn technique_retry_correction_rules(reason: &str) -> Vec<String> {
    let reason = reason.trim();
    let mut rules = vec![
        "重新输出完整 JSON 对象，顶层仍然只能包含 technique、skills、layers。".to_string(),
        "修正上一轮失败原因，不要删除必填字段，不要降低技能与层级完整度。".to_string(),
    ];
    if reason.contains("技能ID")
        || reason.contains("unlockSkillIds")
        || reason.contains("upgradeSkillIds")
    {
        rules.push(
            "layers[].unlockSkillIds 与 layers[].upgradeSkillIds 只能引用本轮 skills[].id 中真实存在的技能ID。"
                .to_string(),
        );
    }
    if reason.contains("最大层数") || reason.contains("maxLayer") {
        rules.push(
            "technique.maxLayer 必须等于 target.maxLayer，layers 必须完整覆盖 1..target.maxLayer。"
                .to_string(),
        );
    }
    if reason.contains("顶层") {
        rules.push("不要把结果包在 candidate、data、result、payload 任何外层字段中。".to_string());
    }
    rules
}

pub fn build_technique_generation_retry_prompt_context(
    prompt_context: Option<serde_json::Value>,
    previous_failure_reason: Option<String>,
) -> Option<serde_json::Value> {
    let Some(reason) = previous_failure_reason
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return prompt_context;
    };

    let mut object = prompt_context
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let correction_rules = technique_retry_correction_rules(&reason);
    object.insert(
        "techniqueRetryGuidance".to_string(),
        serde_json::json!({
            "previousFailureReason": reason,
            "correctionRules": correction_rules,
        }),
    );
    Some(serde_json::Value::Object(object))
}

fn extract_bounded_text(
    value: &serde_json::Value,
    field: &str,
    min_len: usize,
    max_len: usize,
) -> Result<String, AppError> {
    let text = value
        .get(field)
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .ok_or_else(|| AppError::config(format!("功法 AI 缺少字段: {field}")))?;
    let char_count = text.chars().count();
    if char_count < min_len || char_count > max_len {
        return Err(AppError::config(format!("功法 AI 字段 {field} 长度非法")));
    }
    Ok(text.to_string())
}

fn extract_bounded_chinese_text(
    value: &serde_json::Value,
    field: &str,
    min_len: usize,
    max_len: usize,
) -> Result<String, AppError> {
    let text = extract_bounded_text(value, field, min_len, max_len)?;
    if !text.chars().all(|ch| ('一'..='龥').contains(&ch)) {
        return Err(AppError::config(format!(
            "功法 AI 字段 {field} 必须为纯中文"
        )));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::{
        build_technique_candidate_request_prompt_snapshot,
        build_technique_generation_retry_prompt_context, missing_skill_icon_indexes,
        parse_and_validate_generated_technique_candidate, parse_and_validate_technique_ai_draft,
        should_bypass_technique_skill_image_generation,
    };
    use crate::integrations::text_model_config::{TextModelConfigSnapshot, TextModelProvider};

    #[test]
    fn technique_ai_draft_validation_accepts_minimal_valid_shape() {
        let draft = parse_and_validate_technique_ai_draft(
            r#"{"suggestedName":"青木诀","description":"玄品武技草稿","longDesc":"以青木真意推演而成的玄品武技草稿，可于洞府研修中进一步命名发布。"}"#,
            "technique-model",
        )
        .expect("draft should parse");
        assert_eq!(draft.model_name, "technique-model");
        assert_eq!(draft.suggested_name, "青木诀");
        println!("TECHNIQUE_AI_DRAFT_NAME={}", draft.suggested_name);
    }

    #[test]
    fn technique_ai_draft_validation_rejects_non_chinese_name() {
        let error = parse_and_validate_technique_ai_draft(
            r#"{"suggestedName":"QingMu","description":"玄品武技草稿","longDesc":"以青木真意推演而成的玄品武技草稿，可于洞府研修中进一步命名发布。"}"#,
            "technique-model",
        )
        .expect_err("draft should reject latin name");
        assert!(error.to_string().contains("纯中文"));
    }

    #[test]
    fn should_bypass_skill_icon_generation_only_for_development() {
        assert!(should_bypass_technique_skill_image_generation(Some(
            "development"
        )));
        assert!(!should_bypass_technique_skill_image_generation(Some(
            "production"
        )));
        assert!(!should_bypass_technique_skill_image_generation(Some(
            "test"
        )));
        assert!(!should_bypass_technique_skill_image_generation(None));
    }

    #[test]
    fn technique_retry_prompt_context_preserves_source_and_injects_guidance() {
        let source = serde_json::json!({
            "partner": { "name": "青岚" },
            "techniqueBurningWordPrompt": "炎心"
        });

        let retry = build_technique_generation_retry_prompt_context(
            Some(source.clone()),
            Some("layers[].unlockSkillIds 引用了不存在的技能ID".to_string()),
        )
        .expect("retry context should exist");

        assert_eq!(retry["partner"], source["partner"]);
        assert_eq!(retry["techniqueBurningWordPrompt"], "炎心");
        assert_eq!(
            retry["techniqueRetryGuidance"]["previousFailureReason"],
            "layers[].unlockSkillIds 引用了不存在的技能ID"
        );
        let rules = retry["techniqueRetryGuidance"]["correctionRules"]
            .as_array()
            .expect("correction rules should be an array");
        assert!(
            rules
                .iter()
                .any(|rule| rule.as_str().unwrap_or_default().contains("技能ID"))
        );
    }

    #[test]
    fn technique_candidate_request_prompt_snapshot_includes_config_model_and_prompt() {
        let config = TextModelConfigSnapshot {
            provider: TextModelProvider::Anthropic,
            url: "https://api.anthropic.com".to_string(),
            key: "test-key".to_string(),
            model_name: "claude-test".to_string(),
        };

        let snapshot =
            build_technique_candidate_request_prompt_snapshot(&config, "system text", "user text");
        let value: serde_json::Value =
            serde_json::from_str(&snapshot).expect("snapshot should be json");

        assert_eq!(value["provider"], "anthropic");
        assert_eq!(value["model"], "claude-test");
        assert_eq!(value["systemMessage"], "system text");
        assert_eq!(value["userMessage"], "user text");
    }

    fn valid_candidate_json() -> String {
        serde_json::json!({
            "technique": {
                "name": "青木回风诀",
                "type": "武技",
                "quality": "玄",
                "maxLayer": 3,
                "requiredRealm": "炼炁化神·结胎期",
                "attributeType": "physical",
                "attributeElement": "wood",
                "tags": ["洞府研修", "青木"],
                "description": "青木回风，攻守兼备。",
                "longDesc": "以青木生发之意牵引回风劲力，适合洞府研修所得的完整功法候选。"
            },
            "skills": [
                {
                    "id": "generated-skill-1",
                    "name": "青木回风斩",
                    "description": "引青木劲气斩击单体敌人。",
                    "icon": null,
                    "sourceType": "technique",
                    "costLingqi": 12,
                    "costLingqiRate": 0.0,
                    "costQixue": 0,
                    "costQixueRate": 0.0,
                    "cooldown": 1,
                    "targetType": "single_enemy",
                    "targetCount": 1,
                    "damageType": "physical",
                    "element": "wood",
                    "effects": [{"type": "damage", "value": 120}],
                    "triggerType": "active",
                    "aiPriority": 60,
                    "upgrades": []
                }
            ],
            "layers": [
                {
                    "layer": 1,
                    "costSpiritStones": 100,
                    "costExp": 50,
                    "costMaterials": [],
                    "passives": [{"key": "atk", "value": 6}],
                    "unlockSkillIds": ["generated-skill-1"],
                    "upgradeSkillIds": [],
                    "layerDesc": "青木初生，悟得回风斩。"
                },
                {
                    "layer": 2,
                    "costSpiritStones": 200,
                    "costExp": 100,
                    "costMaterials": [],
                    "passives": [{"key": "def", "value": 4}],
                    "unlockSkillIds": [],
                    "upgradeSkillIds": ["generated-skill-1"],
                    "layerDesc": "回风渐疾，斩势更盛。"
                },
                {
                    "layer": 3,
                    "costSpiritStones": 300,
                    "costExp": 150,
                    "costMaterials": [],
                    "passives": [{"key": "speed", "value": 3}],
                    "unlockSkillIds": [],
                    "upgradeSkillIds": ["generated-skill-1"],
                    "layerDesc": "青木成荫，风势圆融。"
                }
            ]
        })
        .to_string()
    }

    #[test]
    fn generated_candidate_validation_accepts_complete_candidate() {
        let candidate = parse_and_validate_generated_technique_candidate(
            &valid_candidate_json(),
            "technique-model",
            "武技",
            "玄",
            3,
        )
        .expect("candidate should parse");
        assert_eq!(candidate.model_name, "technique-model");
        assert_eq!(candidate.technique.name, "青木回风诀");
        assert_eq!(candidate.skills.len(), 1);
        assert_eq!(candidate.layers.len(), 3);
    }

    #[test]
    fn missing_skill_icon_indexes_limits_empty_icons_by_config() {
        let mut candidate = parse_and_validate_generated_technique_candidate(
            &valid_candidate_json(),
            "technique-model",
            "武技",
            "玄",
            3,
        )
        .expect("candidate should parse");
        candidate.skills.push(candidate.skills[0].clone());
        candidate.skills[1].id = "skill-2".to_string();
        candidate.skills[1].icon = Some("   ".to_string());
        candidate.skills.push(candidate.skills[0].clone());
        candidate.skills[2].id = "skill-3".to_string();
        candidate.skills[2].icon = None;

        assert_eq!(missing_skill_icon_indexes(&candidate, 2), vec![0, 1]);
        assert_eq!(missing_skill_icon_indexes(&candidate, 1), vec![0]);
    }

    #[test]
    fn generated_candidate_validation_rejects_wrapper_object() {
        let wrapped = serde_json::json!({ "candidate": serde_json::from_str::<serde_json::Value>(&valid_candidate_json()).unwrap() }).to_string();
        let error = parse_and_validate_generated_technique_candidate(
            &wrapped,
            "technique-model",
            "武技",
            "玄",
            3,
        )
        .expect_err("wrapper should be rejected");
        assert!(error.to_string().contains("顶层"));
    }

    #[test]
    fn generated_candidate_validation_rejects_unknown_layer_skill_id() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_candidate_json()).unwrap();
        value["layers"][0]["unlockSkillIds"] = serde_json::json!(["missing-skill"]);
        let error = parse_and_validate_generated_technique_candidate(
            &value.to_string(),
            "technique-model",
            "武技",
            "玄",
            3,
        )
        .expect_err("missing skill id should be rejected");
        assert!(error.to_string().contains("技能ID不存在"));
    }

    #[test]
    fn generated_candidate_validation_rejects_max_layer_mismatch() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_candidate_json()).unwrap();
        value["technique"]["maxLayer"] = serde_json::json!(2);
        let error = parse_and_validate_generated_technique_candidate(
            &value.to_string(),
            "technique-model",
            "武技",
            "玄",
            3,
        )
        .expect_err("maxLayer mismatch should be rejected");
        assert!(error.to_string().contains("最大层数"));
    }
}
