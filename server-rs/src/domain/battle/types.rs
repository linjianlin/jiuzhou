/**
 * 战斗运行时领域模型。
 *
 * 作用：
 * 1. 做什么：定义 recovery kernel 组装后的 battle identity / dynamic / static / participants，以及面向 realtime 的最小同步载荷结构。
 * 2. 做什么：把 battle 恢复数据和 realtime framing 的稳定字段集中声明，避免 startup、socket、恢复流程各自复制一套字段口径。
 * 3. 不做什么：不解析 Redis、不推进战斗规则，也不负责 socket 发送。
 *
 * 输入 / 输出：
 * - 输入：上游由 recovery/runtime 传入的 battle 恢复数据。
 * - 输出：内存运行态 `BattleRuntime` 与可序列化的 realtime payload structs。
 *
 * 数据流 / 状态流：
 * - recovery snapshot -> BattleRuntimeEngine -> BattleRuntime
 * - BattleRuntime -> realtime builder -> battle:update / battle:sync 最小载荷
 *
 * 复用设计说明：
 * - 把“恢复后的领域状态”和“可推送快照”拆成显式 struct，后续 ticker / settlement / socket sync 都能复用同一份模型，不必重复拼 battleId、session、participants。
 * - 高变化点集中在 realtime payload；领域状态保持稳定，可减少后续在线战斗接线时的重复维护。
 *
 * 关键边界条件与坑点：
 * 1. 当前只支持 recovery 数据足够表达的最小 battle runtime，不会伪造完整 logs、行动队列或规则执行上下文。
 * 2. realtime state 里的 unit 快照按 static/dynamic 同索引合并；若后续 Redis 合约改变顺序，需要在 builder 层显式调整，不能在调用方偷偷兜底。
 */
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runtime::battle::persistence::{
    BattleDynamicStateRedis, BattleDynamicTeamRedis, BattleDynamicTeamsRedis,
    BattleDynamicUnitRedis, BattleStaticStateRedis, BattleStaticTeamRedis, BattleStaticTeamsRedis,
    BattleStaticUnitRedis, CharacterRuntimeResourceRedis, PveResumeIntentRedis,
};
use crate::runtime::projection::service::{
    OnlineBattleCharacterSnapshotRedis, TeamMemberProjectionRedis,
};
use crate::runtime::session::projection::OnlineBattleSessionSnapshotRedis;

