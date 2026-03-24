/**
 * 伙伴弹窗共享常量与纯函数。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护伙伴面板枚举、属性展示顺序、技能结果文案与技能策略重排规则，供总览/升级/功法/技能策略面板复用。
 * 2. 做什么：把高频变化的展示规则从组件 JSX 中抽离，减少重复 map/label 判断。
 * 3. 不做什么：不发请求、不持有状态，也不处理弹窗生命周期。
 *
 * 输入/输出：
 * - 输入：伙伴 DTO、属性键值、功法学习结果。
 * - 输出：可直接渲染的标签、文案和图标地址。
 *
 * 数据流/状态流：
 * partner api DTO -> 本文件格式化/映射/重排 -> PartnerModal UI。
 *
 * 关键边界条件与坑点：
 * 1. 百分比属性与数值属性的格式化规则必须集中，否则总览和功法面板容易出现显示不一致。
 * 2. 技能策略的“顺序即优先级”必须只在这里重排一次，避免前端多个入口各自改 priority 导致提交口径漂移。
 */

import type {
  PartnerBookDto,
  PartnerDetailDto,
  PartnerOverviewDto,
  PartnerPassiveAttrsDto,
  PartnerSkillPolicyEntryDto,
  PartnerSkillPolicySlotDto,
  PartnerTechniqueDto,
  PartnerTechniqueUpgradeCostDto,
} from '../../../../services/api';
import { formatTechniquePassiveAmount } from '../../shared/techniquePassiveDisplay';
import { getPartnerAttrLabel } from '../../shared/partnerDisplay';

export {
  buildPartnerCombatAttrRows,
  formatPartnerAttrValue,
  formatPartnerElementLabel,
  getPartnerDisplayName,
  getPartnerAttrLabel,
  hasPartnerLevelLimitApplied,
  formatPartnerLevelSummary,
  getPartnerVisibleBaseAttrs,
  getPartnerVisibleCombatAttrs,
  resolvePartnerAvatar,
} from '../../shared/partnerDisplay';

export type PartnerPanelKey = 'partners' | 'overview' | 'upgrade' | 'technique' | 'skill_policy' | 'recruit' | 'fusion';

export const PARTNER_PANEL_OPTIONS: Array<{ value: PartnerPanelKey; label: string }> = [
  { value: 'partners', label: '列表' },
  { value: 'overview', label: '总览' },
  { value: 'upgrade', label: '升级' },
  { value: 'technique', label: '功法' },
  { value: 'skill_policy', label: '技能策略' },
  { value: 'recruit', label: '招募' },
  { value: 'fusion', label: '三魂归契' },
];

export const PARTNER_GROWTH_ATTRS: Array<keyof PartnerDetailDto['growth']> = [
  'max_qixue',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
];

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

export const buildPartnerUpgradeRuleLines = (
  partner: Pick<PartnerDetailDto, 'level' | 'currentEffectiveLevel'>,
): string[] => {
  const lines = [
    '伙伴等级受角色境界限制：凡人上限 10 级，此后每提升一个境界档位，上限额外增加 10 级。',
    '达到当前境界上限后，无法继续灌注经验，需先突破境界再继续培养。',
  ];
  if (partner.currentEffectiveLevel < partner.level) {
    lines.push(`当前伙伴虽然仍可出战，但现阶段仅按 ${partner.currentEffectiveLevel} 级结算属性。`);
    return lines;
  }
  lines.push('即使未来伙伴实际等级高于当前境界上限，也仍可出战，但只会按当前生效等级结算属性。');
  return lines;
};

export const groupPartnerSkillPolicyEntries = (
  entries: PartnerSkillPolicyEntryDto[],
): {
  enabledEntries: PartnerSkillPolicyEntryDto[];
  disabledEntries: PartnerSkillPolicyEntryDto[];
} => {
  const enabledEntries = entries.filter((entry) => entry.enabled);
  const disabledEntries = entries.filter((entry) => !entry.enabled);
  return {
    enabledEntries,
    disabledEntries,
  };
};

