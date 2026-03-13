/**
 * 通用 Redis QPS 限流中间件
 *
 * 1. 做什么：基于 Redis 固定时间窗统计指定作用域键的请求次数，为需要限流的 HTTP 路由提供统一 QPS 控制。
 * 2. 不做什么：不负责鉴权，不决定业务接口分组，不在 Redis 异常时做兜底降级。
 *
 * 输入：
 * - `keyPrefix`：限流键前缀，用于区分不同业务路由组。
 * - `limit` / `windowMs`：固定时间窗内允许通过的最大请求数。
 * - `resolveScope`：从请求中解析限流维度（如 `userId`）。
 *
 * 输出：
 * - 未超限：调用 `next()` 进入后续中间件/路由处理器。
 * - 已超限：返回 `429` 与标准 `{ success: false, message }` 响应。
 *
 * 数据流：
 * - route -> resolveScope(req) -> 生成 Redis key -> INCR 计数 -> 判定是否超限 -> next()/429
 *
 * 关键边界条件与坑点：
 * 1. 这里使用固定时间窗而不是滑动时间窗，秒级 QPS 控制足够直接，且能避免在多个坊市接口里重复维护更复杂的算法。
 * 2. `resolveScope` 必须返回稳定且非空的作用域键；本模块不猜测身份来源，调用方应在鉴权中间件之后挂载。
 * 3. Redis 异常会直接抛给全局错误处理中间件；按项目约束不增加 fallback 分支，保证限流语义明确。
 */
import type { Request, RequestHandler } from 'express';
import { redis } from '../config/redis.js';

type QpsLimitScope = string | number;

type QpsLimitOptions = {
  keyPrefix: string;
  limit: number;
  windowMs: number;
  message?: string;
  resolveScope: (req: Request) => QpsLimitScope;
};

const DEFAULT_LIMIT_MESSAGE = '请求过于频繁，请稍后再试';

const assertPositiveInteger = (value: number, fieldName: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} 必须是正整数`);
  }
  return value;
};

const normalizeScopeKey = (scope: QpsLimitScope): string => {
  if (typeof scope === 'number') {
    if (!Number.isInteger(scope) || scope <= 0) {
      throw new Error('QPS 限流作用域必须是正整数');
    }
    return String(scope);
  }

  const normalizedScope = scope.trim();
  if (!normalizedScope) {
    throw new Error('QPS 限流作用域不能为空字符串');
  }
  return normalizedScope;
};

export const createQpsLimitMiddleware = (options: QpsLimitOptions): RequestHandler => {
  const limit = assertPositiveInteger(options.limit, 'limit');
  const windowMs = assertPositiveInteger(options.windowMs, 'windowMs');
  const keyPrefix = options.keyPrefix.trim();
  if (!keyPrefix) {
    throw new Error('keyPrefix 不能为空');
  }

  const limitMessage = options.message?.trim() || DEFAULT_LIMIT_MESSAGE;

  return async (req, res, next) => {
    const scopeKey = normalizeScopeKey(options.resolveScope(req));
    const currentWindow = Math.floor(Date.now() / windowMs);
    const redisKey = `${keyPrefix}:${scopeKey}:${currentWindow}`;
    const requestCount = await redis.incr(redisKey);

    if (requestCount === 1) {
      await redis.pexpire(redisKey, windowMs * 2);
    }

    if (requestCount > limit) {
      res.status(429).json({ success: false, message: limitMessage });
      return;
    }

    next();
  };
};
