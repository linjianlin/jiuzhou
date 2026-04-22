# Rust BattleEngine Node Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Rust 后端战斗运行时，使它在状态 JSON、日志、错误、回合推进、自动行动和结算交接上与 NodeJS `BattleEngine` 逐字段兼容。

**Architecture:** NodeJS 战斗实现继续作为语义权威；Rust 先在现有 `server-rs/src/battle_runtime.rs` 中完成同构行为，不做大规模模块拆分。HTTP route 只负责状态加载、持久化、实时 payload 和 durable settlement task；数据库发奖仍由 `online_battle_settlement` job 幂等处理。

**Tech Stack:** Rust, serde/serde_json, sqlx, Axum, Cargo tests, existing Node TypeScript battle modules as reference.

---

## Files

- Modify: `server-rs/src/battle_runtime.rs`
  - 编译基线修复。
  - Node 兼容日志 shape。
  - 目标解析与错误文案。
  - 回合开始、行动推进、回合结束顺序。
  - 技能效果、伤害、治疗、护盾、buff/debuff、控制、印记、套装。
  - AI、伙伴策略、阶段触发、召唤。
  - 文件内单元测试。
- Modify: `server-rs/src/http/battle.rs`
  - 确认 action route 使用 Rust runtime 返回的 Node 兼容 logs/state。
  - 确认 PVE/PVP/tower 完成后 settlement task payload 字段不漂移。
- Modify: `server-rs/src/realtime/battle.rs`
  - 确认 finished/update realtime payload 转发 Node 兼容日志字段，不额外插入 null 字段。
- Modify: `server-rs/src/jobs/online_battle_settlement.rs`
  - 只在 payload 字段需要和 runtime 输出对齐时修改。
- Reference only: `server/src/battle/battleEngine.ts`
- Reference only: `server/src/battle/modules/skill.ts`
- Reference only: `server/src/battle/modules/buff.ts`
- Reference only: `server/src/battle/modules/setBonus.ts`
- Reference only: `server/src/battle/modules/ai.ts`
- Reference only: `server/src/battle/modules/control.ts`
- Reference only: `server/src/battle/modules/mark.ts`
- Reference only: `server/src/battle/utils/cooldown.ts`

---

### Task 1: 恢复 Rust 战斗运行时编译基线

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 运行当前编译基线**

Run:

```bash
cd server-rs
cargo test battle_runtime --no-run
```

Expected: FAIL with the current known error:

```text
missing fields `momentum_consumed` and `momentum_gained` in initializer of `RuntimeResolvedTargetLog`
```

- [ ] **Step 2: 补齐 `execute_runtime_skill_action` 中的 target log 初始化**

In `server-rs/src/battle_runtime.rs`, find the `target_logs.push(RuntimeResolvedTargetLog {` initializer inside `execute_runtime_skill_action` after `apply_runtime_damage_to_target`, and replace that initializer with:

```rust
target_logs.push(RuntimeResolvedTargetLog {
    target_id: target_id.clone(),
    target_name: target_name.clone(),
    damage: actual_damage,
    heal: 0,
    shield: 0,
    buffs_applied: Vec::new(),
    is_miss: damage_outcome.is_miss,
    is_crit: damage_outcome.is_crit,
    is_parry: damage_outcome.is_parry,
    is_element_bonus: damage_outcome.is_element_bonus,
    shield_absorbed,
    momentum_gained: Vec::new(),
    momentum_consumed: Vec::new(),
});
```

- [ ] **Step 3: 删除会和禁止 fallback 冲突的旧测试**

In `server-rs/src/battle_runtime.rs`, remove the whole test function named:

```rust
fn minimal_pve_action_falls_back_to_first_alive_enemy_when_target_is_stale()
```

This test contradicts the project rule and the approved design: stale player targets must not silently retarget.

- [ ] **Step 4: 运行编译基线**

Run:

```bash
cd server-rs
cargo test battle_runtime --no-run
```

Expected: PASS compilation for `battle_runtime` tests. Warnings from unrelated files may remain visible.

- [ ] **Step 5: 提交编译基线修复**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "fix: restore rust battle runtime compile baseline"
```

---

### Task 2: 锁定 Node 兼容 action log shape

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 写失败测试，覆盖空可选字段省略与动量字段输出**

Add this test inside `#[cfg(test)] mod tests` in `server-rs/src/battle_runtime.rs`:

```rust
#[test]
fn runtime_action_log_omits_empty_optional_fields_and_keeps_node_shape() {
    let log = super::build_runtime_action_log(
        3,
        "player-1",
        "修士1",
        "skill-normal-attack",
        "普通攻击",
        &[super::RuntimeResolvedTargetLog {
            target_id: "monster-1".to_string(),
            target_name: "灰狼".to_string(),
            damage: 12,
            heal: 0,
            shield: 0,
            buffs_applied: Vec::new(),
            is_miss: false,
            is_crit: true,
            is_parry: false,
            is_element_bonus: true,
            shield_absorbed: 4,
            momentum_gained: vec!["moon_trace".to_string()],
            momentum_consumed: Vec::new(),
        }],
    );

    let target = &log["targets"][0];
    assert_eq!(log["type"], "action");
    assert_eq!(log["round"], 3);
    assert_eq!(target["targetId"], "monster-1");
    assert_eq!(target["damage"], 12);
    assert_eq!(target["shieldAbsorbed"], 4);
    assert_eq!(target["hits"][0]["damage"], 12);
    assert_eq!(target["hits"][0]["isCrit"], true);
    assert_eq!(target["hits"][0]["isElementBonus"], true);
    assert_eq!(target["momentumGained"][0], "moon_trace");
    assert!(target.get("heal").is_none());
    assert!(target.get("shield").is_none());
    assert!(target.get("buffsApplied").is_none());
    assert!(target.get("momentumConsumed").is_none());
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server-rs
cargo test runtime_action_log_omits_empty_optional_fields_and_keeps_node_shape -- --nocapture
```

