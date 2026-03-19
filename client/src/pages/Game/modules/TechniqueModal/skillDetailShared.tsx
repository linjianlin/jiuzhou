/**
 * 功法技能详情共享渲染
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中封装功法技能的详情项、内联摘要与 Tooltip 内容，供已学功法与研修草稿共用。
 * 2. 做什么：统一目标类型、消耗、效果列表的文案拼装，避免在多个组件重复写映射与格式化逻辑。
 * 3. 不做什么：不处理研修状态、不处理按钮交互，也不发起任何网络请求。
 *
 * 输入/输出：
 * - 输入：`TechniqueSkillDetailLike` 技能对象。
 * - 输出：详情项数组、摘要文本，以及可直接渲染的 React 节点。
 *
 * 数据流/状态流：
 * TechniqueModal / ResearchPanel -> skillDetailShared -> 统一技能详情展示。
 *
 * 关键边界条件与坑点：
 * 1. 技能效果可能为空数组，此时必须回退到“暂无详细信息”，避免卡片留白。
 * 2. 内联摘要只展示高频关键信息，避免移动端卡片过高；完整信息由 Tooltip 承载。
 */
import type { ReactNode } from 'react';
import type { TechniqueResearchJobDto } from '../../../../services/api';
import { getElementTextClassName } from '../../shared/elementTheme';
import { buildSkillCostEntries, normalizeSkillCost } from '../../shared/skillCost';
import {
  formatDamageTypeLabel,
  formatElementLabel,
  formatSkillEffectLines,
} from '../skillEffectFormatter';

export type TechniqueSkillDetailLike = {
  id: string;
  name: string;
  icon: string;
  description?: string;
  cost_lingqi?: number;
  cost_lingqi_rate?: number;
  cost_qixue?: number;
  cost_qixue_rate?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
};

export type TechniqueResearchPreviewSkill = NonNullable<TechniqueResearchJobDto['preview']>['skills'][number];

type SkillDetailItem = {
  label: string;
  value: string;
  isEffect?: boolean;
};

export type SkillCardSection = {
  metaItems: Array<{ label: string; value: string }>;
  gridItems: Array<{ label: string; value: string; valueClassName?: string }>;
  summaryItems: SkillDetailItem[];
};

const TARGET_TYPE_LABEL: Record<string, string> = {
  self: '自身',
  single_enemy: '单体敌人',
  all_enemy: '全体敌人',
  single_ally: '单体友方',
  all_ally: '全体友方',
  random_enemy: '随机敌人',
  random_ally: '随机友方',
};

const INLINE_SKILL_DETAIL_ORDER = [
  '描述',
  '灵气消耗',
  '冷却回合',
  '目标类型',
  '目标数量',
  '气血消耗',
] as const;

const getTargetTypeLabel = (value: string | undefined): string => {
  if (!value) return '';
  return TARGET_TYPE_LABEL[value] || value;
};

const pickSummaryItems = (items: SkillDetailItem[]): SkillDetailItem[] => {
  const descriptionItem = items.find((item) => item.label === '描述');
  const effectItems = items.filter((item) => item.isEffect);
  if (descriptionItem || effectItems.length > 0) {
    return [
      ...(descriptionItem ? [descriptionItem] : []),
      ...effectItems,
    ];
  }

  return items.slice(0, 2);
};

export const mapResearchPreviewSkillToDetail = (skill: TechniqueResearchPreviewSkill): TechniqueSkillDetailLike => ({
  id: skill.id,
  name: skill.name,
  icon: skill.icon || '',
  description: skill.description || undefined,
  cost_lingqi: skill.costLingqi || undefined,
  cost_lingqi_rate: skill.costLingqiRate || undefined,
  cost_qixue: skill.costQixue || undefined,
  cost_qixue_rate: skill.costQixueRate || undefined,
  cooldown: skill.cooldown || undefined,
  target_type: skill.targetType || undefined,
  target_count: skill.targetCount || undefined,
  damage_type: skill.damageType || undefined,
  element: skill.element || undefined,
  effects: Array.isArray(skill.effects) ? skill.effects : undefined,
});

export const getSkillDetailItems = (skill: TechniqueSkillDetailLike): SkillDetailItem[] => {
  const items: SkillDetailItem[] = [];
  const costEntries = buildSkillCostEntries(normalizeSkillCost({
    costLingqi: skill.cost_lingqi,
    costLingqiRate: skill.cost_lingqi_rate,
    costQixue: skill.cost_qixue,
    costQixueRate: skill.cost_qixue_rate,
  }));

  if (skill.description) {
    items.push({ label: '描述', value: skill.description });
  }
  costEntries.forEach((entry) => {
    items.push({ label: `${entry.label}消耗`, value: entry.value });
  });
  if (skill.cooldown && skill.cooldown > 0) {
    items.push({ label: '冷却回合', value: `${skill.cooldown}回合` });
  }
  if (skill.target_type) {
    items.push({ label: '目标类型', value: getTargetTypeLabel(skill.target_type) });
  }
  if (skill.target_count && skill.target_count > 0) {
    items.push({ label: '目标数量', value: String(skill.target_count) });
  }

  const effectLines = formatSkillEffectLines(skill.effects, {
    damageType: skill.damage_type,
    element: skill.element,
    targetType: skill.target_type,
  });
  effectLines.forEach((line, idx) => {
    items.push({ label: `效果${idx + 1}`, value: line, isEffect: true });
  });

  return items;
};

