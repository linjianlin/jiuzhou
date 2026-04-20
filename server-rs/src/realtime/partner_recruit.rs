use serde::Serialize;

use crate::http::partner::PartnerRecruitStatusDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitStatusPayload {
    pub character_id: i64,
    pub status: PartnerRecruitStatusDto,
}

pub fn build_partner_recruit_status_payload(
    character_id: i64,
    status: PartnerRecruitStatusDto,
) -> PartnerRecruitStatusPayload {
    PartnerRecruitStatusPayload {
        character_id,
        status,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitResultPayload {
    pub character_id: i64,
    pub generation_id: String,
    pub status: String,
    pub has_unread_result: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

pub fn build_partner_recruit_result_payload(
    character_id: i64,
    generation_id: &str,
    status: &str,
    message: &str,
    error_message: Option<String>,
) -> PartnerRecruitResultPayload {
    PartnerRecruitResultPayload {
        character_id,
        generation_id: generation_id.to_string(),
        status: status.to_string(),
        has_unread_result: true,
        message: message.to_string(),
        error_message,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_partner_recruit_result_payload, build_partner_recruit_status_payload};
    use crate::http::partner::PartnerRecruitStatusDto;

    #[test]
    fn partner_recruit_status_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_partner_recruit_status_payload(
            101,
            PartnerRecruitStatusDto {
                feature_code: "partner_system".to_string(),
                unlock_realm: "炼神返虚·养神期".to_string(),
                unlocked: true,
                spirit_stone_cost: 0,
                cooldown_hours: 72,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                custom_base_model_bypasses_cooldown: true,
                custom_base_model_max_length: 12,
                custom_base_model_token_cost: 1,
                custom_base_model_token_item_name: "天机令".to_string(),
                custom_base_model_token_available_qty: 1,
                current_job: None,
                has_unread_result: false,
                result_status: None,
                remaining_until_guaranteed_heaven: 20,
                quality_rates: vec![],
            },
        ))
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["status"]["featureCode"], "partner_system");
        println!("PARTNER_RECRUIT_SOCKET_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn partner_recruit_result_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_partner_recruit_result_payload(
            101,
            "partner-recruit-1",
            "refunded",
            "伙伴招募失败，请前往伙伴界面查看",
            Some("伙伴招募生成链尚未迁移，已自动终结并退款".to_string()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["generationId"], "partner-recruit-1");
        assert_eq!(payload["status"], "refunded");
        println!("PARTNER_RECRUIT_RESULT_SOCKET_RESPONSE={}", payload);
    }
}
