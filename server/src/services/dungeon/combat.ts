/**
 * 秘境战斗（开启/推进/结算）
 *
 * 作用：管理秘境实例的战斗流程，包括开启战斗、推进波次、通关结算。
 * 不做什么：不管理实例的创建/加入/查询。
 *
 * 输入：userId / instanceId。
 * 输出：战斗开启结果 / 推进/结算结果。
 *
 * 复用点：通过 service.ts 的 @Transactional 装饰器在事务中执行。
 *
 * 边界条件：
 * 1) startDungeonInstance 由调用方 @Transactional 保证事务上下文。
 * 2) nextDungeonInstance 的结算部分在通关时执行锁行+奖励发放+记录写入，需在事务中。
 */

import { query } from '../../config/database.js';
import { getBattleState, startDungeonPVEBattle } from '../battle/index.js';
import { runDungeonStartFlow } from './shared/startFlow.js';
import { itemService } from '../itemService.js';
import { sendSystemMail, type MailAttachItem } from '../mailService.js';
import { recordDungeonClearEvent } from '../taskService.js';
import { applyStaminaRecoveryTx } from '../staminaService.js';
import { normalizeAutoDisassembleSetting } from '../autoDisassembleRules.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
  type PendingMailItem,
} from '../autoDisassembleRewardService.js';
import { lockCharacterInventoryMutexes } from '../inventoryMutex.js';
import { resolveQualityRankFromName } from '../shared/itemQuality.js';
import { getDungeonDifficultyById, getItemDefinitionById } from '../staticConfigLoader.js';
import { getDungeonDefById } from './shared/configLoader.js';
import { touchEntryCount, incEntryCount } from './shared/entryCount.js';
import {
  parseParticipants,
  buildParticipantLabel,
  getParticipantNicknameMap,
  getUserAndCharacter,
} from './shared/participants.js';
import {
  DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD,
  buildDungeonRewardEligibleCharacterIds,
  hasDungeonRewardEligibleCharacterIdsField,
  selectDungeonRewardEligibleParticipants,
} from './shared/rewardEligibility.js';
import { loadDungeonBenefitPolicyMap } from './shared/benefitPolicy.js';
import { buildMonsterDefIdsFromWave, getStageAndWave } from './shared/stageData.js';
import { rollDungeonRewardBundle, mergeDungeonRewardBundle } from './shared/rewards.js';
import { asObject, asNumber, asString, countPlayerDeaths } from './shared/typeUtils.js';
import type {
  DungeonInstanceParticipant,
  DungeonInstanceStatus,
  DungeonInstanceRow,
  DungeonRewardBundle,
} from './types.js';

/** 开启秘境战斗（需要事务上下文） */
export const startDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | {
    success: true;
    data: {
      instanceId: string;
      status: DungeonInstanceStatus;
      battleId: string;
      state: unknown;
    };
  }
  | { success: false; message: string }