Expected: FAIL because `momentumGained` is not emitted yet.

- [ ] **Step 3: 更新 `build_runtime_action_log`**

In `server-rs/src/battle_runtime.rs`, inside `build_runtime_action_log`, extend the `if let Some(object) = target_value.as_object_mut()` block with:

```rust
if !target.momentum_gained.is_empty() {
    object.insert(
        "momentumGained".to_string(),
        serde_json::json!(target.momentum_gained),
    );
}
if !target.momentum_consumed.is_empty() {
    object.insert(
        "momentumConsumed".to_string(),
        serde_json::json!(target.momentum_consumed),
    );
}
```

- [ ] **Step 4: 运行日志 shape 测试**

Run:

```bash
cd server-rs
cargo test runtime_action_log_omits_empty_optional_fields_and_keeps_node_shape -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: 运行 battle_runtime 编译**

Run:

```bash
cd server-rs
cargo test battle_runtime --no-run
```

Expected: PASS compilation.

- [ ] **Step 6: 提交日志兼容变更**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "test: lock rust battle action log shape"
```

---

### Task 3: 移除玩家目标静默重定向

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 写失败测试，非法玩家目标必须报错**

Add this test inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn minimal_pve_action_rejects_stale_selected_target() {
    let mut state = build_minimal_pve_battle_state(
        "pve-battle-1",
        1,
        &[
            "monster-gray-wolf".to_string(),
            "monster-white-wolf".to_string(),
        ],
    );

    let error = apply_minimal_pve_action(
        &mut state,
        1,
        "skill-normal-attack",
        &["monster-does-not-exist".to_string()],
    )
    .expect_err("stale target should be rejected");

    assert_eq!(error, "目标不存在或已死亡");
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server-rs
cargo test minimal_pve_action_rejects_stale_selected_target -- --nocapture
```

Expected: FAIL because current `resolve_alive_target_or_first_available` retargets to the first alive enemy.

- [ ] **Step 3: 替换目标解析辅助函数**

Replace `resolve_alive_target_or_first_available` with these two functions:

```rust
fn first_alive_unit_id(state: &BattleStateDto, team: &str) -> Option<String> {
    team_units(state, team)
        .iter()
        .find(|unit| unit.is_alive)
        .map(|unit| unit.id.clone())
}

fn resolve_selected_alive_target(
    state: &BattleStateDto,
    team: &str,
    target_ids: &[String],
) -> Result<Option<String>, String> {
    let Some(target_id) = target_ids.first() else {
        return Ok(None);
    };
    if team_units(state, team)
        .iter()
        .any(|unit| unit.id == *target_id && unit.is_alive)
    {
        return Ok(Some(target_id.clone()));
    }
    Err("目标不存在或已死亡".to_string())
}
```

- [ ] **Step 4: 更新 `resolve_runtime_skill_targets`**

In `resolve_runtime_skill_targets`, replace the target match body with this code:

```rust
let targets = match target_type {
    "self" => vec![actor_id.to_string()],
    "single_ally" => match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
        Some(target_id) => vec![target_id],
        None => first_alive_unit_id(state, ally_team).map(|id| vec![id]).unwrap_or_default(),
    },
    "all_ally" => team_units(state, ally_team)
        .iter()
        .filter(|unit| unit.is_alive)
        .map(|unit| unit.id.clone())
        .collect::<Vec<_>>(),
    "all_enemy" => team_units(state, enemy_team)
        .iter()
        .filter(|unit| unit.is_alive)
        .map(|unit| unit.id.clone())
        .collect::<Vec<_>>(),
    "single_enemy" | "random_enemy" => match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
        Some(target_id) => vec![target_id],
        None => first_alive_unit_id(state, enemy_team).map(|id| vec![id]).unwrap_or_default(),
    },
    _ => return Err(format!("不支持的目标类型: {target_type}")),
};
```

- [ ] **Step 5: 更新 `resolve_effect_target_ids`**

In `resolve_effect_target_ids`, use the same no-retarget behavior:

```rust
let resolved = match mode {
    "self" => vec![actor_id.to_string()],
    "ally" => match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
        Some(target_id) => vec![target_id],
        None => first_alive_unit_id(state, ally_team).map(|id| vec![id]).unwrap_or_default(),
    },
    "enemy" => match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
        Some(target_id) => vec![target_id],
        None => first_alive_unit_id(state, enemy_team).map(|id| vec![id]).unwrap_or_default(),
    },
    _ => match skill_target_type {
        "self" => vec![actor_id.to_string()],
        "single_ally" => match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
            Some(target_id) => vec![target_id],
            None => first_alive_unit_id(state, ally_team).map(|id| vec![id]).unwrap_or_default(),
        },
        "all_ally" => team_units(state, ally_team)
            .iter()
            .filter(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
            .collect::<Vec<_>>(),
        "all_enemy" => team_units(state, enemy_team)
            .iter()
            .filter(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
            .collect::<Vec<_>>(),
        "single_enemy" | "random_enemy" => match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
            Some(target_id) => vec![target_id],
            None => first_alive_unit_id(state, enemy_team).map(|id| vec![id]).unwrap_or_default(),
        },
        _ => return Err(format!("不支持的目标类型: {skill_target_type}")),
    },
};
```

Keep the existing empty-result error:

```rust
if resolved.is_empty() {
    return Err("没有有效目标".to_string());
}
Ok(resolved)
```

- [ ] **Step 6: 运行目标解析测试**

Run:

```bash
cd server-rs
cargo test minimal_pve_action_rejects_stale_selected_target -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: 运行相关目标测试**

