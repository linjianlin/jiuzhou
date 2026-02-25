/**
 * 离线挂机战斗 HTTP 路由层
 *
 * 作用：
 *   暴露 9 个 REST 端点，供客户端管理挂机会话、查询历史、读写配置。
 *   路由层只负责参数校验、权限检查、调用 Service，不包含业务逻辑。
 *
 * 端点列表：
 *   POST   /api/idle/start              → 启动挂机会话
 *   POST   /api/idle/stop               → 停止挂机会话
 *   GET    /api/idle/status             → 查询当前活跃会话
 *   GET    /api/idle/history            → 查询历史记录（最近 30 条）
 *   GET    /api/idle/history/:id/batches → 查询会话内战斗批次（回放）
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
 *   3. maxDurationMs 合法范围 [60_000, 28_800_000]，超出时返回 400
 *   4. GET /progress 返回活跃会话 + 最新批次列表，供断线重连后补全进度
 */

import { Router, type Request, type Response } from 'express';
import { requireCharacter } from '../middleware/auth.js';
import {
  startIdleSession,
  stopIdleSession,
  getActiveIdleSession,
  getIdleHistory,
  getSessionBatches,
  markSessionViewed,
} from '../services/idle/idleSessionService.js';
import { startExecutionLoop } from '../services/idle/idleBattleExecutor.js';
import { validateAutoSkillPolicy, serializeAutoSkillPolicy } from '../services/idle/autoSkillPolicyCodec.js';
import { query } from '../config/database.js';
import { getRoomInMap } from '../services/mapService.js';
import { getMonsterDefinitions } from '../services/staticConfigLoader.js';
import type { IdleConfigDto, IdleSessionRow } from '../services/idle/types.js';

// ============================================
// 常量
// ============================================

const MIN_DURATION_MS = 60_000;       // 1 分钟
const MAX_DURATION_MS = 28_800_000;   // 8 小时

const router = Router();

// ============================================
// 序列化工具
// ============================================

/**
 * 将 IdleSessionRow 序列化为客户端 DTO
 *
 * 作用：
 *   从 sessionSnapshot 中提取 targetMonsterDefId，并通过 monster_def 解析怪物中文名。
 *   剥离 sessionSnapshot（内含角色属性快照，不应暴露给客户端）。
 *
 * 复用点：所有返回 session 的端点（/status、/history、/progress）统一调用。
 */
function sessionToDto(session: IdleSessionRow): Record<string, unknown> {
  const targetMonsterDefId = session.sessionSnapshot?.targetMonsterDefId ?? null;
  let targetMonsterName: string | null = null;
  if (targetMonsterDefId) {
    const monsterDefs = getMonsterDefinitions();
    const def = monsterDefs.find((m) => m.id === targetMonsterDefId);
    targetMonsterName = def?.name ?? targetMonsterDefId;
  }

  // 解构掉 sessionSnapshot，不暴露给客户端
  const { sessionSnapshot: _snap, ...rest } = session;
  return { ...rest, targetMonsterDefId, targetMonsterName };
}

// ============================================
// POST /start — 启动挂机会话
// ============================================

router.post('/start', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;
  const userId = req.userId!;

  const { mapId, roomId, maxDurationMs, autoSkillPolicy, targetMonsterDefId } = req.body as Partial<IdleConfigDto>;

  if (!mapId || typeof mapId !== 'string') {
    res.status(400).json({ success: false, message: '缺少 mapId' });
    return;
  }
  if (!roomId || typeof roomId !== 'string') {
    res.status(400).json({ success: false, message: '缺少 roomId' });
    return;
  }
  if (!targetMonsterDefId || typeof targetMonsterDefId !== 'string') {
    res.status(400).json({ success: false, message: '缺少 targetMonsterDefId' });
    return;
  }
  const durationMs = Number(maxDurationMs);
  if (!Number.isFinite(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    res.status(400).json({
      success: false,
      message: `maxDurationMs 必须在 ${MIN_DURATION_MS} ~ ${MAX_DURATION_MS} 之间`,
    });
    return;
  }

  // 校验 autoSkillPolicy
  const policyValidation = validateAutoSkillPolicy(autoSkillPolicy);
  if (!policyValidation.success) {
    res.status(400).json({ success: false, message: '技能策略非法', errors: policyValidation.errors });
    return;
  }

  // 校验 targetMonsterDefId 属于目标房间
  const room = await getRoomInMap(mapId, roomId);
  if (!room) {
    res.status(400).json({ success: false, message: '房间不存在' });
    return;
  }
  const monsterInRoom = (room.monsters ?? []).some((m) => m.monster_def_id === targetMonsterDefId);
  if (!monsterInRoom) {
    res.status(400).json({ success: false, message: '所选怪物不属于该房间' });
    return;
  }

  const config: IdleConfigDto = {
    mapId,
    roomId,
    maxDurationMs: durationMs,
    autoSkillPolicy: policyValidation.value,
    targetMonsterDefId,
  };

  const result = await startIdleSession({ characterId, userId, config });

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
  const session = await getActiveIdleSession(characterId);
  if (session) {
    startExecutionLoop(session, userId);
  }

  res.json({ success: true, sessionId: result.sessionId });
});