> => {
  const user = await getUserAndCharacter(userId);
  if (!user.ok) return { success: false, message: user.message };

  const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE`, [instanceId]);
  if (instRes.rows.length === 0) {
    return { success: false, message: '秘境实例不存在' };
  }
  const inst = instRes.rows[0] as DungeonInstanceRow;

    if (inst.status !== 'preparing') {
      return { success: false, message: '秘境已开始或已结束' };
    }
    if (inst.creator_id !== user.characterId) {
      return { success: false, message: '只有创建者可以开始秘境' };
    }

    const dungeonDef = getDungeonDefById(inst.dungeon_id);
    if (!dungeonDef) {
      return { success: false, message: '秘境不存在' };
    }
    const dailyLimit = dungeonDef.daily_limit;
    const weeklyLimit = dungeonDef.weekly_limit;
    const minPlayers = dungeonDef.min_players;
    const maxPlayers = dungeonDef.max_players;
    const staminaCost = dungeonDef.stamina_cost;

    const participants = parseParticipants(inst.participants);
    const participantNicknameMap = await getParticipantNicknameMap(participants);
    if (participants.length < minPlayers) {
      return { success: false, message: `人数不足，需要至少${minPlayers}人` };
    }
    if (participants.length > maxPlayers) {
      return { success: false, message: `人数超限，最多${maxPlayers}人` };
    }

    const participantCharacterIds = [...new Set(
      participants
        .map((participant) => Math.floor(Number(participant.characterId)))
        .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
    )];
    const participantBenefitPolicyMap = await loadDungeonBenefitPolicyMap(participantCharacterIds);
    const staminaConsumingParticipants: DungeonInstanceParticipant[] = [];
    const rewardEligibleParticipantsAtStart: DungeonInstanceParticipant[] = [];
    for (const participant of participants) {
      const benefitPolicy = participantBenefitPolicyMap.get(participant.characterId);
      const participantLabel = buildParticipantLabel(participant, participantNicknameMap);
      if (!benefitPolicy) {
        return { success: false, message: `${participantLabel}秘境设置缺失` };
      }
      if (!benefitPolicy.skipStaminaCost) {
        staminaConsumingParticipants.push(participant);
      }
      if (benefitPolicy.rewardEligible) {
        rewardEligibleParticipantsAtStart.push(participant);
      }
    }
    const rewardEligibleCharacterIds = buildDungeonRewardEligibleCharacterIds(rewardEligibleParticipantsAtStart);

    for (const p of participants) {
      const touch = await touchEntryCount(p.characterId, inst.dungeon_id, dailyLimit, weeklyLimit);
      if (!touch.ok) {
        return { success: false, message: touch.message };
      }
    }

    const participantStaminaMaxMap = new Map<number, number>();
    if (staminaCost > 0) {
      for (const p of staminaConsumingParticipants) {
        const participantLabel = buildParticipantLabel(p, participantNicknameMap);
        const staminaState = await applyStaminaRecoveryTx(p.characterId);
        if (!staminaState) {
          return { success: false, message: `${participantLabel}不存在` };
        }
        const stamina = asNumber(staminaState.stamina, 0);
        const staminaMax = asNumber(staminaState.maxStamina, 0);
        participantStaminaMaxMap.set(p.characterId, staminaMax);
        if (stamina < staminaCost) {
          return { success: false, message: `${participantLabel}体力不足，需要${staminaCost}，当前${stamina}` };
        }
      }
    }

    const stageWave = await getStageAndWave(inst.difficulty_id, 1, 1);
    if (!stageWave.ok) {
      return { success: false, message: stageWave.message };
    }

    const monsterDefIds = buildMonsterDefIdsFromWave(stageWave.wave.monsters, 5);
    if (monsterDefIds.length === 0) {
      return { success: false, message: '该波次未配置怪物' };
    }

  return runDungeonStartFlow({
    startBattle: () => startDungeonPVEBattle(userId, monsterDefIds, { skipCooldown: true }),
    commitOnBattleStarted: async ({ battleId, state }) => {
      for (const p of participants) {
        await incEntryCount(p.characterId, inst.dungeon_id);
      }

      if (staminaCost > 0) {
        for (const p of staminaConsumingParticipants) {
          const participantLabel = buildParticipantLabel(p, participantNicknameMap);
          const staminaMaxRaw = participantStaminaMaxMap.get(p.characterId);
          const staminaMax = Math.floor(Number(staminaMaxRaw) || 0);
          if (staminaMax <= 0) {
            return { success: false, message: `${participantLabel}体力上限数据缺失` };
          }
          const updRes = await query(
            `UPDATE characters
                SET stamina = stamina - $1,
                    stamina_recover_at = CASE WHEN stamina >= $3 THEN NOW() ELSE stamina_recover_at END,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $2 AND stamina >= $1`,
            [staminaCost, p.characterId, staminaMax]
          );
          if ((updRes.rowCount ?? 0) === 0) {
            return { success: false, message: `${participantLabel}体力扣除失败` };
          }
        }
      }

      await query(
        `UPDATE dungeon_instance SET status = 'running', start_time = NOW(), current_stage = 1, current_wave = 1 WHERE id = $1`,
        [instanceId]
      );

      await query(
        `
          UPDATE dungeon_instance
          SET instance_data = jsonb_set(
            jsonb_set(COALESCE(instance_data, '{}'::jsonb), '{currentBattleId}', to_jsonb($1::text), true),
            '{${DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD}}',
            to_jsonb($2::int[]),
            true
          )
          WHERE id = $3
        `,
        [battleId, rewardEligibleCharacterIds, instanceId]
      );
      return { success: true, data: { instanceId, status: 'running' as DungeonInstanceStatus, battleId, state } };
    },
  });
};

/** 推进秘境实例（下一波次/通关结算，需要事务上下文） */
export const nextDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | {
    success: true;
    data: {
      instanceId: string;
      status: DungeonInstanceStatus;
      battleId?: string;
      state?: unknown;
      finished?: boolean;
    };
  }
  | { success: false; message: string }
> => {
  const user = await getUserAndCharacter(userId);
  if (!user.ok) return { success: false, message: user.message };

  const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1`, [instanceId]);
  if (instRes.rows.length === 0) return { success: false, message: '秘境实例不存在' };
  const inst = instRes.rows[0] as DungeonInstanceRow;

    if (inst.status !== 'running') return { success: false, message: '秘境未在进行中' };
    if (inst.creator_id !== user.characterId) return { success: false, message: '只有创建者可以推进秘境' };

    const participants = parseParticipants(inst.participants);
    if (!participants.some((p) => p.userId === userId)) return { success: false, message: '无权访问该秘境' };

    const dataObj = asObject(inst.instance_data) ?? {};
    const rewardEligibleParticipants = selectDungeonRewardEligibleParticipants(participants, dataObj);
    if (
      participants.length > 0 &&
      rewardEligibleParticipants.length === 0 &&
      !hasDungeonRewardEligibleCharacterIdsField(dataObj)
    ) {
      console.warn(
        `[dungeon] 实例可领奖名单为空，结算奖励将跳过（instanceId=${instanceId}, participants=${participants.length})`,
      );
    }
    const currentBattleId = typeof dataObj.currentBattleId === 'string' ? dataObj.currentBattleId : '';
    if (!currentBattleId) return { success: false, message: '当前战斗不存在' };

    const battleStateRes = await getBattleState(currentBattleId);
    if (!battleStateRes.success) return { success: false, message: battleStateRes.message || '获取战斗状态失败' };
    const battleData = asObject(battleStateRes.data) ?? {};
    const result = asString(battleData.result, '');
    if (result !== 'attacker_win' && result !== 'defender_win' && result !== 'draw') {
      return { success: false, message: '战斗未结束' };
    }

    if (result !== 'attacker_win') {
      await query(`UPDATE dungeon_instance SET status = 'failed', end_time = NOW() WHERE id = $1`, [instanceId]);
      return { success: true, data: { instanceId, status: 'failed', finished: true } };
    }

    const currentStage = asNumber(inst.current_stage, 1);
    const currentWave = asNumber(inst.current_wave, 1);
    const stageWave = await getStageAndWave(inst.difficulty_id, currentStage, currentWave);
    if (!stageWave.ok) return { success: false, message: stageWave.message };

    let nextStage = currentStage;
    let nextWave = currentWave + 1;
    if (nextWave > stageWave.maxWaveIndexInStage) {
      nextStage = currentStage + 1;
      nextWave = 1;
    }

    if (nextStage > stageWave.stageCount) {
      const logs = battleData.logs;
      const deathCount = countPlayerDeaths(logs);
      const stats = asObject(battleData.stats) ?? {};
      const attackerStats = asObject(stats.attacker) ?? {};
      const totalDamage = Math.floor(asNumber(attackerStats.damageDealt, 0));
      const timeSpentSec = Math.max(0, Math.floor((Date.now() - new Date(inst.start_time || inst.created_at).getTime()) / 1000));
      const pendingMailByCharacter = new Map<number, { userId: number; items: MailAttachItem[] }>();
      const instLockRes = await query(`SELECT status FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE`, [instanceId]);
      if (instLockRes.rows.length === 0) {
        return { success: false, message: '秘境实例不存在' };
      }
      const lockedStatus = asString(instLockRes.rows[0]?.status, '');
      if (lockedStatus !== 'running') {
        if (lockedStatus === 'cleared' || lockedStatus === 'failed' || lockedStatus === 'abandoned') {
          return { success: true, data: { instanceId, status: lockedStatus as DungeonInstanceStatus, finished: true } };
        }
        return { success: false, message: '秘境状态异常，无法结算' };
      }

        await query(
          `UPDATE dungeon_instance SET status = 'cleared', end_time = NOW(), time_spent_sec = $2, total_damage = $3, death_count = $4 WHERE id = $1`,
          [instanceId, timeSpentSec, totalDamage, deathCount]
        );

        const difficultyDef = getDungeonDifficultyById(inst.difficulty_id);
        const firstClearRewardConfig = difficultyDef?.first_clear_rewards ?? {};
        const participantCharacterIds = [...new Set(
          rewardEligibleParticipants
            .map((p) => Number(p.characterId))
            .filter((id) => Number.isFinite(id) && id > 0)
        )].sort((a, b) => a - b);
        const clearCountMap = new Map<number, number>();
        const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();
        const itemMetaCache = new Map<
          string,
          {
            name: string;
            category: string;
            subCategory: string | null;
            effectDefs: unknown;
            qualityRank: number;
          }
        >();

        if (participantCharacterIds.length > 0) {
          await lockCharacterInventoryMutexes(participantCharacterIds);
        }

        const appendGrantedItem = (
          list: Array<{ item_def_id: string; qty: number; item_ids: number[] }>,
          itemDefId: string,
          qty: number,
          itemIds: number[]
        ) => {
          const normalizedQty = Math.max(0, Math.floor(qty));
          if (normalizedQty <= 0) return;
          const safeItemIds = itemIds.filter((id) => Number.isInteger(id) && id > 0);
          const existing = list.find((item) => item.item_def_id === itemDefId);
          if (existing) {
            existing.qty += normalizedQty;
            if (safeItemIds.length > 0) {
              existing.item_ids.push(...safeItemIds);
            }
            return;
          }
          list.push({
            item_def_id: itemDefId,
            qty: normalizedQty,
            item_ids: safeItemIds,
          });
        };

        const appendPendingMailItems = (characterId: number, userId: number, items: PendingMailItem[]) => {
          if (items.length <= 0) return;
          const pending = pendingMailByCharacter.get(characterId) || { userId, items: [] as MailAttachItem[] };
          for (const item of items) {
            const targetBindType = item.options?.bindType || 'none';
            const targetEquipOptionsKey = JSON.stringify(item.options?.equipOptions || null);
            const existing = pending.items.find((x) => {
              const bindType = x.options?.bindType || 'none';
              const equipOptionsKey = JSON.stringify(x.options?.equipOptions || null);
              return x.item_def_id === item.item_def_id && bindType === targetBindType && equipOptionsKey === targetEquipOptionsKey;
            });
            if (existing) {
              existing.qty += item.qty;
              continue;
            }
            pending.items.push({
              item_def_id: item.item_def_id,
              qty: item.qty,
              ...(item.options ? { options: { ...item.options } } : {}),
            });
          }
          pendingMailByCharacter.set(characterId, pending);
        };

        const getItemMeta = async (itemDefId: string): Promise<{
          name: string;
          category: string;
          subCategory: string | null;
          effectDefs: unknown;
          qualityRank: number;
        }> => {
          const cached = itemMetaCache.get(itemDefId);
          if (cached) return cached;
          const row = getItemDefinitionById(itemDefId);
          const meta = {
            name: typeof row?.name === 'string' && row.name.length > 0 ? row.name : itemDefId,
            category: typeof row?.category === 'string' ? row.category : '',
            subCategory: typeof row?.sub_category === 'string' && row.sub_category.length > 0 ? row.sub_category : null,
            effectDefs: row?.effect_defs ?? null,
            qualityRank: resolveQualityRankFromName(row?.quality, 1),
          };
          itemMetaCache.set(itemDefId, meta);
          return meta;
        };

        if (participantCharacterIds.length > 0) {
          const clearCountRes = await query(
            `
              SELECT character_id, COUNT(1)::int AS cnt
              FROM dungeon_record
              WHERE character_id = ANY($1)
                AND dungeon_id = $2
                AND difficulty_id = $3
                AND result = 'cleared'
              GROUP BY character_id
            `,
            [participantCharacterIds, inst.dungeon_id, inst.difficulty_id]
          );
          for (const row of clearCountRes.rows as Array<{ character_id: unknown; cnt: unknown }>) {
            clearCountMap.set(asNumber(row.character_id, 0), asNumber(row.cnt, 0));
          }

          const settingRes = await query(
            `
              SELECT id, auto_disassemble_enabled, auto_disassemble_rules
              FROM characters
              WHERE id = ANY($1)
            `,
            [participantCharacterIds]
          );
          for (const row of settingRes.rows as Array<{
            id: unknown;
            auto_disassemble_enabled: boolean | null;
            auto_disassemble_rules: unknown;
          }>) {
            const id = asNumber(row.id, 0);
            if (!Number.isFinite(id) || id <= 0) continue;
            autoDisassembleSettings.set(
              id,
              normalizeAutoDisassembleSetting({
                enabled: row.auto_disassemble_enabled,
                rules: row.auto_disassemble_rules,
              })
            );
          }
        }

        for (const p of rewardEligibleParticipants) {
          const characterId = Number(p.characterId);
          if (!Number.isFinite(characterId) || characterId <= 0) continue;
          let rewardBundle: DungeonRewardBundle = { exp: 0, silver: 0, items: [] };

          const isFirstClear = asNumber(clearCountMap.get(characterId), 0) <= 0;
          if (isFirstClear) {
            rewardBundle = mergeDungeonRewardBundle(
              rewardBundle,
              rollDungeonRewardBundle(firstClearRewardConfig, 1)
            );
          }

          if (rewardBundle.exp > 0 || rewardBundle.silver > 0) {
            await query(
              `UPDATE characters SET exp = exp + $1, silver = silver + $2, updated_at = NOW() WHERE id = $3`,
              [rewardBundle.exp, rewardBundle.silver, characterId]
            );
          }

          const autoDisassembleSetting =
            autoDisassembleSettings.get(characterId) ||
            normalizeAutoDisassembleSetting({ enabled: false, rules: undefined });
          const grantedItems: Array<{ item_def_id: string; qty: number; item_ids: number[] }> = [];
          let autoDisassembleSilverGained = 0;
          for (const rewardItem of rewardBundle.items) {
            const itemMeta = await getItemMeta(rewardItem.itemDefId);
            const grantResult = await grantRewardItemWithAutoDisassemble({
              characterId,
              itemDefId: rewardItem.itemDefId,
              qty: rewardItem.qty,
              ...(rewardItem.bindType ? { bindType: rewardItem.bindType } : {}),
              itemMeta: {
                itemName: itemMeta.name,
                category: itemMeta.category,
                subCategory: itemMeta.subCategory,
                effectDefs: itemMeta.effectDefs,
                qualityRank: itemMeta.qualityRank,
              },
              autoDisassembleSetting,
              sourceObtainedFrom: 'dungeon_clear_reward',
              createItem: async ({ itemDefId, qty, bindType, obtainedFrom, equipOptions }) => {
                return itemService.createItem(p.userId, characterId, itemDefId, qty, {
                  location: 'bag',
                  obtainedFrom,
                  ...(bindType ? { bindType } : {}),
                  ...(equipOptions ? { equipOptions } : {}),
                });
              },
              addSilver: async (ownerCharacterId, silverGain) => {
                const safeSilver = Math.max(0, Math.floor(Number(silverGain) || 0));
                if (safeSilver <= 0) return { success: true, message: '无需增加银两' };
                const updateRes = await query(
                  `
                    UPDATE characters
                    SET silver = silver + $1,
                        updated_at = NOW()
                    WHERE id = $2
                  `,
                  [safeSilver, ownerCharacterId]
                );
                if (updateRes.rowCount === 0) return { success: false, message: '角色不存在' };
                return { success: true, message: '银两增加成功' };
              },
            });

            for (const warning of grantResult.warnings) {
              console.warn(`秘境结算发奖失败: ${warning}`);
            }
            for (const granted of grantResult.grantedItems) {
              appendGrantedItem(grantedItems, granted.itemDefId, granted.qty, granted.itemIds);
            }
            appendPendingMailItems(characterId, p.userId, grantResult.pendingMailItems);
            if (grantResult.gainedSilver > 0) {
              autoDisassembleSilverGained += grantResult.gainedSilver;
            }
          }

          const rewardsPayload = {
            exp: rewardBundle.exp,
            silver: rewardBundle.silver + autoDisassembleSilverGained,
            items: grantedItems,
            is_first_clear: isFirstClear,
          };

          await query(
            `
              INSERT INTO dungeon_record (character_id, dungeon_id, difficulty_id, instance_id, result, time_spent_sec, damage_dealt, death_count, rewards, is_first_clear)
              VALUES ($1, $2, $3, $4, 'cleared', $5, $6, $7, $8::jsonb, $9)
            `,
            [
              characterId,
              inst.dungeon_id,
              inst.difficulty_id,
              instanceId,
              timeSpentSec,
              totalDamage,
              deathCount,
              JSON.stringify(rewardsPayload),
              isFirstClear,
            ]
          );
        }

        for (const [receiverCharacterId, entry] of pendingMailByCharacter.entries()) {
          const chunkSize = 10;
          for (let i = 0; i < entry.items.length; i += chunkSize) {
            const chunk = entry.items.slice(i, i + chunkSize);
            const mailRes = await sendSystemMail(
              entry.userId,
              receiverCharacterId,
              '秘境通关奖励补发',
              '由于背包已满，部分秘境通关奖励已通过邮件补发，请及时领取。',
              { items: chunk },
              30
            );
            if (!mailRes.success) {
              console.warn(`秘境奖励补发邮件发送失败: ${mailRes.message}`);
            }
          }
        }

      // 任务次数按“可领奖参与者”统计，确保免体力模式不会吃到额外收益。
      const taskEventCharacterIds = buildDungeonRewardEligibleCharacterIds(rewardEligibleParticipants);
      for (const characterId of taskEventCharacterIds) {
        await recordDungeonClearEvent(characterId, inst.dungeon_id, 1, inst.difficulty_id);
      }

      return { success: true, data: { instanceId, status: 'cleared', finished: true } };
    }

    const nextStageWave = await getStageAndWave(inst.difficulty_id, nextStage, nextWave);
    if (!nextStageWave.ok) return { success: false, message: nextStageWave.message };

    const monsterDefIds = buildMonsterDefIdsFromWave(nextStageWave.wave.monsters, 5);
    if (monsterDefIds.length === 0) return { success: false, message: '该波次未配置怪物' };

    await query(`UPDATE dungeon_instance SET current_stage = $2, current_wave = $3 WHERE id = $1`, [
      instanceId,
      nextStage,
      nextWave,
    ]);

    const battleRes = await startDungeonPVEBattle(userId, monsterDefIds, { skipCooldown: true });
    if (!battleRes.success || !battleRes.data?.battleId) return { success: false, message: battleRes.message || '开启战斗失败' };

    const battleId = String(battleRes.data.battleId);
    await query(
      `UPDATE dungeon_instance SET instance_data = jsonb_set(COALESCE(instance_data, '{}'::jsonb), '{currentBattleId}', to_jsonb($1::text), true) WHERE id = $2`,
      [battleId, instanceId]
    );

  return { success: true, data: { instanceId, status: 'running', battleId, state: battleRes.data.state } };
};
