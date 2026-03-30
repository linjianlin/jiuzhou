/**
 * Buff 结构化配置工具
 *
 * 作用：
 * 1) 统一解析与归一化 buffKind / attrKey / applyType / buffKey；
 * 2) 提供跨模块复用的默认规则（属性别名、默认百分比属性集合）。
 *
 * 不做什么：
 * 1) 不执行具体 Buff 结算；
 * 2) 不依赖战斗状态，不读写 BattleUnit。
 *
 * 输入/输出：
 * - 输入：配置层字段（unknown/string）与最小 effect 元信息。
 * - 输出：归一化后的结构化值（BuffKind、attrKey、applyType、buffKey）。
 *
 * 数据流：
 * - 静态配置/动态技能效果 -> 本模块归一化 -> 战斗执行层按 kind 分发处理。
 *
 * 边界条件与坑点：
 * 1) buffKind 使用可扩展字符串联合，未知 kind 不报错但由上层决定是否忽略。
 * 2) attrKey 会做别名映射与连字符归一，避免配置同义词导致运行时键不一致。
 */

export const STRUCTURED_BUFF_KIND_LIST = [
  'attr',
  'dot',
  'hot',
  'dodge_next',
  'reflect_damage',
  'heal_forbid',
  'next_skill_bonus',
  'aura',
] as const;
export type SupportedBuffKind = typeof STRUCTURED_BUFF_KIND_LIST[number];
export type BuffKind = SupportedBuffKind | (string & {});

export const BUFF_APPLY_TYPE_LIST = ['flat', 'percent'] as const;
export type BuffApplyType = typeof BUFF_APPLY_TYPE_LIST[number];

export const DEFAULT_PERCENT_BUFF_ATTR_SET: ReadonlySet<string> = new Set([
  'wugong',
  'fagong',
  'wufang',
  'fafang',
]);

const AURA_RUNTIME_KEY_SEPARATOR = '|';
const AURA_RUNTIME_HOST_PREFIX = 'aura_host';
const AURA_RUNTIME_SUB_PREFIX = 'aura_sub';

const BUFF_ATTR_ALIAS: Record<string, string> = {
  'max-lingqi': 'max_lingqi',
  'max-qixue': 'max_qixue',
  'qixue-huifu': 'qixue_huifu',
  'lingqi-huifu': 'lingqi_huifu',
  'kongzhi-kangxing': 'kongzhi_kangxing',
  'jin-kangxing': 'jin_kangxing',
  'mu-kangxing': 'mu_kangxing',
  'shui-kangxing': 'shui_kangxing',
  'huo-kangxing': 'huo_kangxing',
  'tu-kangxing': 'tu_kangxing',
};

const toNonEmptyLowerText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const text = value.trim().toLowerCase();
  return text.length > 0 ? text : '';
};

const encodeAuraRuntimeKeyPart = (value: string | number): string => encodeURIComponent(String(value));

const decodeAuraRuntimeKeyPart = (value: string): string => decodeURIComponent(value);

export function normalizeBuffKind(raw: unknown): BuffKind | null {
  const kind = toNonEmptyLowerText(raw);
  return kind ? (kind as BuffKind) : null;
}

export function normalizeBuffAttrKey(raw: unknown): string {
  const lowered = toNonEmptyLowerText(raw);
  if (!lowered) return '';
  const aliased = BUFF_ATTR_ALIAS[lowered] ?? lowered;
  return aliased.replace(/-/g, '_');
}

export function normalizeBuffApplyType(raw: unknown): BuffApplyType | null {
  const applyType = toNonEmptyLowerText(raw);
  if (applyType === 'flat') return 'flat';
  if (applyType === 'percent') return 'percent';
  return null;
}

export function resolveBuffEffectKey(effect: {
  type: 'buff' | 'debuff';
  buffKey?: unknown;
  buffKind?: unknown;
  attrKey?: unknown;
}): string {
  const explicitKey = toNonEmptyLowerText(effect.buffKey);
  if (explicitKey) return explicitKey;

  const kind = normalizeBuffKind(effect.buffKind);
  if (!kind) return '';

  if (kind === 'attr') {
    const attrKey = normalizeBuffAttrKey(effect.attrKey);
    return attrKey ? `${effect.type}-${attrKey}` : `${effect.type}-attr`;
  }

  return `${effect.type}-${kind}`;
}

