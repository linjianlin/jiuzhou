/**
 * 千层塔算法生成器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：基于角色 ID、层数与怪物静态定义，稳定生成每层的怪物组合、层型与属性倍率。
 * 2. 做什么：把塔的“节奏规则”集中为单一算法入口，避免路由、结算、前端预览各自拼一遍楼层逻辑。
 * 3. 不做什么：不写数据库，也不直接创建 battle session。
 *
 * 输入/输出：
 * - 输入：角色 ID、层数。
 * - 输出：该层的战斗怪物与前端可展示的预览 DTO。
 *
 * 数据流/状态流：
 * - tower service 调用本模块 -> 生成楼层快照 -> start battle / overview / settlement 共用同一结果。
 *
 * 关键边界条件与坑点：
 * 1. 怪物池按 `kind -> realm` 预分组；如果某个 kind 没有任何可用怪物，会直接抛错阻断服务启动期配置问题。
 * 2. 强度倍率在怪物 `base_attrs` 上一次性生效，并把 encounter variance 归零，避免同一层在同一角色身上再次出现额外随机漂移。
 */

import type { MonsterData } from '../../battle/battleFactory.js';
import { getMonsterDefinitions, type MonsterDefConfig } from '../staticConfigLoader.js';
import { REALM_ORDER, normalizeRealmStrict } from '../shared/realmRules.js';
import { pickDeterministicItem, pickDeterministicIndex } from '../shared/deterministicHash.js';
import { resolveTowerAttrMultiplier } from './difficulty.js';
import type { ResolvedTowerFloor, TowerFloorKind } from './types.js';

const TOWER_CYCLE_FLOORS = 10;

type TowerMonsterPoolState = {
  normal: Map<string, MonsterDefConfig[]>;
  elite: Map<string, MonsterDefConfig[]>;
  boss: Map<string, MonsterDefConfig[]>;
};

const normalizeTowerMonsterKind = (value: string | null | undefined): TowerFloorKind => {
  if (value === 'boss') return 'boss';
  if (value === 'elite') return 'elite';
  return 'normal';
};

const getTowerFloorKind = (floor: number): TowerFloorKind => {
  if (floor % 10 === 0) return 'boss';
  if (floor % 5 === 0) return 'elite';
  return 'normal';
};

const cloneMonsterBaseAttrs = (
  raw: MonsterData['base_attrs'] | undefined,
  multiplier: number,
): MonsterData['base_attrs'] => {
  const source = raw ?? {};
  const next: MonsterData['base_attrs'] = {};
  for (const [attrKey, attrValue] of Object.entries(source)) {
    const value = Number(attrValue);
    if (!Number.isFinite(value) || value <= 0) continue;
    const isRatioAttr =
      attrKey === 'mingzhong'
      || attrKey === 'shanbi'
      || attrKey === 'zhaojia'
      || attrKey === 'baoji'
      || attrKey === 'baoshang'
      || attrKey === 'jianbaoshang'
      || attrKey === 'jianfantan'
      || attrKey === 'kangbao'
      || attrKey === 'zengshang'
      || attrKey === 'zhiliao'
      || attrKey === 'jianliao'
      || attrKey === 'xixue'
      || attrKey === 'lengque'
      || attrKey === 'kongzhi_kangxing'
      || attrKey === 'jin_kangxing'
      || attrKey === 'mu_kangxing'
      || attrKey === 'shui_kangxing'
      || attrKey === 'huo_kangxing'
      || attrKey === 'tu_kangxing'
      || attrKey === 'qixue_huifu'
      || attrKey === 'lingqi_huifu';
    const scaled = value * multiplier;
    next[attrKey as keyof MonsterData['base_attrs']] = isRatioAttr
      ? Number(scaled.toFixed(6))
      : Math.max(1, Math.round(scaled));
  }
  return next;
};

