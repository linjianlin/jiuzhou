use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdatePayload {
    pub kind: String,
    pub source: String,
    pub task_id: String,
    pub status: Option<String>,
    pub tracked: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOverviewUpdatePayload {
    pub character_id: i64,
    pub scopes: Vec<String>,
}

pub fn build_task_update_payload(
    source: &str,
    task_id: &str,
    status: Option<&str>,
    tracked: Option<bool>,
) -> TaskUpdatePayload {
    TaskUpdatePayload {
        kind: "task:update".to_string(),
        source: source.to_string(),
        task_id: task_id.to_string(),
        status: status.map(|value| value.to_string()),
        tracked,
    }
}

pub fn build_task_overview_update_payload(character_id: i64) -> TaskOverviewUpdatePayload {
    TaskOverviewUpdatePayload {
        character_id,
        scopes: vec!["task".to_string()],
    }
}

#[cfg(test)]
mod tests {
    use super::{build_task_overview_update_payload, build_task_update_payload};

    #[test]
    fn task_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_task_update_payload(
            "claim_task",
            "task-main-003",
            Some("claimed"),
            Some(false),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "task:update");
        assert_eq!(payload["taskId"], "task-main-003");
        println!("TASK_REALTIME_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn task_overview_update_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_task_overview_update_payload(101))
            .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["scopes"][0], "task");
        println!("TASK_SOCKET_UPDATE_RESPONSE={}", payload);
    }
}