const rebuildPartnerSkillPolicyEntries = (
  enabledEntries: PartnerSkillPolicyEntryDto[],
  disabledEntries: PartnerSkillPolicyEntryDto[],
): PartnerSkillPolicyEntryDto[] => {
  return [
    ...enabledEntries.map((entry, index) => ({
      ...entry,
      enabled: true,
      priority: index + 1,
    })),
    ...disabledEntries.map((entry, index) => ({
      ...entry,
      enabled: false,
      priority: enabledEntries.length + index + 1,
    })),
  ];
};

export const movePartnerSkillPolicyEntry = (
  entries: PartnerSkillPolicyEntryDto[],
  skillId: string,
  direction: 'up' | 'down',
): PartnerSkillPolicyEntryDto[] => {
  const { enabledEntries, disabledEntries } = groupPartnerSkillPolicyEntries(entries);
  const currentIndex = enabledEntries.findIndex((entry) => entry.skillId === skillId);
  if (currentIndex < 0) return entries;

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= enabledEntries.length) return entries;

  const nextEnabledEntries = [...enabledEntries];
  const currentEntry = nextEnabledEntries[currentIndex];
  const targetEntry = nextEnabledEntries[targetIndex];
  nextEnabledEntries[currentIndex] = targetEntry;
  nextEnabledEntries[targetIndex] = currentEntry;
  return rebuildPartnerSkillPolicyEntries(nextEnabledEntries, disabledEntries);
};

export const reorderPartnerSkillPolicyEntry = (
  entries: PartnerSkillPolicyEntryDto[],
  sourceSkillId: string,
  targetSkillId: string,
): PartnerSkillPolicyEntryDto[] => {
  if (sourceSkillId === targetSkillId) return entries;
  const { enabledEntries, disabledEntries } = groupPartnerSkillPolicyEntries(entries);
  const sourceIndex = enabledEntries.findIndex((entry) => entry.skillId === sourceSkillId);
  const targetIndex = enabledEntries.findIndex((entry) => entry.skillId === targetSkillId);
  if (sourceIndex < 0 || targetIndex < 0) return entries;

  const nextEnabledEntries = [...enabledEntries];
  const [sourceEntry] = nextEnabledEntries.splice(sourceIndex, 1);
  if (!sourceEntry) return entries;
  nextEnabledEntries.splice(targetIndex, 0, sourceEntry);
  return rebuildPartnerSkillPolicyEntries(nextEnabledEntries, disabledEntries);
};

export const togglePartnerSkillPolicyEntry = (
  entries: PartnerSkillPolicyEntryDto[],
  skillId: string,
): PartnerSkillPolicyEntryDto[] => {
  const { enabledEntries, disabledEntries } = groupPartnerSkillPolicyEntries(entries);
  const enabledIndex = enabledEntries.findIndex((entry) => entry.skillId === skillId);
  if (enabledIndex >= 0) {
    const nextEnabledEntries = enabledEntries.filter((entry) => entry.skillId !== skillId);
    const toggledEntry = enabledEntries[enabledIndex];
    return rebuildPartnerSkillPolicyEntries(nextEnabledEntries, [
      ...disabledEntries,
      { ...toggledEntry, enabled: false },
    ]);
  }

  const disabledIndex = disabledEntries.findIndex((entry) => entry.skillId === skillId);
  if (disabledIndex < 0) return entries;
  const toggledEntry = disabledEntries[disabledIndex];
  const nextDisabledEntries = disabledEntries.filter((entry) => entry.skillId !== skillId);
  return rebuildPartnerSkillPolicyEntries([
    ...enabledEntries,
    { ...toggledEntry, enabled: true },
  ], nextDisabledEntries);
};

export const buildPartnerSkillPolicySlots = (
  entries: PartnerSkillPolicyEntryDto[],
): PartnerSkillPolicySlotDto[] => {
  return entries.map((entry) => ({
    skillId: entry.skillId,
    priority: entry.priority,
    enabled: entry.enabled,
  }));
};
