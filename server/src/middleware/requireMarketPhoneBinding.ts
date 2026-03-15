import type { NextFunction, Request, Response } from 'express';
import { assertMarketPhoneBindingReady } from '../services/marketPhoneBindingService.js';

/**
 * 坊市手机号绑定守卫
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在进入物品坊市与伙伴坊市前统一校验账号手机号绑定状态。
 * 2. 做什么：把“功能关闭直接放行、功能开启必须已绑定”的规则收敛到单一中间件，避免各个坊市接口重复判断。
 * 3. 不做什么：不解析 JWT，不查询角色 ID，也不处理具体坊市业务。
 *
 * 输入/输出：
 * - 输入：已由上游鉴权中间件注入 `req.userId` 的请求。
 * - 输出：校验通过则调用 `next()`；失败时把异常交给全局错误处理中间件。
 *
 * 数据流/状态流：
 * 市场路由 -> 鉴权中间件 -> 本中间件 -> 手机号绑定服务 -> 继续执行具体接口。
 *
 * 关键边界条件与坑点：
 * 1. 本中间件依赖 `req.userId`，必须放在 `requireAuth/requireCharacter` 之后使用。
 * 2. 这是坊市唯一准入入口，后续新增坊市子接口时必须继续复用本中间件，不能绕开。
 */

export const requireMarketPhoneBinding = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) {
      throw new Error('requireMarketPhoneBinding 必须在鉴权中间件之后使用');
    }

    await assertMarketPhoneBindingReady(userId);
    next();
  } catch (error) {
    next(error);
  }
};
