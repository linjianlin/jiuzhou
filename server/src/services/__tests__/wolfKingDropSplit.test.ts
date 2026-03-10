/**
 * 狼王野外/秘境掉落拆分测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证野外狼王不会再掉落功法书，同时秘境狼王会同时掉落《清风剑法》《青木诀》，锁定这次拆分后的静态配置边界。
 * - 不做什么：不验证真实随机掉率结算，也不覆盖狼王属性强度平衡。
 *
 * 输入/输出：
 * - 输入：item / monster / drop_pool / drop_pool_common 四类种子数据。
 * - 输出：野外狼王的合并掉落集合中不存在功法书，秘境狼王的合并掉落集合中同时包含两本指定功法书。
 *
 * 数据流/状态流：
 * - 先读取物品定义，建立 `item_def_id -> sub_category` 的单一映射；
 * - 再读取野外狼王与秘境狼王的怪物定义，取到各自掉落池；
 * - 最后合并公共池与专属池，统一按物品分类与指定物品 ID 双重校验狼王掉落规则。
 *
 * 关键边界条件与坑点：
 * 1) 野外狼王的“无功法书”规则仍然要按 `technique_book` 分类判断，避免后续换成别的秘籍时测试漏报。
 * 2) 秘境狼王的“两本都掉”规则要直接锁定到具体物品 ID，避免未来退化成只剩一本到时测试仍误判通过。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asArray,
  asText,
  buildObjectMap,
  collectMergedPoolItemIds,
  type JsonObject,
  loadSeed,
} from './seedTestUtils.js';

const WILD_WOLF_KING_ID = 'monster-elite-wolf-king';
const DUNGEON_WOLF_KING_ID = 'monster-dungeon-wolf-king';
const TECHNIQUE_BOOK_SUB_CATEGORY = 'technique_book';
const DUNGEON_REQUIRED_BOOK_IDS = ['book-qingfeng-jian', 'book-qingmu-jue'] as const;

const collectMonsterDropItemIds = (
  monsterId: string,
  monsterById: Map<string, JsonObject>,
  dropPoolById: Map<string, JsonObject>,
  commonPoolById: Map<string, JsonObject>,
): Set<string> => {
  const monster = monsterById.get(monsterId);
  assert.ok(monster, `缺少怪物定义: ${monsterId}`);

  const dropPoolId = asText(monster.drop_pool_id);
  assert.ok(dropPoolId, `${monsterId} 缺少掉落池配置`);

  return collectMergedPoolItemIds(dropPoolId, dropPoolById, commonPoolById);
};

test('野外狼王不再掉落功法书，秘境狼王同时掉落清风剑法与青木诀', () => {
  const itemSeed = loadSeed('item_def.json');
  const monsterSeed = loadSeed('monster_def.json');
  const dropPoolSeed = loadSeed('drop_pool.json');
  const commonDropPoolSeed = loadSeed('drop_pool_common.json');

  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const dropPoolById = buildObjectMap(asArray(dropPoolSeed.pools), 'id');
  const commonPoolById = buildObjectMap(asArray(commonDropPoolSeed.pools), 'id');
  const itemById = buildObjectMap(asArray(itemSeed.items), 'id');
  const itemSubCategoryById = new Map(
    Array.from(itemById.entries()).map(([itemId, item]) => [itemId, asText(item.sub_category)] as const),
  );

  const wildDropItemIds = collectMonsterDropItemIds(
    WILD_WOLF_KING_ID,
    monsterById,
    dropPoolById,
    commonPoolById,
  );
  const dungeonDropItemIds = collectMonsterDropItemIds(
    DUNGEON_WOLF_KING_ID,
    monsterById,
    dropPoolById,
    commonPoolById,
  );
  const wildHasTechniqueBookDrop = Array.from(wildDropItemIds).some(
    (itemId) => itemSubCategoryById.get(itemId) === TECHNIQUE_BOOK_SUB_CATEGORY,
  );

  assert.equal(wildHasTechniqueBookDrop, false, '野外狼王仍然会掉落功法书');
  for (const bookId of DUNGEON_REQUIRED_BOOK_IDS) {
    assert.equal(dungeonDropItemIds.has(bookId), true, `秘境狼王未掉落指定功法书: ${bookId}`);
  }
});
