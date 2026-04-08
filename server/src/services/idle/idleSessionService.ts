/**
 * IdleSessionService — 挂机会话生命周期管理
 *
 * 作用：
 *   管理 Idle_Session 的完整生命周期：启动、终止、查询、历史记录、回放数据。
 *   不包含战斗执行逻辑（由 IdleBattleExecutor 负责）。
 *
 * 输入/输出：
 *   - startIdleSession：创建新会话，含互斥锁检查、Stamina 检查、快照写入
 *   - stopIdleSession：将会话标记为 stopping（幂等），并返回被停止的会话 ID 列表
 *   - getActiveIdleSession：查询当前活跃会话（用于断线续战）
 *   - getIdleHistory：最近 3 条历史记录（倒序）
 *   - markSessionViewed：标记会话已查看（幂等）
 *   - getSessionBatchSummaries：查询会话内所有 Battle_Batch 摘要（用于回放列表）
 *   - getSessionBatchDetail：查询单个 Battle_Batch 详情（用于回放日志）
 *
 * 数据流：
 *   客户端 → idleRoutes → startIdleSession → Redis 互斥锁 → DB 写入 → IdleBattleExecutor
 *   IdleBattleExecutor 完成后 → stopIdleSession / 自然结束 → DB 更新 status
 *   客户端上线 → getActiveIdleSession → 断线续战
 *
 * 关键边界条件：
 *   1. Redis 互斥锁键：`idle:lock:{characterId}`，TTL = 本次 maxDurationMs + 5min 缓冲（有上下限）
 *      SET NX EX + compare-and-del 保证并发场景下不会误删他人锁
 *   2. getIdleHistory 超过 3 条时自动删除最旧记录（按 started_at 升序取最旧）
 *   3. markSessionViewed 幂等：已设置 viewed_at 时不重复更新
 *   4. stopIdleSession 仅负责状态持久化；执行器收到 stop 信号后会被立即唤醒做终止检查
 */

import { randomUUID } from 'crypto';
import { query, withTransactionAuto } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { redis } from '../../config/redis.js';
import { buildCharacterBattleSnapshot } from '../battle/index.js';
import { partnerService } from '../partnerService.js';
import type {
  IdleConfigDto,
  IdleSessionRow,
  IdleBattleDetailRow,
  IdleBattleSummaryRow,
  SessionSnapshot,
  RewardItemEntry,
} from './types.js';
import {
  rowToIdleBattleStoredDetailRow,
  rowToIdleBattleSummaryRow,
  rowToIdleSessionRow,
} from './rowMappers.js';
import { replayIdleBattleLogs } from './idleBattleSimulationCore.js';
import { getIdleExecutionLoopHeartbeatAt } from './idleExecutionRegistry.js';
import {
  resolveOrphanStoppingSessionIds,
  type IdleSessionActivitySnapshot,
} from './idleSessionActivity.js';
import { resolveIdleMaxDurationMs } from '../shared/idleDurationLimits.js';
import {
  mergeRewardItems as mergeIdleRewardItems,
  type IdleSessionSummaryDelta,
  type IdleSessionSummarySnapshot,
} from './idleSessionSummary.js';
import {
  IDLE_FINISHED_SESSION_STATUSES,
  IDLE_HISTORY_KEEP_SESSION_COUNT,
} from './idleHistoryRetention.js';

// ============================================
// 常量
// ============================================

/** Redis 互斥锁键前缀 */
const IDLE_LOCK_PREFIX = 'idle:lock:';

/** 互斥锁 TTL 缓冲（毫秒） */
const IDLE_LOCK_TTL_BUFFER_MS = 5 * 60 * 1000;

/** 互斥锁 TTL 最小值（秒） */
const IDLE_LOCK_TTL_MIN_SECONDS = 60;

/** 互斥锁 TTL 最大值（秒，按当前最高挂机上限 + 5min 计算） */
const IDLE_LOCK_TTL_MAX_SECONDS = (resolveIdleMaxDurationMs(true) + IDLE_LOCK_TTL_BUFFER_MS) / 1000;

