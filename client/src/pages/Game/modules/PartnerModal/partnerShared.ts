/**
 * 伙伴弹窗共享常量与纯函数。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护伙伴面板枚举、属性展示顺序、技能结果文案，供总览/升级/功法三个面板复用。
 * 2. 做什么：把高频变化的展示规则从组件 JSX 中抽离，减少重复 map/label 判断。
 * 3. 不做什么：不发请求、不持有状态，也不处理弹窗生命周期。
 *
 * 输入/输出：
 * - 输入：伙伴 DTO、属性键值、功法学习结果。
 * - 输出：可直接渲染的标签、文案和图标地址。
 *
 * 数据流/状态流：
 * partner api DTO -> 本文件格式化/映射 -> PartnerModal UI。
 *
 * 关键边界条件与坑点：
 * 1. 百分比属性与数值属性的格式化规则必须集中，否则总览和功法面板容易出现显示不一致。
 * 2. 空槽位数量依赖 `slotCount - techniques.length`，需要统一计算，避免不同面板出现不同结果。
 */

import type {
  PartnerBaseAttrsDto,
  PartnerBookDto,
  PartnerComputedAttrsDto,
  PartnerDetailDto,
  PartnerOverviewDto,
  PartnerPassiveAttrsDto,
  PartnerTechniqueDto,
  PartnerTechniqueUpgradeCostDto,
} from '../../../../services/api';
import { formatPercent, formatRecovery } from '../../shared/formatAttr';
import { DEFAULT_ICON, resolveIconUrl } from '../../shared/resolveIcon';
import { getAttrLabel, isPercentAttrKey } from '../../shared/attrDisplay';
import { formatTechniquePassiveAmount } from '../../shared/techniquePassiveDisplay';

export type PartnerPanelKey = 'partners' | 'overview' | 'upgrade' | 'technique' | 'recruit';

export const PARTNER_PANEL_OPTIONS: Array<{ value: PartnerPanelKey; label: string }> = [
  { value: 'partners', label: '伙伴列表' },
  { value: 'overview', label: '总览' },
  { value: 'upgrade', label: '升级' },
  { value: 'technique', label: '功法' },
  { value: 'recruit', label: '招募' },
];

export const PARTNER_GROWTH_ATTRS: Array<keyof PartnerDetailDto['growth']> = [
  'max_qixue',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
];

export const PARTNER_COMBAT_ATTR_ORDER: Array<keyof PartnerBaseAttrsDto> = [
  'max_qixue',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'jianbaoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'sudu',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'qixue_huifu',
  'lingqi_huifu',
];

const PARTNER_ELEMENT_LABELS: Record<string, string> = {
  none: '无属性',
  jin: '金',
  mu: '木',
  shui: '水',
  huo: '火',
  tu: '土',
  an: '暗',
};

const PARTNER_OBTAINED_FROM_LABELS: Record<string, string> = {
  main_quest: '主线任务',
  main_quest_section: '主线章节',
  main_quest_chapter: '主线章节奖励',
  partner_recruit: 'AI招募',
};

export const getPartnerAttrLabel = (
  attrKey: keyof PartnerComputedAttrsDto | keyof PartnerDetailDto['growth'] | string,
): string => {
  return getAttrLabel(attrKey);
};

export const formatPartnerAttrValue = (
  attrKey: keyof PartnerComputedAttrsDto | keyof PartnerDetailDto['growth'] | string,
  value: number,
): string => {
  if (isPercentAttrKey(attrKey)) {
    return formatPercent(value);
  }
  return formatRecovery(value);
};

export const formatPartnerElementLabel = (element: string): string => {
  return PARTNER_ELEMENT_LABELS[element] ?? '无属性';
};

export const formatPartnerObtainedFromLabel = (obtainedFrom: string | null): string => {
  if (!obtainedFrom) return '主线获得';
  return PARTNER_OBTAINED_FROM_LABELS[obtainedFrom] ?? '其他来源';
};