// ============================================
// POST /stop — 停止挂机会话
// ============================================

router.post('/stop', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;

  const result = await stopIdleSession(characterId);

  if (!result.success) {
    res.status(400).json({ success: false, message: result.error });
    return;
  }

  res.json({ success: true });
});

// ============================================
// GET /status — 查询当前活跃会话
// ============================================

router.get('/status', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;

  const session = await getActiveIdleSession(characterId);
  res.json({ success: true, session: session ? sessionToDto(session) : null });
});

// ============================================
// GET /history — 查询历史记录
// ============================================

router.get('/history', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;

  const history = await getIdleHistory(characterId);
  res.json({ success: true, history: history.map(sessionToDto) });
});

// ============================================
// GET /history/:id/batches — 查询会话战斗批次（回放）
// ============================================

router.get('/history/:id/batches', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;
  const sessionId = String(req.params.id || '');

  if (!sessionId) {
    res.status(400).json({ success: false, message: '缺少 sessionId' });
    return;
  }

  const batches = await getSessionBatches(sessionId, characterId);
  res.json({ success: true, batches });
});

// ============================================
// POST /history/:id/viewed — 标记会话已查看
// ============================================

router.post('/history/:id/viewed', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;
  const sessionId = String(req.params.id || '');

  if (!sessionId) {
    res.status(400).json({ success: false, message: '缺少 sessionId' });
    return;
  }

  await markSessionViewed(sessionId, characterId);
  res.json({ success: true });
});

// ============================================
// GET /progress — 断线补全（活跃会话 + 最新批次）
// ============================================

router.get('/progress', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;

  const session = await getActiveIdleSession(characterId);
  if (!session) {
    res.json({ success: true, session: null, batches: [] });
    return;
  }

  const batches = await getSessionBatches(session.id, characterId);
  res.json({ success: true, session: sessionToDto(session), batches });
});

// ============================================
// GET /config — 读取挂机配置
// ============================================

router.get('/config', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;

  const res2 = await query(
    `SELECT map_id, room_id, max_duration_ms, auto_skill_policy, target_monster_def_id
     FROM idle_configs WHERE character_id = $1`,
    [characterId],
  );

  if (res2.rows.length === 0) {
    // 未配置时返回默认值
    res.json({
      success: true,
      config: {
        mapId: null,
        roomId: null,
        maxDurationMs: 3_600_000,
        autoSkillPolicy: { slots: [] },
        targetMonsterDefId: null,
      },
    });
    return;
  }

  const row = res2.rows[0] as {
    map_id: string | null;
    room_id: string | null;
    max_duration_ms: string;
    auto_skill_policy: unknown;
    target_monster_def_id: string | null;
  };

  res.json({
    success: true,
    config: {
      mapId: row.map_id,
      roomId: row.room_id,
      maxDurationMs: Number(row.max_duration_ms),
      autoSkillPolicy: row.auto_skill_policy,
      targetMonsterDefId: row.target_monster_def_id,
    },
  });
});

// ============================================
// PUT /config — 更新挂机配置
// ============================================

router.put('/config', requireCharacter, async (req: Request, res: Response): Promise<void> => {
  const characterId = req.characterId!;

  const { mapId, roomId, maxDurationMs, autoSkillPolicy, targetMonsterDefId } = req.body as Partial<IdleConfigDto>;

  // 校验 autoSkillPolicy（必填）
  const policyValidation = validateAutoSkillPolicy(autoSkillPolicy);
  if (!policyValidation.success) {
    res.status(400).json({ success: false, message: '技能策略非法', errors: policyValidation.errors });
    return;
  }

  // maxDurationMs 可选，有值时校验范围
  let validatedDurationMs: number | null = null;
  if (maxDurationMs !== undefined) {
    const durationMs = Number(maxDurationMs);
    if (!Number.isFinite(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      res.status(400).json({
        success: false,
        message: `maxDurationMs 必须在 ${MIN_DURATION_MS} ~ ${MAX_DURATION_MS} 之间`,
      });
      return;
    }
    validatedDurationMs = durationMs;
  }

  const policyJson = serializeAutoSkillPolicy(policyValidation.value);

  await query(
    `INSERT INTO idle_configs (character_id, map_id, room_id, max_duration_ms, auto_skill_policy, target_monster_def_id, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
     ON CONFLICT (character_id) DO UPDATE SET
       map_id                = EXCLUDED.map_id,
       room_id               = EXCLUDED.room_id,
       max_duration_ms       = EXCLUDED.max_duration_ms,
       auto_skill_policy     = EXCLUDED.auto_skill_policy,
       target_monster_def_id = EXCLUDED.target_monster_def_id,
       updated_at            = NOW()`,
    [
      characterId,
      mapId ?? null,
      roomId ?? null,
      validatedDurationMs ?? 3_600_000,
      policyJson,
      targetMonsterDefId ?? null,
    ],
  );

  res.json({ success: true });
});

export default router;
