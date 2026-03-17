/**
 * 作用：
 * - 校验战斗技能装载入口会保留 triggerType，并且把被动技能从技能槽依赖中解耦。
 * - 这里只测纯函数，不涉及数据库，确保方案二的复用逻辑稳定。
 *
 * 输入/输出：
 * - 输入：已装备功法、技能槽、技能定义映射、层级规则。
 * - 输出：战斗技能条目数组，包含 `skillId / upgradeLevel / triggerType`。
 *
 * 数据流：
 * - 装备功法与层级规则先解出“已解锁技能”和“升级次数”。
 * - 主动技能只保留已装槽的 active。
 * - 被动技能从已装备功法里直接补齐，不依赖技能槽。
 *
 * 边界条件与坑点：
 * 1. 被动技能即使排进技能槽，也不能占用主动技能顺序。
 * 2. 未装任何技能槽时，被动技能仍应进入战斗技能列表。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { SkillDefConfig } from '../staticConfigLoader.js';
import type { TechniqueLayerStaticRow } from '../shared/techniqueUpgradeRules.js';
import {
  buildCharacterBattleSkillEntries,
  canEquipBattleSkillToSlot,
} from '../shared/characterBattleSkillLoadout.js';

const buildSkillDefMap = (): ReadonlyMap<string, SkillDefConfig> => {
  const rows: SkillDefConfig[] = [
    {
      id: 'skill-active-moon-slash',
      name: '月刃斩',
      source_type: 'technique',
      source_id: 'tech-mirror-moon',
      trigger_type: 'active',
      target_type: 'single_enemy',
      target_count: 1,
      damage_type: 'magic',
      element: 'shui',
      effects: [],
      enabled: true,
    },
    {
      id: 'skill-passive-mirror-aura',
      name: '镜月常明',
      source_type: 'technique',
      source_id: 'tech-mirror-moon',
      trigger_type: 'passive',
      target_type: 'self',
      target_count: 1,
      damage_type: 'magic',
      element: 'shui',
      effects: [],
      enabled: true,
    },
  ] as SkillDefConfig[];
  return new Map(rows.map((row) => [row.id, row] as const));
};

const buildLayerRows = (): TechniqueLayerStaticRow[] => [
  {
    techniqueId: 'tech-mirror-moon',
    layer: 1,
    costSpiritStones: 0,
    costExp: 0,
    costMaterials: [],
    passives: [],
    unlockSkillIds: ['skill-active-moon-slash', 'skill-passive-mirror-aura'],
    upgradeSkillIds: [],
    requiredRealm: null,
    layerDesc: '第一层',
  },
  {
    techniqueId: 'tech-mirror-moon',
    layer: 2,
    costSpiritStones: 0,
    costExp: 0,
    costMaterials: [],
    passives: [],
    unlockSkillIds: [],
    upgradeSkillIds: ['skill-active-moon-slash'],
    requiredRealm: null,
    layerDesc: '第二层',
  },
];

test('主动技能保留槽位顺序，被动技能自动补入且不占主动槽', () => {
  const result = buildCharacterBattleSkillEntries({
    equippedTechniques: [{ techniqueId: 'tech-mirror-moon', currentLayer: 2 }],
    slottedSkills: [
      { skillId: 'skill-passive-mirror-aura', slotIndex: 1 },
      { skillId: 'skill-active-moon-slash', slotIndex: 2 },
    ],
    skillDefs: buildSkillDefMap(),
    layerRows: buildLayerRows(),
  });

  assert.deepEqual(result, [
    {
      skillId: 'skill-active-moon-slash',
      upgradeLevel: 1,
      triggerType: 'active',
    },
    {
      skillId: 'skill-passive-mirror-aura',
      upgradeLevel: 0,
      triggerType: 'passive',
    },
  ]);
});

test('未装技能槽时，被动技能仍会进入战斗列表', () => {
  const result = buildCharacterBattleSkillEntries({
    equippedTechniques: [{ techniqueId: 'tech-mirror-moon', currentLayer: 1 }],
    slottedSkills: [],
    skillDefs: buildSkillDefMap(),
    layerRows: buildLayerRows(),
  });

  assert.deepEqual(result, [
    {
      skillId: 'skill-passive-mirror-aura',
      upgradeLevel: 0,
      triggerType: 'passive',
    },
  ]);
});

test('passive skill cannot be equipped into battle slots', () => {
  assert.equal(canEquipBattleSkillToSlot('active'), true);
  assert.equal(canEquipBattleSkillToSlot('passive'), false);
  assert.equal(canEquipBattleSkillToSlot(undefined), true);
});
