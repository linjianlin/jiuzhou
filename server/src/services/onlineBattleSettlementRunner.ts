/**
 * 在线战斗延迟结算协调器
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一执行在线战斗请求链路提前生成的延迟结算任务，把真实发奖、竞技场积分落库等 DB 副作用移出实时链路。
 * 2. 做什么：负责启动恢复、串行执行、失败重试与竞技场周结算前的显式 flush。
 * 3. 不做什么：不直接生成 battle result，不替代 battle engine，也不决定前端何时展示即时奖励预览。
 *
 * 输入/输出：
 * - 输入：`DeferredSettlementTask`（来自在线战斗投影服务）。
 * - 输出：无同步业务返回；副作用是完成 DB 落库并清理任务。
 *
 * 数据流/状态流：
 * - battle settlement -> enqueue task
 * - startup -> initialize runner -> 恢复 pending/failed 任务
 * - runner tick -> 逐条执行 -> 成功删除 / 失败标记
 *
 * 关键边界条件与坑点：
 * 1. 同一时刻只允许一个任务进入真实落库，避免奖励发放和竞技场积分更新在 DB 层交叉乱序。
 * 2. 任务幂等键固定使用 battleId；重复 enqueue 不会产生第二条任务，也不会重复发奖。
 */

import { query, withTransaction } from '../config/database.js';
import { battleDropService } from './battleDropService.js';
import { settleTowerBattle } from './tower/service.js';
import { itemService } from './itemService.js';
import { sendSystemMail, type MailAttachItem } from './mailService.js';
import { recordDungeonClearEvent, recordKillMonsterEvents } from './taskService.js';
import { normalizeAutoDisassembleSetting } from './autoDisassembleRules.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
  type PendingMailItem,
} from './autoDisassembleRewardService.js';
import {
  addCharacterRewardDelta,
  applyCharacterRewardDeltas,
  type CharacterRewardDelta,
} from './shared/characterRewardSettlement.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { lockCharacterRewardSettlementTargets } from './shared/characterRewardTargetLock.js';
import { getDungeonDifficultyById, getItemDefinitionById } from './staticConfigLoader.js';
import { rollDungeonRewardBundle, mergeDungeonRewardBundle } from './dungeon/shared/rewards.js';
import { resolveDungeonRewardMultiplier } from './dungeon/shared/difficulty.js';
import { asNumber } from './dungeon/shared/typeUtils.js';
import type { DungeonRewardBundle } from './dungeon/types.js';
import { applyStaminaDeltaByCharacterId } from './staminaService.js';
import { getGameServer } from '../game/gameServer.js';
import { createScopedLogger } from '../utils/logger.js';
import { createSlowOperationLogger } from '../utils/slowOperationLogger.js';
import { shouldContinueOnlineBattleSettlementDispatch } from './onlineBattleSettlementDrainPolicy.js';
import {
  deleteDeferredSettlementTask,
  getDeferredSettlementTask,
  listPendingDeferredSettlementTasks,
  loadDeferredSettlementTasksFromRedis,
  updateDeferredSettlementTaskStatus,
  type DeferredSettlementTask,
} from './onlineBattleProjectionService.js';

const RUNNER_INTERVAL_MS = 1500;
const MAX_CONCURRENT_SETTLEMENT_TASKS = 4;
const SETTLEMENT_TICK_DRAIN_TAIL_RESERVE_MS = 350;
const SETTLEMENT_TICK_DISPATCH_BUDGET_MS =
  RUNNER_INTERVAL_MS - SETTLEMENT_TICK_DRAIN_TAIL_RESERVE_MS;
const MAX_SETTLEMENT_TASKS_PER_TICK = MAX_CONCURRENT_SETTLEMENT_TASKS * 2;
const settlementRunnerLogger = createScopedLogger('onlineBattle.settlementRunner');

type DeferredSettlementMonsterSnapshot = DeferredSettlementTask['payload']['monsters'][number];
type DeferredSettlementDungeonStartConsumption = NonNullable<
  DeferredSettlementTask['payload']['dungeonStartConsumption']
>;

