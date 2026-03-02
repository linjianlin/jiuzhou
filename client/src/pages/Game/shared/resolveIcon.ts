/**
 * 统一图标 URL 解析模块
 *
 * 作用：
 * - 将后端返回的 icon 字段（文件名、相对路径、绝对路径、完整 URL）
 *   统一解析为可直接用于 <img src> 的完整 URL
 * - 所有图片资源已迁移至 public/assets/，通过 resolveAssetUrl 解析
 * - 配置 VITE_CDN_BASE 后自动走 CDN 地址
 *
 * 输入：icon 字符串（文件名 / /assets/... / /uploads/... / https://... / 空）
 * 输出：可直接使用的图片 URL
 *
 * 数据流：
 *   icon 字符串 → resolveAssetUrl → CDN_BASE 或 SERVER_BASE 拼接完整 URL
 *
 * 边界条件：
 * - 空字符串 / null / undefined → 返回默认图标
 * - 已是完整 URL (http/https) → 直接返回
 * - 纯文件名（无路径前缀）→ 无法确定子目录，走 fallback
 *
 * 复用点：
 * - Game/index.tsx, BagModal, MarketModal, TaskModal, TechniqueModal,
 *   AchievementModal, RealmModal, WarehouseModal, SkillFloatButton, SectModal 等
 */

import { resolveAssetUrl } from "../../../services/api";

/** 默认回退图标路径（public/assets/ui/ 下的金币图标） */
export const DEFAULT_ICON = resolveAssetUrl(
  "/assets/ui/sh_icon_0006_jinbi_02.png",
);

/**
 * 解析图标 URL（核心函数）
 *
 * 优先级：
 * 1. 空值 → 返回 fallback（默认金币图标）
 * 2. 完整 URL (http/https) → 直接返回
 * 3. 以 / 开头的路径 → resolveAssetUrl（走 CDN 或 SERVER）
 * 4. 纯文件名或相对路径 → 尝试补全为 /assets/ 下的路径
 * 5. 其他 → fallback
 *
 * @param icon     后端返回的 icon 字段
 * @param fallback 未匹配时的回退图标 URL
 */
export const resolveIconUrl = (
  icon: string | null | undefined,
  fallback: string = DEFAULT_ICON,
): string => {
  const raw = (icon ?? "").trim();
  if (!raw) return fallback;

  // 完整 URL 直接返回
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;

  // 以 / 开头的路径直接走 resolveAssetUrl（CDN / SERVER_BASE）
  if (raw.startsWith("/")) {
    return resolveAssetUrl(raw) || fallback;
  }

  // 含目录分隔符的相对路径，补全 /assets/ 前缀
  if (raw.includes("/")) {
    return resolveAssetUrl(`/assets/${raw}`) || fallback;
  }

  // 纯文件名 → 无法确定子目录，走 fallback
  return fallback;
};
