/**
 * PVP 战斗发起与竞技场结算
 *
 * 作用：
 * - startPVPBattle: 创建 PVP 战斗（普通 / 竞技场）
 * - settleArenaBattleIfNeeded: 竞技场评分结算
 *
 * 复用点：路由层 / arenaRoutes 调用 startPVPBattle；settlement.ts / action.ts 调用 settleArenaBattleIfNeeded。
 *
 * 边界条件：
 * 1) 竞技场战斗时 defender 为 NPC 类型，不推送给对手
 * 2) 竞技场评分初始化使用 INSERT ... ON CONFLICT DO NOTHING
 */

import {
  createPVPBattle,
  type CharacterData,
} from "../../battle/battleFactory.js";
import { BattleEngine } from "../../battle/battleEngine.js";
import { query } from "../../config/database.js";
import {
  getCharacterComputedByCharacterId,
  getCharacterComputedByUserId,
} from "../characterComputedService.js";
import {
  calculateArenaRatingDelta,
  DEFAULT_ARENA_RATING,
  type ArenaBattleOutcome,
} from "../shared/arenaRatingDelta.js";
import type { BattleResult } from "./battleTypes.js";
import {
  BATTLE_START_COOLDOWN_MS,
  buildCharacterInBattleResult,
  registerStartedBattle,
  validateBattleStartCooldown,
  buildBattleStartCooldownResult,
} from "./runtime/state.js";
import { attachSetBonusEffectsToCharacterData } from "./shared/effects.js";
import { getCharacterBattleSkillData } from "./shared/skills.js";
import {
  rejectIfIdling,
  withBattleStartResources,
  syncBattleStartResourcesForUsers,
} from "./shared/preparation.js";