const collectUniqueParticipantCharacterIds = (
  participants: DeferredSettlementTask['payload']['participants'],
): number[] => {
  return [...new Set(
    participants
      .map((participant) => Math.floor(Number(participant.characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )].sort((left, right) => left - right);
};

/**
 * 提取延迟结算任务的串行化资源键。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把同一秘境实例的 `dungeon-start` / `dungeon-clear` 任务收敛到同一个资源键，供 runner 做实例级串行调度。
 * 2. 做什么：把资源键解析逻辑集中在单一入口，避免 pick / dispatch / finally 各自复制一套 instanceId 提取规则。
 * 3. 不做什么：不修改任务状态，不访问 Redis/数据库，也不决定任务是否成功。
 *
 * 输入/输出：
 * - 输入：单条延迟结算任务。
 * - 输出：需要串行执行时返回稳定资源键；否则返回 `null`。
 *
 * 数据流/状态流：
 * pending task -> runner 读取任务 -> 本函数提取资源键
 * -> 同一资源键任务在同一时刻只允许一个进入真实落库。
 *
 * 关键边界条件与坑点：
 * 1. `dungeon-start` 与 `dungeon-clear` 必须映射到同一个键，否则仍会并发冲到 `dungeon_instance` / `dungeon_record`。
 * 2. 空字符串 `instanceId` 必须视为无效，不能生成伪键污染串行队列。
 */
const getDeferredSettlementSerializationKey = (
  task: DeferredSettlementTask,
): string | null => {
  const candidates = [
    task.payload.dungeonStartConsumption?.instanceId ?? null,
    task.payload.dungeonSettlement?.instanceId ?? null,
    task.payload.dungeonContext?.instanceId ?? null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const instanceId = candidate.trim();
    if (!instanceId) continue;
    return `dungeon-instance:${instanceId}`;
  }

  return null;
};

/**
 * 从延迟结算任务里的怪物快照构建任务进度事件。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把战斗快照里的怪物列表聚合成 `monsterId -> count`，供任务系统复用。
 * 2. 不做什么：不判断胜负资格，也不直接推进任务。
 *
 * 输入/输出：
 * - 输入：延迟结算任务中的怪物快照数组。
 * - 输出：规整后的怪物击杀事件数组。
 *
 * 数据流/状态流：
 * - 战斗结算写入 monsters 快照 -> 延迟结算读取 -> 本函数聚合 -> taskService 批量记录。
 *
 * 关键边界条件与坑点：
 * 1. 任务快照里的同种怪会按出现次数累计，不能只去重不计数。
 * 2. 空字符串怪物 ID 必须过滤，避免把脏 battle payload 继续传进任务系统。
 */
const buildKillMonsterEventsFromSnapshots = (
  monsters: DeferredSettlementMonsterSnapshot[],
): Array<{ monsterId: string; count: number }> => {
  const countByMonsterId = new Map<string, number>();

  for (const monster of monsters) {
    const monsterId = String(monster.id ?? '').trim();
    if (!monsterId) continue;
    countByMonsterId.set(monsterId, (countByMonsterId.get(monsterId) ?? 0) + 1);
  }

  return [...countByMonsterId.entries()].map(([monsterId, count]) => ({
    monsterId,
    count,
  }));
};

/**
 * 解析延迟结算完成后需要补推角色刷新的用户集合。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把延迟结算任务里会受 DB 真实落库影响的参与者收敛为唯一 userId 列表，避免 runner 成功后遗漏角色刷新。
 * 2. 做什么：同时覆盖普通发奖与组队场景，避免 battle settlement / dungeon / runner 各自再拼一套通知对象。
 * 3. 不做什么：不决定具体推送内容，也不在这里执行任务状态迁移。
 *
 * 输入/输出：
 * - 输入：已完成真实落库的延迟结算任务。
 * - 输出：去重后的 userId 数组。
 *
 * 数据流/状态流：
 * runner 执行成功 -> 本函数提取参与者 userId -> `pushCharacterUpdate` 重新加载权威角色数据。
 *
 * 关键边界条件与坑点：
 * 1. `rewardParticipants` 在部分链路里可能比 `participants` 更精确，这里要两者合并去重，避免组队奖励成员漏推。
 * 2. 非法 userId 必须过滤，否则会把脏任务数据继续传播到 socket 刷新链路。
 */
const collectDeferredSettlementAffectedUserIds = (
  task: DeferredSettlementTask,
): number[] => {
  const userIdSet = new Set<number>();
  for (const participant of task.payload.participants) {
    const userId = Math.floor(Number(participant.userId));
    if (!Number.isFinite(userId) || userId <= 0) continue;
    userIdSet.add(userId);
  }
  for (const participant of task.payload.rewardParticipants) {
    const userId = Math.floor(Number(participant.userId));
    if (!Number.isFinite(userId) || userId <= 0) continue;
    userIdSet.add(userId);
  }
  return [...userIdSet];
};

const pushCharacterUpdatesAfterDeferredSettlement = async (
  task: DeferredSettlementTask,
): Promise<void> => {
  const affectedUserIds = collectDeferredSettlementAffectedUserIds(task);
  if (affectedUserIds.length <= 0) return;

  const gameServer = getGameServer();
  await Promise.all(
    affectedUserIds.map(async (userId) => {
      try {
        await gameServer.pushCharacterUpdate(userId);
      } catch (error) {
        settlementRunnerLogger.warn({
          taskId: task.taskId,
          battleId: task.battleId,
          userId,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        }, '延迟结算完成后推送角色刷新失败');
      }
    }),
  );
};

/**
 * 批量回写秘境进入次数快照。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把同一轮 `dungeon-start` 的多名角色次数快照合并成单条 UPSERT，减少事务内逐行往返。
 * 2. 做什么：保持与原先逐条写入一致的覆盖语义，仍然以 `(character_id, dungeon_id)` 为唯一键收敛。
 * 3. 不做什么：不负责体力扣减、不校验次数合法性，也不决定秘境实例状态迁移。
 *
 * 输入/输出：
 * - 输入：`entryCountSnapshots` 数组。
 * - 输出：无；副作用是批量写入 `dungeon_entry_count`。
 *
 * 数据流/状态流：
 * - `settleDungeonStartConsumptionInDb` 收到快照
 * - 本函数把快照转成 JSON recordset
 * - PostgreSQL 单条 `INSERT ... ON CONFLICT DO UPDATE` 完成整批覆盖。
 *
 * 复用设计说明：
 * - 秘境开战与后续可能的批量恢复都依赖同一份 “角色-秘境次数快照” 写库语义，单独抽函数能避免再回到逐条 `await query`。
 * - 高频变化点是快照数量，不是 SQL 结构，因此把批量写入固定成单一入口，后续扩容仍只改这一处。
 *
 * 关键边界条件与坑点：
 * 1. 空数组必须直接返回，避免生成空 `jsonb_to_recordset` 调用。
 * 2. 入参必须是已归一化快照；这里只做批量持久化，不额外兜底修正脏字段。
 */
const upsertDungeonEntryCountSnapshots = async (
  entryCountSnapshots: DeferredSettlementDungeonStartConsumption['entryCountSnapshots'],
): Promise<void> => {
  if (entryCountSnapshots.length <= 0) {
    return;
  }

  await query(
    `
      INSERT INTO dungeon_entry_count (
        character_id,
        dungeon_id,
        daily_count,
        weekly_count,
        total_count,
        last_daily_reset,
        last_weekly_reset
      )
      SELECT
        row.character_id,
        row.dungeon_id,
        row.daily_count,
        row.weekly_count,
        row.total_count,
        row.last_daily_reset,
        row.last_weekly_reset
      FROM jsonb_to_recordset($1::jsonb) AS row(
        character_id int,
        dungeon_id text,
        daily_count int,
        weekly_count int,
        total_count int,
        last_daily_reset date,
        last_weekly_reset date
      )
      ON CONFLICT (character_id, dungeon_id)
      DO UPDATE
      SET
        daily_count = EXCLUDED.daily_count,
        weekly_count = EXCLUDED.weekly_count,
        total_count = EXCLUDED.total_count,
        last_daily_reset = EXCLUDED.last_daily_reset,
        last_weekly_reset = EXCLUDED.last_weekly_reset
    `,
    [JSON.stringify(entryCountSnapshots.map((snapshot) => ({
      character_id: snapshot.characterId,
      dungeon_id: snapshot.dungeonId,
      daily_count: snapshot.dailyCount,
      weekly_count: snapshot.weeklyCount,
      total_count: snapshot.totalCount,
      last_daily_reset: snapshot.lastDailyReset,
      last_weekly_reset: snapshot.lastWeeklyReset,
    })))],
  );
};

/**
 * 并发推进同一场战斗涉及的怪物击杀任务。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把同一场战斗的多角色击杀事件推进改成按角色并发执行，减少延迟结算在任务系统上的串行等待。
 * 2. 做什么：先提取唯一角色 ID，避免 `rewardParticipants` 重复成员导致重复推进。
 * 3. 不做什么：不构建击杀事件，不决定胜利资格，也不处理秘境通关任务。
 *
 * 输入/输出：
 * - 输入：可领奖角色列表、怪物击杀事件列表。
 * - 输出：无；副作用是推进任务、主线和成就进度。
 *
 * 数据流/状态流：
 * - PVE 结算构建 `killMonsterEvents`
 * - 本函数提取唯一角色 ID
 * - 并发调用 `recordKillMonsterEvents`，每个角色独立推进自己的任务链路。
 *
 * 复用设计说明：
 * - 普通 PVE、组队秘境和后续需要“同战斗多角色共享同一击杀快照”的链路都能复用这一入口，避免继续在调用点手写串行 for-loop。
 * - 高频变化点是参与角色数量，因此把“去重 + 并发”固定在这里，调用方只关心事件本身。
 *
 * 关键边界条件与坑点：
 * 1. 空事件或空角色列表必须直接返回，避免发起无意义 Promise/查询。
 * 2. 这里只能用于角色间彼此独立的任务推进；若未来出现共享事务约束，不能直接照搬到事务内链路。
 */
const recordKillMonsterEventsForParticipants = async (
  rewardParticipants: DeferredSettlementTask['payload']['rewardParticipants'],
  killMonsterEvents: Array<{ monsterId: string; count: number }>,
): Promise<void> => {
  if (rewardParticipants.length <= 0 || killMonsterEvents.length <= 0) {
    return;
  }

  const participantCharacterIds = [...new Set(
    rewardParticipants
      .map((participant) => Math.floor(Number(participant.characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
  if (participantCharacterIds.length <= 0) {
    return;
  }

  await Promise.all(
    participantCharacterIds.map((characterId) => recordKillMonsterEvents(characterId, killMonsterEvents)),
  );
};

const settleDungeonStartConsumptionInDb = async (
  task: DeferredSettlementTask,
): Promise<void> => {
  const dungeonStartConsumption = task.payload.dungeonStartConsumption;
  if (!dungeonStartConsumption) return;

  const safeStartTimeMs = new Date(dungeonStartConsumption.startTime).getTime();
  const safeStartTime = Number.isFinite(safeStartTimeMs)
    ? new Date(safeStartTimeMs).toISOString()
    : new Date().toISOString();
  const participantsJson = JSON.stringify(dungeonStartConsumption.participants);
  const rewardEligibleCharacterIdsJson = JSON.stringify(dungeonStartConsumption.rewardEligibleCharacterIds);

  await withTransaction(async () => {
    await query(
      `
        INSERT INTO dungeon_instance (
          id,
          dungeon_id,
          difficulty_id,
          creator_id,
          team_id,
          status,
          current_stage,
          current_wave,
          participants,
          start_time,
          end_time,
          time_spent_sec,
          total_damage,
          death_count,
          rewards_claimed,
          instance_data
        )
        VALUES ($1, $2, $3, $4, $5, 'preparing', 1, 1, $6::jsonb, NULL, NULL, 0, 0, 0, FALSE, '{}'::jsonb)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        dungeonStartConsumption.instanceId,
        dungeonStartConsumption.dungeonId,
        dungeonStartConsumption.difficultyId,
        dungeonStartConsumption.creatorCharacterId,
        dungeonStartConsumption.teamId,
        participantsJson,
      ],
    );

    const markResult = await query(
      `
        UPDATE dungeon_instance
        SET
          status = 'running',
          current_stage = $2,
          current_wave = $3,
          participants = $4::jsonb,
          start_time = COALESCE(start_time, $5::timestamptz),
          end_time = NULL,
          instance_data = jsonb_set(
            jsonb_set(
              jsonb_set(COALESCE(instance_data, '{}'::jsonb), '{currentBattleId}', to_jsonb($6::text), true),
              '{rewardEligibleCharacterIds}',
              $7::jsonb,
              true
            ),
            '{startResourceTaskId}',
            to_jsonb($8::text),
            true
          )
        WHERE id = $1
          AND COALESCE(instance_data->>'startResourceTaskId', '') = ''
        RETURNING id
      `,
      [
        dungeonStartConsumption.instanceId,
        dungeonStartConsumption.currentStage,
        dungeonStartConsumption.currentWave,
        participantsJson,
        safeStartTime,
        dungeonStartConsumption.currentBattleId,
        rewardEligibleCharacterIdsJson,
        task.taskId,
      ],
    );

    if (markResult.rows.length <= 0) {
      return;
    }

    await upsertDungeonEntryCountSnapshots(dungeonStartConsumption.entryCountSnapshots);

    for (const staminaConsumption of dungeonStartConsumption.staminaConsumptions) {
      const safeAmount = Math.max(0, Math.floor(Number(staminaConsumption.amount) || 0));
      if (safeAmount <= 0) continue;
      const staminaState = await applyStaminaDeltaByCharacterId(
        staminaConsumption.characterId,
        -safeAmount,
      );
      if (!staminaState) {
        throw new Error(`秘境开战体力落库失败: characterId=${staminaConsumption.characterId}`);
      }
    }
  });
};

const settleArenaBattleInDb = async (
  task: DeferredSettlementTask,
): Promise<void> => {
  const arenaDelta = task.payload.arenaDelta;
  if (!arenaDelta) return;

  await query(
    `
      INSERT INTO arena_rating(character_id, rating, win_count, lose_count)
      SELECT character_id, 1000, 0, 0
      FROM unnest($1::int[]) AS character_id
      ON CONFLICT (character_id) DO NOTHING
    `,
    [[arenaDelta.challengerCharacterId, arenaDelta.opponentCharacterId]],
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
      arenaDelta.challengerCharacterId,
      arenaDelta.challengerScoreAfter,
      arenaDelta.challengerOutcome === 'win' ? 1 : 0,
      arenaDelta.challengerOutcome === 'lose' ? 1 : 0,
    ],
  );

  await query(
    `
      INSERT INTO arena_battle(
        battle_id,
        challenger_character_id,
        opponent_character_id,
        status,
        result,
        delta_score,
        score_before,
        score_after,
        finished_at
      )
      VALUES ($1, $2, $3, 'finished', $4, $5, $6, $7, NOW())
      ON CONFLICT (battle_id) DO UPDATE
      SET
        status = EXCLUDED.status,
        result = EXCLUDED.result,
        delta_score = EXCLUDED.delta_score,
        score_before = EXCLUDED.score_before,
        score_after = EXCLUDED.score_after,
        finished_at = EXCLUDED.finished_at
    `,
    [
      task.battleId,
      arenaDelta.challengerCharacterId,
      arenaDelta.opponentCharacterId,
      arenaDelta.challengerOutcome,
      arenaDelta.challengerScoreDelta,
      arenaDelta.challengerScoreAfter - arenaDelta.challengerScoreDelta,
      arenaDelta.challengerScoreAfter,
    ],
  );
};

/**
 * 在事务内执行秘境通关真实发奖。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一把“背包互斥锁 + 角色行锁 + 入包/邮件补发 + dungeon_record 落库”放进同一事务。
 * 2. 做什么：复用 battleDropService 的奖励结算锁协议，避免秘境通关奖励再单独走一套锁时序。
 * 3. 不做什么：不负责延迟结算任务状态流转，任务调度仍由 runner 外层处理。
 *
 * 输入/输出：
 * - 输入：单条延迟结算任务，要求 payload 中存在 dungeonSettlement。
 * - 输出：无；副作用是完成奖励发放、记录落库与任务事件推进。
 *
 * 数据流/状态流：
 * - runner 取到 dungeon-clear 任务；
 * - 外层事务包裹本函数；
 * - 本函数先统一加锁，再执行奖励入包、补发邮件、记录 dungeon_record；
 * - 事务提交后由 runner 删除任务。
 *
 * 关键边界条件与坑点：
 * 1. `lockCharacterRewardSettlementTargets` 依赖事务上下文，不能从非事务函数直接调用。
 * 2. 奖励物品创建和角色资源写回必须与 dungeon_record 落库保持同一事务，避免出现“记录已写但奖励没入包”的分裂状态。
 */
const settleDungeonClearInDbInTransaction = async (
  task: DeferredSettlementTask,
): Promise<void> => {
  const dungeonSettlement = task.payload.dungeonSettlement;
  if (!dungeonSettlement) return;

  const difficultyDef = getDungeonDifficultyById(dungeonSettlement.difficultyId);
  const firstClearRewardConfig = difficultyDef?.first_clear_rewards ?? {};
  const rewardMultiplier = resolveDungeonRewardMultiplier(difficultyDef?.reward_mult);
  const rewardParticipants = task.payload.rewardParticipants;
  const participantCharacterIds = collectUniqueParticipantCharacterIds(rewardParticipants);
  const teamClearParticipantCount = collectUniqueParticipantCharacterIds(task.payload.participants).length;

  const clearCountMap = new Map<number, number>();
  const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();
  const pendingCharacterRewardDeltas = new Map<number, CharacterRewardDelta>();
  const pendingMailByCharacter = new Map<number, { userId: number; items: MailAttachItem[] }>();
  const itemMetaCache = new Map<
    string,
    {
      name: string;
      category: string;
      subCategory: string | null;
      effectDefs: unknown;
      qualityRank: number;
      disassemblable: boolean | null;
    }
  >();

  const instanceLockResult = await query(
    `
      SELECT id
      FROM dungeon_instance
      WHERE id = $1
      FOR UPDATE
    `,
    [dungeonSettlement.instanceId],
  );
  if (instanceLockResult.rows.length <= 0) {
    throw new Error(`秘境实例不存在，无法执行通关结算: ${dungeonSettlement.instanceId}`);
  }

  if (participantCharacterIds.length > 0) {
    await lockCharacterRewardSettlementTargets(participantCharacterIds);

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
      [participantCharacterIds, dungeonSettlement.dungeonId, dungeonSettlement.difficultyId],
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
      [participantCharacterIds],
    );
    for (const row of settingRes.rows as Array<{
      id: unknown;
      auto_disassemble_enabled: boolean | null;
      auto_disassemble_rules: unknown;
    }>) {
      const characterId = asNumber(row.id, 0);
      if (!Number.isFinite(characterId) || characterId <= 0) continue;
      autoDisassembleSettings.set(
        characterId,
        normalizeAutoDisassembleSetting({
          enabled: row.auto_disassemble_enabled,
          rules: row.auto_disassemble_rules,
        }),
      );
    }
  }

  const appendGrantedItem = (
    list: Array<{ item_def_id: string; qty: number; item_ids: number[] }>,
    itemDefId: string,
    qty: number,
    itemIds: number[],
  ): void => {
    const normalizedQty = Math.max(0, Math.floor(qty));
    if (normalizedQty <= 0) return;
    const safeItemIds = itemIds.filter((itemId) => Number.isInteger(itemId) && itemId > 0);
    const existing = list.find((entry) => entry.item_def_id === itemDefId);
    if (existing) {
      existing.qty += normalizedQty;
      if (safeItemIds.length > 0) existing.item_ids.push(...safeItemIds);
      return;
    }
    list.push({
      item_def_id: itemDefId,
      qty: normalizedQty,
      item_ids: safeItemIds,
    });
  };

  const appendPendingMailItems = (
    characterId: number,
    userId: number,
    items: PendingMailItem[],
  ): void => {
    if (items.length <= 0) return;
    const pending = pendingMailByCharacter.get(characterId) ?? { userId, items: [] as MailAttachItem[] };
    for (const item of items) {
      const targetBindType = item.options?.bindType ?? 'none';
      const targetEquipOptionsKey = JSON.stringify(item.options?.equipOptions ?? null);
      const existing = pending.items.find((entry) => {
        const bindType = entry.options?.bindType ?? 'none';
        const equipOptionsKey = JSON.stringify(entry.options?.equipOptions ?? null);
        return entry.item_def_id === item.item_def_id
          && bindType === targetBindType
          && equipOptionsKey === targetEquipOptionsKey;
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
    disassemblable: boolean | null;
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
      disassemblable: typeof row?.disassemblable === 'boolean' ? row.disassemblable : null,
    };
    itemMetaCache.set(itemDefId, meta);
    return meta;
  };

  for (const participant of rewardParticipants) {
    const characterId = Math.floor(Number(participant.characterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;

    let rewardBundle: DungeonRewardBundle = { exp: 0, silver: 0, items: [] };
    const isFirstClear = asNumber(clearCountMap.get(characterId), 0) <= 0;
    if (isFirstClear) {
      rewardBundle = mergeDungeonRewardBundle(
        rewardBundle,
        rollDungeonRewardBundle(firstClearRewardConfig, rewardMultiplier),
      );
    }

    addCharacterRewardDelta(pendingCharacterRewardDeltas, characterId, {
      exp: rewardBundle.exp,
      silver: rewardBundle.silver,
    });

    const autoDisassembleSetting =
      autoDisassembleSettings.get(characterId)
      ?? normalizeAutoDisassembleSetting({ enabled: false, rules: undefined });
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
          disassemblable: itemMeta.disassemblable,
        },
        autoDisassembleSetting,
        sourceObtainedFrom: 'dungeon_clear_reward',
        createItem: async ({ itemDefId, qty, bindType, obtainedFrom, equipOptions }) => {
          return itemService.createItem(participant.userId, characterId, itemDefId, qty, {
            location: 'bag',
            obtainedFrom,
            ...(bindType ? { bindType } : {}),
            ...(equipOptions ? { equipOptions } : {}),
          });
        },
        addSilver: async (ownerCharacterId, silverGain) => {
          const safeSilver = Math.max(0, Math.floor(Number(silverGain) || 0));
          if (safeSilver <= 0) return { success: true, message: '无需增加银两' };
          addCharacterRewardDelta(pendingCharacterRewardDeltas, ownerCharacterId, {
            silver: safeSilver,
          });
          return { success: true, message: '银两增加成功' };
        },
      });

      for (const warning of grantResult.warnings) {
        settlementRunnerLogger.warn({
          instanceId: dungeonSettlement.instanceId,
          characterId,
          warning,
        }, '秘境结算发奖失败');
      }
      for (const grantedItem of grantResult.grantedItems) {
        appendGrantedItem(grantedItems, grantedItem.itemDefId, grantedItem.qty, grantedItem.itemIds);
      }
      appendPendingMailItems(characterId, participant.userId, grantResult.pendingMailItems);
      if (grantResult.gainedSilver > 0) {
        autoDisassembleSilverGained += grantResult.gainedSilver;
      }
    }

    await query(
      `
        INSERT INTO dungeon_record (
          character_id,
          dungeon_id,
          difficulty_id,
          instance_id,
          result,
          time_spent_sec,
          damage_dealt,
          death_count,
          rewards,
          is_first_clear
        )
        VALUES ($1, $2, $3, $4, 'cleared', $5, $6, $7, $8::jsonb, $9)
      `,
      [
        characterId,
        dungeonSettlement.dungeonId,
        dungeonSettlement.difficultyId,
        dungeonSettlement.instanceId,
        dungeonSettlement.timeSpentSec,
        dungeonSettlement.totalDamage,
        dungeonSettlement.deathCount,
        JSON.stringify({
          exp: rewardBundle.exp,
          silver: rewardBundle.silver + autoDisassembleSilverGained,
          items: grantedItems,
          is_first_clear: isFirstClear,
        }),
        isFirstClear,
      ],
    );
  }

  for (const [receiverCharacterId, entry] of pendingMailByCharacter.entries()) {
    const chunkSize = 10;
    for (let index = 0; index < entry.items.length; index += chunkSize) {
      const chunk = entry.items.slice(index, index + chunkSize);
      const mailRes = await sendSystemMail(
        entry.userId,
        receiverCharacterId,
        '秘境通关奖励补发',
        '由于背包已满，部分秘境通关奖励已通过邮件补发，请及时领取。',
        { items: chunk },
        30,
      );
      if (!mailRes.success) {
        settlementRunnerLogger.warn({
          instanceId: dungeonSettlement.instanceId,
          receiverCharacterId,
          message: mailRes.message,
        }, '秘境奖励补发邮件发送失败');
      }
    }
  }

  for (const participant of rewardParticipants) {
    await recordDungeonClearEvent(
      participant.characterId,
      dungeonSettlement.dungeonId,
      1,
      teamClearParticipantCount,
      dungeonSettlement.difficultyId,
    );
  }

  await applyCharacterRewardDeltas(pendingCharacterRewardDeltas);
};

const settleDungeonClearInDb = async (
  task: DeferredSettlementTask,
): Promise<void> => {
  await withTransaction(async () => {
    await settleDungeonClearInDbInTransaction(task);
  });
};

const executeDeferredSettlementTask = async (
  task: DeferredSettlementTask,
): Promise<void> => {
  if (task.payload.dungeonStartConsumption) {
    await settleDungeonStartConsumptionInDb(task);
    return;
  }

  if (task.payload.battleType === 'pve') {
    if (
      task.payload.result === 'attacker_win' &&
      task.payload.rewardParticipants.length > 0 &&
      task.payload.battleRewardPlan !== null &&
      !task.payload.isTowerBattle
    ) {
      await battleDropService.settleBattleRewardPlan(task.payload.battleRewardPlan);
    }

    if (task.payload.isTowerBattle && task.payload.rewardParticipants.length > 0) {
      await settleTowerBattle({
        battleId: task.battleId,
        result: task.payload.result,
        participants: task.payload.rewardParticipants,
      });
    }

    if (task.payload.result === 'attacker_win' && task.payload.rewardParticipants.length > 0) {
      const killMonsterEvents = buildKillMonsterEventsFromSnapshots(task.payload.monsters);
      await recordKillMonsterEventsForParticipants(task.payload.rewardParticipants, killMonsterEvents);
    }

    if (task.payload.dungeonSettlement && task.payload.result === 'attacker_win') {
      await settleDungeonClearInDb(task);
    }
  }

  if (task.payload.battleType === 'pvp') {
    await settleArenaBattleInDb(task);
  }
};

class OnlineBattleSettlementRunner {
  private timer: NodeJS.Timeout | null = null;
  private initialized = false;
  private drainPromise: Promise<void> | null = null;
  private activeTaskIds = new Set<string>();
  private activeSerializationKeys = new Set<string>();

  /**
   * 选择当前这一轮允许处理的待执行任务。
   *
   * 作用（做什么 / 不做什么）：
   * 1. 做什么：把“是否只处理竞技场任务”的筛选规则收敛到单一入口，避免 initialize / flush / tick 各写一套。
   * 2. 做什么：过滤掉当前进程已经 claim 的任务，避免并发 drain 时重复消费同一条延迟结算。
   * 3. 不做什么：不从 Redis 直接取任务实体，也不修改任务状态。
   *
   * 输入/输出：
   * - 输入：可选的 `onlyArena` 过滤条件。
   * - 输出：符合条件的待处理任务列表，顺序与 `listPendingDeferredSettlementTasks()` 保持一致。
   *
   * 数据流/状态流：
   * - tick/flush 先调用本方法读取内存中的 pending/failed 任务；
   * - 外层随后再用 taskId 拉取最新任务实体并执行真实结算；
   * - 这样筛选规则与执行规则保持单一来源。
   *
   * 关键边界条件与坑点：
   * 1. 这里只读 `listPendingDeferredSettlementTasks()` 的结果，不能在这里偷偷更新状态，否则会打乱 runner 的重试协议。
   * 2. `onlyArena` 模式必须严格只放行带 `arenaDelta` 的 PVP 任务，避免竞技场周结算 flush 时顺手把 PVE 奖励也一起冲掉。
   */
  private pickRunnableTasks(
    limit: number,
    options?: { onlyArena?: boolean },
  ): DeferredSettlementTask[] {
    if (limit <= 0) return [];
    const selectedTasks: DeferredSettlementTask[] = [];
    const claimedSerializationKeys = new Set<string>();

    for (const task of listPendingDeferredSettlementTasks()) {
      if (this.activeTaskIds.has(task.taskId)) continue;
      if (
        options?.onlyArena
        && !(task.payload.battleType === 'pvp' && task.payload.arenaDelta !== null)
      ) {
        continue;
      }

      const serializationKey = getDeferredSettlementSerializationKey(task);
      if (
        serializationKey
        && (
          this.activeSerializationKeys.has(serializationKey)
          || claimedSerializationKeys.has(serializationKey)
        )
      ) {
        continue;
      }

      selectedTasks.push(task);
      if (serializationKey) {
        claimedSerializationKeys.add(serializationKey);
      }
      if (selectedTasks.length >= limit) {
        break;
      }
    }

    return selectedTasks;
  }

  /**
   * 处理单条延迟结算任务。
   *
   * 作用（做什么 / 不做什么）：
   * 1. 做什么：统一封装“标记 running -> 执行真实结算 -> 成功删任务 / 失败回写状态”的单任务生命周期。
   * 2. 做什么：给并发 drain 提供可组合的最小执行单元，避免批量调度层再次复制错误处理逻辑。
   * 3. 不做什么：不决定批次大小，不调度其他任务，也不管理定时器。
   *
   * 输入/输出：
   * - 输入：已被当前进程 claim 的待处理任务。
   * - 输出：本次处理结果，供外层并发 drain 统计成功/失败数量。
   *
   * 数据流/状态流：
   * - 外层 drain 先把 taskId 放入 `activeTaskIds`；
   * - 本函数拉取最新任务实体并执行真实结算；
   * - 结束后统一从 `activeTaskIds` 释放 claim。
   *
   * 关键边界条件与坑点：
   * 1. 即便 Redis 中的任务已经被其他链路删除，本函数也必须安全返回 `skipped`，不能把 drain 整体打断。
   * 2. `activeTaskIds` 的释放必须放在 finally，避免任务异常后永久卡住同一个 taskId。
   */
  private async processTask(
    task: DeferredSettlementTask,
  ): Promise<'success' | 'failed' | 'skipped'> {
    const serializationKey = getDeferredSettlementSerializationKey(task);
    try {
      const freshTask = await getDeferredSettlementTask(task.taskId);
      if (!freshTask) {
        return 'skipped';
      }

      await updateDeferredSettlementTaskStatus({
        taskId: freshTask.taskId,
        status: 'running',
        incrementAttempt: true,
      });
      await executeDeferredSettlementTask(freshTask);
      await deleteDeferredSettlementTask(freshTask.taskId);
      await pushCharacterUpdatesAfterDeferredSettlement(freshTask);
      return 'success';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateDeferredSettlementTaskStatus({
        taskId: task.taskId,
        status: 'failed',
        errorMessage: message,
      });
      return 'failed';
    } finally {
      this.activeTaskIds.delete(task.taskId);
      if (serializationKey) {
        this.activeSerializationKeys.delete(serializationKey);
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await loadDeferredSettlementTasksFromRedis();
    this.timer = setInterval(() => {
      void this.tick();
    }, RUNNER_INTERVAL_MS);
    await this.tick();
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.initialized = false;
  }

  async flush(options?: { onlyArena?: boolean }): Promise<void> {
    await this.tick({
      ...options,
      drainAll: true,
    });
  }

  private async tick(options?: { onlyArena?: boolean; drainAll?: boolean }): Promise<void> {
    if (this.drainPromise) {
      await this.drainPromise;
      return;
    }

    const initialTasks = this.pickRunnableTasks(1, options);
    if (initialTasks.length <= 0) {
      return;
    }

    this.drainPromise = (async () => {
      const slowLogger = createSlowOperationLogger({
        label: 'onlineBattleSettlementRunner.tick',
        fields: {
          onlyArena: options?.onlyArena === true,
          maxConcurrency: MAX_CONCURRENT_SETTLEMENT_TASKS,
          drainAll: options?.drainAll === true,
          tickBudgetMs: RUNNER_INTERVAL_MS,
          dispatchBudgetMs: SETTLEMENT_TICK_DISPATCH_BUDGET_MS,
          drainTailReserveMs: SETTLEMENT_TICK_DRAIN_TAIL_RESERVE_MS,
          maxDispatchedTaskCount: MAX_SETTLEMENT_TASKS_PER_TICK,
        },
        thresholdMs: RUNNER_INTERVAL_MS,
      });
      let processedTaskCount = 0;
      let failedTaskCount = 0;
      let skippedTaskCount = 0;
      let dispatchedTaskCount = 0;
      const drainStartedAt = Date.now();

      try {
        const activePromises = new Map<
          string,
          Promise<{ taskId: string; outcome: 'success' | 'failed' | 'skipped' }>
        >();

        for (;;) {
          const availableSlots = MAX_CONCURRENT_SETTLEMENT_TASKS - activePromises.size;
          if (
            availableSlots > 0
            && shouldContinueOnlineBattleSettlementDispatch({
              drainAll: options?.drainAll === true,
              elapsedMs: Date.now() - drainStartedAt,
              dispatchedTaskCount,
              tickBudgetMs: RUNNER_INTERVAL_MS,
              drainTailReserveMs: SETTLEMENT_TICK_DRAIN_TAIL_RESERVE_MS,
              maxDispatchedTaskCount: MAX_SETTLEMENT_TASKS_PER_TICK,
            })
          ) {
            const tasksToStart = this.pickRunnableTasks(availableSlots, options);
            for (const task of tasksToStart) {
              this.activeTaskIds.add(task.taskId);
              const serializationKey = getDeferredSettlementSerializationKey(task);
              if (serializationKey) {
                this.activeSerializationKeys.add(serializationKey);
              }
              const taskPromise = this.processTask(task).then((outcome) => ({
                taskId: task.taskId,
                outcome,
              }));
              activePromises.set(task.taskId, taskPromise);
              dispatchedTaskCount += 1;
              slowLogger.mark('dispatchTask', {
                taskId: task.taskId,
                activeTaskCount: activePromises.size,
              });
            }
          }

          if (activePromises.size <= 0) {
            break;
          }

          const settledTask = await Promise.race(activePromises.values());
          activePromises.delete(settledTask.taskId);
          if (settledTask.outcome === 'success') {
            processedTaskCount += 1;
          } else if (settledTask.outcome === 'failed') {
            failedTaskCount += 1;
          } else {
            skippedTaskCount += 1;
          }
          slowLogger.mark('taskSettled', {
            taskId: settledTask.taskId,
            activeTaskCount: activePromises.size,
            outcome: settledTask.outcome,
          });
        }
      } finally {
        slowLogger.flush({
          dispatchedTaskCount,
          processedTaskCount,
          failedTaskCount,
          skippedTaskCount,
        });
      }
    })();

    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }
}

const runner = new OnlineBattleSettlementRunner();

export const initializeOnlineBattleSettlementRunner = async (): Promise<void> => {
  await runner.initialize();
};

export const shutdownOnlineBattleSettlementRunner = async (): Promise<void> => {
  await runner.shutdown();
};

export const flushOnlineBattleSettlementTasks = async (
  options?: { onlyArena?: boolean },
): Promise<void> => {
  await runner.flush(options);
};