/**
 * 生成光环宿主 Buff 的运行时唯一键。
 *
 * 作用：
 * 1) 让同一施法者的多个光环实例彼此独立，避免后一个光环把前一个光环宿主 Buff 刷新掉。
 * 2) 保持键值稳定，同一技能同一 effect 位点重复施放时仍走刷新，而不是无限新增。
 *
 * 输入/输出：
 * - 输入：施法者 ID、技能 ID、effect 下标、配置层 buffKey。
 * - 输出：仅供运行时使用的稳定 buffDefId。
 *
 * 边界条件与坑点：
 * 1) 各段必须做 URL 编码，避免技能 ID 或 buffKey 内含分隔符时解析错位。
 * 2) 这里只生成运行时唯一键，不应直接用于日志展示，展示层仍应使用原始 buffKey。
 */
export function buildAuraHostRuntimeBuffKey(params: {
  sourceUnitId: string;
  skillId: string;
  effectIndex: number;
  buffDefId: string;
}): string {
  return [
    AURA_RUNTIME_HOST_PREFIX,
    params.sourceUnitId,
    params.skillId,
    params.effectIndex,
    params.buffDefId,
  ]
    .map(encodeAuraRuntimeKeyPart)
    .join(AURA_RUNTIME_KEY_SEPARATOR);
}

/**
 * 生成光环子 Buff 的运行时唯一键。
 *
 * 作用：
 * 1) 让不同光环实例下发出的同名子 Buff 先各自入表，再交给聚合层统一判定“同类取最高”。
 * 2) 把“光环实例身份”和“子 Buff 原始 key”收口到单一格式，避免战斗模块各自拼字符串。
 *
 * 输入/输出：
 * - 输入：施法者 ID、宿主光环运行时键、子 Buff 原始 key。
 * - 输出：仅供运行时使用的稳定子 Buff 键。
 *
 * 边界条件与坑点：
 * 1) 子 Buff 原始 key 不能为空，否则聚合层无法回收成同类分组键。
 * 2) 宿主光环键必须参与编码，否则同一施法者的多条光环仍会互相刷新。
 */
export function buildAuraSubRuntimeBuffKey(params: {
  sourceUnitId: string;
  auraHostBuffDefId: string;
  subBuffDefId: string;
}): string {
  return [
    AURA_RUNTIME_SUB_PREFIX,
    params.sourceUnitId,
    params.auraHostBuffDefId,
    params.subBuffDefId,
  ]
    .map(encodeAuraRuntimeKeyPart)
    .join(AURA_RUNTIME_KEY_SEPARATOR);
}

/**
 * 从光环子 Buff 运行时键中提取“同类取最高”分组键。
 *
 * 作用：
 * 1) 抹平不同施法者、不同光环实例带来的运行时差异，只保留子 Buff 原始 key 参与互斥比较。
 * 2) 让属性重算、DOT/HOT、反伤等消费端继续共用同一份聚合结果。
 *
 * 输入/输出：
 * - 输入：运行时子 Buff 的 buffDefId。
 * - 输出：原始子 Buff key；若不是光环子 Buff 运行时键则返回 null。
 *
 * 边界条件与坑点：
 * 1) 键段数量不匹配时必须直接返回 null，避免把非光环 Buff 误判成互斥组。
 * 2) 这里只提取最后一段原始子 Buff key，不应把宿主光环键带入分组，否则同类光环会失去互斥能力。
 */
export function resolveAuraSubRuntimeGroupKey(buffDefId: string): string | null {
  const parts = buffDefId.split(AURA_RUNTIME_KEY_SEPARATOR);
  if (parts.length !== 4) return null;

  const [prefix, , , encodedSubBuffDefId] = parts;
  if (decodeAuraRuntimeKeyPart(prefix) !== AURA_RUNTIME_SUB_PREFIX) return null;

  const subBuffDefId = decodeAuraRuntimeKeyPart(encodedSubBuffDefId).trim();
  return subBuffDefId.length > 0 ? subBuffDefId : null;
}

export function resolveSignedAttrValue(effectType: 'buff' | 'debuff', rawValue: unknown): number {
  const value = typeof rawValue === 'number' && Number.isFinite(rawValue)
    ? rawValue
    : typeof rawValue === 'string'
      ? Number(rawValue)
      : 0;
  const absValue = Number.isFinite(value) ? Math.abs(value) : 0;
  if (absValue <= 0) return 0;
  return effectType === 'debuff' ? -absValue : absValue;
}