const buildTowerMonsterPools = (): TowerMonsterPoolState => {
  const pools: TowerMonsterPoolState = {
    normal: new Map(),
    elite: new Map(),
    boss: new Map(),
  };

  for (const monster of getMonsterDefinitions()) {
    if (monster.enabled === false) continue;
    const monsterId = typeof monster.id === 'string' ? monster.id.trim() : '';
    if (!monsterId) continue;
    const kind = normalizeTowerMonsterKind(monster.kind);
    const realm = normalizeRealmStrict(monster.realm ?? '凡人');
    const targetPool = pools[kind];
    const group = targetPool.get(realm) ?? [];
    group.push({
      ...monster,
      id: monsterId,
    });
    targetPool.set(realm, group);
  }

  for (const kind of ['normal', 'elite', 'boss'] as const) {
    const targetPool = pools[kind];
    for (const monsters of targetPool.values()) {
      monsters.sort((left, right) => left.id.localeCompare(right.id));
    }
    if (targetPool.size <= 0) {
      throw new Error(`千层塔缺少可用怪物池: ${kind}`);
    }
  }

  return pools;
};

const towerMonsterPools = buildTowerMonsterPools();

const getRealmSequenceForKind = (kind: TowerFloorKind): string[] => {
  const pool = towerMonsterPools[kind];
  return REALM_ORDER.filter((realm) => pool.has(realm));
};

const resolveKindRealmForFloor = (params: {
  floor: number;
  kind: TowerFloorKind;
}): { realm: string; overflowTierCount: number } => {
  const realms = getRealmSequenceForKind(params.kind);
  if (realms.length <= 0) {
    throw new Error(`千层塔缺少 ${params.kind} 境界怪物`);
  }
  const cycleIndex = Math.floor((params.floor - 1) / TOWER_CYCLE_FLOORS);
  const realmIndex = Math.min(cycleIndex, realms.length - 1);
  return {
    realm: realms[realmIndex] as string,
    overflowTierCount: Math.max(0, cycleIndex - (realms.length - 1)),
  };
};

const resolveMonsterCountForFloor = (params: {
  kind: TowerFloorKind;
  floor: number;
  seed: string;
}): number => {
  if (params.kind === 'boss') return 1;
  if (params.kind === 'elite') return 2;
  const extraCount = pickDeterministicIndex({
    seed: `${params.seed}::monster-count`,
    length: 2,
  });
  return 2 + extraCount;
};

const buildTowerMonsterForFloor = (params: {
  monster: MonsterDefConfig;
  kind: TowerFloorKind;
  attrMultiplier: number;
}): MonsterData => {
  const baseAttrs = cloneMonsterBaseAttrs(
    (params.monster.base_attrs ?? {}) as MonsterData['base_attrs'],
    params.attrMultiplier,
  );
  return {
    id: params.monster.id,
    name: params.monster.name,
    realm: normalizeRealmStrict(params.monster.realm ?? '凡人'),
    element: typeof params.monster.element === 'string' ? params.monster.element : 'none',
    base_attrs: baseAttrs,
    ai_profile: params.monster.ai_profile as MonsterData['ai_profile'],
    attr_variance: 0,
    attr_multiplier_min: 1,
    attr_multiplier_max: 1,
    exp_reward: 0,
    silver_reward_min: 0,
    silver_reward_max: 0,
    kind: params.kind,
  };
};

export const resolveTowerFloor = (params: {
  characterId: number;
  floor: number;
}): ResolvedTowerFloor => {
  const floor = Math.max(1, Math.floor(params.floor));
  const kind = getTowerFloorKind(floor);
  const seed = `tower:${params.characterId}:${floor}`;
  const { realm, overflowTierCount } = resolveKindRealmForFloor({ floor, kind });
  const candidates = towerMonsterPools[kind].get(realm);
  if (!candidates || candidates.length <= 0) {
    throw new Error(`千层塔楼层缺少怪物候选: floor=${floor}, kind=${kind}, realm=${realm}`);
  }

  const attrMultiplier = resolveTowerAttrMultiplier({
    floor,
    kind,
    overflowTierCount,
  });
  const monsterCount = resolveMonsterCountForFloor({ kind, floor, seed });

  const monsters = Array.from({ length: monsterCount }, (_value, index) => {
    const picked = pickDeterministicItem({
      seed: `${seed}::monster`,
      items: candidates,
      offset: index,
    });
    return buildTowerMonsterForFloor({
      monster: picked,
      kind,
      attrMultiplier,
    });
  });

  return {
    monsters,
    preview: {
      floor,
      kind,
      seed,
      realm,
      monsterIds: monsters.map((monster) => monster.id),
      monsterNames: monsters.map((monster) => monster.name),
    },
  };
};
