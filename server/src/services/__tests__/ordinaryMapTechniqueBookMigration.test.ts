/**
 * 普通地图功法书迁移测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定“普通地图怪物不再掉落功法书，迁移后的功法书改由对应养气期秘境掉落”这一条静态配置规则。
 * - 不做什么：不执行真实战斗，也不校验具体掉率平衡，只验证配置边界是否被破坏。
 *
 * 输入/输出：
 * - 输入：map / monster / item / drop_pool / drop_pool_common / dungeon 六类种子数据。
 * - 输出：断言普通地图合并掉落中不存在 `technique_book`，并断言两座养气期秘境的目标怪物池包含迁移后的功法书。
 *
 * 数据流/状态流：
 * - 先从地图种子收集所有普通地图会刷新的怪物；
 * - 再串联怪物定义与合并后的掉落池，统一判定地图侧是否仍残留功法书；
 * - 最后回到养气期秘境配置，确认苍狼巢穴与石窟矿洞已经接住这批功法书掉落。
 *
 * 关键边界条件与坑点：
 * 1) 地图怪物的最终掉落需要合并公共池与专属池后再判断，不能只看专属 entries，否则会漏掉公共池里未来新增的功法书。
 * 2) 石窟矿洞为了和普通地图解耦，使用了秘境专用石傀儡；测试必须直接锁定该怪物 ID，避免后续又改回共享怪物导致地图侧回流。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asArray,
  asObject,
  asText,
  buildObjectMap,
  collectMergedPoolItemIds,
  loadSeed,
} from './seedTestUtils.js';

const TECHNIQUE_BOOK_SUB_CATEGORY = 'technique_book';
const WOLF_DEN_BOOK_IDS = ['book-tiebu-quan', 'book-jingang-quan'] as const;
const STONE_MINE_BOOK_IDS = ['book-houtu-gong', 'book-shuiyun-zhang'] as const;
const WOLF_DEN_MONSTER_ID = 'monster-dungeon-wolf-king';
const STONE_MINE_MONSTER_ID = 'monster-dungeon-stone-golem';

const collectMapMonsterIds = () => {
  const mapSeed = loadSeed('map_def.json');
  const monsterIds = new Set<string>();
  for (const mapValue of asArray(mapSeed.maps)) {
    const map = asObject(mapValue);
    if (!map) continue;
    for (const roomValue of asArray(map.rooms)) {
      const room = asObject(roomValue);
      if (!room) continue;
      for (const monsterValue of asArray(room.monsters)) {
        const monster = asObject(monsterValue);
        const monsterId = asText(monster?.monster_def_id);
        if (monsterId) monsterIds.add(monsterId);
      }
    }
  }
  return monsterIds;
};

const collectDungeonMonsterIds = (seedFileName: string): Set<string> => {
  const dungeonSeed = loadSeed(seedFileName);
  const monsterIds = new Set<string>();
  for (const dungeonValue of asArray(dungeonSeed.dungeons)) {
    const dungeon = asObject(dungeonValue);
    if (!dungeon) continue;
    for (const difficultyValue of asArray(dungeon.difficulties)) {
      const difficulty = asObject(difficultyValue);
      if (!difficulty) continue;
      for (const stageValue of asArray(difficulty.stages)) {
        const stage = asObject(stageValue);
        if (!stage) continue;
        for (const waveValue of asArray(stage.waves)) {
          const wave = asObject(waveValue);
          if (!wave) continue;
          for (const monsterValue of asArray(wave.monsters)) {
            const monster = asObject(monsterValue);
            const monsterId = asText(monster?.monster_def_id);
            if (monsterId) monsterIds.add(monsterId);
          }
        }
      }
    }
  }
  return monsterIds;
};

test('普通地图不再掉落功法书，养气期秘境承接对应秘籍掉落', () => {
  const itemSeed = loadSeed('item_def.json');
  const monsterSeed = loadSeed('monster_def.json');
  const dropPoolSeed = loadSeed('drop_pool.json');
  const commonDropPoolSeed = loadSeed('drop_pool_common.json');

  const itemById = buildObjectMap(asArray(itemSeed.items), 'id');
  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const dropPoolById = buildObjectMap(asArray(dropPoolSeed.pools), 'id');
  const commonPoolById = buildObjectMap(asArray(commonDropPoolSeed.pools), 'id');
  const mapMonsterIds = collectMapMonsterIds();
  const wolfDenDungeonMonsterIds = collectDungeonMonsterIds('dungeon_qi_cultivation_1.json');
  const stoneMineDungeonMonsterIds = collectDungeonMonsterIds('dungeon_qi_cultivation_2.json');

  const itemSubCategoryById = new Map(
    Array.from(itemById.entries()).map(([itemId, item]) => [itemId, asText(item.sub_category)] as const),
  );

  for (const monsterId of mapMonsterIds) {
    const monster = monsterById.get(monsterId);
    assert.ok(monster, `普通地图引用了不存在怪物: ${monsterId}`);
    const dropPoolId = asText(monster.drop_pool_id);
    if (!dropPoolId) continue;

    const mergedDropItemIds = collectMergedPoolItemIds(dropPoolId, dropPoolById, commonPoolById);
    const hasTechniqueBook = Array.from(mergedDropItemIds).some(
      (itemId) => itemSubCategoryById.get(itemId) === TECHNIQUE_BOOK_SUB_CATEGORY,
    );
    assert.equal(hasTechniqueBook, false, `${monsterId} 仍然会在普通地图掉落功法书`);
  }

  const wolfDenMonster = monsterById.get(WOLF_DEN_MONSTER_ID);
  assert.ok(wolfDenMonster, `缺少秘境怪物定义: ${WOLF_DEN_MONSTER_ID}`);
  assert.equal(wolfDenDungeonMonsterIds.has(WOLF_DEN_MONSTER_ID), true, `苍狼巢穴未引用怪物: ${WOLF_DEN_MONSTER_ID}`);
  const wolfDenDropPoolId = asText(wolfDenMonster.drop_pool_id);
  assert.ok(wolfDenDropPoolId, `${WOLF_DEN_MONSTER_ID} 缺少掉落池配置`);
  const wolfDenDropItemIds = collectMergedPoolItemIds(wolfDenDropPoolId, dropPoolById, commonPoolById);
  for (const itemId of WOLF_DEN_BOOK_IDS) {
    assert.equal(wolfDenDropItemIds.has(itemId), true, `${WOLF_DEN_MONSTER_ID} 未掉落迁移后的功法书: ${itemId}`);
  }

  const stoneMineMonster = monsterById.get(STONE_MINE_MONSTER_ID);
  assert.ok(stoneMineMonster, `缺少秘境怪物定义: ${STONE_MINE_MONSTER_ID}`);
  assert.equal(stoneMineDungeonMonsterIds.has(STONE_MINE_MONSTER_ID), true, `石窟矿洞未引用怪物: ${STONE_MINE_MONSTER_ID}`);
  const stoneMineDropPoolId = asText(stoneMineMonster.drop_pool_id);
  assert.ok(stoneMineDropPoolId, `${STONE_MINE_MONSTER_ID} 缺少掉落池配置`);
  const stoneMineDropItemIds = collectMergedPoolItemIds(stoneMineDropPoolId, dropPoolById, commonPoolById);
  for (const itemId of STONE_MINE_BOOK_IDS) {
    assert.equal(stoneMineDropItemIds.has(itemId), true, `${STONE_MINE_MONSTER_ID} 未掉落迁移后的功法书: ${itemId}`);
  }
});