export const resolvePartnerAvatar = (avatar: string | null): string => {
  return resolveIconUrl(avatar, DEFAULT_ICON);
};

export const resolvePartnerActionLabel = (isActive: boolean): string => {
  return isActive ? '下阵' : '设为出战';
};

export const resolvePartnerNextSelectedId = (
  overview: PartnerOverviewDto | null,
  selectedPartnerId: number | null,
): number | null => {
  if (!overview) return null;
  const partnerIds = overview.partners.map((partner) => partner.id);
  if (selectedPartnerId !== null && partnerIds.includes(selectedPartnerId)) {
    return selectedPartnerId;
  }
  return overview.activePartnerId ?? overview.partners[0]?.id ?? null;
};

export const getPartnerEmptySlotCount = (partner: PartnerDetailDto): number => {
  return Math.max(0, partner.slotCount - partner.techniques.length);
};

export const getPartnerVisibleCombatAttrs = (
  computedAttrs: PartnerComputedAttrsDto,
): Array<{ key: keyof PartnerBaseAttrsDto; value: number }> => {
  return PARTNER_COMBAT_ATTR_ORDER
    .map((key) => ({ key, value: Number(computedAttrs[key]) || 0 }))
    .filter((entry) => entry.value !== 0);
};

export const getPartnerVisibleBaseAttrs = (
  baseAttrs: PartnerBaseAttrsDto,
  compareAttrs?: PartnerBaseAttrsDto,
): Array<{ key: keyof PartnerBaseAttrsDto; value: number }> => {
  return PARTNER_COMBAT_ATTR_ORDER
    .map((key) => ({
      key,
      value: Number(baseAttrs[key]) || 0,
      compareValue: Number(compareAttrs?.[key]) || 0,
    }))
    .filter((entry) => entry.value !== 0 || entry.compareValue !== 0)
    .map(({ key, value }) => ({ key, value }));
};

export const formatPartnerTechniquePassiveLines = (
  technique: PartnerTechniqueDto,
): string[] => {
  const passiveEntries = Object.entries(technique.passiveAttrs as PartnerPassiveAttrsDto);
  return passiveEntries.map(([attrKey, value]) => {
    return `${getPartnerAttrLabel(attrKey)} ${formatTechniquePassiveAmount(attrKey, value)}`;
  });
};

export const formatPartnerTechniqueLayerLabel = (
  technique: PartnerTechniqueDto,
): string => {
  return `第 ${technique.currentLayer} / ${technique.maxLayer} 层`;
};

export const formatPartnerTechniqueUpgradeCostLines = (
  cost: PartnerTechniqueUpgradeCostDto,
): string[] => {
  const lines = [
    `升至第 ${cost.nextLayer} 层`,
    `消耗灵石 ${cost.spiritStones.toLocaleString()}`,
    `消耗经验 ${cost.exp.toLocaleString()}`,
  ];
  for (const material of cost.materials) {
    lines.push(`消耗材料 ${material.itemName ?? material.itemId} x${material.qty}`);
  }
  return lines;
};

export const formatPartnerTechniqueSkillToggleLabel = (
  technique: PartnerTechniqueDto,
  expanded: boolean,
): string => {
  if (expanded) {
    return `收起技能（${technique.skills.length}）`;
  }
  return `已解锁技能 ${technique.skills.length} 个`;
};

export const formatPartnerLearnResult = (
  learnedTechnique: PartnerTechniqueDto,
  replacedTechnique: PartnerTechniqueDto | null,
): string => {
  if (replacedTechnique) {
    return `学习成功：已领悟「${learnedTechnique.name}」，覆盖「${replacedTechnique.name}」`;
  }
  return `学习成功：已领悟「${learnedTechnique.name}」`;
};

export const resolvePartnerBookLabel = (book: PartnerBookDto): string => {
  return book.name;
};