#[derive(Debug, Clone, PartialEq)]
pub struct BattleRuntimeIdentity {
    pub battle_id: String,
    pub battle_type: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BattleRuntimeDynamicState {
    pub round_count: u32,
    pub current_team: String,
    pub current_unit_id: Option<String>,
    pub phase: String,
    pub result: Option<Value>,
    pub rewards: Option<Value>,
    pub random_index: u64,
    pub log_cursor: u64,
    pub teams: BattleDynamicTeamsRedis,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BattleRuntimeStaticState {
    pub battle_id: String,
    pub battle_type: String,
    pub cooldown_timing_mode: String,
    pub first_mover: String,
    pub random_seed: String,
    pub teams: BattleStaticTeamsRedis,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BattleRuntimeParticipant {
    pub user_id: Option<i64>,
    pub character_id: i64,
    pub unit_id: Option<String>,
    pub team_id: Option<String>,
    pub is_team_leader: bool,
    pub projection: Option<OnlineBattleCharacterSnapshotRedis>,
    pub team_member_projection: Option<TeamMemberProjectionRedis>,
    pub runtime_resource: Option<CharacterRuntimeResourceRedis>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BattleRuntimeParticipants {
    pub user_ids: Vec<i64>,
    pub character_ids: Vec<i64>,
    pub members: Vec<BattleRuntimeParticipant>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BattleRuntime {
    pub identity: BattleRuntimeIdentity,
    pub dynamic_state: BattleRuntimeDynamicState,
    pub static_state: BattleRuntimeStaticState,
    pub participants: BattleRuntimeParticipants,
    pub session: Option<OnlineBattleSessionSnapshotRedis>,
    pub pve_resume_intent: Option<PveResumeIntentRedis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BattleRealtimeKind {
    BattleStarted,
    BattleState,
    BattleFinished,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleRealtimeStateSnapshot {
    pub battle_id: String,
    pub battle_type: String,
    pub cooldown_timing_mode: String,
    pub first_mover: String,
    pub round_count: u32,
    pub current_team: String,
    pub current_unit_id: Option<String>,
    pub phase: String,
    pub result: Option<Value>,
    pub rewards: Option<Value>,
    pub random_index: u64,
    pub log_cursor: u64,
    pub teams: BattleRealtimeTeamsSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BattleRealtimeTeamsSnapshot {
    pub attacker: BattleRealtimeTeamSnapshot,
    pub defender: BattleRealtimeTeamSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleRealtimeTeamSnapshot {
    pub owner_id: Option<i64>,
    pub total_speed: i64,
    pub units: Vec<BattleRealtimeUnitSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleRealtimeUnitSnapshot {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub unit_type: String,
    pub source_id: Value,
    pub formation_order: i64,
    pub owner_unit_id: Option<Value>,
    pub base_attrs: Value,
    pub current_attrs: Value,
    pub qixue: i64,
    pub lingqi: i64,
    pub shields: Vec<Value>,
    pub buffs: Vec<Value>,
    pub marks: Vec<Value>,
    pub momentum: i64,
    pub skill_cooldowns: Value,
    pub skill_cooldown_discount_bank: Value,
    pub triggered_phase_ids: Vec<Value>,
    pub control_diminishing: Value,
    pub is_alive: bool,
    pub can_act: bool,
    pub stats: Value,
    pub skills: Vec<Value>,
    pub set_bonus_effects: Vec<Value>,
    pub ai_profile: Option<Value>,
    pub partner_skill_policy: Option<Value>,
    pub is_summon: bool,
    pub summoner_id: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleRealtimePayload {
    pub kind: BattleRealtimeKind,
    pub battle_id: String,
    pub state: BattleRealtimeStateSnapshot,
    pub logs: Vec<Value>,
    pub log_start: u64,
    pub log_delta: bool,
    pub units_delta: bool,
    pub session: Option<OnlineBattleSessionSnapshotRedis>,
    pub rewards: Option<Value>,
    pub result: Option<String>,
    pub authoritative: bool,
}

impl From<BattleDynamicStateRedis> for BattleRuntimeDynamicState {
    fn from(value: BattleDynamicStateRedis) -> Self {
        Self {
            round_count: value.round_count,
            current_team: value.current_team,
            current_unit_id: value.current_unit_id,
            phase: value.phase,
            result: value.result,
            rewards: value.rewards,
            random_index: value.random_index,
            log_cursor: value.log_cursor,
            teams: value.teams,
        }
    }
}

impl From<BattleStaticStateRedis> for BattleRuntimeStaticState {
    fn from(value: BattleStaticStateRedis) -> Self {
        Self {
            battle_id: value.battle_id,
            battle_type: value.battle_type,
            cooldown_timing_mode: value.cooldown_timing_mode,
            first_mover: value.first_mover,
            random_seed: value.random_seed,
            teams: value.teams,
        }
    }
}

pub fn build_team_snapshot(
    static_team: &BattleStaticTeamRedis,
    dynamic_team: &BattleDynamicTeamRedis,
) -> BattleRealtimeTeamSnapshot {
    BattleRealtimeTeamSnapshot {
        owner_id: static_team.odwner_id,
        total_speed: dynamic_team.total_speed,
        units: static_team
            .units
            .iter()
            .zip(dynamic_team.units.iter())
            .map(|(static_unit, dynamic_unit)| build_unit_snapshot(static_unit, dynamic_unit))
            .collect(),
    }
}

pub fn build_unit_snapshot(
    static_unit: &BattleStaticUnitRedis,
    dynamic_unit: &BattleDynamicUnitRedis,
) -> BattleRealtimeUnitSnapshot {
    BattleRealtimeUnitSnapshot {
        id: static_unit.id.clone(),
        name: static_unit.name.clone(),
        unit_type: static_unit.unit_type.clone(),
        source_id: static_unit.source_id.clone(),
        formation_order: static_unit.formation_order,
        owner_unit_id: static_unit.owner_unit_id.clone(),
        base_attrs: static_unit.base_attrs.clone(),
        current_attrs: dynamic_unit.current_attrs.clone(),
        qixue: dynamic_unit.qixue,
        lingqi: dynamic_unit.lingqi,
        shields: dynamic_unit.shields.clone(),
        buffs: dynamic_unit.buffs.clone(),
        marks: dynamic_unit.marks.clone(),
        momentum: dynamic_unit.momentum,
        skill_cooldowns: dynamic_unit.skill_cooldowns.clone(),
        skill_cooldown_discount_bank: dynamic_unit.skill_cooldown_discount_bank.clone(),
        triggered_phase_ids: dynamic_unit.triggered_phase_ids.clone(),
        control_diminishing: dynamic_unit.control_diminishing.clone(),
        is_alive: dynamic_unit.is_alive,
        can_act: dynamic_unit.can_act,
        stats: dynamic_unit.stats.clone(),
        skills: static_unit.skills.clone(),
        set_bonus_effects: static_unit.set_bonus_effects.clone(),
        ai_profile: static_unit.ai_profile.clone(),
        partner_skill_policy: static_unit.partner_skill_policy.clone(),
        is_summon: static_unit.is_summon,
        summoner_id: static_unit.summoner_id.clone(),
    }
}

pub fn build_realtime_state(runtime: &BattleRuntime) -> BattleRealtimeStateSnapshot {
    BattleRealtimeStateSnapshot {
        battle_id: runtime.identity.battle_id.clone(),
        battle_type: runtime.identity.battle_type.clone(),
        cooldown_timing_mode: runtime.static_state.cooldown_timing_mode.clone(),
        first_mover: runtime.static_state.first_mover.clone(),
        round_count: runtime.dynamic_state.round_count,
        current_team: runtime.dynamic_state.current_team.clone(),
        current_unit_id: runtime.dynamic_state.current_unit_id.clone(),
        phase: runtime.dynamic_state.phase.clone(),
        result: runtime.dynamic_state.result.clone(),
        rewards: runtime.dynamic_state.rewards.clone(),
        random_index: runtime.dynamic_state.random_index,
        log_cursor: runtime.dynamic_state.log_cursor,
        teams: BattleRealtimeTeamsSnapshot {
            attacker: build_team_snapshot(
                &runtime.static_state.teams.attacker,
                &runtime.dynamic_state.teams.attacker,
            ),
            defender: build_team_snapshot(
                &runtime.static_state.teams.defender,
                &runtime.dynamic_state.teams.defender,
            ),
        },
    }
}

pub fn extract_result_text(result: &Option<Value>) -> Option<String> {
    result
        .as_ref()
        .and_then(|item| item.as_str().map(ToString::to_string))
}
