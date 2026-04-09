/**
 * 全局 HTTP 慢请求日志中间件
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在统一 HTTP 入口记录整条请求处理耗时，并只在超过阈值时输出结构化慢日志，避免每个路由各写一套计时与日志规则。
 * 2. 做什么：把 method、path、statusCode、鉴权上下文与响应长度收敛到单一出口，方便后续按接口维度聚合慢请求。
 * 3. 不做什么：不做错误处理、不改响应结构、不记录业务阶段分段，也不为未超阈值请求创建日志对象。
 *
 * 输入/输出：
 * - 输入：Express `Request / Response / NextFunction`。
 * - 输出：无同步返回；副作用仅为在响应完成后按阈值输出慢日志。
 *
 * 数据流/状态流：
 * - 请求进入中间件时记录高精度起始时间；
 * - 响应 `finish` 时计算总耗时；
 * - 若总耗时大于阈值，则收集请求/响应上下文并通过统一 logger 输出。
 *
 * 复用设计说明：
 * - 统一复用现有 `createScopedLogger` 作为日志出口，让 HTTP 慢日志和 battle、worker 等日志仍在同一条日志链路里展示。
 * - 整个应用只在 `app.ts` 注册一次；所有接口共享这一个中间件，避免路由层重复实现阈值判断和字段拼装。
 *
 * 关键边界条件与坑点：
 * 1. `path` 只能记录去掉 query 的路径，否则日志聚合会被查询参数打散，还可能把不该记录的参数带进日志。
 * 2. `userId / characterId` 依赖后续鉴权中间件注入，因此必须在响应完成时读取，不能在请求刚进入时提前快照。
 */
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

import { createScopedLogger } from '../utils/logger.js';

export type HttpSlowRequestLogEntry = {
  kind: 'slow_http_request';
  thresholdMs: number;
  totalCostMs: number;
  method: string;
  path: string;
  statusCode: number;
  userId?: number;
  characterId?: number;
  ip?: string;
  contentLength?: number;
};

export const HTTP_SLOW_REQUEST_THRESHOLD_MS = 250;

const httpSlowRequestScopedLogger = createScopedLogger('http.slow-request');

const roundDurationMs = (value: number): number => {
  return Math.max(0, Math.round(value));
};

const stripQueryFromPath = (rawUrl: string): string => {
  const queryIndex = rawUrl.indexOf('?');
  return queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
};

const normalizeContentLength = (
  headerValue: number | string | string[] | undefined,
): number | undefined => {
  if (typeof headerValue === 'number') {
    return Number.isFinite(headerValue) && headerValue >= 0 ? headerValue : undefined;
  }
  if (typeof headerValue !== 'string') {
    return undefined;
  }

  const normalized = Number(headerValue);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : undefined;
};

const buildSlowRequestLogEntry = (
  req: Request,
  res: Response,
  totalCostMs: number,
): HttpSlowRequestLogEntry => {
  return {
    kind: 'slow_http_request',
    thresholdMs: HTTP_SLOW_REQUEST_THRESHOLD_MS,
    totalCostMs,
    method: req.method,
    path: stripQueryFromPath(req.originalUrl || req.url),
    statusCode: res.statusCode,
    userId: req.userId,
    characterId: req.characterId,
    ip: req.ip,
    contentLength: normalizeContentLength(res.getHeader('content-length')),
  };
};

export const httpSlowRequestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const startAt = performance.now();

  res.once('finish', () => {
    const totalCostMs = roundDurationMs(performance.now() - startAt);
    if (totalCostMs <= HTTP_SLOW_REQUEST_THRESHOLD_MS) {
      return;
    }

    httpSlowRequestScopedLogger.warn(
      buildSlowRequestLogEntry(req, res, totalCostMs),
      'slow http request',
    );
  });

  next();
};
