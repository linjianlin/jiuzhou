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
 *   - getIdleHistory：最近 30 条历史记录（倒序）
 *   - markSessionViewed：标记会话已查看（幂等）
 *   - getSessionBatches：查询会话内所有 Battle_Batch（用于回放）
 *
 * 数据流：
 *   客户端 → idleRoutes → startIdleSession → Redis 互斥锁 → DB 写入 → IdleBattleExecutor
 *   IdleBattleExecutor 完成后 → stopIdleSession / 自然结束 → DB 更新 status
 *   客户端上线 → getActiveIdleSession → 断线续战
 *
 * 关键边界条件：
 *   1. Redis 互斥锁键：`idle:lock:{characterId}`，TTL = 本次 maxDurationMs + 5min 缓冲（有上下限）
 *      SET NX EX + compare-and-del 保证并发场景下不会误删他人锁
 *   2. getIdleHistory 超过 30 条时自动删除最旧记录（按 started_at 升序取最旧）
 *   3. markSessionViewed 幂等：已设置 viewed_at 时不重复更新
 *   4. stopIdleSession 仅负责状态持久化；执行器收到 stop 信号后会被立即唤醒做终止检查
 */

import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { redis } from '../../config/redis.js';
import { buildCharacterBattleSnapshot } from '../battle/index.js';
import type {
  IdleConfigDto,
  IdleSessionRow,
  IdleBattleRow,
  SessionSnapshot,
  RewardItemEntry,
} from './types.js';
import { rowToIdleBattleRow, rowToIdleSessionRow } from './rowMappers.js';

// ============================================
// 常量
// ============================================

/** Redis 互斥锁键前缀 */
const IDLE_LOCK_PREFIX = 'idle:lock:';

/** 互斥锁 TTL 缓冲（毫秒） */
const IDLE_LOCK_TTL_BUFFER_MS = 5 * 60 * 1000;

/** 互斥锁 TTL 最小值（秒） */
const IDLE_LOCK_TTL_MIN_SECONDS = 60;

/** 互斥锁 TTL 最大值（秒，8h + 5min） */
const IDLE_LOCK_TTL_MAX_SECONDS = (28_800_000 + IDLE_LOCK_TTL_BUFFER_MS) / 1000;

/** 历史记录最大保留条数 */
const MAX_HISTORY_COUNT = 30;

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

