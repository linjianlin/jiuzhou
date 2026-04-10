/**
 * 战斗运行时组装引擎。
 *
 * 作用：
 * 1. 做什么：把 recovery kernel 输出的 battle / session / projection / resource 数据，装配为单场 battle 的内存运行态模型。
 * 2. 做什么：集中维护 battleId -> session、character -> projection/resource 的拼装规则，避免 startup 与 runtime registry 各自复制查找逻辑。
 * 3. 不做什么：不执行战斗 tick、不生成日志，也不修改 recovery snapshot。
 *
 * 输入 / 输出：
 * - 输入：`RuntimeRecoverySnapshot` 与 battleId。
 * - 输出：可注册到 runtime registry 的 `BattleRuntime`。
 *
 * 数据流 / 状态流：
 * - RuntimeRecoverySnapshot -> 查 battle/session/projection/resource 索引 -> BattleRuntime
 *
 * 复用设计说明：
 * - 单场装配逻辑是 startup 恢复、后续懒回填和 battle:sync 的共同前置步骤，收口在这里能减少跨模块重复遍历 snapshot。
 * - 参与者信息是高频查询点，组装时直接归并 userId / characterId / projection / resource，后续 socket 层只读不再重复扫描。
 *
 * 关键边界条件与坑点：
 * 1. 这里只装配 recovery 已存在的数据，缺失 projection/resource 时会保留 None，而不是伪造默认状态。
 * 2. player characterId 从 static unit 的 `sourceId` 提取；monster 或非数值 sourceId 必须跳过，不能污染角色索引。
 */
use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::types::{
    BattleRuntime, BattleRuntimeDynamicState, BattleRuntimeIdentity, BattleRuntimeParticipant,
    BattleRuntimeParticipants, BattleRuntimeStaticState,
};
use crate::runtime::battle::persistence::PveResumeIntentRedis;
use crate::runtime::projection::service::RuntimeRecoverySnapshot;
use crate::runtime::session::projection::OnlineBattleSessionSnapshotRedis;

pub struct BattleRuntimeEngine;

impl BattleRuntimeEngine {
    pub fn assemble(snapshot: &RuntimeRecoverySnapshot, battle_id: &str) -> Option<BattleRuntime> {
        let recovered = snapshot
            .battles
            .iter()
            .find(|battle| battle.battle_id == battle_id)?;

        let session_id = find_session_id(snapshot, battle_id);
        let session = session_id
            .as_ref()
            .and_then(|item| find_session_snapshot(snapshot, item))
            .or_else(|| find_session_by_current_battle(snapshot, battle_id));
        let pve_resume_intent = find_pve_resume_intent(snapshot, battle_id);

        let projection_by_character_id = snapshot
            .online_projection
            .character_snapshots
            .iter()
            .map(|item| (item.character_id, item.clone()))
            .collect::<BTreeMap<_, _>>();
        let resource_by_character_id = snapshot
            .runtime_resources
            .iter()
            .map(|(character_id, resource)| (*character_id, resource.clone()))
            .collect::<BTreeMap<_, _>>();
        let user_id_by_character_id = build_user_id_by_character_id(snapshot);
        let team_member_by_user_id = snapshot
            .online_projection
            .team_members
            .iter()
            .map(|(user_id, team_member)| (*user_id, team_member.clone()))
            .collect::<BTreeMap<_, _>>();

        let character_ids =
            collect_player_character_ids(recovered.static_state.teams.attacker.units.iter())
                .into_iter()
                .chain(collect_player_character_ids(
                    recovered.static_state.teams.defender.units.iter(),
                ))
                .collect::<Vec<_>>();

        let members = character_ids
            .iter()
            .map(|character_id| {
                let projection = projection_by_character_id.get(character_id).cloned();
                let user_id = projection
                    .as_ref()
                    .map(|item| item.user_id)
                    .or_else(|| user_id_by_character_id.get(character_id).copied());
                let team_member_projection =
                    user_id.and_then(|item| team_member_by_user_id.get(&item).cloned());
                let unit_id = find_unit_id_by_character_id(
                    recovered.static_state.teams.attacker.units.iter(),
                    *character_id,
                )
                .or_else(|| {
                    find_unit_id_by_character_id(
                        recovered.static_state.teams.defender.units.iter(),
                        *character_id,
                    )
                });

                BattleRuntimeParticipant {
                    user_id,
                    character_id: *character_id,
                    unit_id,
                    team_id: projection.as_ref().and_then(|item| item.team_id.clone()),
                    is_team_leader: projection
                        .as_ref()
                        .map(|item| item.is_team_leader)
                        .unwrap_or(false),
                    projection,
                    team_member_projection,
                    runtime_resource: resource_by_character_id.get(character_id).cloned(),
                }
            })
            .collect::<Vec<_>>();

        Some(BattleRuntime {
            identity: BattleRuntimeIdentity {
                battle_id: recovered.battle_id.clone(),
                battle_type: recovered.static_state.battle_type.clone(),
                session_id,
            },
            dynamic_state: BattleRuntimeDynamicState::from(recovered.dynamic_state.clone()),
            static_state: BattleRuntimeStaticState::from(recovered.static_state.clone()),
            participants: BattleRuntimeParticipants {
                user_ids: dedupe_i64(recovered.participants.iter().copied()),
                character_ids: dedupe_i64(character_ids.into_iter()),
                members,
            },
            session,
            pve_resume_intent,
        })
    }
}

