/**
 * 静态图片资源路径常量
 *
 * 作用：
 * - 集中管理所有 UI / 地图等固定图片的路径
 * - 通过 resolveAssetUrl 解析，自动适配 CDN（VITE_CDN_BASE）
 * - 替代原先散落在各模块中的 `import xxx from '...assets/images/...'`
 *
 * 数据流：
 *   路径常量 → resolveAssetUrl → CDN_BASE 或 SERVER_BASE 拼接完整 URL
 *
 * 边界条件：
 * - 所有图片必须存在于 public/assets/ 下，路径与此处一致
 * - 新增图片时在此文件添加常量，禁止在业务组件中直接写路径
 *
 * 复用点：
 * - Auth/index.tsx, Game/index.tsx, MapModal, TaskModal, TechniqueModal,
 *   AchievementModal, RealmModal, RankModal, BattlePassModal, MonthCardModal,
 *   TeamModal, SectModal, SkillFloatButton 等
 */

import { resolveAssetUrl } from "../../../services/api";

/* ───────── 通用 UI ───────── */

export const IMG_LOGO = resolveAssetUrl("/assets/logo.png");
export const IMG_COIN = resolveAssetUrl("/assets/ui/sh_icon_0006_jinbi_02.png");
export const IMG_LINGSHI = resolveAssetUrl("/assets/ui/lingshi.png");
export const IMG_TONGQIAN = resolveAssetUrl("/assets/ui/tongqian.png");
export const IMG_EQUIP_MALE = resolveAssetUrl("/assets/ui/ep-n.png");
export const IMG_EQUIP_FEMALE = resolveAssetUrl("/assets/ui/ep.png");
export const IMG_EXP = resolveAssetUrl("/assets/ui/icon_exp.png");

/* ───────── 地图 ───────── */

export const IMG_MAP_01 = resolveAssetUrl("/assets/map/cp_icon_map01.png");
export const IMG_MAP_02 = resolveAssetUrl("/assets/map/cp_icon_map02.png");
export const IMG_MAP_03 = resolveAssetUrl("/assets/map/cp_icon_map03.png");
export const IMG_MAP_04 = resolveAssetUrl("/assets/map/cp_icon_map04.png");
export const IMG_MAP_05 = resolveAssetUrl("/assets/map/cp_icon_map05.png");
export const IMG_MAP_06 = resolveAssetUrl("/assets/map/cp_icon_map06.png");
