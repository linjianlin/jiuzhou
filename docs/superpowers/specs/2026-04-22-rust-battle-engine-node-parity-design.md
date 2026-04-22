# Rust BattleEngine Node Parity Design

## Goal

Bring the Rust backend battle runtime to field-level parity with the NodeJS BattleEngine so the frontend can consume either backend without branching. Node remains the authority for battle semantics during this work.

The target surface includes battle state JSON, action logs, round logs, death logs, skill errors, response fields, automatic turn advancement, battle completion, and settlement handoff. The implementation must not introduce backward-compatible fallback branches unless a future task explicitly asks for them.

## Scope

The Rust implementation should align with the Node battle stack centered on:

- `server/src/battle/battleEngine.ts`
- `server/src/battle/modules/skill.ts`
- `server/src/battle/modules/buff.ts`
- `server/src/battle/modules/setBonus.ts`
- `server/src/battle/modules/ai.ts`
- `server/src/battle/modules/control.ts`
- `server/src/battle/modules/mark.ts`
- `server/src/battle/utils/cooldown.ts`

The Rust work should stay primarily in `server-rs/src/battle_runtime.rs` because the current branch already has extensive in-progress battle runtime changes there. HTTP routes, realtime payload builders, and settlement jobs should only change when needed to preserve the Node-compatible contract.

## Architecture

The Rust battle runtime keeps a clear boundary between battle simulation and durable settlement.

`server-rs/src/battle_runtime.rs` owns in-memory battle state advancement:

- Battle initialization and passive skill execution.
- Round start and round end processing.
- Action cursor repair and unit turn advancement.
- Player, monster, summon, and partner action execution.
- Skill effect resolution and action log construction.
- Battle end detection and reward summary calculation.

HTTP handlers in `server-rs/src/http/battle.rs` own request validation, battle state persistence, realtime payload emission, and durable settlement task creation.

`server-rs/src/jobs/online_battle_settlement.rs` remains responsible for idempotent database settlement for generic PVE, dungeon clear, tower win, and arena battle tasks. Battle simulation must not directly perform reward writes.

## Battle Flow

Starting a battle should match Node `BattleEngine.startBattle`:

- Validate the battle state.
- Set `roundCount` to `1`.
- Clear `currentUnitId`.
- Set `phase` to `roundStart`.
- Execute `triggerType=passive` skills for alive units.
- Process the first round start.

Round start should:

- Emit `round_start`.
- Set alive units to `canAct=true`.
- Reset per-round set runtime state.
- Decay marks.
- Process DOT and HOT effects.
- Trigger `on_turn_start` set effects.
- Recover `qixue` and `lingqi` from recovery attributes.
- Recompute team speed after all effects.
- Determine first mover by total speed, with attacker winning ties.
- Sort each team by current speed.
- Set `phase=action` and point `currentUnitId` at the first actable unit.

Action advancement should use `currentUnitId` and `canAct` as the source of truth. It must tolerate dead units, removed units, summons, and stale cursors by repairing to the next legal unit, switching teams, or ending the round.

Round end should:

- Set `phase=roundEnd`.
- Process buff duration decay and expiration logs.
- Settle set deferred damage.
- Decay momentum.
- Emit `round_end`.
- End if either team has no alive units.
- End as `draw` when the PVE or PVP round cap is reached.
- Increment `roundCount` and process the next round start otherwise.

## Skill And Effect Parity

Rust skill execution should match Node `executeSkill` semantics and log shape. The required effect families are:

- Damage, including physical and magical damage.
- Healing and shield application.
- Buff and debuff application.
- Control effects such as stun, fear, silence, and disarm.
- Cleanse and dispel.
- Marks, including stack and duration behavior.
- Lifesteal and healing modifiers.
- Attribute modifiers and percent or flat modes.
- Element counter bonus and element resistance.
- Hit, dodge, parry, critical hit, critical damage, anti-critical, and defense reduction formulas.
- Set bonus proc effects and deferred damage.
- Monster phase triggers for enrage and summon.

Unknown snapshot skills should fail with a deterministic error instead of falling back to normal attack. Required target types or effect types that Rust does not understand should also fail or no-op only where Node would no-op.

## AI And Automation

Monster and summon turns should use the same decision model as Node `makeAIDecision`: choose an available skill, resolve targets from the skill target type, execute, then advance.