export async function startPVPBattle(
  userId: number,
  opponentCharacterId: number,
  battleId?: string,
): Promise<BattleResult> {
  try {
    const challengerBase = await getCharacterComputedByUserId(userId);
    if (!challengerBase) {
      return { success: false, message: "角色不存在" };
    }

    const challengerCharacterId = Number(challengerBase.id);
    if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0) {
      return { success: false, message: "角色数据异常" };
    }

    const idleReject = await rejectIfIdling(challengerCharacterId);
    if (idleReject) return idleReject;

    const oppId = Number(opponentCharacterId);
    if (!Number.isFinite(oppId) || oppId <= 0) {
      return { success: false, message: "对手参数错误" };
    }

    const opponentBase = await getCharacterComputedByCharacterId(oppId);
    if (!opponentBase) {
      return { success: false, message: "对手不存在" };
    }

    const opponentUserId = Number(opponentBase.user_id);
    if (!Number.isFinite(opponentUserId) || opponentUserId <= 0) {
      return { success: false, message: "对手数据异常" };
    }

    const requestedBattleId =
      typeof battleId === "string" ? battleId.trim() : "";
    const isArenaBattle = requestedBattleId.startsWith("arena-battle-");

    const challengerInBattleResult = buildCharacterInBattleResult(
      challengerCharacterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (challengerInBattleResult) return challengerInBattleResult;
    if (!isArenaBattle) {
      const opponentInBattleResult = buildCharacterInBattleResult(
        oppId,
        "opponent_in_battle",
        "对手正在战斗中",
      );
      if (opponentInBattleResult) return opponentInBattleResult;
    }
    const challengerCooldown = validateBattleStartCooldown(
      challengerCharacterId,
    );
    if (challengerCooldown) {
      return buildBattleStartCooldownResult(
        challengerCooldown,
        "battle_start_cooldown",
      );
    }
    if (!isArenaBattle) {
      const opponentCooldown = validateBattleStartCooldown(oppId);
      if (opponentCooldown) {
        return buildBattleStartCooldownResult(
          opponentCooldown,
          "opponent_battle_start_cooldown",
          "对手刚结束战斗，暂时无法发起挑战",
        );
      }
    }

    const challenger = await attachSetBonusEffectsToCharacterData(
      challengerCharacterId,
      challengerBase as CharacterData,
    );
    const opponent = await attachSetBonusEffectsToCharacterData(
      oppId,
      opponentBase as CharacterData,
    );
    const recoveredChallenger = withBattleStartResources(challenger);
    const recoveredOpponent = withBattleStartResources(opponent);

    const challengerSkills = await getCharacterBattleSkillData(
      challengerCharacterId,
    );
    const opponentSkills = await getCharacterBattleSkillData(oppId);

    await syncBattleStartResourcesForUsers(
      isArenaBattle ? [userId] : [userId, opponentUserId],
      { context: "同步战前资源（PVP战斗）" },
    );

    const finalBattleId = requestedBattleId
      ? requestedBattleId
      : `pvp-battle-${userId}-${Date.now()}`;
    const battleState = createPVPBattle(
      finalBattleId,
      recoveredChallenger,
      challengerSkills,
      recoveredOpponent,
      opponentSkills,
      isArenaBattle ? { defenderUnitType: "npc" } : undefined,
    );

    const engine = new BattleEngine(battleState);
    registerStartedBattle(
      finalBattleId,
      engine,
      isArenaBattle ? [userId] : [userId, opponentUserId],
    );

    return {
      success: true,
      message: "战斗开始",
      data: {
        battleId: finalBattleId,
        state: engine.getState(),
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    console.error("发起PVP战斗失败:", error);
    return { success: false, message: "发起PVP战斗失败" };
  }
}

export async function settleArenaBattleIfNeeded(
  battleId: string,
  battleResult: "attacker_win" | "defender_win" | "draw",
): Promise<void> {
  const res = await query(
    `SELECT challenger_character_id, opponent_character_id, status FROM arena_battle WHERE battle_id = $1 LIMIT 1`,
    [battleId],
  );
  if (res.rows.length === 0) return;

  const row = res.rows[0] as {
    challenger_character_id?: unknown;
    opponent_character_id?: unknown;
    status?: unknown;
  };
  if (String(row.status ?? "") === "finished") return;

  const challengerCharacterId = Number(row.challenger_character_id);
  const opponentCharacterId = Number(row.opponent_character_id);
  if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0)
    return;
  if (!Number.isFinite(opponentCharacterId) || opponentCharacterId <= 0) return;

  await query(
    `INSERT INTO arena_rating(character_id, rating) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING`,
    [challengerCharacterId, DEFAULT_ARENA_RATING],
  );
  await query(
    `INSERT INTO arena_rating(character_id, rating) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING`,
    [opponentCharacterId, DEFAULT_ARENA_RATING],
  );

  const challengerRatingRes = await query(
    `SELECT rating FROM arena_rating WHERE character_id = $1`,
    [challengerCharacterId],
  );
  const opponentRatingRes = await query(
    `SELECT rating FROM arena_rating WHERE character_id = $1`,
    [opponentCharacterId],
  );
  const challengerBefore =
    Number(challengerRatingRes.rows?.[0]?.rating ?? DEFAULT_ARENA_RATING) ||
    DEFAULT_ARENA_RATING;
  const opponentBefore =
    Number(opponentRatingRes.rows?.[0]?.rating ?? DEFAULT_ARENA_RATING) ||
    DEFAULT_ARENA_RATING;

  const challengerOutcome: ArenaBattleOutcome =
    battleResult === "attacker_win"
      ? "win"
      : battleResult === "defender_win"
        ? "lose"
        : "draw";
  const challengerDelta = calculateArenaRatingDelta({
    selfRating: challengerBefore,
    opponentRating: opponentBefore,
    outcome: challengerOutcome,
  });
  const challengerAfter = Math.max(0, challengerBefore + challengerDelta);

  const opponentOutcome: ArenaBattleOutcome =
    challengerOutcome === "win"
      ? "lose"
      : challengerOutcome === "lose"
        ? "win"
        : "draw";
  const opponentDelta = calculateArenaRatingDelta({
    selfRating: opponentBefore,
    opponentRating: challengerBefore,
    outcome: opponentOutcome,
  });
  const opponentAfter = Math.max(0, opponentBefore + opponentDelta);

  await query(
    `
      UPDATE arena_rating
      SET
        rating = $2,
        win_count = win_count + $3,
        lose_count = lose_count + $4,
        last_battle_at = NOW(),
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [
      challengerCharacterId,
      challengerAfter,
      challengerOutcome === "win" ? 1 : 0,
      challengerOutcome === "lose" ? 1 : 0,
    ],
  );
  await query(
    `
      UPDATE arena_rating
      SET
        rating = $2,
        win_count = win_count + $3,
        lose_count = lose_count + $4,
        last_battle_at = NOW(),
        updated_at = NOW()
      WHERE character_id = $1
    `,
    [
      opponentCharacterId,
      opponentAfter,
      opponentOutcome === "win" ? 1 : 0,
      opponentOutcome === "lose" ? 1 : 0,
    ],
  );

  await query(
    `
      UPDATE arena_battle
      SET
        status = 'finished',
        result = $2,
        delta_score = $3,
        score_before = $4,
        score_after = $5,
        finished_at = NOW()
      WHERE battle_id = $1
        AND status <> 'finished'
    `,
    [
      battleId,
      challengerOutcome,
      challengerDelta,
      challengerBefore,
      challengerAfter,
    ],
  );
}
