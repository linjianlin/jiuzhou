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
import { formatSkillEffectLines } from '../skillEffectFormatter';

export type TechniqueSkillDetailLike = {
  id: string;
  name: string;
  icon: string;
  description?: string;
  cost_lingqi?: number;
  cost_qixue?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
};

type SkillDetailItem = {
  label: string;
  value: string;
  isEffect?: boolean;
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

export const getSkillDetailItems = (skill: TechniqueSkillDetailLike): SkillDetailItem[] => {
  const items: SkillDetailItem[] = [];

  if (skill.description) {
    items.push({ label: '描述', value: skill.description });
  }
  if (skill.cost_lingqi && skill.cost_lingqi > 0) {
    items.push({ label: '灵气消耗', value: String(skill.cost_lingqi) });
  }
  if (skill.cost_qixue && skill.cost_qixue > 0) {
    items.push({ label: '气血消耗', value: String(skill.cost_qixue) });
  }
  if (skill.cooldown && skill.cooldown > 0) {
    items.push({ label: '冷却回合', value: `${skill.cooldown}回合` });
  }
  if (skill.target_type) {
    items.push({ label: '目标类型', value: TARGET_TYPE_LABEL[skill.target_type] || skill.target_type });
  }
  if (skill.target_count && skill.target_count > 0) {
    items.push({ label: '目标数量', value: String(skill.target_count) });
  }

  const effectLines = formatSkillEffectLines(skill.effects, {
    damageType: skill.damage_type,
    element: skill.element,
  });
  effectLines.forEach((line, idx) => {
    items.push({ label: `效果${idx + 1}`, value: line, isEffect: true });
  });

  return items;
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

  return [...inlineItems, ...effectItems].slice(0, 7);
};

export const getSkillInlineSummary = (skill: TechniqueSkillDetailLike): string => {
  const detailItems = getSkillInlineDetailItems(skill);
  if (detailItems.length === 0) return '暂无详细信息';

  return detailItems
    .map((item) => (item.label === '描述' || item.isEffect ? item.value : `${item.label}:${item.value}`))
    .join(' · ');
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
