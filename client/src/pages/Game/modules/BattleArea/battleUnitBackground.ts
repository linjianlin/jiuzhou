/**
 * BattleArea 单位头像背景解析
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：集中决定哪些战斗单位允许显示头像背景，以及把后端头像路径解析成可直接用于背景图的 URL。
 * - 做什么：为 BattleUnitCard 提供单一入口，避免 JSX 里散落 `unitType` 与 `avatar` 判断。
 * - 不做什么：不渲染 React 节点，不提供默认图，也不为怪物/NPC/召唤物猜测图片。
 *
 * 输入/输出：
 * - 输入：最小化单位视图模型片段（`unitType`、`avatar`）。
 * - 输出：可用于 CSS background-image 的 URL，或 `undefined`。
 *
 * 数据流/状态流：
 * - BattleUnit / BattleUnitDto -> 本模块 -> BattleUnitCard 背景层样式。
 *
 * 关键边界条件与坑点：
 * 1. 当前需求只覆盖 `player` 与 `partner`；其他单位即使未来出现图片字段，也不能在这里隐式放开。
 * 2. 空头像必须返回 `undefined`，不能私自补默认图，否则会把“有头像”和“无头像”两种业务状态抹平。
 */

import { resolveAvatarUrl } from '../../../../services/api';
import { resolvePartnerAvatar } from '../../shared/partnerDisplay';

type BattleUnitBackgroundSource = {
  unitType?: 'player' | 'monster' | 'npc' | 'summon' | 'partner';
  avatar?: string | null;
};

export const resolveBattleUnitBackgroundImage = (
  unit: BattleUnitBackgroundSource,
  enabled: boolean = true,
): string | undefined => {
  if (!enabled) return undefined;
  const avatar = String(unit.avatar ?? '').trim();
  if (!avatar) return undefined;
  if (unit.unitType === 'player') return resolveAvatarUrl(avatar);
  if (unit.unitType === 'partner') return resolvePartnerAvatar(avatar);
  return undefined;
};
