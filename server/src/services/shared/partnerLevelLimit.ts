/**
 * 伙伴等级境界限制共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护“角色当前境界 -> 伙伴等级上限 -> 当前生效等级”的唯一换算规则，供伙伴展示、战斗构建与培养入口复用。
 * 2. 做什么：把实际等级与生效等级拆开，避免总览、战斗和灌注链路各自重复判断“是否超出境界上限”。
 * 3. 不做什么：不直接读写数据库，不决定前端文案，也不处理角色境界突破流程。
 *
 * 输入/输出：
 * - 输入：角色境界上下文 `realm/subRealm` 与伙伴当前实际等级。
 * - 输出：当前境界、伙伴等级上限、当前生效等级，以及是否存在等级压制。
 *
 * 数据流/状态流：
 * - 角色境界 -> 本模块计算等级上限与生效等级 -> 伙伴 DTO / 战斗属性 / 灌注校验统一消费。
 *
 * 关键边界条件与坑点：
 * 1. 境界枚举必须严格走共享 `realmRules`，未知境界不能让等级上限漂移到错误档位。
 * 2. 超出上限的伙伴仍允许展示和出战，因此这里返回“实际等级 + 生效等级”双值，而不是直接覆盖原等级。
 */

import { getRealmRankOneBasedStrict, normalizeRealmStrict, type RealmName } from './realmRules.js';

export type PartnerOwnerRealmContext = {
  realm: string;
  subRealm: string | null;
};

export type PartnerLevelLimitSnapshot = {
  currentRealm: RealmName;
  levelCap: number;
  actualLevel: number;
  effectiveLevel: number;
  isLevelLimited: boolean;
};

const normalizeInteger = (value: unknown, minimum: number = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.floor(parsed));
};

export const resolvePartnerLevelLimit = (params: {
  ownerRealm: PartnerOwnerRealmContext;
  partnerLevel: number;
}): PartnerLevelLimitSnapshot => {
  const currentRealm = normalizeRealmStrict(
    params.ownerRealm.realm,
    params.ownerRealm.subRealm,
  );
  const realmRank = getRealmRankOneBasedStrict(
    params.ownerRealm.realm,
    params.ownerRealm.subRealm,
  );
  const actualLevel = Math.max(1, normalizeInteger(params.partnerLevel, 1));
  const levelCap = Math.max(10, realmRank * 10);
  const effectiveLevel = Math.min(actualLevel, levelCap);

  return {
    currentRealm,
    levelCap,
    actualLevel,
    effectiveLevel,
    isLevelLimited: actualLevel > levelCap,
  };
};
