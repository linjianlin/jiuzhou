/**
 * 离线挂机战斗 HTTP 路由层
 *
 * 作用：
 *   暴露 10 个 REST 端点，供客户端管理挂机会话、查询历史、读写配置。
 *   路由层只负责参数校验、权限检查、调用 Service，不包含业务逻辑。
 *
 * 端点列表：
 *   POST   /api/idle/start              → 启动挂机会话
 *   POST   /api/idle/stop               → 停止挂机会话
 *   GET    /api/idle/status             → 查询当前活跃会话
 *   GET    /api/idle/history            → 查询历史记录（最近 3 条）
 *   GET    /api/idle/history/:id/batches → 查询会话内战斗批次摘要（回放列表）
 *   GET    /api/idle/history/:id/batches/:batchId → 查询单个战斗批次详情（回放日志）
 *   POST   /api/idle/history/:id/viewed → 标记会话已查看
 *   GET    /api/idle/progress           → 断线补全（活跃会话 + 最新批次）
 *   GET    /api/idle/config             → 读取挂机配置
 *   PUT    /api/idle/config             → 更新挂机配置
 *
 * 数据流：
 *   客户端 → requireCharacter → 参数校验 → Service 调用 → JSON 响应
 *
 * 关键边界条件：
 *   1. 所有端点均使用 requireCharacter 中间件，确保 req.characterId 和 req.userId 已注入
 *   2. PUT /config 调用 validateAutoSkillPolicy 校验策略，非法时返回 400 + 字段路径错误
 *   3. maxDurationMs 最小值固定 60_000，最大值取决于当前月卡权益（基础 8 小时，月卡生效时可扩展到 12 小时）
 *   4. GET /progress 返回活跃会话 + 批次摘要列表，供断线重连后补全进度
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter } from '../middleware/auth.js';
import { idleSessionService } from '../services/idle/idleSessionService.js';
import {
  startExecutionLoop,
  requestImmediateStop,
} from '../services/idle/idleBattleExecutorWorker.js';
import { validateAutoSkillPolicy, serializeAutoSkillPolicy } from '../services/idle/autoSkillPolicyCodec.js';
import { reconcileIdleAutoSkillPolicyForCharacter } from '../services/idle/idleAutoSkillPolicy.js';
import { query } from '../config/database.js';
import { getRoomInMap } from '../services/mapService.js';
import { getMonsterDefinitions } from '../services/staticConfigLoader.js';
import type { IdleConfigDto, IdleSessionRow } from '../services/idle/types.js';
import { sendSuccess, sendOk } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';
import {
  isIdleDurationMsWithinLimit,
  MIN_IDLE_DURATION_MS,
  resolveIdleDurationLimitByCharacter,
} from '../services/shared/idleDurationLimits.js';
import { getSingleParam, parseNonEmptyText } from '../services/shared/httpParam.js';
import { toIdleSessionView } from '../services/idle/idleSessionView.js';

// ============================================
// 常量
// ============================================

const router = Router();

function parseIncludePartnerInBattle(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return false;
  }
  return value;
}

// ============================================
// 序列化工具
// ============================================

// ============================================
// POST /start — 启动挂机会话
// ============================================

router.post('/start', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const userId = req.userId!;

  const {
    mapId,
    roomId,
    maxDurationMs,
    autoSkillPolicy,
    targetMonsterDefId,
    includePartnerInBattle,
  } = req.body as Partial<IdleConfigDto>;

  if (!mapId || typeof mapId !== 'string') {
    throw new BusinessError('缺少 mapId');
  }
  if (!roomId || typeof roomId !== 'string') {
    throw new BusinessError('缺少 roomId');
  }
  if (!targetMonsterDefId || typeof targetMonsterDefId !== 'string') {
    throw new BusinessError('缺少 targetMonsterDefId');
  }
  const validatedIncludePartnerInBattle = parseIncludePartnerInBattle(includePartnerInBattle);
  const durationLimit = await resolveIdleDurationLimitByCharacter(characterId);
  const durationMs = Number(maxDurationMs);
  if (!isIdleDurationMsWithinLimit(durationMs, durationLimit.maxDurationMs)) {
    throw new BusinessError(`maxDurationMs 必须在 ${MIN_IDLE_DURATION_MS} ~ ${durationLimit.maxDurationMs} 之间`);
  }

  // 校验 autoSkillPolicy
  const policyValidation = validateAutoSkillPolicy(autoSkillPolicy);
  if (!policyValidation.success) {
    res.status(400).json({ success: false, message: '技能策略非法', errors: policyValidation.errors });
    return;
  }
  const normalizedPolicy = await reconcileIdleAutoSkillPolicyForCharacter(characterId, policyValidation.value);

  // 校验 targetMonsterDefId 属于目标房间
  const room = await getRoomInMap(mapId, roomId);
  if (!room) {
    throw new BusinessError('房间不存在');
  }
  const monsterInRoom = (room.monsters ?? []).some((m) => m.monster_def_id === targetMonsterDefId);
  if (!monsterInRoom) {
    throw new BusinessError('所选怪物不属于该房间');
  }

  const config: IdleConfigDto = {
    mapId,
    roomId,
    maxDurationMs: durationMs,
    autoSkillPolicy: normalizedPolicy,
    targetMonsterDefId,
    includePartnerInBattle: validatedIncludePartnerInBattle,
  };

  const result = await idleSessionService.startIdleSession({ characterId, userId, config });

  if (!result.success) {
    // 已有活跃会话 → 409
    const statusCode = result.existingSessionId ? 409 : 400;
    res.status(statusCode).json({
      success: false,
      message: result.error,
      existingSessionId: result.existingSessionId,
    });
    return;
  }

  // 启动执行循环（异步，不阻塞响应）
  const session = await idleSessionService.getActiveIdleSession(characterId);
  if (session) {
    startExecutionLoop(session, userId);
  }

  sendSuccess(res, { sessionId: result.sessionId });
}));

// ============================================
// POST /stop — 停止挂机会话
// ============================================

router.post('/stop', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;

  const result = await idleSessionService.stopIdleSession(characterId);

  if (!result.success) {
    throw new BusinessError(result.error ?? '停止挂机失败');
  }

  // 立即唤醒执行循环做终止检查，避免等待下一次长延迟 tick。
  for (const sessionId of result.sessionIds ?? []) {
    requestImmediateStop(sessionId);
  }

  sendOk(res);
}));

// ============================================
// GET /status — 查询当前活跃会话
// ============================================

router.get('/status', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;

  const session = await idleSessionService.getActiveIdleSession(characterId);
  sendSuccess(res, { session: session ? toIdleSessionView(session) : null });
}));

// ============================================
// GET /history — 查询历史记录
// ============================================

router.get('/history', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;

  const history = await idleSessionService.getIdleHistory(characterId);
  sendSuccess(res, { history: history.map(toIdleSessionView) });
}));

// ============================================
// GET /history/:id/batches — 查询会话战斗批次摘要（回放列表）
// ============================================

router.get('/history/:id/batches', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const sessionId = parseNonEmptyText(getSingleParam(req.params.id));

  if (!sessionId) {
    throw new BusinessError('缺少 sessionId');
  }

  const batches = await idleSessionService.getSessionBatchSummaries(sessionId, characterId);
  sendSuccess(res, { batches });
}));

// ============================================
// GET /history/:id/batches/:batchId — 查询单个战斗批次详情（回放日志）
// ============================================

router.get('/history/:id/batches/:batchId', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const sessionId = parseNonEmptyText(getSingleParam(req.params.id));
  const batchId = parseNonEmptyText(getSingleParam(req.params.batchId));

  if (!sessionId) {
    throw new BusinessError('缺少 sessionId');
  }
  if (!batchId) {
    throw new BusinessError('缺少 batchId');
  }

  const batch = await idleSessionService.getSessionBatchDetail(sessionId, characterId, batchId);
  sendSuccess(res, { batch });
}));

// ============================================
// POST /history/:id/viewed — 标记会话已查看
// ============================================

router.post('/history/:id/viewed', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const sessionId = parseNonEmptyText(getSingleParam(req.params.id));

  if (!sessionId) {
    throw new BusinessError('缺少 sessionId');
  }

  await idleSessionService.markSessionViewed(sessionId, characterId);
  sendOk(res);
}));

// ============================================
// GET /progress — 断线补全（活跃会话 + 最新批次）
// ============================================

router.get('/progress', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;

  const session = await idleSessionService.getActiveIdleSession(characterId);
  if (!session) {
    sendSuccess(res, { session: null, batches: [] });
    return;
  }

  const batches = await idleSessionService.getSessionBatchSummaries(session.id, characterId);
  sendSuccess(res, { session: toIdleSessionView(session), batches });
}));

// ============================================
// GET /config — 读取挂机配置
// ============================================

router.get('/config', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const durationLimit = await resolveIdleDurationLimitByCharacter(characterId);

  const res2 = await query(
    `SELECT map_id, room_id, max_duration_ms, auto_skill_policy, target_monster_def_id, include_partner_in_battle
     FROM idle_configs WHERE character_id = $1`,
    [characterId],
  );

  if (res2.rows.length === 0) {
    // 未配置时返回默认值
    sendSuccess(res, {
      config: {
        mapId: null,
        roomId: null,
        maxDurationMs: 3_600_000,
        autoSkillPolicy: { slots: [] },
        targetMonsterDefId: null,
        includePartnerInBattle: true,
      },
      maxDurationLimitMs: durationLimit.maxDurationMs,
      monthCardActive: durationLimit.monthCardActive,
    });
    return;
  }

  const row = res2.rows[0] as {
    map_id: string | null;
    room_id: string | null;
    max_duration_ms: string;
    auto_skill_policy: unknown;
    target_monster_def_id: string | null;
    include_partner_in_battle: boolean;
  };
  const persistedPolicyValidation = validateAutoSkillPolicy(row.auto_skill_policy);
  if (!persistedPolicyValidation.success) {
    throw new Error('idle_configs.auto_skill_policy 数据非法');
  }
  const normalizedPolicy = await reconcileIdleAutoSkillPolicyForCharacter(characterId, persistedPolicyValidation.value);
  const normalizedPolicyJson = serializeAutoSkillPolicy(normalizedPolicy);
  if (normalizedPolicyJson !== serializeAutoSkillPolicy(persistedPolicyValidation.value)) {
    await query(
      `
        UPDATE idle_configs
        SET auto_skill_policy = $2::jsonb,
            updated_at = NOW()
        WHERE character_id = $1
      `,
      [characterId, normalizedPolicyJson],
    );
  }
  const persistedDurationMs = Number(row.max_duration_ms);
  const normalizedDurationMs =
    Number.isFinite(persistedDurationMs) && persistedDurationMs > durationLimit.maxDurationMs
      ? durationLimit.maxDurationMs
      : persistedDurationMs;
  // 读取时只裁剪返回值，保留玩家原始偏好，避免月卡到期后永久丢失 12 小时配置。

  sendSuccess(res, {
    config: {
      mapId: row.map_id,
      roomId: row.room_id,
      maxDurationMs: normalizedDurationMs,
      autoSkillPolicy: normalizedPolicy,
      targetMonsterDefId: row.target_monster_def_id,
      includePartnerInBattle: row.include_partner_in_battle,
    },
    maxDurationLimitMs: durationLimit.maxDurationMs,
    monthCardActive: durationLimit.monthCardActive,
  });
}));

// ============================================
// PUT /config — 更新挂机配置
// ============================================

router.put('/config', requireCharacter, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;

  const {
    mapId,
    roomId,
    maxDurationMs,
    autoSkillPolicy,
    targetMonsterDefId,
    includePartnerInBattle,
  } = req.body as Partial<IdleConfigDto>;
  const validatedIncludePartnerInBattle = parseIncludePartnerInBattle(includePartnerInBattle);
  const durationLimit = await resolveIdleDurationLimitByCharacter(characterId);

  // 校验 autoSkillPolicy（必填）
  const policyValidation = validateAutoSkillPolicy(autoSkillPolicy);
  if (!policyValidation.success) {
    res.status(400).json({ success: false, message: '技能策略非法', errors: policyValidation.errors });
    return;
  }
  const normalizedPolicy = await reconcileIdleAutoSkillPolicyForCharacter(characterId, policyValidation.value);

  // maxDurationMs 可选，有值时校验范围
  let validatedDurationMs: number | null = null;
  if (maxDurationMs !== undefined) {
    const durationMs = Number(maxDurationMs);
    if (!isIdleDurationMsWithinLimit(durationMs, durationLimit.maxDurationMs)) {
      throw new BusinessError(`maxDurationMs 必须在 ${MIN_IDLE_DURATION_MS} ~ ${durationLimit.maxDurationMs} 之间`);
    }
    validatedDurationMs = durationMs;
  }

  const policyJson = serializeAutoSkillPolicy(normalizedPolicy);

  await query(
    `INSERT INTO idle_configs (character_id, map_id, room_id, max_duration_ms, auto_skill_policy, target_monster_def_id, include_partner_in_battle, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
     ON CONFLICT (character_id) DO UPDATE SET
       map_id                = EXCLUDED.map_id,
       room_id               = EXCLUDED.room_id,
       max_duration_ms       = EXCLUDED.max_duration_ms,
       auto_skill_policy     = EXCLUDED.auto_skill_policy,
       target_monster_def_id = EXCLUDED.target_monster_def_id,
       include_partner_in_battle = EXCLUDED.include_partner_in_battle,
       updated_at            = NOW()`,
    [
      characterId,
      mapId ?? null,
      roomId ?? null,
      validatedDurationMs ?? 3_600_000,
      policyJson,
      targetMonsterDefId ?? null,
      validatedIncludePartnerInBattle,
    ],
  );

  sendOk(res);
}));

export default router;