fn collect_player_character_ids<'a>(
    units: impl Iterator<Item = &'a crate::runtime::battle::persistence::BattleStaticUnitRedis>,
) -> Vec<i64> {
    units
        .filter(|unit| unit.unit_type == "player")
        .filter_map(|unit| parse_character_id(&unit.source_id))
        .collect()
}

fn parse_character_id(source_id: &Value) -> Option<i64> {
    source_id
        .as_i64()
        .or_else(|| source_id.as_u64().and_then(|item| i64::try_from(item).ok()))
        .or_else(|| source_id.as_str().and_then(|item| item.parse::<i64>().ok()))
        .filter(|item| *item > 0)
}

fn find_unit_id_by_character_id<'a>(
    mut units: impl Iterator<Item = &'a crate::runtime::battle::persistence::BattleStaticUnitRedis>,
    character_id: i64,
) -> Option<String> {
    units
        .find(|unit| parse_character_id(&unit.source_id) == Some(character_id))
        .map(|unit| unit.id.clone())
}

fn build_user_id_by_character_id(snapshot: &RuntimeRecoverySnapshot) -> BTreeMap<i64, i64> {
    let mut mapping = BTreeMap::new();
    for snapshot_item in &snapshot.online_projection.character_snapshots {
        mapping.insert(snapshot_item.character_id, snapshot_item.user_id);
    }
    for (user_id, character_id) in &snapshot.online_projection.user_character_links {
        mapping.entry(*character_id).or_insert(*user_id);
    }
    mapping
}

fn find_session_id(snapshot: &RuntimeRecoverySnapshot, battle_id: &str) -> Option<String> {
    snapshot
        .online_projection
        .session_battle_links
        .iter()
        .find(|(linked_battle_id, _)| linked_battle_id == battle_id)
        .map(|(_, session_id)| session_id.clone())
}

fn find_session_snapshot(
    snapshot: &RuntimeRecoverySnapshot,
    session_id: &str,
) -> Option<OnlineBattleSessionSnapshotRedis> {
    snapshot
        .battle_sessions
        .projections
        .iter()
        .find(|projection| projection.session_id == session_id)
        .cloned()
        .or_else(|| {
            snapshot
                .online_projection
                .session_projections
                .iter()
                .find(|projection| projection.session_id == session_id)
                .cloned()
        })
}

fn find_session_by_current_battle(
    snapshot: &RuntimeRecoverySnapshot,
    battle_id: &str,
) -> Option<OnlineBattleSessionSnapshotRedis> {
    snapshot
        .battle_sessions
        .projections
        .iter()
        .chain(snapshot.online_projection.session_projections.iter())
        .find(|projection| projection.current_battle_id.as_deref() == Some(battle_id))
        .cloned()
}

fn find_pve_resume_intent(
    snapshot: &RuntimeRecoverySnapshot,
    battle_id: &str,
) -> Option<PveResumeIntentRedis> {
    snapshot
        .battle_sessions
        .pve_resume_intents
        .iter()
        .find(|intent| intent.battle_id == battle_id)
        .cloned()
}

fn dedupe_i64(items: impl Iterator<Item = i64>) -> Vec<i64> {
    let mut seen = BTreeSet::new();
    items.filter(|item| seen.insert(*item)).collect()
}