/** 查询角色当前活跃会话 ID（启动冲突判定专用） */
async function findActiveSessionId(characterId: number): Promise<string | undefined> {
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
    const { characterId, config } = params;

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

      // 无活跃会话但拿不到锁：判定为陈旧锁，先做 compare-and-del 再重试一次。
      const currentLockValue = await redis.get(lockKey);
      if (currentLockValue) {
        await compareAndDeleteLock(lockKey, currentLockValue);
      }

      lockAcquired = await tryAcquireStartLock(lockKey, lockToken, lockTtlSeconds);
      if (!lockAcquired) {
        const raceSessionId = await findActiveSessionId(characterId);
        if (raceSessionId) {
          return { success: false, error: '已有活跃挂机会话', existingSessionId: raceSessionId };
        }
        return { success: false, error: '挂机会话正在初始化，请稍后重试' };
      }
    }

    // 2. 快照构建放在事务外，避免长事务占用连接与行锁。
    const snapshotData = await buildCharacterBattleSnapshot(characterId);
    if (!snapshotData) {
      await releaseStartLock(lockKey, lockToken);
      return { success: false, error: '角色数据加载失败' };
    }

    const snapshot: SessionSnapshot = {
      characterId,
      nickname: snapshotData.nickname,
      realm: snapshotData.realm,
      baseAttrs: snapshotData.baseAttrs,
      skills: snapshotData.skills,
      setBonusEffects: snapshotData.setBonusEffects,
      autoSkillPolicy: config.autoSkillPolicy,
      targetMonsterDefId: config.targetMonsterDefId,
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
   * 查询历史记录（最近 30 条，按 started_at 倒序）
   *
   * 超过 30 条时自动删除最旧记录（在同一事务内完成，保证原子性）。
   */
  @Transactional
  async getIdleHistory(characterId: number): Promise<IdleSessionRow[]> {
    // 查询总数
    const countRes = await query(
      `SELECT COUNT(*) AS cnt FROM idle_sessions
       WHERE character_id = $1 AND status IN ('completed', 'interrupted')`,
      [characterId]
    );
    const total = Number(countRes.rows[0]?.cnt ?? 0);

    // 超出上限时删除最旧记录
    if (total > MAX_HISTORY_COUNT) {
      const deleteCount = total - MAX_HISTORY_COUNT;
      await query(
        `DELETE FROM idle_sessions
         WHERE id IN (
           SELECT id FROM idle_sessions
           WHERE character_id = $1 AND status IN ('completed', 'interrupted')
           ORDER BY started_at ASC
           LIMIT $2
         )`,
        [characterId, deleteCount]
      );
    }

    // 查询最近 30 条（倒序）
    const res = await query(
      `SELECT * FROM idle_sessions
       WHERE character_id = $1 AND status IN ('completed', 'interrupted')
       ORDER BY started_at DESC
       LIMIT $2`,
      [characterId, MAX_HISTORY_COUNT]
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
   * 查询会话内所有 Battle_Batch（用于回放，按 batch_index 升序）
   *
   * 权限检查：通过 session_id + character_id 联查，防止越权访问。
   */
  async getSessionBatches(sessionId: string, characterId: number): Promise<IdleBattleRow[]> {
    const res = await query(
      `SELECT b.* FROM idle_battle_batches b
       JOIN idle_sessions s ON s.id = b.session_id
       WHERE b.session_id = $1 AND s.character_id = $2
       ORDER BY b.batch_index ASC`,
      [sessionId, characterId]
    );

    return (res.rows as Record<string, unknown>[]).map(rowToIdleBattleRow);
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
    delta: {
      totalBattlesDelta: number;
      winDelta: number;
      loseDelta: number;
      expDelta: number;
      silverDelta: number;
      newItems: RewardItemEntry[];
      bagFullFlag?: boolean;
    }
  ): Promise<void> {
    const { totalBattlesDelta, winDelta, loseDelta, expDelta, silverDelta, newItems, bagFullFlag } = delta;

    if (newItems.length === 0 && bagFullFlag === undefined) {
      // 无物品更新，直接用原子加法
      await query(
        `UPDATE idle_sessions
         SET total_battles = total_battles + $2,
             win_count     = win_count + $3,
             lose_count    = lose_count + $4,
             total_exp     = total_exp + $5,
             total_silver  = total_silver + $6,
             updated_at    = NOW()
         WHERE id = $1`,
        [sessionId, totalBattlesDelta, winDelta, loseDelta, expDelta, silverDelta]
      );
      return;
    }

    // 有物品更新：先读取现有 reward_items，合并后写回
    const res = await query(
      `SELECT reward_items, bag_full_flag FROM idle_sessions WHERE id = $1`,
      [sessionId]
    );
    if (res.rows.length === 0) return;

    const existing = (res.rows[0].reward_items as RewardItemEntry[]) ?? [];
    const merged = mergeRewardItems(existing, newItems);

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
        bagFullFlag ?? false,
      ]
    );
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
  const map = new Map<string, RewardItemEntry>();
  for (const item of existing) {
    map.set(item.itemDefId, { ...item });
  }
  for (const item of newItems) {
    const prev = map.get(item.itemDefId);
    if (prev) {
      prev.quantity += item.quantity;
    } else {
      map.set(item.itemDefId, { ...item });
    }
  }
  return Array.from(map.values());
}

// ============================================
// 单例导出
// ============================================

export const idleSessionService = new IdleSessionService();
