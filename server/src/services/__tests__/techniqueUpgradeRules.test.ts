/**
 * 功法层级技能解锁规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“技能首次出现在 `upgradeSkillIds` 也会从该层开始解锁”的共享规则，避免战斗可用技能和面板展示再次分叉。
 * 2. 做什么：同时验证 upgradeLevel 统计仍保持原语义，确保补解锁后不会把强化层数算错。
 * 3. 不做什么：不读取静态配置文件、不访问数据库，也不覆盖角色技能槽装配逻辑。
 *
 * 输入/输出：
 * - 输入：手工构造的 `TechniqueLayerStaticRow[]` 与当前层数。
 * - 输出：已解锁技能集合与技能强化次数映射。
 *
 * 数据流/状态流：
 * technique_layer 静态层数组 -> techniqueUpgradeRules 共享函数 -> characterAvailableSkills / 战斗链路消费。
 *
 * 关键边界条件与坑点：
 * 1. 仅存在于 `upgradeSkillIds` 的技能必须在首次出现层进入解锁集合，否则生成功法会出现“预览可见、实战不可用”的断层。
 * 2. 视为解锁不等于额外多算强化次数；upgradeLevel 仍只由 `upgradeSkillIds` 的累计出现次数决定。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTechniqueSkillUpgradeCountMap,
  buildTechniqueUnlockedSkillIdSet,
  type TechniqueLayerStaticRow,
} from '../shared/techniqueUpgradeRules.js';

const buildLayerRow = (
  overrides: Partial<TechniqueLayerStaticRow>,
): TechniqueLayerStaticRow => {
  return {
    techniqueId: 'tech-test',
    layer: 1,
    costSpiritStones: 0,
    costExp: 0,
    costMaterials: [],
    passives: [],
    unlockSkillIds: [],
    upgradeSkillIds: [],
    requiredRealm: null,
    ...overrides,
  };
};

test('buildTechniqueUnlockedSkillIdSet: 首次出现在 upgradeSkillIds 的技能也应视为已解锁', () => {
  const layerRows: TechniqueLayerStaticRow[] = [
    buildLayerRow({
      layer: 1,
      unlockSkillIds: ['skill-a'],
    }),
    buildLayerRow({
      layer: 2,
      upgradeSkillIds: ['skill-a'],
    }),
    buildLayerRow({
      layer: 3,
      upgradeSkillIds: ['skill-b'],
    }),
  ];

  assert.deepEqual(
    Array.from(buildTechniqueUnlockedSkillIdSet(layerRows, 2)).sort(),
    ['skill-a'],
  );
  assert.deepEqual(
    Array.from(buildTechniqueUnlockedSkillIdSet(layerRows, 3)).sort(),
    ['skill-a', 'skill-b'],
  );
});

test('buildTechniqueSkillUpgradeCountMap: 补解锁后仍只按 upgradeSkillIds 统计强化次数', () => {
  const layerRows: TechniqueLayerStaticRow[] = [
    buildLayerRow({
      layer: 1,
      unlockSkillIds: ['skill-a'],
    }),
    buildLayerRow({
      layer: 2,
      upgradeSkillIds: ['skill-a', 'skill-b'],
    }),
    buildLayerRow({
      layer: 3,
      upgradeSkillIds: ['skill-b'],
    }),
  ];

  const upgradeCountMap = buildTechniqueSkillUpgradeCountMap(layerRows, 3);
  assert.equal(upgradeCountMap.get('skill-a'), 1);
  assert.equal(upgradeCountMap.get('skill-b'), 2);
});
