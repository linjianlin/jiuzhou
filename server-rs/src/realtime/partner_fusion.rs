use serde::Serialize;

use crate::http::partner::PartnerFusionStatusDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerFusionStatusPayload {
    pub character_id: i64,
    pub status: PartnerFusionStatusDto,
}

pub fn build_partner_fusion_status_payload(
    character_id: i64,
    status: PartnerFusionStatusDto,
) -> PartnerFusionStatusPayload {
    PartnerFusionStatusPayload {
        character_id,
        status,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerFusionResultPayload {
    pub character_id: i64,
    pub fusion_id: String,
    pub status: String,
    pub has_unread_result: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

pub fn build_partner_fusion_result_payload(
    character_id: i64,
    fusion_id: &str,
    status: &str,
    message: &str,
    preview: Option<serde_json::Value>,
    error_message: Option<String>,
) -> PartnerFusionResultPayload {
    PartnerFusionResultPayload {
        character_id,
        fusion_id: fusion_id.to_string(),
        status: status.to_string(),
        has_unread_result: true,
        message: message.to_string(),
        preview,
        error_message,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_partner_fusion_result_payload, build_partner_fusion_status_payload};
    use crate::http::partner::PartnerFusionStatusDto;

    #[test]
    fn partner_fusion_status_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_partner_fusion_status_payload(
            101,
            PartnerFusionStatusDto {
                feature_code: "partner_system".to_string(),
                unlocked: true,
                current_job: None,
                has_unread_result: false,
                result_status: None,
            },
        ))
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["status"]["featureCode"], "partner_system");
        println!("PARTNER_FUSION_SOCKET_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn partner_fusion_result_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_partner_fusion_result_payload(
            101,
            "partner-fusion-1",
            "failed",
            "三魂归契失败，请前往伙伴界面查看",
            None,
            Some("三魂归契生成链尚未迁移，已自动终结".to_string()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["fusionId"], "partner-fusion-1");
        assert_eq!(payload["status"], "failed");
        println!("PARTNER_FUSION_RESULT_SOCKET_RESPONSE={}", payload);
    }
}
