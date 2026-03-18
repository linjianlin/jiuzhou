/**
 * 战斗静态定义索引缓存
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把技能/怪物静态定义集中构建为按 id 访问的只读索引，供 battle/shared 热路径复用。
 * 2. 做什么：在静态配置缓存替换后自动重建索引，避免每次请求重复扫描整份定义数组。
 * 3. 不做什么：不解析技能升级、不拼装运行时技能/怪物数据，也不持有战斗状态。
 *
 * 输入/输出：
 * - 输入：staticConfigLoader 暴露的 `getSkillDefinitions()`、`getMonsterDefinitions()` 结果。
 * - 输出：启用状态下的 `ReadonlyMap<string, SkillDefConfig | MonsterDefConfig>`。
 *
 * 数据流/状态流：
 * - staticConfigLoader 缓存数组 -> 本模块按数组引用生成索引 -> skills.ts / monsters.ts 复用同一份索引。
 *
 * 关键边界条件与坑点：
 * 1. 必须以“定义数组引用”作为缓存失效条件；否则静态配置 reload 后会继续命中旧索引。
 * 2. 这里只保留 `enabled !== false` 的定义；调用方不能再各自散落一份启用过滤逻辑。
 */

import {
  getMonsterDefinitions,
  getSkillDefinitions,
  type MonsterDefConfig,
  type SkillDefConfig,
} from "../../staticConfigLoader.js";

type EnabledStaticDefinition = {
  id: string;
  enabled?: boolean;
};

type DefinitionIndexSnapshot<T extends EnabledStaticDefinition> = {
  source: readonly T[];
  enabledById: ReadonlyMap<string, T>;
};

let skillDefinitionSnapshot: DefinitionIndexSnapshot<SkillDefConfig> | null = null;
let monsterDefinitionSnapshot: DefinitionIndexSnapshot<MonsterDefConfig> | null = null;

const buildEnabledDefinitionMap = <T extends EnabledStaticDefinition>(
  definitions: readonly T[],
): ReadonlyMap<string, T> => {
  const enabledById = new Map<string, T>();
  for (const definition of definitions) {
    if (definition.enabled === false) continue;
    enabledById.set(definition.id, definition);
  }
  return enabledById;
};

const getOrCreateDefinitionSnapshot = <T extends EnabledStaticDefinition>(
  definitions: readonly T[],
  currentSnapshot: DefinitionIndexSnapshot<T> | null,
): DefinitionIndexSnapshot<T> => {
  if (currentSnapshot?.source === definitions) {
    return currentSnapshot;
  }

  return {
    source: definitions,
    enabledById: buildEnabledDefinitionMap(definitions),
  };
};

export const getEnabledBattleSkillDefinitionMap = (): ReadonlyMap<string, SkillDefConfig> => {
  skillDefinitionSnapshot = getOrCreateDefinitionSnapshot(
    getSkillDefinitions(),
    skillDefinitionSnapshot,
  );
  return skillDefinitionSnapshot.enabledById;
};

export const getEnabledBattleMonsterDefinitionMap = (): ReadonlyMap<string, MonsterDefConfig> => {
  monsterDefinitionSnapshot = getOrCreateDefinitionSnapshot(
    getMonsterDefinitions(),
    monsterDefinitionSnapshot,
  );
  return monsterDefinitionSnapshot.enabledById;
};
