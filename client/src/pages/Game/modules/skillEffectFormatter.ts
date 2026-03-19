import { formatMarkEffectText } from "../shared/markEffectText";
import { translateControlName } from "../shared/controlNameMap";
import { formatElementLabel as formatSharedElementLabel } from "../shared/elementTheme";
import { translateKnownBuffKeyName } from "../shared/buffNameMap";

type SkillEffectContext = {
  damageType?: string | null | undefined;
  element?: string | null | undefined;
  targetType?: string | null | undefined;
};

const DAMAGE_TYPE_LABEL: Record<string, string> = {
  physical: '物理',
  magic: '法术',
  true: '真实',
};

const RESOURCE_TYPE_LABEL: Record<string, string> = {
  lingqi: '灵气',
  qixue: '气血',
};

const DISPEL_TYPE_LABEL: Record<string, string> = {
  buff: '增益',
  debuff: '减益',
  all: '增益/减益',
};

const MOMENTUM_BONUS_LABEL: Record<string, string> = {
  damage: '伤害',
  heal: '治疗',
  shield: '护盾',
  resource: '资源',
  all: '全部效果',
};

const ATTR_LABEL: Record<string, string> = {
  wugong: '物攻',
  fagong: '法攻',
  wufang: '物防',
  fafang: '法防',
  shanbi: '闪避',
  sudu: '速度',
  max_qixue: '气血上限',
  max_lingqi: '灵气上限',
  kongzhi_kangxing: '控制抗性',
};

