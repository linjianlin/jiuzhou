/**
 * 离线挂机战斗 API 层
 *
 * 作用：
 *   封装所有 /api/idle/* HTTP 调用，供 useIdleBattle Hook 使用。
 *   复用项目现有的 axios 实例（services/api/core.ts），不重复实现请求逻辑。
 *   不包含任何状态管理或 UI 逻辑。
 *
 * 输入/输出：
 *   - 每个函数对应一个 REST 端点，返回类型与服务端响应体对齐
 *   - 错误由 axios 拦截器统一处理（返回 { success: false, message }）
 *
 * 数据流：
 *   useIdleBattle → idleBattleApi → axios → /api/idle/* → 服务端
 *
 * 关键边界条件：
 *   1. 所有函数均不做 try/catch，错误由调用方（Hook）处理
 *   2. startIdleSession 返回 409 时 axios 拦截器会 reject，调用方需区分 409 与其他错误
 */

import type { AxiosRequestConfig } from "axios";
import api from "../../../../../services/api/core";
import type {
  IdleStartParams,
  IdleStartResponse,
  IdleStatusResponse,
  IdleHistoryResponse,
  IdleBatchesResponse,
  IdleBatchDetailResponse,
  IdleProgressResponse,
  IdleConfigResponse,
  IdleConfigDto,
} from "../types";

interface ApiSuccessEnvelope<T> {
  success: boolean;
  data: T;
}

interface ApiOkEnvelope {
  success: boolean;
}

const unwrapData = async <T>(
  request: Promise<ApiSuccessEnvelope<T>>,
): Promise<T> => {
  const response = await request;
  return response.data;
};

/** 启动挂机会话 */
export const startIdleSession = (
  params: IdleStartParams,
): Promise<IdleStartResponse> =>
  unwrapData<IdleStartResponse>(api.post("/idle/start", params));

/** 停止挂机会话 */
export const stopIdleSession = (): Promise<ApiOkEnvelope> =>
  api.post("/idle/stop");

/** 查询当前活跃会话 */
export const getIdleStatus = (
  requestConfig?: AxiosRequestConfig,
): Promise<IdleStatusResponse> =>
  unwrapData<IdleStatusResponse>(api.get("/idle/status", requestConfig));

/** 查询历史记录（最近 3 条） */
export const getIdleHistory = (): Promise<IdleHistoryResponse> =>
  unwrapData<IdleHistoryResponse>(api.get("/idle/history"));

/** 查询会话内战斗批次（回放） */
export const getIdleBatches = (
  sessionId: string,
): Promise<IdleBatchesResponse> =>
  unwrapData<IdleBatchesResponse>(
    api.get(`/idle/history/${sessionId}/batches`),
  );

/** 查询单个战斗批次详情（回放日志） */
export const getIdleBatchDetail = (
  sessionId: string,
  batchId: string,
): Promise<IdleBatchDetailResponse> =>
  unwrapData<IdleBatchDetailResponse>(
    api.get(`/idle/history/${sessionId}/batches/${batchId}`),
  );

/** 标记会话已查看 */
export const markIdleSessionViewed = (
  sessionId: string,
): Promise<ApiOkEnvelope> => api.post(`/idle/history/${sessionId}/viewed`);

/** 断线补全（活跃会话 + 最新批次） */
export const getIdleProgress = (): Promise<IdleProgressResponse> =>
  unwrapData<IdleProgressResponse>(api.get("/idle/progress"));

/** 读取挂机配置 */
export const getIdleConfig = (): Promise<IdleConfigResponse> =>
  unwrapData<IdleConfigResponse>(api.get("/idle/config"));

/** 更新挂机配置 */
export const updateIdleConfig = (
  config: Omit<IdleConfigDto, "mapId" | "roomId"> & {
    mapId?: string | null;
    roomId?: string | null;
  },
): Promise<ApiOkEnvelope> => api.put("/idle/config", config);
