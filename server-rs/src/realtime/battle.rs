use serde::Serialize;

use crate::battle_runtime::{BattleStateDto, MinimalBattleRewardItemDto};
use crate::state::BattleSessionSnapshotDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleRewardsPayload {
    pub exp: i64,
    pub silver: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_exp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_silver: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participant_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_player_rewards: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleRealtimePayload {
    pub kind: String,
    pub battle_id: String,
    pub state: Option<BattleStateDto>,
    pub logs: Option<Vec<serde_json::Value>>,
    pub log_start: Option<i64>,
    pub log_delta: Option<bool>,
    pub session: Option<BattleSessionSnapshotDto>,
    pub rewards: Option<BattleRewardsPayload>,
    pub result: Option<String>,
    pub authoritative: Option<bool>,
    pub success: Option<bool>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BattleFinishedMeta {
    pub rewards: Option<BattleRewardsPayload>,
    pub result: Option<String>,
    pub success: Option<bool>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleCooldownPayload {
    pub kind: String,
    pub character_id: i64,
    pub remaining_ms: i64,
    pub timestamp: i64,
}

pub fn build_battle_started_payload(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
) -> BattleRealtimePayload {
    BattleRealtimePayload {
        kind: "battle_started".to_string(),
        battle_id: battle_id.to_string(),
        state: Some(state),
        logs: Some(logs),
        log_start: Some(0),
        log_delta: Some(false),
        session,
        rewards: None,
        result: None,
        authoritative: Some(true),
        success: None,
        message: None,
    }
}

pub fn build_battle_state_payload(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
) -> BattleRealtimePayload {
    BattleRealtimePayload {
        kind: "battle_state".to_string(),
        battle_id: battle_id.to_string(),
        state: Some(state),
        logs: Some(logs),
        log_start: Some(0),
        log_delta: Some(false),
        session,
        rewards: None,
        result: None,
        authoritative: Some(true),
        success: None,
        message: None,
    }
}

pub fn build_battle_finished_payload(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
    meta: BattleFinishedMeta,
) -> BattleRealtimePayload {
    BattleRealtimePayload {
        kind: "battle_finished".to_string(),
        battle_id: battle_id.to_string(),
        state: Some(state),
        logs: Some(logs),
        log_start: Some(0),
        log_delta: Some(false),
        session,
        rewards: meta.rewards,
        result: meta.result,
        authoritative: Some(true),
        success: meta.success,
        message: meta.message,
    }
}

pub fn build_battle_abandoned_payload(
    battle_id: &str,
    session: Option<BattleSessionSnapshotDto>,
    success: bool,
    message: &str,
) -> BattleRealtimePayload {
    BattleRealtimePayload {
        kind: "battle_abandoned".to_string(),
        battle_id: battle_id.to_string(),
        state: None,
        logs: None,
        log_start: None,
        log_delta: None,
        session,
        rewards: None,
        result: None,
        authoritative: Some(true),
        success: Some(success),
        message: Some(message.to_string()),
    }
}

pub fn build_battle_cooldown_sync_payload(
    actor_id: Option<&str>,
    cooldown_ms: i64,
) -> BattleCooldownPayload {
    BattleCooldownPayload {
        kind: "battle:cooldown-sync".to_string(),
        character_id: parse_character_id_from_actor_id(actor_id),
        remaining_ms: cooldown_ms.max(0),
        timestamp: current_timestamp_ms(),
    }
}

pub fn build_battle_cooldown_ready_payload(actor_id: Option<&str>) -> BattleCooldownPayload {
    BattleCooldownPayload {
        kind: "battle:cooldown-ready".to_string(),
        character_id: parse_character_id_from_actor_id(actor_id),
        remaining_ms: 0,
        timestamp: current_timestamp_ms(),
    }
}

pub fn build_reward_item_values(items: &[MinimalBattleRewardItemDto]) -> Vec<serde_json::Value> {
    items
        .iter()
        .map(|item| {
            serde_json::json!({
                "itemDefId": item.item_def_id,
                "itemName": item.item_name,
                "qty": item.qty,
            })
        })
        .collect()
}

pub fn build_single_player_reward_values(
    user_id: i64,
    character_id: i64,
    exp: i64,
    silver: i64,
    items: &[MinimalBattleRewardItemDto],
) -> Vec<serde_json::Value> {
    vec![serde_json::json!({
        "userId": user_id,
        "characterId": character_id,
        "exp": exp,
        "silver": silver,
        "items": build_reward_item_values(items),
    })]
}

fn parse_character_id_from_actor_id(actor_id: Option<&str>) -> i64 {
    actor_id
        .and_then(|value| value.strip_prefix("player-"))
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0)
}

fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use crate::battle_runtime::build_minimal_pve_battle_state;
    use crate::battle_runtime::MinimalBattleRewardItemDto;
    use crate::state::{BattleSessionContextDto, BattleSessionSnapshotDto};

    use super::{
        build_battle_abandoned_payload, build_battle_cooldown_ready_payload,
        build_battle_cooldown_sync_payload, build_battle_finished_payload,
        build_battle_started_payload, build_battle_state_payload, build_reward_item_values,
        build_single_player_reward_values, BattleFinishedMeta, BattleRewardsPayload,
    };

    fn sample_session() -> BattleSessionSnapshotDto {
        BattleSessionSnapshotDto {
            session_id: "pve-session-1".to_string(),
            session_type: "pve".to_string(),
            owner_user_id: 1,
            participant_user_ids: vec![1],
            current_battle_id: Some("pve-battle-1".to_string()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-gray-wolf".to_string()],
            },
        }
    }

    #[test]
    fn battle_started_payload_matches_contract() {
        let payload = serde_json::to_value(build_battle_started_payload(
            "pve-battle-1",
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]),
            vec![serde_json::json!({"type": "round_start", "round": 1})],
            Some(sample_session()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_started");
        assert_eq!(payload["authoritative"], true);
        assert_eq!(payload["logStart"], 0);
        assert_eq!(payload["logDelta"], false);
        println!("BATTLE_REALTIME_STARTED_RESPONSE={}", payload);
    }

    #[test]
    fn battle_state_payload_matches_contract() {
        let payload = serde_json::to_value(build_battle_state_payload(
            "pve-battle-1",
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]),
            vec![serde_json::json!({"type": "action", "round": 1})],
            Some(sample_session()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_state");
        assert_eq!(payload["authoritative"], true);
        assert_eq!(payload["logStart"], 0);
        assert_eq!(payload["logDelta"], false);
        println!("BATTLE_REALTIME_STATE_RESPONSE={}", payload);
    }

    #[test]
    fn battle_finished_payload_matches_contract() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.phase = "finished".to_string();
        state.result = Some("attacker_win".to_string());
        let payload = serde_json::to_value(build_battle_finished_payload(
            "pve-battle-1",
            state,
            vec![serde_json::json!({"type": "death", "round": 1})],
            Some(sample_session()),
            BattleFinishedMeta {
                rewards: Some(BattleRewardsPayload {
                    exp: 12,
                    silver: 34,
                    total_exp: Some(56),
                    total_silver: Some(78),
                    participant_count: Some(1),
                    items: Some(vec![]),
                    per_player_rewards: Some(vec![]),
                }),
                result: Some("attacker_win".to_string()),
                success: Some(true),
                message: Some("战斗结束".to_string()),
            },
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_finished");
        assert_eq!(payload["authoritative"], true);
        assert_eq!(payload["logStart"], 0);
        assert_eq!(payload["logDelta"], false);
        assert_eq!(payload["rewards"]["exp"], 12);
        assert_eq!(payload["result"], "attacker_win");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["message"], "战斗结束");
        println!("BATTLE_REALTIME_FINISHED_RESPONSE={}", payload);
    }

    #[test]
    fn battle_abandoned_payload_matches_contract() {
        let payload = serde_json::to_value(build_battle_abandoned_payload(
            "pve-battle-1",
            Some(sample_session()),
            true,
            "已放弃战斗",
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_abandoned");
        assert_eq!(payload["authoritative"], true);
        println!("BATTLE_REALTIME_ABANDONED_RESPONSE={}", payload);
    }

    #[test]
    fn battle_cooldown_sync_payload_matches_contract() {
        let payload =
            serde_json::to_value(build_battle_cooldown_sync_payload(Some("player-1"), 1500))
                .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle:cooldown-sync");
        assert_eq!(payload["characterId"], 1);
        assert_eq!(payload["remainingMs"], 1500);
        println!("BATTLE_REALTIME_COOLDOWN_SYNC_RESPONSE={}", payload);
    }

    #[test]
    fn battle_cooldown_ready_payload_matches_contract() {
        let payload = serde_json::to_value(build_battle_cooldown_ready_payload(Some("player-1")))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle:cooldown-ready");
        assert_eq!(payload["characterId"], 1);
        assert_eq!(payload["remainingMs"], 0);
        println!("BATTLE_REALTIME_COOLDOWN_READY_RESPONSE={}", payload);
    }

    #[test]
    fn reward_item_builders_include_item_and_player_shape() {
        let items = vec![MinimalBattleRewardItemDto {
            item_def_id: "mat-005".to_string(),
            item_name: "铁木芯".to_string(),
            qty: 2,
            bind_type: "none".to_string(),
        }];
        let item_values = build_reward_item_values(&items);
        let player_values = build_single_player_reward_values(11, 22, 33, 44, &items);
        assert_eq!(item_values[0]["itemDefId"], "mat-005");
        assert_eq!(player_values[0]["userId"], 11);
        assert_eq!(player_values[0]["items"][0]["qty"], 2);
        println!(
            "BATTLE_REWARD_ITEM_VALUES={}",
            serde_json::json!({
                "items": item_values,
                "perPlayerRewards": player_values,
            })
        );
    }
}