const PERCENT_BUFF_ATTR_SET = new Set([
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

const normalizeAttrKey = (raw: string): string => {
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return '';
  if (lowered === 'max-lingqi') return 'max_lingqi';
  if (lowered === 'kongzhi-kangxing') return 'kongzhi_kangxing';
  return lowered.replace(/-/g, '_');
};

const normalizeBuffKey = (raw: unknown): string => toText(raw).toLowerCase();

const normalizeBuffKind = (raw: unknown): string => toText(raw).toLowerCase();

const normalizeBuffApplyType = (raw: unknown): 'flat' | 'percent' | '' => {
  const applyType = toText(raw).toLowerCase();
  if (applyType === 'flat' || applyType === 'percent') return applyType;
  return '';
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const toPositiveInt = (value: unknown): number => {
  const raw = toNumber(value);
  if (raw === null) return 0;
  return Math.max(0, Math.floor(raw));
};

const formatPercent = (value: number): string => {
  const percent = value * 100;
  return Number.isInteger(percent) ? `${percent}` : `${Number(percent.toFixed(2))}`;
};

export const formatDamageTypeLabel = (value: string | null | undefined): string => {
  if (!value) return '';
  return DAMAGE_TYPE_LABEL[value] || value;
};

export const formatElementLabel = (value: string | null | undefined): string => {
  return formatSharedElementLabel(value);
};

const describeScaleAttr = (attrRaw: unknown): string => {
  const attr = normalizeAttrKey(toText(attrRaw));
  if (!attr) return '';
  return ATTR_LABEL[attr] || attr;
};

const formatScaledValue = (effect: Record<string, unknown>, kind: 'damage' | 'heal' | 'shield'): string => {
  const valueType = toText(effect.valueType) || 'scale';
  const value = toNumber(effect.value);
  const scaleRate = toNumber(effect.scaleRate);
  const scaleAttrText = describeScaleAttr(effect.scaleAttr);

  if (valueType === 'scale') {
    const rate = scaleRate ?? value;
    if (rate === null || rate <= 0) return '';
    return scaleAttrText
      ? `倍率 ${formatPercent(rate)}%（${scaleAttrText}）`
      : `倍率 ${formatPercent(rate)}%`;
  }

  if (valueType === 'flat') {
    if (value === null || value <= 0) return '';
    return `固定 ${Math.max(0, Math.floor(value))}`;
  }

  if (valueType === 'percent') {
    if (value === null || value <= 0) return '';
    if (kind === 'damage' || kind === 'heal') return `目标最大气血 ${formatPercent(value)}%`;
    return `比例 ${formatPercent(value)}%`;
  }

  // combined: 固定基础值 + 属性加成（如：50 + 法攻*0.5）
  if (valueType === 'combined') {
    const baseValue = toNumber(effect.baseValue) ?? value;
    const rate = scaleRate ?? 0;
    const parts: string[] = [];
    if (baseValue !== null && baseValue > 0) {
      parts.push(`固定 ${Math.floor(baseValue)}`);
    }
    if (rate > 0 && scaleAttrText) {
      parts.push(`${scaleAttrText}*${formatPercent(rate)}%`);
    }
    return parts.length > 0 ? parts.join(' + ') : '';
  }

  if (value === null || value <= 0) return '';
  return `数值 ${Math.floor(value)}`;
};

const formatDamageEffect = (effect: Record<string, unknown>, context: SkillEffectContext): string => {
  const damageTypeRaw = toText(effect.damageType) || toText(context.damageType);
  const damageType = formatDamageTypeLabel(damageTypeRaw);
  const elementRaw = toText(effect.element) || toText(context.element);
  const element = formatElementLabel(elementRaw);
  const scaled = formatScaledValue(effect, 'damage');
  const hitCount = Math.max(1, toPositiveInt(effect.hit_count) || 1);

  const prefix = damageType ? `造成${damageType}伤害` : '造成伤害';
  const suffixes: string[] = [];
  if (element && element !== '无') suffixes.push(`${element}属性`);
  if (scaled) suffixes.push(scaled);
  if (hitCount > 1) suffixes.push(`连击${hitCount}次`);
  return suffixes.length > 0 ? `${prefix}，${suffixes.join('，')}` : prefix;
};

const formatHealEffect = (effect: Record<string, unknown>): string => {
  const scaled = formatScaledValue(effect, 'heal');
  return scaled ? `恢复气血，${scaled}` : '恢复气血';
};

const formatShieldEffect = (effect: Record<string, unknown>): string => {
  const scaled = formatScaledValue(effect, 'shield');
  const duration = toPositiveInt(effect.duration);
  let text = scaled ? `获得护盾，${scaled}` : '获得护盾';
  if (duration > 0) text += `，持续${duration}回合`;
  return text;
};

const resolveBuffAttr = (effect: Record<string, unknown>, buffKey: string): string => {
  const attrKey = normalizeAttrKey(toText(effect.attrKey));
  if (attrKey) return attrKey;

  const matched = /^(?:buff|debuff)-([a-z0-9-]+)-(?:up|down)$/.exec(buffKey);
  if (!matched) return '';
  return normalizeAttrKey(matched[1]);
};

const formatBuffName = (
  effect: Record<string, unknown>,
  effectType: 'buff' | 'debuff',
): { name: string; attr: string; buffKey: string } => {
  const buffKey = normalizeBuffKey(effect.buffKey);
  const attr = resolveBuffAttr(effect, buffKey);
  const knownBuffName = translateKnownBuffKeyName(buffKey);

  if (knownBuffName) return { name: knownBuffName, attr, buffKey };
  if (!buffKey && !attr) {
    return { name: effectType === 'buff' ? '增益效果' : '减益效果', attr: '', buffKey: '' };
  }
  if (!attr) return { name: buffKey || (effectType === 'buff' ? '增益效果' : '减益效果'), attr: '', buffKey };

  const attrText = ATTR_LABEL[attr] || attr;
  const trend = effectType === 'buff' ? '提升' : '降低';
  return { name: `${attrText}${trend}`, attr, buffKey };
};

const formatBuffValue = (
  effect: Record<string, unknown>,
  attr: string,
  applyType: 'flat' | 'percent' | '',
): string => {
  const valueType = toText(effect.valueType).toLowerCase();
  const raw = toNumber(effect.value);

  // combined: 固定基础值 + 属性加成（如：50 + 法攻*0.5）
  if (valueType === 'combined') {
    const baseValue = toNumber(effect.baseValue) ?? raw;
    const scaleRate = toNumber(effect.scaleRate);
    const scaleAttrText = describeScaleAttr(effect.scaleAttr);
    const parts: string[] = [];
    if (baseValue !== null && baseValue > 0) {
      parts.push(`固定 ${Math.floor(baseValue)}`);
    }
    if (scaleRate !== null && scaleRate > 0 && scaleAttrText) {
      parts.push(`${scaleAttrText}*${formatPercent(scaleRate)}%`);
    }
    return parts.length > 0 ? parts.join(' + ') : '';
  }

  if (valueType === 'scale' || valueType === 'percent') {
    return formatScaledValue(effect, 'shield');
  }

  if (raw === null || raw <= 0) return '';
  if (applyType === 'percent') return `幅度 ${formatPercent(raw)}%`;
  if (attr && PERCENT_BUFF_ATTR_SET.has(attr) && valueType !== 'flat') return `幅度 ${formatPercent(raw)}%`;
  return `数值 ${Math.floor(raw)}`;
};

type BuffDetailResolver = {
  override?: (effect: Record<string, unknown>) => string;
  extra?: (effect: Record<string, unknown>) => string;
};

const formatReflectDamageDetail = (effect: Record<string, unknown>): string => {
  const rate = toNumber(effect.value);
  if (rate === null || rate <= 0) return '';
  return `反震本次实际受击伤害 ${formatPercent(rate)}%`;
};

const formatHealForbidDetail = (): string => {
  return '期间无法通过治疗与持续恢复回复气血';
};

const formatNextSkillBonusDetail = (effect: Record<string, unknown>): string => {
  const rate = toNumber(effect.value);
  const bonusType = toText(effect.bonusType);
  const bonusTypeText = bonusType
    ? MOMENTUM_BONUS_LABEL[bonusType] || bonusType
    : '全部效果';
  if (rate === null || rate <= 0) return `下一次技能强化${bonusTypeText}`;
  return `下一次技能的${bonusTypeText}提高${formatPercent(rate)}%`;
};

const formatBurnExtraDetail = (effect: Record<string, unknown>): string => {
  const burnBonusRate = toNumber(effect.bonusTargetMaxQixueRate);
  if (burnBonusRate === null || burnBonusRate <= 0) return '';
  return `目标最大气血 ${formatPercent(burnBonusRate)}%`;
};

/**
 * Buff 特例展示规则表。
 *
 * 作用：
 * - 把“需要专属文案的 Buff”集中到单一入口，避免技能卡、背包弹窗等多个展示位各写一套判断。
 * - 支持按 buffKind 覆盖基础数值文案，或按 buffKey 追加额外规则说明。
 *
 * 输入：
 * - effect：当前结构化 Buff 效果对象。
 *
 * 输出：
 * - override：完全替代默认数值文案。
 * - extra：在默认数值文案后追加说明。
 *
 * 数据流：
 * - 技能效果对象 -> kind/key 对应规则 -> `formatBuffDetail` 统一拼装 -> 所有技能详情入口复用同一结果。
 *
 * 关键边界条件与坑点：
 * 1) `reflect_damage` 的 value 是比例，不能再走通用 `Math.floor`，否则 0.3 会错误显示成 0。
 * 2) 表里只收“已有明确展示语义”的 Buff，避免把普通属性 Buff 过度特殊化，反而增加维护成本。
 */
const AURA_TARGET_LABEL: Record<string, string> = {
  all_ally: '全体友方',
  all_enemy: '全体敌方',
  self: '自身',
};

const RESOURCE_EFFECT_TARGET_LABEL: Record<string, string> = {
  self: '自身',
  single_enemy: '目标',
  all_enemy: '敌方全体',
  single_ally: '友方目标',
  all_ally: '友方全体',
  random_enemy: '随机敌方目标',
  random_ally: '随机友方目标',
};

/**
 * 格式化光环子效果描述
 *
 * 作用：将光环的 auraEffects 子效果数组转为可读文案，复用已有的子效果格式化函数。
 * 输入：effect 对象（含 auraTarget、auraEffects）。
 * 输出：形如"光环·全体友方：物防提升（幅度 15%），持续1回合"的完整描述。
 *
 * 坑点：
 * 1) 子效果可能包含 damage/heal/buff/debuff/resource/restore_lingqi 多种类型，需逐一分发。
 * 2) 光环永久存在，不显示外层 duration。
 */
const formatAuraDetail = (effect: Record<string, unknown>): string => {
  const auraTarget = toText(effect.auraTarget);
  const targetLabel = AURA_TARGET_LABEL[auraTarget] || auraTarget || '范围';
  const auraEffects = Array.isArray(effect.auraEffects) ? effect.auraEffects : [];

  const subLines: string[] = [];
  for (const sub of auraEffects) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
    const subEffect = sub as Record<string, unknown>;
    const subType = toText(subEffect.type);
    if (subType === 'damage') {
      subLines.push(formatDamageEffect(subEffect, {}));
    } else if (subType === 'heal') {
      subLines.push(formatHealEffect(subEffect));
    } else if (subType === 'buff') {
      subLines.push(formatBuffEffect(subEffect, 'buff', { ignoreDuration: true }));
    } else if (subType === 'debuff') {
      subLines.push(formatBuffEffect(subEffect, 'debuff', { ignoreDuration: true }));
    } else if (subType === 'resource') {
      subLines.push(formatResourceEffect(subEffect, { targetType: auraTarget }));
    } else if (subType === 'restore_lingqi') {
      subLines.push(formatRestoreLingqiEffect(subEffect));
    }
  }

  if (subLines.length === 0) return `光环·${targetLabel}`;
  return `光环·${targetLabel}：${subLines.join('；')}`;
};

const BUFF_DETAIL_RESOLVER_BY_KIND: Record<string, BuffDetailResolver> = {
  reflect_damage: {
    override: formatReflectDamageDetail,
  },
  heal_forbid: {
    override: formatHealForbidDetail,
  },
  next_skill_bonus: {
    override: formatNextSkillBonusDetail,
  },
  aura: {
    override: formatAuraDetail,
  },
};

const BUFF_DETAIL_RESOLVER_BY_KEY: Record<string, BuffDetailResolver> = {
  'debuff-burn': {
    extra: formatBurnExtraDetail,
  },
};

/**
 * 生成 Buff/Debuff 的额外规则说明。
 *
 * 作用：
 * - 把“特定 buff 的额外效果文案”集中在单一函数中，避免业务组件和主格式化流程重复写分支。
 *
 * 输入：
 * - effect: 当前效果对象（由后端技能数据透传）
 * - buffKey: Buff 标识
 *
 * 输出：
 * - 可拼接在括号内的文案片段；无额外规则时返回空字符串
 *
 * 数据流：
 * - effect/buffKey -> 匹配对应规则 -> 读取后端字段 -> 产出文案片段
 *
 * 边界条件与坑点：
 * 1) 未识别的 buffKey 必须返回空字符串，避免误导性展示。
 * 2) 本函数只负责“额外规则文案”，不处理基础 value 格式化，职责与 formatBuffValue 严格分离。
 */
const formatBuffExtraValue = (effect: Record<string, unknown>, buffKey: string, buffKind: string): string => {
  const keyResolver = BUFF_DETAIL_RESOLVER_BY_KEY[buffKey];
  if (keyResolver?.extra) {
    return keyResolver.extra(effect);
  }
  const kindResolver = BUFF_DETAIL_RESOLVER_BY_KIND[buffKind];
  return kindResolver?.extra ? kindResolver.extra(effect) : '';
};

/**
 * 组合 Buff/Debuff 括号内的数值说明。
 *
 * 作用：
 * - 把基础值文案与额外规则文案统一拼接为单一输出，确保所有调用点展示一致。
 *
 * 输入：
 * - effect: 当前效果对象
 * - buffKey: Buff 标识
 * - attr: 解析出的属性标识（用于基础值格式化）
 *
 * 输出：
 * - 形如“数值 50 + 目标最大气血 1%”的组合文案；无内容时返回空字符串
 *
 * 数据流：
 * - effect/attr -> formatBuffValue -> 基础文案
 * - effect/buffKey -> formatBuffExtraValue -> 额外文案
 * - 两段文案按“ + ”连接为最终文案
 *
 * 边界条件与坑点：
 * 1) 任一片段为空时会被过滤，避免出现多余连接符。
 * 2) 保持“ + ”连接语义，明确表示同一效果由多段伤害规则共同组成。
 */
const formatBuffDetail = (
  effect: Record<string, unknown>,
  buffKey: string,
  buffKind: string,
  attr: string,
  applyType: 'flat' | 'percent' | '',
): string => {
  const kindResolver = BUFF_DETAIL_RESOLVER_BY_KIND[buffKind];
  if (kindResolver?.override) {
    return kindResolver.override(effect);
  }
  const keyResolver = BUFF_DETAIL_RESOLVER_BY_KEY[buffKey];
  if (keyResolver?.override) {
    return keyResolver.override(effect);
  }
  const baseValueText = formatBuffValue(effect, attr, applyType);
  const extraValueText = formatBuffExtraValue(effect, buffKey, buffKind);
  return [baseValueText, extraValueText].filter((part) => part.length > 0).join(' + ');
};

const formatBuffEffect = (
  effect: Record<string, unknown>,
  effectType: 'buff' | 'debuff',
  options: { ignoreDuration?: boolean } = {},
): string => {
  const applyType = normalizeBuffApplyType(effect.applyType);
  const buffKind = normalizeBuffKind(effect.buffKind);
  const { name, attr, buffKey } = formatBuffName(effect, effectType);
  const valueText = formatBuffDetail(effect, buffKey, buffKind, attr, applyType);
  const duration = toPositiveInt(effect.duration);

  let text = `${effectType === 'buff' ? '施加增益' : '施加减益'}：${name}`;
  if (valueText) text += `（${valueText}）`;
  // 光环永久存在，不显示外层 duration
  if (duration > 0 && buffKind !== 'aura' && !options.ignoreDuration) text += `，持续${duration}回合`;
  return text;
};

const formatLifestealEffect = (effect: Record<string, unknown>): string => {
  const value = toNumber(effect.value);
  if (value === null || value <= 0) return '吸血';
  return `吸血 ${formatPercent(value)}%`;
};

const formatRestoreLingqiEffect = (effect: Record<string, unknown>): string => {
  const value = toNumber(effect.value);
  if (value === null || value <= 0) return '恢复灵气';
  return `恢复灵气 ${Math.floor(value)}`;
};

const formatCleanseEffect = (effect: Record<string, unknown>): string => {
  const count = Math.max(1, toPositiveInt(effect.count) || 1);
  return `净化减益 ${count}个`;
};

const formatCleanseControlEffect = (effect: Record<string, unknown>): string => {
  const count = toPositiveInt(effect.count);
  if (count > 0) return `净化控制 ${count}个`;
  return '净化控制效果';
};

const formatControlEffect = (effect: Record<string, unknown>): string => {
  const controlTypeRaw = toText(effect.controlType);
  const controlType = translateControlName(controlTypeRaw) || '控制';
  const duration = toPositiveInt(effect.duration);
  const chance = toNumber(effect.chance);

  const parts = [`附加控制：${controlType}`];
  if (duration > 0) parts.push(`持续${duration}回合`);
  if (chance !== null && chance > 0) parts.push(`概率${formatPercent(chance)}%`);
  return parts.join('，');
};

const formatDispelEffect = (effect: Record<string, unknown>): string => {
  const dispelTypeRaw = toText(effect.dispelType) || 'all';
  const dispelType = DISPEL_TYPE_LABEL[dispelTypeRaw] || dispelTypeRaw;
  const count = toPositiveInt(effect.count);
  if (count > 0) return `驱散${dispelType} ${count}个`;
  return `驱散${dispelType}`;
};

const formatResourceEffect = (
  effect: Record<string, unknown>,
  context: SkillEffectContext = {},
): string => {
  const resourceTypeRaw = toText(effect.resourceType);
  const resourceType = RESOURCE_TYPE_LABEL[resourceTypeRaw] || resourceTypeRaw || '资源';
  const value = toNumber(effect.value);
  const targetLabel = RESOURCE_EFFECT_TARGET_LABEL[toText(context.targetType)] || '目标';
  if (value === null || value === 0) return `调整${targetLabel}${resourceType}`;
  const sign = value > 0 ? '+' : '-';
  return `调整${targetLabel}${resourceType} ${sign}${Math.abs(Math.floor(value))}`;
};

const formatMomentumEffect = (effect: Record<string, unknown>): string => {
  const operation = toText(effect.operation).toLowerCase();
  const gainStacks = toPositiveInt(effect.gainStacks || effect.stacks || effect.value) || 1;
  const maxStacks = toPositiveInt(effect.maxStacks);
  const perStackRate = toNumber(effect.perStackRate);
  const bonusTypeRaw = toText(effect.bonusType);
  const bonusType = MOMENTUM_BONUS_LABEL[bonusTypeRaw] || bonusTypeRaw;

  if (operation === 'gain') {
    const parts = [`获得势 ${gainStacks}层`];
    if (maxStacks > 0) parts.push(`上限${maxStacks}层`);
    return parts.join('，');
  }

  const consumeMode = toText(effect.consumeMode) === 'fixed' ? '固定层数' : '全部势';
  const parts = [`消耗${consumeMode}`];
  if (perStackRate !== null && perStackRate > 0) {
    parts.push(`每层使${bonusType || '技能效果'}提高${formatPercent(perStackRate)}%`);
  } else if (bonusType) {
    parts.push(`强化${bonusType}`);
  }
  return parts.join('，');
};

const FATE_SWAP_MODE_LABEL: Record<string, string> = {
  debuff_to_target: '将自身减益转嫁给目标',
  buff_to_self: '夺取目标增益归于自身',
  shield_steal: '窃取目标护盾',
};

const formatDelayedBurstEffect = (effect: Record<string, unknown>, context: SkillEffectContext): string => {
  const duration = Math.max(1, toPositiveInt(effect.duration) || 1);
  const damageText = formatDamageEffect(effect, context);
  return `埋下延迟爆发，${duration}次回合开始后触发：${damageText}`;
};

const formatFateSwapEffect = (effect: Record<string, unknown>): string => {
  const swapMode = toText(effect.swapMode);
  const count = Math.max(1, toPositiveInt(effect.count) || 1);
  if (swapMode === 'shield_steal') {
    const rate = toNumber(effect.value);
    const rateText = rate !== null && rate > 0 ? `${formatPercent(rate)}%` : '100%';
    return `命运交换：${FATE_SWAP_MODE_LABEL[swapMode] || '窃取目标护盾'} ${rateText}`;
  }
  return `命运交换：${FATE_SWAP_MODE_LABEL[swapMode] || '搬运状态'}（最多${count}个）`;
};

export const formatSkillEffectLines = (effectsRaw: unknown, context: SkillEffectContext = {}): string[] => {
  if (!Array.isArray(effectsRaw)) return [];

  const lines: string[] = [];
  for (const raw of effectsRaw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const effect = raw as Record<string, unknown>;
    const type = toText(effect.type);

    if (type === 'damage') {
      lines.push(formatDamageEffect(effect, context));
      continue;
    }
    if (type === 'heal') {
      lines.push(formatHealEffect(effect));
      continue;
    }
    if (type === 'shield') {
      lines.push(formatShieldEffect(effect));
      continue;
    }
    if (type === 'buff') {
      lines.push(formatBuffEffect(effect, 'buff'));
      continue;
    }
    if (type === 'debuff') {
      lines.push(formatBuffEffect(effect, 'debuff'));
      continue;
    }
    if (type === 'mark') {
      const markText = formatMarkEffectText(effect);
      lines.push(markText ?? '施加印记效果');
      continue;
    }
    if (type === 'lifesteal') {
      lines.push(formatLifestealEffect(effect));
      continue;
    }
    if (type === 'restore_lingqi') {
      lines.push(formatRestoreLingqiEffect(effect));
      continue;
    }
    if (type === 'cleanse') {
      lines.push(formatCleanseEffect(effect));
      continue;
    }
    if (type === 'cleanse_control') {
      lines.push(formatCleanseControlEffect(effect));
      continue;
    }
    if (type === 'control') {
      lines.push(formatControlEffect(effect));
      continue;
    }
    if (type === 'dispel') {
      lines.push(formatDispelEffect(effect));
      continue;
    }
    if (type === 'resource') {
      lines.push(formatResourceEffect(effect, context));
      continue;
    }
    if (type === 'momentum') {
      lines.push(formatMomentumEffect(effect));
      continue;
    }
    if (type === 'delayed_burst') {
      lines.push(formatDelayedBurstEffect(effect, context));
      continue;
    }
    if (type === 'fate_swap') {
      lines.push(formatFateSwapEffect(effect));
      continue;
    }

    if (type) lines.push(`效果：${type}`);
  }

  return lines;
};
