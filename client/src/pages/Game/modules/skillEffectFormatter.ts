import { formatMarkEffectText } from "../shared/markEffectText";

type SkillEffectContext = {
  damageType?: string | null | undefined;
  element?: string | null | undefined;
};

const DAMAGE_TYPE_LABEL: Record<string, string> = {
  physical: '物理',
  magic: '法术',
  true: '真实',
};

const ELEMENT_LABEL: Record<string, string> = {
  none: '无',
  jin: '金',
  mu: '木',
  shui: '水',
  huo: '火',
  tu: '土',
};

const CONTROL_TYPE_LABEL: Record<string, string> = {
  freeze: '冰冻',
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

const BUFF_ID_NAME: Record<string, string> = {
  'debuff-burn': '灼烧',
  'buff-hot': '持续治疗',
  'buff-dodge-next': '下一次闪避',
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
  const damageType = DAMAGE_TYPE_LABEL[damageTypeRaw] || damageTypeRaw || '';
  const elementRaw = toText(effect.element) || toText(context.element);
  const element = ELEMENT_LABEL[elementRaw] || elementRaw || '';
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

const formatBuffName = (buffIdRaw: string, effectType: 'buff' | 'debuff'): { name: string; attr: string } => {
  if (!buffIdRaw) return { name: effectType === 'buff' ? '增益效果' : '减益效果', attr: '' };
  if (BUFF_ID_NAME[buffIdRaw]) return { name: BUFF_ID_NAME[buffIdRaw], attr: '' };

  const matched = /^(buff|debuff)-([a-z0-9-]+)-(up|down)$/.exec(buffIdRaw);
  if (!matched) return { name: buffIdRaw, attr: '' };

  const attr = normalizeAttrKey(matched[2]);
  const attrText = ATTR_LABEL[attr] || attr;
  const trend = matched[3] === 'up' ? '提升' : '降低';
  return { name: `${attrText}${trend}`, attr };
};

const formatBuffValue = (effect: Record<string, unknown>, attr: string): string => {
  const valueType = toText(effect.valueType) || 'flat';
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

  if (raw === null || raw <= 0) return '';
  if (attr && PERCENT_BUFF_ATTR_SET.has(attr)) return `幅度 ${formatPercent(raw)}%`;
  return `数值 ${Math.floor(raw)}`;
};

/**
 * 生成 Buff/Debuff 的额外规则说明。
 *
 * 作用：
 * - 把“特定 buff 的额外效果文案”集中在单一函数中，避免业务组件和主格式化流程重复写分支。
 *
 * 输入：
 * - effect: 当前效果对象（由后端技能数据透传）
 * - buffId: Buff 标识
 *
 * 输出：
 * - 可拼接在括号内的文案片段；无额外规则时返回空字符串
 *
 * 数据流：
 * - effect/buffId -> 匹配对应规则 -> 读取后端字段 -> 产出文案片段
 *
 * 边界条件与坑点：
 * 1) 未识别的 buffId 必须返回空字符串，避免误导性展示。
 * 2) 本函数只负责“额外规则文案”，不处理基础 value 格式化，职责与 formatBuffValue 严格分离。
 */
const formatBuffExtraValue = (effect: Record<string, unknown>, buffId: string): string => {
  if (buffId === 'debuff-burn') {
    const burnBonusRate = toNumber(effect.bonusTargetMaxQixueRate);
    if (burnBonusRate !== null && burnBonusRate > 0) {
      return `目标最大气血 ${formatPercent(burnBonusRate)}%`;
    }
    return '';
  }
  return '';
};

/**
 * 组合 Buff/Debuff 括号内的数值说明。
 *
 * 作用：
 * - 把基础值文案与额外规则文案统一拼接为单一输出，确保所有调用点展示一致。
 *
 * 输入：
 * - effect: 当前效果对象
 * - buffId: Buff 标识
 * - attr: 解析出的属性标识（用于基础值格式化）
 *
 * 输出：
 * - 形如“数值 50 + 目标最大气血 1%”的组合文案；无内容时返回空字符串
 *
 * 数据流：
 * - effect/attr -> formatBuffValue -> 基础文案
 * - effect/buffId -> formatBuffExtraValue -> 额外文案
 * - 两段文案按“ + ”连接为最终文案
 *
 * 边界条件与坑点：
 * 1) 任一片段为空时会被过滤，避免出现多余连接符。
 * 2) 保持“ + ”连接语义，明确表示同一效果由多段伤害规则共同组成。
 */
const formatBuffDetail = (effect: Record<string, unknown>, buffId: string, attr: string): string => {
  const baseValueText = formatBuffValue(effect, attr);
  const extraValueText = formatBuffExtraValue(effect, buffId);
  return [baseValueText, extraValueText].filter((part) => part.length > 0).join(' + ');
};

const formatBuffEffect = (effect: Record<string, unknown>, effectType: 'buff' | 'debuff'): string => {
  const buffId = toText(effect.buffId);
  const { name, attr } = formatBuffName(buffId, effectType);
  const valueText = formatBuffDetail(effect, buffId, attr);
  const duration = toPositiveInt(effect.duration);

  let text = `${effectType === 'buff' ? '施加增益' : '施加减益'}：${name}`;
  if (valueText) text += `（${valueText}）`;
  if (duration > 0) text += `，持续${duration}回合`;
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
  const controlType = CONTROL_TYPE_LABEL[controlTypeRaw] || controlTypeRaw || '控制';
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

const formatResourceEffect = (effect: Record<string, unknown>): string => {
  const resourceTypeRaw = toText(effect.resourceType);
  const resourceType = RESOURCE_TYPE_LABEL[resourceTypeRaw] || resourceTypeRaw || '资源';
  const value = toNumber(effect.value);
  if (value === null || value === 0) return `调整${resourceType}`;
  const sign = value > 0 ? '+' : '-';
  return `调整${resourceType} ${sign}${Math.abs(Math.floor(value))}`;
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
      lines.push(formatResourceEffect(effect));
      continue;
    }

    if (type) lines.push(`效果：${type}`);
  }

  return lines;
};
