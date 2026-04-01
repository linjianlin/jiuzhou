/**
 * 千层塔算法生成器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：基于层数与怪物池定义，稳定生成每层的怪物组合、层型、候选池来源与属性倍率。
 * 2. 做什么：把塔的“节奏规则”集中为单一算法入口，避免路由、结算、前端预览各自拼一遍楼层逻辑。
 * 3. 不做什么：不写数据库，也不直接创建 battle session。
 *
 * 输入/输出：
 * - 输入：层数，以及按 `kind -> realm` 预分组后的怪物池。
 * - 输出：该层的战斗怪物与前端可展示的预览 DTO。
 *
 * 数据流/状态流：
 * - tower service 调用本模块 -> 生成楼层快照 -> start battle / overview / settlement 共用同一结果。
 *
 * 关键边界条件与坑点：
 * 1. 封顶前继续按境界推进选怪，封顶后改为按 `kind` 进入全量混池；这条规则必须只存在于本模块，不能散落到 service 或前端预览。
 * 2. 强度倍率在怪物 `base_attrs` 上一次性生效，并把 encounter variance 归零，避免同一层在不同入口里出现额外随机漂移。
 * 3. overflow 混池预览必须明确标出“混池”状态，否则前端会把最后一个境界名误当成当前层只会出该境界怪。
 */

import type { MonsterData } from '../../battle/battleFactory.js';
import { getMonsterDefinitions, type MonsterDefConfig } from '../staticConfigLoader.js';
import { REALM_ORDER, normalizeRealmStrict } from '../shared/realmRules.js';
import { pickDeterministicIndex, pickDeterministicItems } from '../shared/deterministicHash.js';
import { scaleMonsterBaseAttrs } from '../shared/monsterBaseAttrScaling.js';
import { resolveTowerAttrMultiplier } from './difficulty.js';
import type { ResolvedTowerFloor, TowerFloorKind, TowerMonsterPoolState } from './types.js';

const TOWER_CYCLE_FLOORS = 10;
const TOWER_NORMAL_MONSTER_COUNT_MIN = 2;
const TOWER_NORMAL_MONSTER_COUNT_VARIANCE = 2;
const TOWER_NORMAL_MONSTER_COUNT_INTERVAL = 50;
const TOWER_NORMAL_MONSTER_COUNT_CAP = 5;
const TOWER_ELITE_MONSTER_COUNT_BASE = 2;
const TOWER_ELITE_MONSTER_COUNT_INTERVAL = 75;
const TOWER_ELITE_MONSTER_COUNT_CAP = 4;
const TOWER_BOSS_MONSTER_COUNT_BASE = 1;
const TOWER_BOSS_MONSTER_COUNT_INTERVAL = 100;
const TOWER_BOSS_MONSTER_COUNT_CAP = 3;

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

