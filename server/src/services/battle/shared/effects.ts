/**
 * 装备套装效果 / 词缀效果查询与合并
 *
 * 作用：
 * - 查询角色已装备物品的套装效果（BattleSetBonusEffect）
 * - 查询角色已装备物品的词缀效果
 * - 合并两类效果到 CharacterData
 *
 * 不做什么：不修改角色数据、不参与战斗计算。
 *
 * 输入/输出：
 * - getCharacterBattleSetBonusEffects: characterId -> BattleSetBonusEffect[]
 * - getCharacterBattleAffixEffects: characterId -> BattleSetBonusEffect[]
 * - attachSetBonusEffectsToCharacterData: (characterId, data) -> data（附加 setBonusEffects）
 *
 * 复用点：
 * - pve.ts / pvp.ts / preparation.ts / snapshot.ts 中调用 attachSetBonusEffectsToCharacterData
 *
 * 边界条件：
 * 1) 查询失败时回退为基础角色数据（不中断战斗流程）
 * 2) 套装效果按 priority -> pieceCount 升序排列
 */

import { query } from "../../../config/database.js";
import type { BattleSetBonusEffect } from "../../../battle/types.js";
import type { CharacterData } from "../../../battle/battleFactory.js";
import {
  getItemDefinitionsByIds,
  getItemSetDefinitions,
} from "../../staticConfigLoader.js";
import {
  extractBattleAffixEffectsFromEquippedItems,
  type BattleAffixEffectSource,
} from "../../battleAffixEffectService.js";
import { toNumber, toRecord, toText } from "./helpers.js";

// ------ 常量 ------

const BATTLE_SET_BONUS_TRIGGER_SET = new Set([
  "on_turn_start",
  "on_skill",
  "on_hit",
  "on_crit",
  "on_be_hit",
  "on_heal",
]);

const BATTLE_SET_BONUS_EFFECT_TYPE_SET = new Set([
  "buff",
  "debuff",
  "damage",
  "heal",
  "resource",
  "shield",
]);

// ------ 套装效果 ------

export async function getCharacterBattleSetBonusEffects(
  characterId: number,
): Promise<BattleSetBonusEffect[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const result = await query(
    `
      SELECT item_def_id
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'equipped'
    `,
    [characterId],
  );

  const itemDefIds = Array.from(
    new Set(
      (result.rows as Array<Record<string, unknown>>)
        .map((row) => toText(row.item_def_id))
        .filter((itemDefId): itemDefId is string => !!itemDefId),
    ),
  );
  const defs = getItemDefinitionsByIds(itemDefIds);
  const setCountMap = new Map<string, number>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const itemDefId = toText(row.item_def_id);
    if (!itemDefId) continue;
    const setId = toText(defs.get(itemDefId)?.set_id);
    if (!setId) continue;
    setCountMap.set(setId, (setCountMap.get(setId) ?? 0) + 1);
  }

  const staticSetMap = new Map(
    getItemSetDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );

  const out: BattleSetBonusEffect[] = [];
  for (const [setId, equippedCount] of setCountMap.entries()) {
    const setDef = staticSetMap.get(setId);
    if (!setDef) continue;
    const setName = toText(setDef.name) || setId;
    const bonuses = Array.isArray(setDef.bonuses) ? setDef.bonuses : [];
    const sortedBonuses = bonuses
      .map((bonus) => ({
        pieceCount: Math.max(1, Math.floor(Number(bonus.piece_count) || 1)),
        priority: Math.max(0, Math.floor(Number(bonus.priority) || 0)),
        effectDefs: Array.isArray(bonus.effect_defs) ? bonus.effect_defs : [],
      }))
      .sort(
        (left, right) =>
          left.priority - right.priority || left.pieceCount - right.pieceCount,
      );

    for (const bonus of sortedBonuses) {
      if (equippedCount < bonus.pieceCount) continue;
      for (const raw of bonus.effectDefs) {
        const effectRow = toRecord(raw);
        const trigger = toText(effectRow.trigger);
        const effectType = toText(effectRow.effect_type);
        if (!BATTLE_SET_BONUS_TRIGGER_SET.has(trigger)) continue;
        if (!BATTLE_SET_BONUS_EFFECT_TYPE_SET.has(effectType)) continue;

        const targetRaw = toText(effectRow.target);
        const target = targetRaw === "enemy" ? "enemy" : "self";
        const params = toRecord(effectRow.params);
        const duration = toNumber(effectRow.duration_round);
        const element = toText(effectRow.element);

        out.push({
          setId,
          setName,
          pieceCount: bonus.pieceCount,
          trigger: trigger as BattleSetBonusEffect["trigger"],
          target,
          effectType: effectType as BattleSetBonusEffect["effectType"],
          durationRound:
            duration === null ? undefined : Math.max(1, Math.floor(duration)),
          element: element || undefined,
          params,
        });
      }
    }
  }

  return out;
}

// ------ 词缀效果 ------

export async function getCharacterBattleAffixEffects(
  characterId: number,
): Promise<BattleSetBonusEffect[]> {
  if (!Number.isFinite(characterId) || characterId <= 0) return [];

  const result = await query(
    `
      SELECT id AS item_instance_id, item_def_id, affixes
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = 'equipped'
      ORDER BY id ASC
    `,
    [characterId],
  );

  const itemDefIds = Array.from(
    new Set(
      (result.rows as Array<Record<string, unknown>>)
        .map((row) => toText(row.item_def_id))
        .filter((itemDefId): itemDefId is string => !!itemDefId),
    ),
  );
  const defs = getItemDefinitionsByIds(itemDefIds);
  const sources: BattleAffixEffectSource[] = [];
  for (const row of result.rows) {
    const record = row as Record<string, unknown>;
    const itemInstanceId = Math.floor(toNumber(record.item_instance_id) ?? 0);
    if (itemInstanceId <= 0) continue;
    const itemDefId = toText(record.item_def_id);
    if (!itemDefId) continue;
    const itemDef = defs.get(itemDefId);
    if (!itemDef || itemDef.category !== "equipment") continue;

    sources.push({
      itemInstanceId,
      itemName: toText(itemDef.name),
      affixesRaw: record.affixes,
    });
  }

  return extractBattleAffixEffectsFromEquippedItems(sources);
}

// ------ 合并到角色数据 ------

export async function attachSetBonusEffectsToCharacterData<T extends CharacterData>(
  characterId: number,
  data: T,
): Promise<T> {
  try {
    const [setBonusEffects, affixEffects] = await Promise.all([
      getCharacterBattleSetBonusEffects(characterId),
      getCharacterBattleAffixEffects(characterId),
    ]);
    const mergedEffects = [...setBonusEffects, ...affixEffects];
    if (mergedEffects.length === 0) return data;
    return {
      ...data,
      setBonusEffects: mergedEffects,
    };
  } catch (error) {
    console.warn("[battle] 读取角色战斗效果失败，已回退为基础角色数据:", error);
    return data;
  }
}