Partner turns should use `partnerSkillPolicy` in the same way Node uses `makePartnerSkillPolicyDecision`.

Player auto execution should use the configured skill policy when one is supplied. In live online action calls, Rust should stop on the next player-controlled unit and return control to the client.

Controlled units should emit a Node-compatible `skip` action log and advance normally.

Summoned units should be inserted into the summoner's team with `canAct=false`, then become actable at the next round start.

## Field-Level Compatibility

Rust DTOs and JSON logs should preserve Node names and omission behavior.

Battle state should continue using camelCase fields, including:

- `battleId`
- `battleType`
- `cooldownTimingMode`
- `teams`
- `roundCount`
- `currentTeam`
- `currentUnitId`
- `phase`
- `firstMover`
- `result`
- `randomSeed`
- `randomIndex`
- `runtimeSkillCooldowns`

Unit snapshots should keep Node-compatible nested structures for `baseAttrs`, `currentAttrs`, `shields`, `buffs`, `marks`, `momentum`, `setBonusEffects`, `skills`, `skillCooldowns`, `skillCooldownDiscountBank`, `partnerSkillPolicy`, `controlDiminishing`, and `stats`.

Action logs should include:

- `type`
- `round`
- `actorId`
- `actorName`
- `skillId`
- `skillName`
- `targets`

Target logs should include Node-compatible target fields and omit absent optional fields rather than serializing unnecessary `null`s. Hit logs should include the fields used by Node and the frontend, such as damage, heal, shield, miss, crit, parry, element bonus, and shield absorption.

Round, death, DOT, HOT, and buff expiration logs should use Node-compatible names and field shapes.

## Errors

Errors should be deterministic and aligned with Node wording where practical:

- Missing current actor.
- Acting outside the current player turn.
- Unknown skill id in the battle snapshot.
- Skill cooldown remaining.
- Insufficient `lingqi` or `qixue`.
- Invalid target.
- Finished battle.
- Unsupported battle type for the called action.

The implementation must not add compatibility fallback behavior for old or malformed data shapes. If a field is optional in Node, Rust may apply the same default. If the field is required by the Node contract, Rust should return a clear error or let the caller surface a clear server error.

## Settlement Boundary

Battle completion should calculate the battle result and expose reward summary data, but database mutation remains in settlement jobs.

For PVE wins, the HTTP layer should continue enqueueing the existing generic PVE settlement task using the Node-compatible reward participant and reward plan payload shape.

For tower wins, the HTTP layer should continue enqueueing tower settlement tasks.

For arena battles, the HTTP layer should continue enqueueing arena settlement tasks and let the existing idempotent job update authoritative arena tables.

## Tests

Validation should happen in three layers.

Rust battle runtime unit tests should cover:

- Start battle passive skills.
- Round start and round end.
- Speed ordering and attacker tie-break.
- Action cursor repair.
- Cooldown timing.
- Single enemy, ally, self, and multi-target resolution.
- Damage formulas.
- Healing and shields.
- Buff, debuff, cleanse, and dispel.
- Control skip behavior.
- Mark stack and duration behavior.
- Set bonus proc and deferred damage.
- Monster phase enrage and summon.
- Partner policy decisions.
- Victory, defeat, and draw.

Rust HTTP and integration tests should cover:

- PVE start and action routes.
- PVE victory settlement task creation.
- PVP victory arena settlement task creation.
- Tower victory settlement task creation.
- Finished battle realtime payload fields.

Node parity tests should migrate the semantics of key Node battle tests into Rust where practical, especially passive aura, turn recovery, cooldown, buff targeting, marks, set bonus proc, taunt or target forcing, and ally target behavior.

Suggested verification commands:

```bash
cd server-rs
cargo test battle_runtime
cargo test battle_route
cargo test online_battle_settlement
```

If existing unrelated failures appear, record them separately instead of hiding them with fallback code.

## Acceptance Criteria

- Rust battle runtime compiles.
- Key Rust battle runtime tests pass.
- Rust battle state JSON and logs are compatible with Node for the covered scenarios.
- Frontend battle flows do not need backend-specific branches.
- PVE, tower, and arena settlement handoff still use durable idempotent settlement tasks.
- No backward-compatible fallback branches are added without an explicit future request.
