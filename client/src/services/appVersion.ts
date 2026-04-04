/**
 * 应用版本运行时服务。
 *
 * 作用：
 * 1. 统一暴露当前构建版本元数据与远端版本清单读取能力，作为“页头版本展示”和“根部更新检测”的唯一数据入口。
 * 2. 复用静态资源地址解析链路拼接 `version.json`，确保启用 CDN 后版本检测与 JS/CSS 资源命中同一静态源。
 * 3. 不做什么：不持有 UI 状态、不管理轮询生命周期，也不在请求失败时主动弹出错误提示。
 *
 * 输入 / 输出：
 * - 输入：编译期注入的版本常量、运行时缓存穿透参数、可选 `AbortSignal`。
 * - 输出：当前版本元数据、展示文案、远端版本清单 URL 和读取函数。
 *
 * 数据流 / 状态流：
 * Vite `define` 注入当前构建版本
 * -> 本模块归一化为稳定 `CURRENT_APP_VERSION_META`
 * -> 根部更新检测组件拉取远端 `version.json`
 * -> 本模块解析为同构版本元数据
 * -> UI 层只消费统一结果。
 *
 * 复用设计说明：
 * 1. 当前版本与远端版本读取共用同一类型和归一化规则，避免页头、检测器、后续设置页再维护多套解析逻辑。
 * 2. URL 拼接复用 `resolveAssetUrl`，把静态资源出口规则继续集中在 `runtimeUrls.ts`，不新增第二条地址判断链。
 * 3. 清单解析放在服务层后，轮询组件只关心“拿到版本元数据”，降低 UI 与协议格式的耦合。
 *
 * 关键边界条件与坑点：
 * 1. 远端版本清单必须使用缓存穿透参数与 `no-store`，否则 CDN 或浏览器缓存会导致一直看不到新版本。
 * 2. 当前构建版本与远端版本必须通过同一归一化函数处理，避免因为空白字符或格式差异出现误报。
 */

import { APP_VERSION_MANIFEST_PATH } from '../constants/appVersion';
import {
  formatAppVersionDisplayLabel,
  normalizeAppVersionMeta,
  type AppVersionMeta,
  type AppVersionMetaSource,
} from '../shared/appVersionShared';
import { resolveAssetUrl } from './runtimeUrls';

const parseAppVersionMeta = (rawText: string): AppVersionMeta => {
  const parsed = JSON.parse(rawText) as AppVersionMetaSource;
  return normalizeAppVersionMeta(parsed);
};

export const CURRENT_APP_VERSION_META = Object.freeze(
  normalizeAppVersionMeta({
    version: __APP_VERSION__,
    builtAt: __APP_BUILT_AT__,
  }),
);

export const CURRENT_APP_VERSION_LABEL = formatAppVersionDisplayLabel(CURRENT_APP_VERSION_META);
export const APP_VERSION_MANIFEST_URL = resolveAssetUrl(APP_VERSION_MANIFEST_PATH);

export const buildAppVersionManifestRequestUrl = (cacheBustToken: string): string => {
  const requestUrl = new URL(APP_VERSION_MANIFEST_URL);
  requestUrl.searchParams.set('t', cacheBustToken);
  return requestUrl.toString();
};

export const fetchLatestAppVersionMeta = async (
  cacheBustToken: string,
  signal?: AbortSignal,
): Promise<AppVersionMeta> => {
  const response = await fetch(buildAppVersionManifestRequestUrl(cacheBustToken), {
    method: 'GET',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    throw new Error(`应用版本清单请求失败：${response.status}`);
  }

  return parseAppVersionMeta(await response.text());
};