export const buildTowerMonsterPoolsFromDefinitions = (
  monsterDefinitions: MonsterDefConfig[] = getMonsterDefinitions(),
): TowerMonsterPoolState => {
  const pools: TowerMonsterPoolState = {
    normal: new Map(),
    elite: new Map(),
    boss: new Map(),
  };

  for (const monster of monsterDefinitions) {
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

const towerMonsterPools = buildTowerMonsterPoolsFromDefinitions();

export const getLiveTowerMonsterPools = (): TowerMonsterPoolState => {
  return towerMonsterPools;
};

export const buildTowerMixedMonsterCandidates = (params: {
  kind: TowerFloorKind;
  pools: TowerMonsterPoolState;
}): MonsterDefConfig[] => {
  const bucket = params.pools[params.kind];
  const candidates: MonsterDefConfig[] = [];

  for (const realm of REALM_ORDER) {
    const monsters = bucket.get(realm);
    if (!monsters || monsters.length <= 0) continue;
    candidates.push(...monsters);
  }

  if (candidates.length <= 0) {
    throw new Error(`千层塔缺少 ${params.kind} 混池怪物`);
  }

  return candidates;
};

const resolveKindRealmForFloor = (params: {
  floor: number;
  kind: TowerFloorKind;
  pools: TowerMonsterPoolState;
}): { realm: string; overflowTierCount: number } => {
  const pool = params.pools[params.kind];
  const realms = REALM_ORDER.filter((realm) => pool.has(realm));
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

const resolveTowerMonsterCountGrowth = (params: {
  floor: number;
  interval: number;
}): number => {
  const floor = Math.max(1, Math.floor(params.floor));
  return Math.floor(floor / params.interval);
};

export const resolveTowerMonsterCandidatesForFloor = (params: {
  floor: number;
  kind: TowerFloorKind;
  pools: TowerMonsterPoolState;
}): {
  realm: string;
  overflowTierCount: number;
  poolMode: 'realm' | 'mixed';
  candidates: MonsterDefConfig[];
} => {
  const kindRealmResult = resolveKindRealmForFloor({
    floor: params.floor,
    kind: params.kind,
    pools: params.pools,
  });

  if (kindRealmResult.overflowTierCount > 0) {
    return {
      realm: kindRealmResult.realm,
      overflowTierCount: kindRealmResult.overflowTierCount,
      poolMode: 'mixed',
      candidates: buildTowerMixedMonsterCandidates({
        kind: params.kind,
        pools: params.pools,
      }),
    };
  }

  const candidates = params.pools[params.kind].get(kindRealmResult.realm);
  if (!candidates || candidates.length <= 0) {
    throw new Error(
      `千层塔楼层缺少怪物候选: floor=${Math.max(1, Math.floor(params.floor))}, kind=${params.kind}, realm=${kindRealmResult.realm}`,
    );
  }

  return {
    realm: kindRealmResult.realm,
    overflowTierCount: kindRealmResult.overflowTierCount,
    poolMode: 'realm',
    candidates,
  };
};

export const resolveTowerMonsterCountForFloor = (params: {
  kind: TowerFloorKind;
  floor: number;
  seed: string;
}): number => {
  if (params.kind === 'boss') {
    return Math.min(
      TOWER_BOSS_MONSTER_COUNT_CAP,
      TOWER_BOSS_MONSTER_COUNT_BASE + resolveTowerMonsterCountGrowth({
        floor: params.floor,
        interval: TOWER_BOSS_MONSTER_COUNT_INTERVAL,
      }),
    );
  }
  if (params.kind === 'elite') {
    return Math.min(
      TOWER_ELITE_MONSTER_COUNT_CAP,
      TOWER_ELITE_MONSTER_COUNT_BASE + resolveTowerMonsterCountGrowth({
        floor: params.floor,
        interval: TOWER_ELITE_MONSTER_COUNT_INTERVAL,
      }),
    );
  }
  const extraCount = pickDeterministicIndex({
    seed: `${params.seed}::monster-count`,
    length: TOWER_NORMAL_MONSTER_COUNT_VARIANCE,
  });
  return Math.min(
    TOWER_NORMAL_MONSTER_COUNT_CAP,
    TOWER_NORMAL_MONSTER_COUNT_MIN + extraCount + resolveTowerMonsterCountGrowth({
      floor: params.floor,
      interval: TOWER_NORMAL_MONSTER_COUNT_INTERVAL,
    }),
  );
};

const buildTowerMonsterForFloor = (params: {
  monster: MonsterDefConfig;
  kind: TowerFloorKind;
  attrMultiplier: number;
}): MonsterData => {
  const baseAttrs = scaleMonsterBaseAttrs(
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

export const resolveTowerFloorFromPools = (params: {
  floor: number;
  pools: TowerMonsterPoolState;
}): ResolvedTowerFloor => {
  const floor = Math.max(1, Math.floor(params.floor));
  const kind = getTowerFloorKind(floor);
  const seed = `tower:${floor}`;
  const {
    realm,
    overflowTierCount,
    poolMode,
    candidates,
  } = resolveTowerMonsterCandidatesForFloor({
    floor,
    kind,
    pools: params.pools,
  });

  const attrMultiplier = resolveTowerAttrMultiplier({
    floor,
    kind,
    overflowTierCount,
  });
  const monsterCount = resolveTowerMonsterCountForFloor({ kind, floor, seed });

  const previewRealm = poolMode === 'mixed' ? `${realm}·混池` : realm;
  const monsters = pickDeterministicItems({
    seed: `${seed}::monster`,
    items: candidates,
    count: monsterCount,
  }).map((monster) => buildTowerMonsterForFloor({
    monster,
    kind,
    attrMultiplier,
  }));

  return {
    monsters,
    preview: {
      floor,
      kind,
      seed,
      realm: previewRealm,
      monsterIds: monsters.map((monster) => monster.id),
      monsterNames: monsters.map((monster) => monster.name),
    },
  };
};

export const resolveTowerFloor = (params: {
  floor: number;
  characterId?: number;
}): ResolvedTowerFloor => {
  return resolveTowerFloorFromPools({
    floor: params.floor,
    pools: towerMonsterPools,
  });
};