export const getSkillCardSections = (skill: TechniqueSkillDetailLike): SkillCardSection => {
  const metaItems: SkillCardSection['metaItems'] = [];
  buildSkillCostEntries(normalizeSkillCost({
    costLingqi: skill.cost_lingqi,
    costLingqiRate: skill.cost_lingqi_rate,
    costQixue: skill.cost_qixue,
    costQixueRate: skill.cost_qixue_rate,
  })).forEach((entry) => {
    metaItems.push({ label: entry.label, value: entry.value });
  });
  if (skill.cooldown && skill.cooldown > 0) metaItems.push({ label: '冷却', value: `${skill.cooldown}回合` });

  const gridItems: SkillCardSection['gridItems'] = [];
  if (skill.target_type) gridItems.push({ label: '目标', value: getTargetTypeLabel(skill.target_type) });
  if (skill.target_count && skill.target_count > 0) gridItems.push({ label: '数量', value: String(skill.target_count) });

  const damageTypeText = formatDamageTypeLabel(skill.damage_type);
  if (damageTypeText) gridItems.push({ label: '伤害', value: damageTypeText });

  const elementText = formatElementLabel(skill.element);
  if (elementText && elementText !== '无') {
    gridItems.push({
      label: '五行',
      value: elementText,
      valueClassName: getElementTextClassName(skill.element),
    });
  }

  return {
    metaItems,
    gridItems,
    summaryItems: pickSummaryItems(getSkillDetailItems(skill)),
  };
};

export const getSkillInlineDetailItems = (skill: TechniqueSkillDetailLike): SkillDetailItem[] => {
  const allItems = getSkillDetailItems(skill);
  if (allItems.length === 0) return [];

  const byLabel = new Map(allItems.map((item) => [item.label, item]));
  const inlineItems = INLINE_SKILL_DETAIL_ORDER.reduce<SkillDetailItem[]>((acc, label) => {
    const item = byLabel.get(label);
    if (item) acc.push(item);
    return acc;
  }, []);
  const effectItems = allItems.filter((item) => item.isEffect);

  return [...inlineItems, ...effectItems];
};

export const getSkillInlineSummary = (skill: TechniqueSkillDetailLike): string => {
  const detailItems = getSkillInlineDetailItems(skill);
  if (detailItems.length === 0) return '暂无详细信息';

  return detailItems
    .map((item) => (item.label === '描述' || item.isEffect ? item.value : `${item.label}:${item.value}`))
    .join(' · ');
};

export const renderSkillCardDetails = (skill: TechniqueSkillDetailLike): ReactNode => {
  const sections = getSkillCardSections(skill);

  return (
    <div className="skill-card-details">
      <div className="skill-card-header">
        <div className="skill-card-title-row">
          <div className="skill-card-title">{skill.name}</div>
        </div>
        {sections.metaItems.length > 0 ? (
          <div className="skill-card-meta">
            {sections.metaItems.map((item) => (
              <span key={`${item.label}-${item.value}`} className="skill-card-meta-pill">
                <span className="skill-card-meta-label">{item.label}</span>
                <span className="skill-card-meta-value">{item.value}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="skill-card-meta skill-card-meta--empty" />
        )}
      </div>

      {sections.gridItems.length > 0 ? (
        <div className="skill-card-grid">
          {sections.gridItems.map((item) => (
            <div key={`${item.label}-${item.value}`} className="skill-card-grid-item">
              <span className="skill-card-grid-label">{item.label}</span>
              <span className={`skill-card-grid-value${item.valueClassName ? ` ${item.valueClassName}` : ''}`}>{item.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="skill-card-summary">
        {sections.summaryItems.length > 0 ? (
          sections.summaryItems.map((item, idx) => {
            const rowClassName = item.isEffect ? 'skill-card-summary-row is-effect' : 'skill-card-summary-row is-description';
            return (
              <div key={`${item.label}-${idx}`} className={rowClassName}>
                {item.value}
              </div>
            );
          })
        ) : (
          <div className="skill-card-summary-empty">暂无详细信息</div>
        )}
      </div>
    </div>
  );
};

export const renderSkillInlineDetails = (skill: TechniqueSkillDetailLike): ReactNode => {
  const detailItems = getSkillInlineDetailItems(skill);
  if (detailItems.length === 0) {
    return <div className="skill-inline-empty">暂无详细信息</div>;
  }

  return (
    <div className="skill-inline-lines">
      {detailItems.map((item, idx) => {
        if (item.label === '描述' || item.isEffect) {
          const rowClassName = item.isEffect ? 'skill-inline-row is-effect' : 'skill-inline-row is-description';
          return (
            <div key={`${item.label}-${idx}`} className={rowClassName}>
              <span className="skill-inline-value">{item.value}</span>
            </div>
          );
        }

        return (
          <div key={`${item.label}-${idx}`} className="skill-inline-row">
            <span className="skill-inline-label">{item.label}：</span>
            <span className="skill-inline-value">{item.value}</span>
          </div>
        );
      })}
    </div>
  );
};

export const renderSkillTooltip = (skill: TechniqueSkillDetailLike): ReactNode => {
  const items = getSkillDetailItems(skill);

  return (
    <div className="skill-tooltip">
      <div className="skill-tooltip-title">{skill.name}</div>
      {items.length > 0 ? (
        <div className="skill-tooltip-content">
          {items.map((item, idx) =>
            item.isEffect ? (
              <div key={idx} className="skill-tooltip-row is-effect">
                <span className="skill-tooltip-value">{item.value}</span>
              </div>
            ) : (
              <div key={idx} className="skill-tooltip-row">
                <span className="skill-tooltip-label">{item.label}：</span>
                <span className="skill-tooltip-value">{item.value}</span>
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="skill-tooltip-empty">暂无详细信息</div>
      )}
    </div>
  );
};
