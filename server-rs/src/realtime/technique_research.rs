use serde::Serialize;

use crate::http::character_technique::TechniqueResearchStatusDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchStatusPayload {
    pub character_id: i64,
    pub status: TechniqueResearchStatusDto,
}

pub fn build_technique_research_status_payload(
    character_id: i64,
    status: TechniqueResearchStatusDto,
) -> TechniqueResearchStatusPayload {
    TechniqueResearchStatusPayload {
        character_id,
        status,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchResultPayload {
    pub character_id: i64,
    pub generation_id: String,
    pub status: String,
    pub has_unread_result: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

pub fn build_technique_research_result_payload(
    character_id: i64,
    generation_id: &str,
    status: &str,
    message: &str,
    preview: Option<serde_json::Value>,
    error_message: Option<String>,
) -> TechniqueResearchResultPayload {
    TechniqueResearchResultPayload {
        character_id,
        generation_id: generation_id.to_string(),
        status: status.to_string(),
        has_unread_result: true,
        message: message.to_string(),
        preview,
        error_message,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_technique_research_result_payload, build_technique_research_status_payload};
    use crate::http::character_technique::{
        TechniqueResearchNameRulesDto, TechniqueResearchStatusDto,
    };

    #[test]
    fn technique_research_status_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_technique_research_status_payload(
            101,
            TechniqueResearchStatusDto {
                unlock_realm: "炼炁化神·结胎期".to_string(),
                unlocked: true,
                fragment_balance: 4000,
                fragment_cost: 3500,
                cooldown_bypass_fragment_cost: 2800,
                cooldown_hours: 72,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                cooldown_bypass_token_bypasses_cooldown: true,
                cooldown_bypass_token_cost: 1,
                cooldown_bypass_token_item_name: "冷却绕过令牌".to_string(),
                cooldown_bypass_token_available_qty: 1,
                burning_word_prompt_max_length: 2,
                current_draft: None,
                draft_expire_at: None,
                name_rules: TechniqueResearchNameRulesDto {
                    min_length: 2,
                    max_length: 14,
                    fixed_prefix: "『研』".to_string(),
                    pattern_hint: "仅支持纯中文".to_string(),
                    immutable_after_publish: true,
                },
                current_job: None,
                has_unread_result: false,
                result_status: None,
                remaining_until_guaranteed_heaven: 20,
                quality_rates: vec![],
            },
        ))
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["status"]["unlockRealm"], "炼炁化神·结胎期");
        println!("TECHNIQUE_RESEARCH_SOCKET_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn technique_research_result_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_technique_research_result_payload(
            101,
            "tech-gen-1",
            "failed",
            "洞府推演失败，请前往功法查看",
            None,
            Some("已放弃本次研修草稿，并按过期规则结算".to_string()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["generationId"], "tech-gen-1");
        assert_eq!(payload["status"], "failed");
        println!("TECHNIQUE_RESEARCH_RESULT_SOCKET_RESPONSE={}", payload);
    }
}
