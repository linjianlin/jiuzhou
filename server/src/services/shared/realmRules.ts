/**
 * 境界序列与归一化规则（服务端共享）
 *
 * 输入：
 * - realmRaw/subRealmRaw：角色境界主阶段与小阶段（可能为空、可能是全称、主阶段或小阶段）
 *
 * 输出：
 * - REALM_ORDER：统一境界顺序
 * - normalizeRealmKeepingUnknown：尽量标准化；无法识别时保留原始主阶段文本
 * - normalizeRealmStrict：只返回受支持境界，无法识别回退“凡人”
 * - getRealmOrderIndex/getRealmRankZeroBased/getRealmRankOneBasedStrict：统一排名计算
 *
 * 注意：
 * - 不同业务对“未知境界”处理不同：有的需要 -1，有的需要回退 0 或 1。
 * - 这里提供多种 rank 函数，由调用方按语义选择，避免隐式行为变化。
 */
export const REALM_ORDER = [
  '凡人',
  '炼精化炁·养气期',
  '炼精化炁·通脉期',
  '炼精化炁·凝炁期',
  '炼炁化神·炼己期',
  '炼炁化神·采药期',
  '炼炁化神·结胎期',
  '炼神返虚·养神期',
  '炼神返虚·还虚期',
  '炼神返虚·合道期',
  '炼虚合道·证道期',
  '炼虚合道·历劫期',
  '炼虚合道·成圣期',
] as const;

export type RealmName = (typeof REALM_ORDER)[number];

export const REALM_MAJOR_TO_FIRST: Record<string, RealmName> = {
  凡人: '凡人',
  炼精化炁: '炼精化炁·养气期',
  炼炁化神: '炼炁化神·炼己期',
  炼神返虚: '炼神返虚·养神期',
  炼虚合道: '炼虚合道·证道期',
};

export const REALM_SUB_TO_FULL: Record<string, RealmName> = {
  养气期: '炼精化炁·养气期',
  通脉期: '炼精化炁·通脉期',
  凝炁期: '炼精化炁·凝炁期',
  炼己期: '炼炁化神·炼己期',
  采药期: '炼炁化神·采药期',
  结胎期: '炼炁化神·结胎期',
  养神期: '炼神返虚·养神期',
  还虚期: '炼神返虚·还虚期',
  合道期: '炼神返虚·合道期',
  证道期: '炼虚合道·证道期',
  历劫期: '炼虚合道·历劫期',
  成圣期: '炼虚合道·成圣期',
};

const toTrimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const isRealmName = (value: string): value is RealmName => {
  return (REALM_ORDER as readonly string[]).includes(value);
};

export const normalizeRealmKeepingUnknown = (realmRaw: unknown, subRealmRaw?: unknown): string => {
  const realm = toTrimmedString(realmRaw);
  const subRealm = toTrimmedString(subRealmRaw);
  if (!realm && !subRealm) return '凡人';
  if (realm && isRealmName(realm)) return realm;
  if (realm && subRealm) {
    const full = `${realm}·${subRealm}`;
    if (isRealmName(full)) return full;
  }
  if (realm && REALM_MAJOR_TO_FIRST[realm]) return REALM_MAJOR_TO_FIRST[realm];
  if (realm && REALM_SUB_TO_FULL[realm]) return REALM_SUB_TO_FULL[realm];
  if (!realm && subRealm && REALM_SUB_TO_FULL[subRealm]) return REALM_SUB_TO_FULL[subRealm];
  return realm || '凡人';
};

export const normalizeRealmStrict = (realmRaw: unknown, subRealmRaw?: unknown): RealmName => {
  const normalized = normalizeRealmKeepingUnknown(realmRaw, subRealmRaw);
  if (isRealmName(normalized)) return normalized;
  return '凡人';
};

export const getRealmOrderIndex = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  const normalized = normalizeRealmKeepingUnknown(realmRaw, subRealmRaw);
  return REALM_ORDER.indexOf(normalized as RealmName);
};

export const getRealmRankZeroBased = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  const index = getRealmOrderIndex(realmRaw, subRealmRaw);
  return index >= 0 ? index : 0;
};

export const getRealmRankOneBasedStrict = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  const normalized = normalizeRealmStrict(realmRaw, subRealmRaw);
  const index = REALM_ORDER.indexOf(normalized);
  return index >= 0 ? index + 1 : 1;
};

/**
 * 装备需求境界归一化（兼容旧逻辑）
 *
 * 与 normalizeRealmStrict 的区别：
 * - 额外兼容形如 `主阶段·子阶段·其他` 的文本，按前两段尝试匹配；
 * - 无法识别时固定回退为“凡人”，用于装备相关的保守口径。
 */
export const normalizeRealmForEquipment = (realmRaw?: unknown): RealmName => {
  const raw = toTrimmedString(realmRaw);
  if (!raw) return '凡人';
  if (isRealmName(raw)) return raw;

  const mappedMajor = REALM_MAJOR_TO_FIRST[raw];
  if (mappedMajor) return mappedMajor;

  const mappedSub = REALM_SUB_TO_FULL[raw];
  if (mappedSub) return mappedSub;

  const split = raw.split('·');
  if (split.length >= 2) {
    const full = `${split[0]}·${split[1]}`;
    if (isRealmName(full)) return full;
    const subMapped = REALM_SUB_TO_FULL[split[1] ?? ''];
    if (subMapped) return subMapped;
  }

  return '凡人';
};

/**
 * 装备体系使用的 1-based 境界档位（最小为 1）。
 */
export const getRealmRankOneBasedForEquipment = (realmRaw?: unknown): number => {
  const normalized = normalizeRealmForEquipment(realmRaw);
  const index = REALM_ORDER.indexOf(normalized);
  return index >= 0 ? index + 1 : 1;
};
