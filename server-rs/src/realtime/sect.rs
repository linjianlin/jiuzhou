use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectUpdatePayload {
    pub kind: String,
    pub source: String,
    pub sect_id: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectIndicatorPayload {
    pub joined: bool,
    pub my_pending_application_count: i64,
    pub sect_pending_application_count: i64,
    pub can_manage_applications: bool,
}

pub fn build_sect_update_payload(
    source: &str,
    sect_id: Option<&str>,
    message: Option<&str>,
) -> SectUpdatePayload {
    SectUpdatePayload {
        kind: "sect:update".to_string(),
        source: source.to_string(),
        sect_id: sect_id.map(|value| value.to_string()),
        message: message.map(|value| value.to_string()),
    }
}

pub fn build_sect_indicator_payload(
    joined: bool,
    my_pending_application_count: i64,
    sect_pending_application_count: i64,
    can_manage_applications: bool,
) -> SectIndicatorPayload {
    SectIndicatorPayload {
        joined,
        my_pending_application_count: my_pending_application_count.max(0),
        sect_pending_application_count: sect_pending_application_count.max(0),
        can_manage_applications,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_sect_indicator_payload, build_sect_update_payload};

    #[test]
    fn sect_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_sect_update_payload(
            "apply_to_sect",
            Some("sect-1"),
            Some("申请已提交"),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "sect:update");
        assert_eq!(payload["sectId"], "sect-1");
        println!("SECT_REALTIME_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn sect_indicator_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_sect_indicator_payload(true, 1, 3, true))
            .expect("payload should serialize");
        assert_eq!(payload["joined"], true);
        assert_eq!(payload["myPendingApplicationCount"], 1);
        assert_eq!(payload["sectPendingApplicationCount"], 3);
        assert_eq!(payload["canManageApplications"], true);
        println!("SECT_SOCKET_UPDATE_RESPONSE={}", payload);
    }
}
