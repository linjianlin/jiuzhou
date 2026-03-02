/**
 * 路由层标准响应工具
 *
 * 作用：统一 HTTP 响应格式，消除路由中重复的 res.json / res.status 样板代码。
 * 输入：Express Response 对象 + 数据。
 * 输出：标准 JSON 响应 { success, data?, message? }。
 *
 * 数据流：路由处理函数 -> sendSuccess/sendOk/sendResult -> res.json
 *
 * 边界条件：
 * 1) sendResult 根据 result.success 决定 HTTP 状态码（200 或 400），适用于 service 返回 { success, ... } 的场景。
 * 2) 错误场景不在此处理 —— 统一 throw BusinessError，由 errorHandler 中间件兜底。
 */
import type { Response } from 'express';

/** 成功响应：{ success: true, data } */
export const sendSuccess = <T>(res: Response, data: T): void => {
  res.json({ success: true, data });
};

/** 成功响应（无 data）：{ success: true } */
export const sendOk = (res: Response): void => {
  res.json({ success: true });
};

/** 透传 service 结果：根据 success 字段决定状态码 */
export const sendResult = (res: Response, result: { success: boolean }): void => {
  res.status(result.success ? 200 : 400).json(result);
};
