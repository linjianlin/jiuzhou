import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter } from '../middleware/auth.js';
import { sendResult } from '../middleware/response.js';
import { enqueueWanderGenerationJob } from '../services/wanderJobRunner.js';
import { wanderService } from '../services/wander/service.js';

/**
 * 云游奇遇路由
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：提供云游奇遇概览、生成与选项确认接口。
 * 2. 做什么：只负责角色鉴权、读取参数并透传到云游服务。
 * 3. 不做什么：不重复实现冷却校验、AI 调用或正式称号发放逻辑。
 *
 * 输入/输出：
 * - 输入：已登录且已创建角色的请求；确认接口额外接收 `episodeId` 与 `optionIndex`。
 * - 输出：统一 `{ success, message, data }` 响应。
 *
 * 数据流/状态流：
 * 前端弹窗 -> `/api/wander/*` -> `wanderService` -> 返回云游概览/剧情结果。
 *
 * 关键边界条件与坑点：
 * 1. 所有接口都依赖 `requireCharacter`，因此游客态和未建角账号不会进入云游逻辑。
 * 2. 入口层只做鉴权与参数透传，开放策略与冷却规则统一下沉到共享规则和服务层，避免重复判断。
 */

const router = Router();
router.use(requireCharacter);

router.get('/overview', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await wanderService.getOverview(characterId);
  sendResult(res, result);
}));

router.post('/generate', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await wanderService.createGenerationJob(characterId);
  if (!result.success || !result.data) {
    sendResult(res, result);
    return;
  }

  try {
    await enqueueWanderGenerationJob({
      characterId,
      generationId: result.data.job.generationId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知异常';
    await wanderService.markGenerationJobFailed(characterId, result.data.job.generationId, `云游任务投递失败：${reason}`);
    sendResult(res, {
      success: false,
      message: '云游启动失败，请稍后重试',
    });
    return;
  }

  sendResult(res, result);
}));

router.post('/choose', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = req.body as { episodeId?: string; optionIndex?: number | string };
  const episodeId = typeof body.episodeId === 'string' ? body.episodeId.trim() : '';
  const optionIndex = typeof body.optionIndex === 'string' ? Number(body.optionIndex) : Number(body.optionIndex);
  const result = await wanderService.chooseEpisode(characterId, episodeId, optionIndex);
  if (!result.success || !result.data) {
    sendResult(res, result);
    return;
  }

  try {
    await enqueueWanderGenerationJob({
      characterId,
      generationId: result.data.job.generationId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知异常';
    await wanderService.markGenerationJobFailed(characterId, result.data.job.generationId, `云游结算任务投递失败：${reason}`);
    sendResult(res, {
      ...result,
      message: '抉择已记录，但尾声推演启动失败，可稍后重试',
    });
    return;
  }

  sendResult(res, result);
}));

export default router;