// ============================================
// 内部工具
// ============================================

/** 构造 Redis 互斥锁键 */
function idleLockKey(characterId: number): string {
  return `${IDLE_LOCK_PREFIX}${characterId}`;
}

/** 根据本次挂机时长计算锁 TTL（防止短时挂机失败后锁残留过久） */
function idleLockTtlSeconds(maxDurationMs: number): number {
  const ttl = Math.ceil((maxDurationMs + IDLE_LOCK_TTL_BUFFER_MS) / 1000);
  return Math.min(IDLE_LOCK_TTL_MAX_SECONDS, Math.max(IDLE_LOCK_TTL_MIN_SECONDS, ttl));
}

/** 归一化角色ID数组：仅保留正整数并去重，供批量 SQL 查询复用。 */
function normalizeCharacterIds(characterIds: number[]): number[] {
  const normalized = new Set<number>();
  for (const rawCharacterId of characterIds) {
    const characterId = Math.floor(Number(rawCharacterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    normalized.add(characterId);
  }
  return Array.from(normalized.values());
}

/**
 * 收敛“同一角色存在多条 active/stopping 会话”的异常状态。
 *
 * 作用：
 *   历史竞态可能为同一角色写出多条活跃会话；这里统一保留最新一条，
 *   其余全部改为 interrupted，避免多个执行循环持续争抢同一角色的背包互斥锁。
 *
 * 边界条件：
 *   1. 仅处理 `status IN ('active', 'stopping')` 的重复会话，不触碰历史会话。
 *   2. 保留规则固定为 `started_at DESC, id DESC` 的第一条，确保所有调用点口径一致。
 */
async function collapseDuplicateActiveSessions(characterIds: number[]): Promise<void> {
  const normalizedCharacterIds = normalizeCharacterIds(characterIds);
  if (normalizedCharacterIds.length === 0) {
    return;
  }

  const res = await query(
    `
      WITH ranked_sessions AS (
        SELECT
          id,
          character_id,
          ROW_NUMBER() OVER (
            PARTITION BY character_id
            ORDER BY started_at DESC, id DESC
          ) AS rn
        FROM idle_sessions
        WHERE character_id = ANY($1::int[])
          AND status IN ('active', 'stopping')
      )
      SELECT id, rn
      FROM ranked_sessions
      WHERE rn > 1
    `,
    [normalizedCharacterIds],
  );

  const duplicatedSessionIds = res.rows.map((row) => String(row.id));
  if (duplicatedSessionIds.length === 0) {
    return;
  }

  await query(
    `
      UPDATE idle_sessions
      SET status = 'interrupted',
          ended_at = NOW(),
          updated_at = NOW()
      WHERE id = ANY($1::uuid[])
    `,
    [duplicatedSessionIds],
  );
}

/**
 * 收敛没有执行循环承接的 stopping 会话。
 *
 * 作用：
 *   服务端在读取“当前活跃挂机状态”前先做一次自愈，避免孤儿 stopping 会话长期
 *   被 `/status`、启动互斥和组队互斥误判成仍在挂机。
 *
 * 边界条件：
 *   1. 只处理 status='stopping' 的会话，不会误伤 active 会话。
 *   2. 只要执行循环仍在注册表内，就视为正在正常收尾，不提前强制结束。
 */
async function settleOrphanStoppingSessions(characterIds: number[]): Promise<void> {
  const normalizedCharacterIds = normalizeCharacterIds(characterIds);
  if (normalizedCharacterIds.length === 0) {
    return;
  }

  await collapseDuplicateActiveSessions(normalizedCharacterIds);

  const res = await query(
    `SELECT id, character_id, status
     FROM idle_sessions
     WHERE character_id = ANY($1::int[])
       AND status = 'stopping'`,
    [normalizedCharacterIds],
  );

  if (res.rows.length === 0) {
    return;
  }

  const stoppingSessions: IdleSessionActivitySnapshot[] = (res.rows as Array<{ id: unknown; character_id: unknown; status: unknown }>).map((row) => ({
    id: String(row.id),
    characterId: Number(row.character_id),
    status: row.status as IdleSessionRow['status'],
  }));
  const orphanSessionIds = resolveOrphanStoppingSessionIds(
    stoppingSessions,
    getIdleExecutionLoopHeartbeatAt,
  );

  if (orphanSessionIds.length === 0) {
    return;
  }

  await query(
    `UPDATE idle_sessions
     SET status = 'interrupted',
         ended_at = NOW(),
         updated_at = NOW()
     WHERE id = ANY($1::uuid[])`,
    [orphanSessionIds],
  );

  const orphanSessionIdSet = new Set(orphanSessionIds);
  const orphanCharacterIds = Array.from(new Set(
    stoppingSessions
      .filter((session) => orphanSessionIdSet.has(session.id))
      .map((session) => session.characterId),
  ));

  if (orphanCharacterIds.length > 0) {
    await redis.del(...orphanCharacterIds.map(idleLockKey));
  }
}

/** 查询角色当前活跃会话 ID（启动冲突判定专用） */
async function findActiveSessionId(characterId: number): Promise<string | undefined> {
  await settleOrphanStoppingSessions([characterId]);
  const existingRes = await query(
    `SELECT id FROM idle_sessions
     WHERE character_id = $1 AND status IN ('active', 'stopping')
     ORDER BY started_at DESC
     LIMIT 1`,
    [characterId]
  );
  return existingRes.rows[0] ? String(existingRes.rows[0].id) : undefined;
}

/** 比较并删除锁（仅当当前 value 与期望值一致时删除） */
async function compareAndDeleteLock(lockKey: string, expectedValue: string): Promise<boolean> {
  const deleted = await redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
       return redis.call('DEL', KEYS[1])
     end
     return 0`,
    1,
    lockKey,
    expectedValue
  );
  return Number(deleted) === 1;
}

/** 尝试获取启动锁（使用 token 防止并发误删） */
async function tryAcquireStartLock(lockKey: string, lockToken: string, ttlSeconds: number): Promise<boolean> {
  const lockAcquired = await redis.set(lockKey, lockToken, 'EX', ttlSeconds, 'NX');
  return lockAcquired === 'OK';
}

/** 仅在持有 token 时释放启动锁 */
async function releaseStartLock(lockKey: string, lockToken: string): Promise<void> {
  await compareAndDeleteLock(lockKey, lockToken);
}

// ============================================
// 类型定义
// ============================================

export interface StartIdleSessionParams {
  characterId: number;
  userId: number;
  config: IdleConfigDto;
}

export interface StartIdleSessionResult {
  success: boolean;
  sessionId?: string;
  error?: string;
  /** 409 时返回现有会话 ID */
  existingSessionId?: string;
}

export interface StopIdleSessionResult {
  success: boolean;
  error?: string;
  /** 本次请求命中的会话 ID 列表（可能为 1 个；异常并发场景可能 > 1） */
  sessionIds?: string[];
}

// ============================================
// IdleSessionService Class
// ============================================

/**
 * IdleSessionService — 挂机会话生命周期管理 class
 *
 * 作用：
 *   管理 Idle_Session 的完整生命周期：启动、终止、查询、历史记录、回放数据。
 *   使用 @Transactional 装饰器自动管理事务。
 */
class IdleSessionService {
  /**
   * 启动挂机会话
   *
   * 步骤：
   *   1. Redis SET NX EX 互斥锁检查（原子性，防并发）
   *   2. 事务外：构建角色快照（避免长事务）
   *   3. 事务内：角色行锁 + 会话写入
   *   4. 返回新会话 ID
   *
   * 失败场景：
   *   - 已有活跃会话 → success: false, error: '已有活跃挂机会话', existingSessionId
   *   - 角色不存在 → success: false, error: '角色不存在'
   */
  @Transactional
  async startIdleSession(params: StartIdleSessionParams): Promise<StartIdleSessionResult> {
    const { characterId, userId, config } = params;

    // 0. 组队中禁止挂机：查询 team_members 表判断角色是否在队伍中
    const teamCheck = await query(
      `SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1`,
      [characterId]
    );
    if (teamCheck.rows.length > 0) {
      return { success: false, error: '组队中无法进行离线挂机，请先退出队伍' };
    }

    const lockKey = idleLockKey(characterId);
    const lockToken = `idle-start:${randomUUID()}`;
    const lockTtlSeconds = idleLockTtlSeconds(config.maxDurationMs);

    // 1. 尝试获取 Redis 互斥锁（SET NX EX）
    let lockAcquired = await tryAcquireStartLock(lockKey, lockToken, lockTtlSeconds);
    if (!lockAcquired) {
      const existingSessionId = await findActiveSessionId(characterId);
      if (existingSessionId) {
        return { success: false, error: '已有活跃挂机会话', existingSessionId };
      }
      return { success: false, error: '挂机会话正在初始化，请稍后重试' };
    }

    // 2. 快照构建放在事务外，避免长事务占用连接与行锁。
    const snapshotData = await buildCharacterBattleSnapshot(characterId);
    if (!snapshotData) {
      await releaseStartLock(lockKey, lockToken);
      return { success: false, error: '角色数据加载失败' };
    }

    const partnerBattleMember = await partnerService.buildConfiguredPartnerBattleMember({
      characterId,
      enabled: config.includePartnerInBattle,
    });

    const snapshot: SessionSnapshot = {
      characterId,
      nickname: snapshotData.nickname,
      realm: snapshotData.realm,
      baseAttrs: snapshotData.baseAttrs,
      skills: snapshotData.skills,
      setBonusEffects: snapshotData.setBonusEffects,
      autoSkillPolicy: config.autoSkillPolicy,
      targetMonsterDefId: config.targetMonsterDefId,
      includePartnerInBattle: config.includePartnerInBattle,
      partnerBattleMember,
    };

    try {
      // 3. 角色行锁（防止会话创建期间角色被并发变更）
      const charRes = await query(
        `SELECT id FROM characters WHERE id = $1 FOR UPDATE`,
        [characterId]
      );
      if (charRes.rows.length === 0) {
        await releaseStartLock(lockKey, lockToken);
        return { success: false, error: '角色不存在' };
      }

      // 角色行锁到手后再次复检活跃会话，彻底堵住同角色并发 start 写出多条 active 的竞态。
      const activeSessionRes = await query(
        `SELECT id
         FROM idle_sessions
         WHERE character_id = $1
           AND status IN ('active', 'stopping')
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
        [characterId],
      );
      if (activeSessionRes.rows.length > 0) {
        await releaseStartLock(lockKey, lockToken);
        return {
          success: false,
          error: '已有活跃挂机会话',
          existingSessionId: String(activeSessionRes.rows[0]?.id),
        };
      }

      // 4. 写入 idle_sessions
      const sessionId = randomUUID();
      await query(
        `INSERT INTO idle_sessions (
          id, character_id, status, map_id, room_id, max_duration_ms,
          session_snapshot, total_battles, win_count, lose_count,
          total_exp, total_silver, reward_items, bag_full_flag,
          started_at, ended_at, viewed_at
        ) VALUES (
          $1, $2, 'active', $3, $4, $5,
          $6, 0, 0, 0,
          0, 0, '[]', false,
          NOW(), NULL, NULL
        )`,
        [
          sessionId,
          characterId,
          config.mapId,
          config.roomId,
          config.maxDurationMs,
          JSON.stringify(snapshot),
        ]
      );

      return { success: true, sessionId };
    } catch (err) {
      await releaseStartLock(lockKey, lockToken);
      throw err;
    }
  }

  /**
   * 终止挂机会话（标记为 stopping）
   *
   * 只将 status 改为 stopping，执行循环在下一场战斗完成后检查此状态并自然退出。
   * 若会话不存在或不属于该角色，返回 success: false。
   */
  async stopIdleSession(characterId: number): Promise<StopIdleSessionResult> {
    const res = await query(
      `UPDATE idle_sessions
       SET status = 'stopping', updated_at = NOW()
       WHERE character_id = $1 AND status IN ('active', 'stopping')
       RETURNING id`,
      [characterId]
    );

    if (res.rows.length === 0) {
      return { success: false, error: '没有活跃的挂机会话' };
    }
    return { success: true, sessionIds: res.rows.map((row) => String(row.id)) };
  }

  /**
   * 查询当前活跃会话（status IN ('active', 'stopping')）
   * 用于断线续战和状态同步。
   */
  async getActiveIdleSession(characterId: number): Promise<IdleSessionRow | null> {
    await settleOrphanStoppingSessions([characterId]);
    const res = await query(
      `SELECT * FROM idle_sessions
       WHERE character_id = $1 AND status IN ('active', 'stopping')
       ORDER BY started_at DESC
       LIMIT 1`,
      [characterId]
    );

    if (res.rows.length === 0) return null;
    return rowToIdleSessionRow(res.rows[0] as Record<string, unknown>);
  }

  /**
   * 批量查询“当前处于活跃挂机状态”的角色集合。
   *
   * 作用：
   *   统一封装“角色是否在挂机中（active/stopping）”的批量判定逻辑，
   *   并改为只读取 Redis 挂机锁投影，避免在线战斗请求链回落 DB。
   *
   * 输入/输出：
   *   - 输入：characterIds（可能包含重复值、非整数、无效值）
   *   - 输出：Set<number>（仅包含正整数角色ID，自动去重）
   *
   * 数据流：
   *   调用方角色ID数组 → normalizeCharacterIds → Redis mget 挂机锁
   *   → 结果二次过滤 → 返回活跃挂机角色ID集合。
   *
   * 关键边界条件：
   *   1. 输入数组为空或全为非法值时，直接返回空集合，不触发 SQL 查询。
   *   2. 仅认定存在有效挂机锁的角色为“挂机中”；请求链不再回退 DB 校验。
   */
  async getActiveIdleCharacterIdSet(characterIds: number[]): Promise<Set<number>> {
    const normalizedCharacterIds = normalizeCharacterIds(characterIds);
    if (normalizedCharacterIds.length === 0) {
      return new Set<number>();
    }

    const activeIdleCharacterIdSet = new Set<number>();
    const lockValues = await redis.mget(
      ...normalizedCharacterIds.map(idleLockKey),
    );
    for (let index = 0; index < normalizedCharacterIds.length; index += 1) {
      const characterId = normalizedCharacterIds[index]!;
      const lockValue = lockValues[index];
      if (typeof lockValue !== 'string' || lockValue.length <= 0) continue;
      activeIdleCharacterIdSet.add(characterId);
    }

    return activeIdleCharacterIdSet;
  }

  /**
   * 收敛全量活跃挂机会话中的重复角色。
   *
   * 作用：
   *   给服务启动恢复链路提供统一自愈入口，避免历史脏数据在重启后再次恢复出多条执行循环。
   *
   * 边界条件：
   *   1. 仅处理当前仍是 active/stopping 的角色集合，空集合直接返回。
   *   2. 这里只做会话状态收敛，不负责执行循环的启动与停止。
   */
  async settleAllDuplicateActiveSessions(): Promise<void> {
    const res = await query<{ character_id: number | string }>(
      `
        SELECT DISTINCT character_id
        FROM idle_sessions
        WHERE status IN ('active', 'stopping')
      `,
    );
    await collapseDuplicateActiveSessions(
      res.rows.map((row) => Number(row.character_id)),
    );
  }

  /**
   * 按会话 ID 查询会话（用于执行循环做精确终止判定）
   */
  async getIdleSessionById(sessionId: string): Promise<IdleSessionRow | null> {
    const res = await query(
      `SELECT * FROM idle_sessions
       WHERE id = $1
       LIMIT 1`,
      [sessionId]
    );

    if (res.rows.length === 0) return null;
    return rowToIdleSessionRow(res.rows[0] as Record<string, unknown>);
  }

  /**
   * 查询历史记录（最近 3 条，按 started_at 倒序）
   *
   * 超过 3 条时自动删除最旧记录（在同一事务内完成，保证原子性）。
   */
  @Transactional
  async getIdleHistory(characterId: number): Promise<IdleSessionRow[]> {
    // 查询总数
    const countRes = await query(
      `SELECT COUNT(*) AS cnt FROM idle_sessions
       WHERE character_id = $1 AND status = ANY($2::varchar[])`,
      [characterId, IDLE_FINISHED_SESSION_STATUSES]
    );
    const total = Number(countRes.rows[0]?.cnt ?? 0);

    // 超出上限时删除最旧记录
    if (total > IDLE_HISTORY_KEEP_SESSION_COUNT) {
      const deleteCount = total - IDLE_HISTORY_KEEP_SESSION_COUNT;
      await query(
        `DELETE FROM idle_sessions
         WHERE id IN (
           SELECT id FROM idle_sessions
           WHERE character_id = $1 AND status = ANY($2::varchar[])
           ORDER BY started_at ASC, id ASC
           LIMIT $3
         )`,
        [characterId, IDLE_FINISHED_SESSION_STATUSES, deleteCount]
      );
    }

    // 查询最近 3 条（倒序）
    const res = await query(
      `SELECT * FROM idle_sessions
       WHERE character_id = $1 AND status = ANY($2::varchar[])
       ORDER BY started_at DESC, id DESC
       LIMIT $3`,
      [characterId, IDLE_FINISHED_SESSION_STATUSES, IDLE_HISTORY_KEEP_SESSION_COUNT]
    );
    return (res.rows as Record<string, unknown>[]).map(rowToIdleSessionRow);
  }

  /**
   * 标记会话为已查看（幂等：已设置 viewed_at 时不重复更新）
   *
   * 权限检查：通过 character_id 过滤，防止越权访问。
   */
  async markSessionViewed(sessionId: string, characterId: number): Promise<void> {
    await query(
      `UPDATE idle_sessions
       SET viewed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND character_id = $2 AND viewed_at IS NULL`,
      [sessionId, characterId]
    );
  }

  /**
   * 查询会话内所有 Battle_Batch 摘要（用于回放左侧列表，按 batch_index 升序）
   *
   * 权限检查：通过 session_id + character_id 联查，防止越权访问。
   */
  async getSessionBatchSummaries(
    sessionId: string,
    characterId: number,
  ): Promise<IdleBattleSummaryRow[]> {
    const res = await query(
      `SELECT
         b.id,
         b.session_id,
         b.batch_index,
         b.result,
         b.round_count,
         b.exp_gained,
         b.silver_gained,
         jsonb_array_length(b.items_gained) AS item_count,
         b.executed_at
       FROM idle_battle_batches b
       JOIN idle_sessions s ON s.id = b.session_id
       WHERE b.session_id = $1 AND s.character_id = $2
       ORDER BY b.batch_index ASC`,
      [sessionId, characterId],
    );

    return (res.rows as Record<string, unknown>[]).map(rowToIdleBattleSummaryRow);
  }

  /**
   * 查询单个 Battle_Batch 详情（用于回放右侧日志面板）
   *
   * 权限检查：通过 session_id + character_id 联查，防止越权访问。
   */
  async getSessionBatchDetail(
    sessionId: string,
    characterId: number,
    batchId: string,
  ): Promise<IdleBattleDetailRow | null> {
    const res = await query(
      `SELECT
         b.id,
         b.session_id,
         b.batch_index,
         b.result,
         b.round_count,
         b.random_seed,
         b.exp_gained,
         b.silver_gained,
         jsonb_array_length(b.items_gained) AS item_count,
         b.items_gained,
         b.battle_log,
         b.monster_ids,
         b.executed_at
       FROM idle_battle_batches b
       JOIN idle_sessions s ON s.id = b.session_id
       WHERE b.session_id = $1
         AND s.character_id = $2
         AND b.id = $3
       LIMIT 1`,
      [sessionId, characterId, batchId],
    );

    if (res.rows.length === 0) return null;
    const storedRow = rowToIdleBattleStoredDetailRow(
      res.rows[0] as Record<string, unknown>,
    );
    return {
      ...storedRow,
      battleLog: replayIdleBattleLogs(storedRow.battleReplaySnapshot),
    };
  }

  /**
   * 释放 Redis 互斥锁（由 IdleBattleExecutor 在会话结束时调用）
   */
  async releaseIdleLock(characterId: number): Promise<void> {
    await redis.del(idleLockKey(characterId));
  }

  /**
   * 将会话标记为已完成（由 IdleBattleExecutor 调用）
   *
   * 同时更新 ended_at，供历史记录展示。
   */
  async completeIdleSession(
    sessionId: string,
    status: 'completed' | 'interrupted'
  ): Promise<void> {
    await query(
      `UPDATE idle_sessions
       SET status = $2, ended_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [sessionId, status]
    );
  }

  /**
   * 累加更新会话汇总字段（由 IdleBattleExecutor 在每场战斗完成后调用）
   *
   * 使用 SQL 原子加法，避免并发覆盖。
   * rewardItems 合并逻辑：将新物品追加到现有 JSONB 数组（按 itemDefId 合并数量）。
   */
  async updateSessionSummary(
    sessionId: string,
    delta: IdleSessionSummaryDelta,
    snapshot?: IdleSessionSummarySnapshot,
  ): Promise<void> {
    const {
      totalBattlesDelta,
      winDelta,
      loseDelta,
      expDelta,
      silverDelta,
      newItems,
      bagFullFlag,
    } = delta;

    await withTransactionAuto(async () => {
      if (snapshot) {
        await query(
          `UPDATE idle_sessions
           SET total_battles = total_battles + $2,
               win_count     = win_count + $3,
               lose_count    = lose_count + $4,
               total_exp     = total_exp + $5,
               total_silver  = total_silver + $6,
               reward_items  = $7,
               bag_full_flag = $8,
               updated_at    = NOW()
           WHERE id = $1`,
          [
            sessionId,
            totalBattlesDelta,
            winDelta,
            loseDelta,
            expDelta,
            silverDelta,
            JSON.stringify(snapshot.rewardItems),
            snapshot.bagFullFlag,
          ],
        );
        return;
      }

      if (newItems.length === 0) {
        await query(
          `UPDATE idle_sessions
           SET total_battles = total_battles + $2,
               win_count     = win_count + $3,
               lose_count    = lose_count + $4,
               total_exp     = total_exp + $5,
               total_silver  = total_silver + $6,
               bag_full_flag = CASE WHEN $7 THEN true ELSE bag_full_flag END,
               updated_at    = NOW()
           WHERE id = $1`,
          [sessionId, totalBattlesDelta, winDelta, loseDelta, expDelta, silverDelta, bagFullFlag],
        );
        return;
      }

      const res = await query(
        `SELECT reward_items
         FROM idle_sessions
         WHERE id = $1
         FOR UPDATE`,
        [sessionId],
      );
      if (res.rows.length === 0) {
        return;
      }

      const existing = (res.rows[0].reward_items as RewardItemEntry[]) ?? [];
      const merged = mergeIdleRewardItems(existing, newItems);

      await query(
        `UPDATE idle_sessions
         SET total_battles = total_battles + $2,
             win_count     = win_count + $3,
             lose_count    = lose_count + $4,
             total_exp     = total_exp + $5,
             total_silver  = total_silver + $6,
             reward_items  = $7,
             bag_full_flag = CASE WHEN $8 THEN true ELSE bag_full_flag END,
             updated_at    = NOW()
         WHERE id = $1`,
        [
          sessionId,
          totalBattlesDelta,
          winDelta,
          loseDelta,
          expDelta,
          silverDelta,
          JSON.stringify(merged),
          bagFullFlag,
        ],
      );
    });
  }
}

/**
 * 合并奖励物品列表（按 itemDefId 累加数量）
 * 纯函数，无副作用，便于测试。
 */
export function mergeRewardItems(
  existing: RewardItemEntry[],
  newItems: RewardItemEntry[]
): RewardItemEntry[] {
  return mergeIdleRewardItems(existing, newItems);
}

// ============================================
// 单例导出
// ============================================

export const idleSessionService = new IdleSessionService();