Run:

```bash
cd server-rs
cargo test minimal_pve_action_supports_single_ally_heal_and_buff_targeting -- --nocapture
cargo test minimal_pve_action_supports_self_lingqi_restore_skill_effect -- --nocapture
```

Expected: both PASS.

- [ ] **Step 8: 提交目标校验变更**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "fix: reject stale rust battle targets"
```

---

### Task 4: 对齐回合结束日志顺序和冷却推进

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 写失败测试，round_end 必须在 round-end buff 日志之后**

Add this test:

```rust
#[test]
fn round_end_buff_expire_logs_before_round_end() {
    let mut state =
        build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
    state.teams.attacker.units[0].buffs.push(serde_json::json!({
        "id": "buff-expire",
        "buffDefId": "buff-expire",
        "name": "短效增益",
        "type": "buff",
        "category": "runtime",
        "sourceUnitId": "player-1",
        "remainingDuration": 1,
        "stacks": 1,
        "maxStacks": 1,
        "attrModifiers": [],
        "tags": [],
        "dispellable": true
    }));
    state.teams.attacker.units[0].current_attrs.sudu = 0;
    refresh_battle_team_total_speed(&mut state);
    state.first_mover = determine_first_mover(&state).to_string();

    let outcome = apply_minimal_pve_action(
        &mut state,
        1,
        "skill-normal-attack",
        &["monster-1-monster-gray-wolf".to_string()],
    )
    .expect("action should advance round");

    let expire_index = outcome
        .logs
        .iter()
        .position(|log| log["type"] == "buff_expire")
        .expect("buff expire log should exist");
    let round_end_index = outcome
        .logs
        .iter()
        .position(|log| log["type"] == "round_end")
        .expect("round_end log should exist");

    assert!(expire_index < round_end_index);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server-rs
cargo test round_end_buff_expire_logs_before_round_end -- --nocapture
```

Expected: FAIL because `round_end` is currently pushed before round-end buff processing.

- [ ] **Step 3: 移动 `round_end` 日志位置**

In `process_round_end_and_start_next_round`, move:

```rust
logs.push(build_round_end_log(state.round_count));
```

from the start of the function to immediately after the loop that calls `process_round_end_buffs`, before `finish_battle_if_needed`.

- [ ] **Step 4: 确保行动后冷却只跳过本次使用技能**

In `complete_unit_action_and_advance`, verify this call is present and keep it unchanged:

```rust
reduce_runtime_skill_cooldowns_for_unit(state, actor_id, used_skill_id);
```

If the function currently reduces cooldowns before recording used-skill cooldown, move reduction before `current_unit.can_act = false` and keep the `used_skill_id` skip.

- [ ] **Step 5: 运行回合与冷却测试**

Run:

```bash
cd server-rs
cargo test round_end_buff_expire_logs_before_round_end -- --nocapture
cargo test minimal_pve_action_cooldown_blocks_next_own_turn_then_unlocks_after_other_skill -- --nocapture
cargo test minimal_pve_action_runs_all_defender_turns_before_returning_to_attacker -- --nocapture
```

Expected: all PASS.

- [ ] **Step 6: 提交回合推进变更**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "fix: align rust battle round advancement"
```

---

### Task 5: 对齐技能效果、控制和印记日志

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 写失败测试，控制跳过日志必须没有空 target hit**

Add this test:

```rust
#[test]
fn controlled_unit_skip_log_has_empty_targets() {
    let mut state =
        build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
    state.teams.defender.units[0].buffs.push(serde_json::json!({
        "id": "control-stun",
        "buffDefId": "control-stun",
        "name": "眩晕",
        "type": "debuff",
        "category": "control",
        "sourceUnitId": "player-1",
        "remainingDuration": 1,
        "stacks": 1,
        "maxStacks": 1,
        "control": "stun",
        "tags": ["stun"],
        "dispellable": true
    }));

    let outcome = apply_minimal_pve_action(
        &mut state,
        1,
        "skill-normal-attack",
        &["monster-1-monster-gray-wolf".to_string()],
    )
    .expect("action should succeed");

    let skip_log = outcome
        .logs
        .iter()
        .find(|log| log["skillId"] == "skip")
        .expect("skip log should exist");
    assert_eq!(skip_log["targets"].as_array().unwrap().len(), 0);
}
```

- [ ] **Step 2: 运行控制日志测试**

Run:

```bash
cd server-rs
cargo test controlled_unit_skip_log_has_empty_targets -- --nocapture
```

Expected: PASS if current `build_runtime_action_log` keeps empty targets as `[]`; FAIL if it emits synthetic hit rows.

- [ ] **Step 3: 写失败测试，buff sourceUnitId 不能是 null**

Add this test:

```rust
#[test]
fn runtime_buff_effect_records_source_unit_id() {
    let mut state =
        build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
    state.teams.attacker.units[0].skills.push(serde_json::json!({
        "id": "skill-self-buff-source",
        "name": "凝神",
        "description": "提升武攻",
        "type": "active",
        "targetType": "self",
        "damageType": "magic",
        "cooldown": 0,
        "cost": {"lingqi": 0, "qixue": 0},
        "effects": [
            {
                "type": "buff",
                "buffKind": "attr",
                "attrKey": "wugong",
                "value": 5,
                "applyType": "flat",
                "duration": 1
            }
        ]
    }));

    apply_minimal_pve_action(&mut state, 1, "skill-self-buff-source", &[])
        .expect("buff skill should succeed");

    let buff = state.teams.attacker.units[0]
        .buffs
        .iter()
        .find(|buff| buff["buffDefId"] == "buff-wugong")
        .expect("buff should exist");
    assert_eq!(buff["sourceUnitId"], "player-1");
}
```

- [ ] **Step 4: 运行 buff source 测试确认失败**

Run:

```bash
cd server-rs
cargo test runtime_buff_effect_records_source_unit_id -- --nocapture
```

Expected: FAIL because `apply_runtime_buff_effect` currently writes `sourceUnitId: null`.

- [ ] **Step 5: 修改 `apply_runtime_buff_effect` 签名并传入 actor**

Change the function signature:

```rust
fn apply_runtime_buff_effect(
    unit: &mut BattleUnitDto,
    source_unit_id: &str,
    effect_type: &str,
    effect: &serde_json::Value,
) -> Option<String> {
```

Inside the JSON object, replace:

```rust
"sourceUnitId": serde_json::Value::Null,
```

with:

```rust
"sourceUnitId": source_unit_id,
```

Update the call site in `execute_runtime_skill_action`:

```rust
if let Some(buff_key) = apply_runtime_buff_effect(target, actor_id, effect_type, effect) {
```

- [ ] **Step 6: 运行技能效果测试组**

Run:

```bash
cd server-rs
cargo test minimal_pve_action_supports_single_ally_heal_and_buff_targeting -- --nocapture
cargo test minimal_pve_action_control_effect_causes_enemy_turn_skip -- --nocapture
cargo test minimal_pve_action_cleanse_control_removes_stun_from_ally -- --nocapture
cargo test minimal_pve_action_applies_mark_and_bonus_damage_uses_same_source_only -- --nocapture
cargo test runtime_buff_effect_records_source_unit_id -- --nocapture
```

Expected: all PASS.

- [ ] **Step 7: 提交技能效果变更**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "fix: align rust battle skill effects"
```

---

### Task 6: 补齐套装延迟伤害与回合开始套装契约

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 写失败测试，延迟伤害在 round_end 结算**

Add this test:

```rust
#[test]
fn round_end_settles_set_deferred_damage() {
    let mut state =
        build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
    state.teams.defender.units[0].qixue = 100;
    state.teams.defender.units[0].buffs.push(serde_json::json!({
        "id": "set-deferred-1",
        "buffDefId": "set-deferred-damage",
        "name": "延迟伤害",
        "type": "debuff",
        "category": "set_bonus",
        "sourceUnitId": "player-1",
        "remainingDuration": 1,
        "stacks": 1,
        "maxStacks": 1,
        "deferredDamage": {
            "pool": 30,
            "settleRate": 1.0,
            "damageType": "physical"
        },
        "tags": ["set_bonus"],
        "dispellable": false
    }));
    state.teams.attacker.units[0].current_attrs.sudu = 0;
    refresh_battle_team_total_speed(&mut state);
    state.first_mover = determine_first_mover(&state).to_string();

    let outcome = apply_minimal_pve_action(
        &mut state,
        1,
        "skill-normal-attack",
        &["monster-1-monster-gray-wolf".to_string()],
    )
    .expect("action should advance round");

    assert!(outcome.logs.iter().any(|log| log["type"] == "dot" && log["damage"] == 30));
    assert!(state.teams.defender.units[0].qixue <= 70);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd server-rs
cargo test round_end_settles_set_deferred_damage -- --nocapture
```

Expected: FAIL because deferred set damage is not yet settled from `process_round_end_and_start_next_round`.

- [ ] **Step 3: 新增 `settle_runtime_set_deferred_damage_at_round_end`**

Add this function near `process_runtime_set_bonus_turn_start_effects`:

```rust
fn settle_runtime_set_deferred_damage_at_round_end(
    state: &mut BattleStateDto,
    unit_id: &str,
    logs: &mut Vec<serde_json::Value>,
) {
    let round = state.round_count;
    let Some(unit) = unit_by_id_mut(state, unit_id) else {
        return;
    };
    if !unit.is_alive {
        return;
    }
    let unit_name = unit.name.clone();
    let mut next_buffs = Vec::new();
    for mut buff in unit.buffs.clone() {
        let Some(deferred) = buff.get("deferredDamage").cloned() else {
            next_buffs.push(buff);
            continue;
        };
        let pool = deferred
            .get("pool")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default()
            .max(0);
        let settle_rate = deferred
            .get("settleRate")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);
        let damage_type = deferred
            .get("damageType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("physical");
        let remaining_duration = buff
            .get("remainingDuration")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(1);
        let settle_damage = if remaining_duration <= 1 {
            pool
        } else {
            ((pool as f64) * settle_rate).floor().max(1.0) as i64
        };
        let (actual_damage, _shield_absorbed) =
            apply_runtime_damage_to_target(unit, settle_damage, damage_type);
        if actual_damage > 0 {
            logs.push(build_dot_log(
                round,
                unit_id,
                unit_name.as_str(),
                buff.get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("延迟伤害"),
                actual_damage,
            ));
        }
        let next_pool = (pool - settle_damage).max(0);
        let next_duration = remaining_duration - 1;
        if next_pool > 0 && next_duration > 0 && unit.is_alive {
            if let Some(object) = buff.as_object_mut() {
                object.insert("remainingDuration".to_string(), serde_json::json!(next_duration));
                object.insert(
                    "deferredDamage".to_string(),
                    serde_json::json!({
                        "pool": next_pool,
                        "settleRate": settle_rate,
                        "damageType": damage_type,
                    }),
                );
            }
            next_buffs.push(buff);
        }
    }
    unit.buffs = next_buffs;
    if !unit.is_alive {
        logs.push(build_minimal_death_log(round, unit_id, unit_name.as_str(), None, None));
    }
}
```

- [ ] **Step 4: 在回合结束调用延迟伤害结算**

In `process_round_end_and_start_next_round`, inside the loop over `unit_ids`, call deferred damage after `process_round_end_buffs`:

```rust
process_round_end_buffs(state, unit_id.as_str(), logs);
settle_runtime_set_deferred_damage_at_round_end(state, unit_id.as_str(), logs);
```

- [ ] **Step 5: 运行套装测试**

Run:

```bash
cd server-rs
cargo test round_end_settles_set_deferred_damage -- --nocapture
cargo test battle_start_applies_equip_trigger_set_bonus_buff -- --nocapture
cargo test round_start_applies_on_turn_start_set_bonus_heal -- --nocapture
```

Expected: all PASS.

- [ ] **Step 6: 提交套装结算变更**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "feat: settle rust battle set deferred damage"
```

---

### Task 7: 补齐怪物阶段触发与召唤

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 扩展怪物 seed 结构**

In `MonsterAiProfileSeed`, replace the struct with:

```rust
#[derive(Debug, Deserialize, Clone)]
struct MonsterAiProfileSeed {
    skills: Option<Vec<String>>,
    #[serde(rename = "phaseTriggers")]
    phase_triggers: Option<Vec<serde_json::Value>>,
}
```

When building monster units in `build_minimal_pve_battle_state`, set `aiProfile`-compatible data into `source_id` is not acceptable because frontend expects `sourceId`. Instead add phase trigger data to each monster unit as a runtime buff-free field by storing it in `source_id` only if `source_id` already remains the monster definition id. Use this exact optional field addition on `BattleUnitDto`:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub triggered_phase_ids: Vec<String>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub ai_profile: Option<serde_json::Value>,
```

Initialize both fields for every `BattleUnitDto` literal:

```rust
triggered_phase_ids: Vec::new(),
ai_profile: None,
```

For monster units, initialize:

```rust
triggered_phase_ids: Vec::new(),
ai_profile: seed.ai_profile.as_ref().map(|profile| {
    serde_json::json!({
        "skills": profile.skills.clone().unwrap_or_default(),
        "phaseTriggers": profile.phase_triggers.clone().unwrap_or_default(),
    })
}),
```

- [ ] **Step 2: 写失败测试，低血量怪物行动前触发 enrage**

Add this test:

```rust
#[test]
fn monster_phase_trigger_enrage_applies_buff_before_action() {
    let mut state =
        build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
    state.teams.defender.units[0].qixue = 10;
    state.teams.defender.units[0].ai_profile = Some(serde_json::json!({
        "phaseTriggers": [{
            "id": "low-hp-enrage",
            "hpPercent": 0.5,
            "action": "enrage",
            "effects": [{
                "type": "buff",
                "buffKind": "attr",
                "attrKey": "wugong",
                "value": 5,
                "applyType": "flat",
                "duration": 2
            }]
        }]
    }));

    let outcome = apply_minimal_pve_action(
        &mut state,
        1,
        "skill-normal-attack",
        &["monster-1-monster-gray-wolf".to_string()],
    )
    .expect("action should let monster act");

    assert!(outcome.logs.iter().any(|log| log["skillId"] == "proc-phase-enrage-low-hp-enrage"));
    assert!(state.teams.defender.units[0]
        .triggered_phase_ids
        .iter()
        .any(|id| id == "low-hp-enrage"));
}
```

- [ ] **Step 3: 实现 `process_runtime_phase_triggers_before_action`**

Add a function before `execute_runtime_auto_turn`:

```rust
fn process_runtime_phase_triggers_before_action(
    state: &mut BattleStateDto,
    actor_id: &str,
    logs: &mut Vec<serde_json::Value>,
) -> Result<(), String> {
    let actor_snapshot = unit_by_id(state, actor_id)
        .cloned()
        .ok_or_else(|| "当前不可行动".to_string())?;
    if actor_snapshot.r#type != "monster" && actor_snapshot.r#type != "summon" {
        return Ok(());
    }
    let phase_triggers = actor_snapshot
        .ai_profile
        .as_ref()
        .and_then(|profile| profile.get("phaseTriggers"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if phase_triggers.is_empty() {
        return Ok(());
    }
    let max_qixue = actor_snapshot.current_attrs.max_qixue.max(1) as f64;
    let hp_percent = (actor_snapshot.qixue.max(0) as f64) / max_qixue;

    for trigger in phase_triggers {
        let trigger_id = trigger
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if trigger_id.is_empty() {
            continue;
        }
        let threshold = trigger
            .get("hpPercent")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let already_triggered = unit_by_id(state, actor_id)
            .map(|unit| unit.triggered_phase_ids.iter().any(|id| id == &trigger_id))
            .unwrap_or(false);
        if already_triggered || hp_percent > threshold {
            continue;
        }

        let action = trigger
            .get("action")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if action == "enrage" {
            let effects = trigger
                .get("effects")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut buffs_applied = Vec::new();
            for effect in effects {
                let effect_type = effect
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("buff");
                let Some(unit) = unit_by_id_mut(state, actor_id) else {
                    return Err("当前不可行动".to_string());
                };
                if let Some(buff_key) = apply_runtime_buff_effect(unit, actor_id, effect_type, &effect) {
                    buffs_applied.push(buff_key);
                }
            }
            if let Some(unit) = unit_by_id_mut(state, actor_id) {
                unit.triggered_phase_ids.push(trigger_id.clone());
            }
            let actor_name = unit_by_id(state, actor_id)
                .map(|unit| unit.name.clone())
                .unwrap_or_else(|| actor_snapshot.name.clone());
            logs.push(build_runtime_action_log(
                state.round_count.max(1),
                actor_id,
                actor_name.as_str(),
                format!("proc-phase-enrage-{trigger_id}").as_str(),
                "阶段触发·狂暴",
                &[RuntimeResolvedTargetLog {
                    target_id: actor_id.to_string(),
                    target_name: actor_name,
                    damage: 0,
                    heal: 0,
                    shield: 0,
                    buffs_applied,
                    is_miss: false,
                    is_crit: false,
                    is_parry: false,
                    is_element_bonus: false,
                    shield_absorbed: 0,
                    momentum_gained: Vec::new(),
                    momentum_consumed: Vec::new(),
                }],
            ));
        }
    }
    Ok(())
}
```

- [ ] **Step 4: 调用阶段触发**

At the start of `execute_runtime_auto_turn`, after loading `actor` and before control checks, call:

```rust
process_runtime_phase_triggers_before_action(state, actor_id, logs)?;
if state.phase == "finished" {
    return Ok(());
}
```

- [ ] **Step 5: 运行阶段触发测试**

Run:

```bash
cd server-rs
cargo test monster_phase_trigger_enrage_applies_buff_before_action -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: 提交阶段触发基础实现**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "feat: add rust monster phase enrage trigger"
```

---

### Task 8: 补齐召唤阶段触发

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`

- [ ] **Step 1: 写失败测试，召唤单位当回合不能行动**

Add this test:

```rust
#[test]
fn monster_phase_trigger_summon_adds_next_round_unit() {
    let mut state =
        build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
    state.teams.defender.units[0].qixue = 10;
    state.teams.defender.units[0].ai_profile = Some(serde_json::json!({
        "phaseTriggers": [{
            "id": "call-wolf",
            "hpPercent": 0.5,
            "action": "summon",
            "summonCount": 1,
            "summonTemplate": {
                "id": "wolf-cub",
                "name": "幼狼",
                "baseAttrs": {
                    "max_qixue": 30,
                    "max_lingqi": 0,
                    "wugong": 6,
                    "fagong": 0,
                    "wufang": 0,
                    "fafang": 0,
                    "sudu": 1
                },
                "skills": [{
                    "id": "skill-normal-attack",
                    "name": "普通攻击",
                    "targetType": "single_enemy",
                    "damageType": "physical",
                    "cooldown": 0,
                    "cost": {"lingqi": 0, "qixue": 0},
                    "effects": []
                }]
            }
        }]
    }));

    let outcome = apply_minimal_pve_action(
        &mut state,
        1,
        "skill-normal-attack",
        &["monster-1-monster-gray-wolf".to_string()],
    )
    .expect("action should let monster summon");

    assert!(outcome.logs.iter().any(|log| log["skillId"] == "proc-phase-summon-call-wolf"));
    let summoned = state.teams.defender.units.iter().find(|unit| unit.id.contains("summon-wolf-cub"));
    assert!(summoned.is_some());
    assert_eq!(summoned.unwrap().can_act, false);
}
```

- [ ] **Step 2: 运行召唤测试确认失败**

Run:

```bash
cd server-rs
cargo test monster_phase_trigger_summon_adds_next_round_unit -- --nocapture
```

Expected: FAIL because summon action is not implemented.

- [ ] **Step 3: 新增 `battle_attrs_from_json`**

Add this helper near `build_monster_battle_attrs`:

```rust
fn battle_attrs_from_json(value: &serde_json::Value) -> BattleUnitCurrentAttrsDto {
    let read_i64 = |key: &str, fallback: i64| -> i64 {
        value
            .get(key)
            .or_else(|| value.get(key.replace("_", "").as_str()))
            .and_then(|raw| raw.as_i64().or_else(|| raw.as_f64().map(|v| v.round() as i64)))
            .unwrap_or(fallback)
    };
    BattleUnitCurrentAttrsDto {
        max_qixue: read_i64("max_qixue", read_i64("qixue", 1)).max(1),
        max_lingqi: read_i64("max_lingqi", read_i64("lingqi", 0)).max(0),
        wugong: read_i64("wugong", 0).max(0),
        fagong: read_i64("fagong", 0).max(0),
        wufang: read_i64("wufang", 0).max(0),
        fafang: read_i64("fafang", 0).max(0),
        sudu: read_i64("sudu", 1).max(1),
        mingzhong: read_i64("mingzhong", 100),
        shanbi: read_i64("shanbi", 0),
        zhaojia: read_i64("zhaojia", 0),
        baoji: read_i64("baoji", 0),
        baoshang: read_i64("baoshang", 0),
        jianbaoshang: read_i64("jianbaoshang", 0),
        jianfantan: read_i64("jianfantan", 0),
        kangbao: read_i64("kangbao", 0),
        zengshang: read_i64("zengshang", 0),
        zhiliao: read_i64("zhiliao", 0),
        jianliao: read_i64("jianliao", 0),
        xixue: read_i64("xixue", 0),
        lengque: read_i64("lengque", 0),
        kongzhi_kangxing: read_i64("kongzhi_kangxing", 0),
        jin_kangxing: read_i64("jin_kangxing", 0),
        mu_kangxing: read_i64("mu_kangxing", 0),
        shui_kangxing: read_i64("shui_kangxing", 0),
        huo_kangxing: read_i64("huo_kangxing", 0),
        tu_kangxing: read_i64("tu_kangxing", 0),
        qixue_huifu: read_i64("qixue_huifu", 0),
        lingqi_huifu: read_i64("lingqi_huifu", 0),
        realm: value.get("realm").and_then(serde_json::Value::as_str).map(str::to_string),
        element: value
            .get("element")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .or_else(|| Some("none".to_string())),
    }
}
```

- [ ] **Step 4: 在阶段触发函数中实现 summon 分支**

Inside `process_runtime_phase_triggers_before_action`, add an `else if action == "summon"` branch:

```rust
} else if action == "summon" {
    let template = trigger
        .get("summonTemplate")
        .cloned()
        .ok_or_else(|| "召唤模板缺失".to_string())?;
    let template_id = template
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("summon")
        .trim()
        .to_string();
    let template_name = template
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(template_id.as_str())
        .to_string();
    let summon_count = trigger
        .get("summonCount")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
        .max(1);
    let attrs = battle_attrs_from_json(
        template
            .get("baseAttrs")
            .or_else(|| template.get("base_attrs"))
            .unwrap_or(&serde_json::Value::Null),
    );
    let mut skills = template
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !skills.iter().any(|skill| {
        skill.get("id").and_then(serde_json::Value::as_str) == Some("skill-normal-attack")
    }) {
        skills.insert(0, build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0));
    }
    let team_key = if state.teams.attacker.units.iter().any(|unit| unit.id == actor_id) {
        "attacker"
    } else {
        "defender"
    };
    let mut summoned_logs = Vec::new();
    for index in 0..summon_count {
        let summon_id = format!(
            "summon-{}-{}-{}",
            template_id,
            state.round_count.max(1),
            index + 1
        );
        let summon = BattleUnitDto {
            id: summon_id.clone(),
            name: template_name.clone(),
            r#type: "summon".to_string(),
            source_id: serde_json::json!(template_id),
            base_attrs: attrs.clone(),
            formation_order: None,
            owner_unit_id: Some(actor_id.to_string()),
            month_card_active: None,
            avatar: None,
            qixue: attrs.max_qixue.max(1),
            lingqi: attrs.max_lingqi.max(0),
            current_attrs: attrs.clone(),
            shields: Vec::new(),
            is_alive: true,
            can_act: false,
            buffs: Vec::new(),
            marks: Vec::new(),
            momentum: None,
            set_bonus_effects: Vec::new(),
            skills: skills.clone(),
            skill_cooldowns: BTreeMap::new(),
            skill_cooldown_discount_bank: BTreeMap::new(),
            partner_skill_policy: None,
            control_diminishing: BTreeMap::new(),
            stats: empty_battle_stats(),
            reward_exp: None,
            reward_silver: None,
            triggered_phase_ids: Vec::new(),
            ai_profile: template.get("aiProfile").cloned(),
        };
        team_units_mut(state, team_key).push(summon);
        summoned_logs.push(RuntimeResolvedTargetLog {
            target_id: summon_id,
            target_name: template_name.clone(),
            damage: 0,
            heal: 0,
            shield: 0,
            buffs_applied: Vec::new(),
            is_miss: false,
            is_crit: false,
            is_parry: false,
            is_element_bonus: false,
            shield_absorbed: 0,
            momentum_gained: Vec::new(),
            momentum_consumed: Vec::new(),
        });
    }
    if let Some(unit) = unit_by_id_mut(state, actor_id) {
        unit.triggered_phase_ids.push(trigger_id.clone());
    }
    refresh_battle_team_total_speed(state);
    logs.push(build_runtime_action_log(
        state.round_count.max(1),
        actor_id,
        actor_snapshot.name.as_str(),
        format!("proc-phase-summon-{trigger_id}").as_str(),
        "阶段触发·召唤",
        &summoned_logs,
    ));
```

- [ ] **Step 5: 运行召唤测试**

Run:

```bash
cd server-rs
cargo test monster_phase_trigger_summon_adds_next_round_unit -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: 运行阶段触发组**

Run:

```bash
cd server-rs
cargo test monster_phase_trigger_enrage_applies_buff_before_action -- --nocapture
cargo test monster_phase_trigger_summon_adds_next_round_unit -- --nocapture
```

Expected: both PASS.

- [ ] **Step 7: 提交召唤实现**

Run:

```bash
git add server-rs/src/battle_runtime.rs
git commit -m "feat: add rust battle summon phase trigger"
```

---

### Task 9: HTTP 与实时 payload 契约回归

**Files:**
- Modify: `server-rs/src/http/battle.rs`
- Modify: `server-rs/src/realtime/battle.rs`
- Modify: `server-rs/src/jobs/online_battle_settlement.rs`

- [ ] **Step 1: 检查 action route 是否保留 runtime logs**

Run:

```bash
rg -n "apply_minimal_pve_action|apply_minimal_pvp_action|logs|build_battle_finished_payload|enqueue_generic_pve_settlement_task|enqueue_arena_battle_settlement_task|enqueue_tower_win_settlement_task" server-rs/src/http/battle.rs server-rs/src/realtime/battle.rs server-rs/src/jobs/online_battle_settlement.rs
```

Expected: command prints all call sites that transform battle state, logs, realtime payloads, and settlement task payloads.

- [ ] **Step 2: 写 route 回归断言**

In the existing route test module that already contains battle route tests, add assertions to the PVE action victory test so it checks these response fields:

```rust
assert_eq!(body["success"], true);
assert_eq!(body["data"]["state"]["phase"], "finished");
assert_eq!(body["data"]["state"]["result"], "attacker_win");
assert_eq!(body["data"]["logs"][0]["type"], "action");
assert!(body["data"]["logs"][0]["targets"][0]["hits"][0].get("damage").is_some());
assert!(body["data"]["logs"][0]["targets"][0]["hits"][0].get("isMiss").is_some());
assert!(body["data"]["debugRealtime"].get("battleId").is_some());
```

Use the local response variable name already used in that test. Do not create a second HTTP client helper.

- [ ] **Step 3: 运行 battle route 测试**

Run:

```bash
cd server-rs
cargo test battle_route_generic_pve_finish_sets_auto_advance_contract -- --nocapture
```

Expected: PASS.

- [ ] **Step 4: 运行 settlement 任务测试**

Run:

```bash
cd server-rs
cargo test online_battle_settlement -- --nocapture
```

Expected: PASS for online settlement tests or only unrelated environment failures that mention missing database connectivity.

- [ ] **Step 5: 提交 HTTP 契约断言**

Run:

```bash
git add server-rs/src/http/battle.rs server-rs/src/realtime/battle.rs server-rs/src/jobs/online_battle_settlement.rs
git commit -m "test: lock rust battle http parity contract"
```

---

### Task 10: 全量战斗运行时验收

**Files:**
- Modify: `server-rs/src/battle_runtime.rs`
- Modify: `server-rs/src/http/battle.rs`
- Modify: `server-rs/src/realtime/battle.rs`
- Modify: `server-rs/src/jobs/online_battle_settlement.rs`

- [ ] **Step 1: 运行 battle runtime 测试**

Run:

```bash
cd server-rs
cargo test battle_runtime -- --nocapture
```

Expected: PASS.

- [ ] **Step 2: 运行 route 与 settlement 测试**

Run:

```bash
cd server-rs
cargo test battle_route -- --nocapture
cargo test online_battle_settlement -- --nocapture
```

Expected: PASS, or database-dependent tests clearly fail before hitting battle assertions because local infrastructure is unavailable.

- [ ] **Step 3: 运行格式检查**

Run:

```bash
cd server-rs
cargo fmt --check
```

Expected: PASS.

- [ ] **Step 4: 如格式检查失败，格式化并复查**

Run:

```bash
cd server-rs
cargo fmt
cargo fmt --check
```

Expected: PASS.

- [ ] **Step 5: 检查禁止 fallback 文案**

Run:

```bash
rg -n "fallback|Fallback|FALLBACK|向后兼容|兼容旧|first_alive_enemy|falls_back" server-rs/src/battle_runtime.rs server-rs/src/http/battle.rs
```

Expected: no matches that introduce backward-compatible fallback behavior. Matches in removed test names must not remain.

- [ ] **Step 6: 最终提交**

Run:

```bash
git add server-rs/src/battle_runtime.rs server-rs/src/http/battle.rs server-rs/src/realtime/battle.rs server-rs/src/jobs/online_battle_settlement.rs
git commit -m "feat: align rust battle engine with node runtime"
```

- [ ] **Step 7: 汇总结果**

Record the exact commands run and whether they passed:

```text
cargo test battle_runtime -- --nocapture
cargo test battle_route -- --nocapture
cargo test online_battle_settlement -- --nocapture
cargo fmt --check
```

If a command fails for local infrastructure, include the first failing error line and the reason it is unrelated to the battle runtime implementation.
