use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessagePayload {
    pub kind: String,
    pub id: String,
    pub client_id: Option<String>,
    pub channel: String,
    pub sender_user_id: i64,
    pub sender_character_id: i64,
    pub sender_name: String,
    pub sender_month_card_active: bool,
    pub sender_title: String,
    pub content: String,
    #[serde(rename = "timestamp")]
    pub timestamp_ms: i64,
    pub pm_target_character_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSystemPayload {
    pub kind: String,
    pub channel: String,
    pub content: String,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatErrorPayload {
    pub kind: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTypingPayload {
    pub kind: String,
    pub channel: String,
    pub sender_id: String,
    pub active: bool,
}

pub fn build_chat_message_payload(
    id: &str,
    client_id: Option<&str>,
    channel: &str,
    sender_user_id: i64,
    sender_character_id: i64,
    sender_name: &str,
    sender_month_card_active: bool,
    sender_title: &str,
    content: &str,
    timestamp_ms: i64,
    pm_target_character_id: Option<i64>,
) -> ChatMessagePayload {
    ChatMessagePayload {
        kind: "chat:message".to_string(),
        id: id.to_string(),
        client_id: client_id.map(|value| value.to_string()),
        channel: channel.to_string(),
        sender_user_id,
        sender_character_id,
        sender_name: sender_name.to_string(),
        sender_month_card_active,
        sender_title: sender_title.to_string(),
        content: content.to_string(),
        timestamp_ms,
        pm_target_character_id,
    }
}

pub fn build_chat_system_payload(
    channel: &str,
    content: &str,
    timestamp_ms: i64,
) -> ChatSystemPayload {
    ChatSystemPayload {
        kind: "chat:system".to_string(),
        channel: channel.to_string(),
        content: content.to_string(),
        timestamp_ms,
    }
}

pub fn build_chat_error_payload(code: &str, message: &str) -> ChatErrorPayload {
    ChatErrorPayload {
        kind: "chat:error".to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

pub fn build_chat_typing_payload(
    channel: &str,
    sender_id: &str,
    active: bool,
) -> ChatTypingPayload {
    ChatTypingPayload {
        kind: "chat:typing".to_string(),
        channel: channel.to_string(),
        sender_id: sender_id.to_string(),
        active,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_chat_error_payload, build_chat_message_payload, build_chat_system_payload,
        build_chat_typing_payload,
    };

    #[test]
    fn chat_message_payload_matches_contract() {
        let payload = serde_json::to_value(build_chat_message_payload(
            "chat-1",
            Some("client-1"),
            "world",
            1,
            101,
            "凌霄子",
            true,
            "散修",
            "大家好",
            1712800000000,
            None,
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "chat:message");
        assert_eq!(payload["senderCharacterId"], 101);
        assert_eq!(payload["timestamp"], 1712800000000i64);
        println!("CHAT_MESSAGE_RESPONSE={}", payload);
    }

    #[test]
    fn chat_system_payload_matches_contract() {
        let payload = serde_json::to_value(build_chat_system_payload(
            "system",
            "服务器维护中",
            1712800000000,
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "chat:system");
        println!("CHAT_SYSTEM_RESPONSE={}", payload);
    }

    #[test]
    fn chat_error_payload_matches_contract() {
        let payload = serde_json::to_value(build_chat_error_payload("CHAT_RATE_LIMIT", "发言过快"))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "chat:error");
        println!("CHAT_ERROR_RESPONSE={}", payload);
    }

    #[test]
    fn chat_typing_payload_matches_contract() {
        let payload = serde_json::to_value(build_chat_typing_payload("world", "user-1", true))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "chat:typing");
        println!("CHAT_TYPING_RESPONSE={}", payload);
    }
}
