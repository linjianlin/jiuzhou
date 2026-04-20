use serde::Serialize;

use crate::http::partner::PartnerReboneStatusDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerReboneStatusPayload {
    pub character_id: i64,
    pub status: PartnerReboneStatusDto,
}

pub fn build_partner_rebone_status_payload(
    character_id: i64,
    status: PartnerReboneStatusDto,
) -> PartnerReboneStatusPayload {
    PartnerReboneStatusPayload {
        character_id,
        status,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerReboneResultPayload {
    pub character_id: i64,
    pub rebone_id: String,
    pub partner_id: i64,
    pub status: String,
    pub has_unread_result: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

pub fn build_partner_rebone_result_payload(
    character_id: i64,
    rebone_id: &str,
    partner_id: i64,
    status: &str,
    message: &str,
    error_message: Option<String>,
) -> PartnerReboneResultPayload {
    PartnerReboneResultPayload {
        character_id,
        rebone_id: rebone_id.to_string(),
        partner_id,
        status: status.to_string(),
        has_unread_result: true,
        message: message.to_string(),
        error_message,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_partner_rebone_result_payload, build_partner_rebone_status_payload};
    use crate::http::partner::PartnerReboneStatusDto;

    #[test]
    fn partner_rebone_status_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_partner_rebone_status_payload(
            101,
            PartnerReboneStatusDto {
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
        println!("PARTNER_REBONE_SOCKET_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn partner_rebone_result_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_partner_rebone_result_payload(
            101,
            "partner-rebone-1",
            7,
            "failed",
            "归元洗髓失败，请前往伙伴界面查看",
            Some("归元洗髓执行链尚未迁移，已自动终结并退款".to_string()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["reboneId"], "partner-rebone-1");
        assert_eq!(payload["partnerId"], 7);
        println!("PARTNER_REBONE_RESULT_SOCKET_RESPONSE={}", payload);
    }
}
