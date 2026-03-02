import axios from "axios";
import {
  emitApiErrorToast,
  shouldAutoErrorToast,
  toUnifiedApiError,
} from "./error";

const normalizeBaseUrl = (raw: string): string => {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.replace(/\/+$/, "");
};

const isLoopbackHostname = (hostname: string): boolean => {
  const h = String(hostname || "")
    .trim()
    .toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
};

const resolveApiBase = (): string => {
  const fromEnv = normalizeBaseUrl(
    (import.meta.env.VITE_API_BASE as string | undefined) ?? "",
  );

  if (typeof window === "undefined" || !window.location) {
    return fromEnv || "http://localhost:6011/api";
  }

  const protocol = window.location.protocol || "http:";
  const hostname = window.location.hostname;

  // 生产环境使用同域名，开发环境使用 6011 端口
  const isDev = isLoopbackHostname(hostname);
  const runtimeDefault = isDev
    ? `${protocol}//${hostname}:6011/api`
    : `${protocol}//${hostname}/api`;

  const base = fromEnv || runtimeDefault;

  try {
    const url = new URL(base);
    if (isLoopbackHostname(url.hostname) && !isLoopbackHostname(hostname)) {
      url.hostname = hostname;
      return normalizeBaseUrl(url.toString());
    }
    return normalizeBaseUrl(url.toString());
  } catch {
    if (base.startsWith("/"))
      return normalizeBaseUrl(`${window.location.origin}${base}`);
    return base;
  }
};

export const API_BASE = resolveApiBase();
export const SERVER_BASE = API_BASE.replace(/\/api\/?$/, "");

// CDN 静态资源地址（可选）
// 用于动态加载的图片等资源，如物品图标、头像等
const resolveCdnBase = (): string => {
  const fromEnv = normalizeBaseUrl(
    (import.meta.env.VITE_CDN_BASE as string | undefined) ?? "",
  );
  // 如果未配置 CDN，则回退到 SERVER_BASE
  return fromEnv || SERVER_BASE;
};

export const CDN_BASE = resolveCdnBase();

/** VITE_CDN_BASE 是否被显式配置（非空） */
export const CDN_ENABLED = CDN_BASE !== SERVER_BASE;

/**
 * 解析资源 URL
 * - /uploads/* 用户上传内容 -> SERVER_BASE
 * - 其他静态资源路径 -> CDN_BASE
 * - 已经是完整 URL 的直接返回
 */
export const resolveAssetUrl = (path: string): string => {
  const raw = (path ?? "").trim();
  if (!raw) return "";
  // 已经是完整 URL
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  // 用户上传内容，必须从服务器获取
  if (raw.startsWith("/uploads/")) return `${SERVER_BASE}${raw}`;
  // 其他静态资源路径，从 CDN 获取
  if (raw.startsWith("/")) return `${CDN_BASE}${raw}`;
  // 相对路径，尝试补全
  return `${CDN_BASE}/${raw}`;
};

const api = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: {
    "Content-Type": "application/json",
  },
});

// 请求拦截器 - 添加token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器
api.interceptors.response.use(
  (response) => {
    const payload = response.data;
    if (payload && typeof payload === "object" && "success" in payload) {
      const success = (payload as { success?: unknown }).success;
      if (success === false) {
        const record = payload as { message?: unknown; code?: unknown };
        const normalized = toUnifiedApiError(
          {
            message: record.message,
            code: record.code,
            success: false,
            httpStatus: response.status,
            raw: payload,
          },
          "请求失败",
        );
        if (shouldAutoErrorToast(response.config)) {
          emitApiErrorToast({ message: normalized.message, error: normalized });
        }
        return Promise.reject(normalized);
      }
    }
    return payload;
  },
  (error) => {
    const normalized = toUnifiedApiError(error, "网络错误");
    if (shouldAutoErrorToast(error?.config)) {
      emitApiErrorToast({ message: normalized.message, error: normalized });
    }
    return Promise.reject(normalized);
  },
);

export default api;
