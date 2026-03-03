/**
 * 悟道路由
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：暴露悟道总览与注入接口，统一参数校验与响应格式。
 * 2) 不做什么：不承载悟道业务公式，不直接操作数据库。
 *
 * 输入/输出：
 * - 输入：HTTP 请求（鉴权后 userId，注入等级 levels）。
 * - 输出：标准业务响应 `{ success, message, data }`。
 *
 * 数据流/状态流：
 * router -> insightService -> sendResult -> （成功时）safePushCharacterUpdate。
 *
 * 关键边界条件与坑点：
 * 1) levels 必须是 1~100 的整数；非法值直接返回业务失败，不进入 service 写逻辑。
 * 2) 注入成功后必须推送角色刷新事件，避免客户端经验与属性展示滞后。
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { sendResult } from '../middleware/response.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { insightService } from '../services/insightService.js';

const router = Router();

router.use(requireAuth);

router.get('/overview', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const result = await insightService.getOverview(userId);
  return sendResult(res, result);
}));

router.post('/inject', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const body = (req.body ?? {}) as { levels?: unknown };
  const levels = Number(body.levels);
  if (!Number.isInteger(levels) || levels < 1 || levels > 100) {
    const invalidResult = {
      success: false,
      message: 'levels 参数无效，需为 1~100 的整数',
    };
    return sendResult(res, invalidResult);
  }

  const result = await insightService.injectExp(userId, { levels });
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

export default router;
