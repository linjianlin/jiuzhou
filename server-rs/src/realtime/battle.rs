use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_delta: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub units_delta: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<BattleSessionSnapshotDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<BattleRewardsPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoritative: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battle_start_cooldown_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_battle_available_at: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct BattleFinishedMeta {
    pub rewards: Option<BattleRewardsPayload>,
    pub result: Option<String>,
    pub success: Option<bool>,
    pub message: Option<String>,
    pub battle_start_cooldown_ms: Option<i64>,
    pub retry_after_ms: Option<i64>,
    pub next_battle_available_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleCooldownPayload {
    #[serde(skip_serializing)]
    pub kind: String,
    pub character_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_ms: Option<i64>,
    pub timestamp: i64,
}

static BATTLE_LOG_CURSORS: OnceLock<Mutex<BTreeMap<String, i64>>> = OnceLock::new();

fn battle_log_cursors() -> &'static Mutex<BTreeMap<String, i64>> {
    BATTLE_LOG_CURSORS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn consume_battle_log_delta(battle_id: &str, logs_len: usize, reset: bool) -> i64 {
    let mut cursors = battle_log_cursors()
        .lock()
        .expect("battle log cursor mutex should not be poisoned");
    if reset {
        cursors.insert(battle_id.to_string(), 0);
    }
    let log_start = cursors.get(battle_id).copied().unwrap_or(0);
    cursors.insert(battle_id.to_string(), log_start + logs_len as i64);
    log_start
}

pub fn build_battle_snapshot_state_value(state: BattleStateDto) -> Value {
    serde_json::to_value(state).expect("battle state should serialize")
}

pub fn build_battle_delta_state_value(state: BattleStateDto) -> Value {
    let mut value = build_battle_snapshot_state_value(state);
    strip_static_fields_from_state(&mut value);
    value
}

fn strip_static_fields_from_state(state: &mut Value) {
    if let Some(teams) = state.get_mut("teams").and_then(Value::as_object_mut) {
        for team in teams.values_mut() {
            if let Some(units) = team.get_mut("units").and_then(Value::as_array_mut) {
                for unit in units {
                    strip_static_unit_fields(unit);
                }
            }
        }
    }
}

fn strip_static_unit_fields(unit: &mut Value) {
    if let Some(object) = unit.as_object_mut() {
        object.remove("baseAttrs");
        object.remove("skills");
        object.remove("setBonusEffects");
        object.remove("aiProfile");
    }
}

pub fn build_battle_started_payload(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
) -> BattleRealtimePayload {
    build_battle_started_payload_with_cursor_mode(battle_id, state, logs, session, true)
}

pub fn build_battle_started_sync_payload(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
) -> BattleRealtimePayload {
    build_battle_started_payload_with_cursor_mode(battle_id, state, logs, session, false)
}

fn build_battle_started_payload_with_cursor_mode(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
    reset_log_cursor: bool,
) -> BattleRealtimePayload {
    let log_start = consume_battle_log_delta(battle_id, logs.len(), reset_log_cursor);
    BattleRealtimePayload {
        kind: "battle_started".to_string(),
        battle_id: battle_id.to_string(),
        state: Some(build_battle_snapshot_state_value(state)),
        logs: Some(logs),
        log_start: Some(log_start),
        log_delta: Some(true),
        units_delta: None,
        session,
        rewards: None,
        result: None,
        authoritative: Some(true),
        success: None,
        message: None,
        battle_start_cooldown_ms: None,
        retry_after_ms: None,
        next_battle_available_at: None,
    }
}

pub fn build_battle_state_payload(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
) -> BattleRealtimePayload {
    let log_start = consume_battle_log_delta(battle_id, logs.len(), false);
    BattleRealtimePayload {
        kind: "battle_state".to_string(),
        battle_id: battle_id.to_string(),
        state: Some(build_battle_delta_state_value(state)),
        logs: Some(logs),
        log_start: Some(log_start),
        log_delta: Some(true),
        units_delta: Some(true),
        session,
        rewards: None,
        result: None,
        authoritative: Some(true),
        success: None,
        message: None,
        battle_start_cooldown_ms: None,
        retry_after_ms: None,
        next_battle_available_at: None,
    }
}

pub fn build_battle_finished_payload(
    battle_id: &str,
    state: BattleStateDto,
    logs: Vec<serde_json::Value>,
    session: Option<BattleSessionSnapshotDto>,
    meta: BattleFinishedMeta,
) -> BattleRealtimePayload {
    let log_start = consume_battle_log_delta(battle_id, logs.len(), false);
    BattleRealtimePayload {
        kind: "battle_finished".to_string(),
        battle_id: battle_id.to_string(),
        state: Some(build_battle_snapshot_state_value(state)),
        logs: Some(logs),
        log_start: Some(log_start),
        log_delta: Some(true),
        units_delta: None,
        session,
        rewards: meta.rewards,
        result: meta.result,
        authoritative: Some(true),
        success: meta.success,
        message: meta.message,
        battle_start_cooldown_ms: meta.battle_start_cooldown_ms,
        retry_after_ms: meta.retry_after_ms,
        next_battle_available_at: meta.next_battle_available_at,
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
        units_delta: None,
        session,
        rewards: None,
        result: None,
        authoritative: Some(true),
        success: Some(success),
        message: Some(message.to_string()),
        battle_start_cooldown_ms: None,
        retry_after_ms: None,
        next_battle_available_at: None,
    }
}

pub fn build_battle_cooldown_sync_payload(
    actor_id: Option<&str>,
    cooldown_ms: i64,
) -> BattleCooldownPayload {
    BattleCooldownPayload {
        kind: "battle:cooldown-sync".to_string(),
        character_id: parse_character_id_from_actor_id(actor_id),
        remaining_ms: Some(cooldown_ms.max(0)),
        timestamp: current_timestamp_ms(),
    }
}

pub fn build_battle_cooldown_ready_payload(actor_id: Option<&str>) -> BattleCooldownPayload {
    BattleCooldownPayload {
        kind: "battle:cooldown-ready".to_string(),
        character_id: parse_character_id_from_actor_id(actor_id),
        remaining_ms: None,
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
    use crate::battle_runtime::MinimalBattleRewardItemDto;
    use crate::battle_runtime::build_minimal_pve_battle_state;
    use crate::state::{BattleSessionContextDto, BattleSessionSnapshotDto};

    use super::{
        BattleFinishedMeta, BattleRewardsPayload, build_battle_abandoned_payload,
        build_battle_cooldown_ready_payload, build_battle_cooldown_sync_payload,
        build_battle_finished_payload, build_battle_started_payload,
        build_battle_started_sync_payload, build_battle_state_payload, build_reward_item_values,
        build_single_player_reward_values,
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
            "pve-battle-started",
            build_minimal_pve_battle_state(
                "pve-battle-started",
                1,
                &["monster-gray-wolf".to_string()],
            ),
            vec![serde_json::json!({"type": "round_start", "round": 1})],
            Some(sample_session()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_started");
        assert_eq!(payload["authoritative"], true);
        assert_eq!(payload["logStart"], 0);
        assert_eq!(payload["logDelta"], true);
        assert!(payload.get("unitsDelta").is_none());
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("baseAttrs")
                .is_some()
        );
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("skills")
                .is_some()
        );
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("setBonusEffects")
                .is_some()
        );
        println!("BATTLE_REALTIME_STARTED_RESPONSE={}", payload);
    }

    #[test]
    fn battle_state_payload_matches_contract() {
        let payload = serde_json::to_value(build_battle_state_payload(
            "pve-battle-state",
            build_minimal_pve_battle_state(
                "pve-battle-state",
                1,
                &["monster-gray-wolf".to_string()],
            ),
            vec![serde_json::json!({"type": "action", "round": 1})],
            Some(sample_session()),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_state");
        assert_eq!(payload["authoritative"], true);
        assert_eq!(payload["logStart"], 0);
        assert_eq!(payload["logDelta"], true);
        assert_eq!(payload["unitsDelta"], true);
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("baseAttrs")
                .is_none()
        );
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("skills")
                .is_none()
        );
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("setBonusEffects")
                .is_none()
        );
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("qixue")
                .is_some()
        );
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("currentAttrs")
                .is_some()
        );
        println!("BATTLE_REALTIME_STATE_RESPONSE={}", payload);
    }

    #[test]
    fn battle_started_sync_payload_keeps_log_cursor_and_full_state() {
        let battle_id = "pve-battle-sync-cursor";
        let started = serde_json::to_value(build_battle_started_payload(
            battle_id,
            build_minimal_pve_battle_state(battle_id, 1, &["monster-gray-wolf".to_string()]),
            vec![serde_json::json!({"type": "round_start", "round": 1})],
            Some(sample_session()),
        ))
        .expect("payload should serialize");
        assert_eq!(started["logStart"], 0);

        let synced = serde_json::to_value(build_battle_started_sync_payload(
            battle_id,
            build_minimal_pve_battle_state(battle_id, 1, &["monster-gray-wolf".to_string()]),
            vec![],
            Some(sample_session()),
        ))
        .expect("payload should serialize");
        assert_eq!(synced["kind"], "battle_started");
        assert_eq!(synced["logStart"], 1);
        assert_eq!(synced["logDelta"], true);
        assert!(synced.get("unitsDelta").is_none());
        assert!(
            synced["state"]["teams"]["attacker"]["units"][0]
                .get("baseAttrs")
                .is_some()
        );
    }

    #[test]
    fn battle_finished_payload_matches_contract() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-finished",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.phase = "finished".to_string();
        state.result = Some("attacker_win".to_string());
        let payload = serde_json::to_value(build_battle_finished_payload(
            "pve-battle-finished",
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
                battle_start_cooldown_ms: Some(1500),
                retry_after_ms: Some(1200),
                next_battle_available_at: Some(1234567890),
            },
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_finished");
        assert_eq!(payload["authoritative"], true);
        assert_eq!(payload["logStart"], 0);
        assert_eq!(payload["logDelta"], true);
        assert!(payload.get("unitsDelta").is_none());
        assert_eq!(payload["rewards"]["exp"], 12);
        assert_eq!(payload["result"], "attacker_win");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["message"], "战斗结束");
        assert_eq!(payload["battleStartCooldownMs"], 1500);
        assert_eq!(payload["retryAfterMs"], 1200);
        assert_eq!(payload["nextBattleAvailableAt"], 1234567890);
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
        assert!(payload.get("state").is_none());
        assert!(payload.get("logs").is_none());
        assert!(payload.get("rewards").is_none());
        println!("BATTLE_REALTIME_ABANDONED_RESPONSE={}", payload);
    }

    #[test]
    fn battle_cooldown_sync_payload_matches_contract() {
        let cooldown_payload = build_battle_cooldown_sync_payload(Some("player-1"), 1500);
        assert_eq!(cooldown_payload.kind, "battle:cooldown-sync");
        let payload = serde_json::to_value(cooldown_payload).expect("payload should serialize");
        assert!(payload.get("kind").is_none());
        assert_eq!(payload["characterId"], 1);
        assert_eq!(payload["remainingMs"], 1500);
        println!("BATTLE_REALTIME_COOLDOWN_SYNC_RESPONSE={}", payload);
    }

    #[test]
    fn battle_cooldown_ready_payload_matches_contract() {
        let cooldown_payload = build_battle_cooldown_ready_payload(Some("player-1"));
        assert_eq!(cooldown_payload.kind, "battle:cooldown-ready");
        let payload = serde_json::to_value(cooldown_payload).expect("payload should serialize");
        assert!(payload.get("kind").is_none());
        assert_eq!(payload["characterId"], 1);
        assert!(payload.get("remainingMs").is_none());
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
