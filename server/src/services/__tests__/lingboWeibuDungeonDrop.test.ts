/**
 * 凌波微步通脉期普通秘境掉落测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：校验《凌波微步》会出现在与其使用境界相同的“普通”秘境怪物掉落池中。
 * - 不做什么：不执行真实掉落随机结算，也不验证具体掉率数值是否平衡。
 *
 * 输入/输出：
 * - 输入：item / technique / dungeon / monster / drop_pool / drop_pool_common 六类种子数据。
 * - 输出：断言目标秘籍的来源提示正确，且目标普通秘境至少存在一个怪物掉落池包含该秘籍。
 *
 * 数据流/状态流：
 * - 先从《凌波微步》物品定义中读取使用境界；
 * - 再扫描所有秘境种子，筛出同境界的普通难度秘境；
 * - 最后串联怪物定义与掉落池，确认这些秘境里确实能掉落对应秘籍。
 *
 * 关键边界条件与坑点：
 * 1) 秘境掉落实际来自怪物掉落池，不能只看 difficulty 自身字段，否则会漏掉真实来源。
 * 2) 同一个怪物掉落池可能混入公共池，断言时必须按“公共池 + 专属池”合并后再判断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asArray,
  asObject,
  asText,
  buildObjectMap,
  collectDungeonSeedFileNames,
  collectMergedPoolItemIds,
  loadSeed,
} from './seedTestUtils.js';

const BOOK_ITEM_ID = 'book-lingbo-weibu';
const TECHNIQUE_ID = 'tech-lingbo-weibu';
const EXPECTED_SOURCE_HINT = '通脉期普通秘境';

test('凌波微步应出现在相同境界的普通难度秘境掉落中', () => {
  const itemSeed = loadSeed('item_def.json');
  const techniqueSeed = loadSeed('technique_def.json');
  const monsterSeed = loadSeed('monster_def.json');
  const dropPoolSeed = loadSeed('drop_pool.json');
  const commonDropPoolSeed = loadSeed('drop_pool_common.json');

  const bookDef = asArray(itemSeed.items).find((entry) => asText(asObject(entry)?.id) === BOOK_ITEM_ID);
  assert.ok(bookDef, `缺少物品定义: ${BOOK_ITEM_ID}`);
  const bookObject = asObject(bookDef);
  assert.ok(bookObject, `${BOOK_ITEM_ID} 物品定义格式错误`);
  const targetRealm = asText(bookObject.use_req_realm);
  assert.ok(targetRealm, `${BOOK_ITEM_ID} 缺少 use_req_realm`);
  const sourceHints = asArray(bookObject.source_hint).map((entry) => asText(entry)).filter(Boolean);
  assert.equal(sourceHints.includes(EXPECTED_SOURCE_HINT), true, `${BOOK_ITEM_ID} 缺少来源提示: ${EXPECTED_SOURCE_HINT}`);

  const techniqueDef = asArray(techniqueSeed.techniques).find((entry) => asText(asObject(entry)?.id) === TECHNIQUE_ID);
  assert.ok(techniqueDef, `缺少功法定义: ${TECHNIQUE_ID}`);
  const techniqueObject = asObject(techniqueDef);
  assert.ok(techniqueObject, `${TECHNIQUE_ID} 功法定义格式错误`);
  const obtainHints = asArray(techniqueObject.obtain_hint).map((entry) => asText(entry)).filter(Boolean);
  assert.equal(obtainHints.includes(EXPECTED_SOURCE_HINT), true, `${TECHNIQUE_ID} 缺少获取提示: ${EXPECTED_SOURCE_HINT}`);

  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const dropPoolById = buildObjectMap(asArray(dropPoolSeed.pools), 'id');
  const commonPoolById = buildObjectMap(asArray(commonDropPoolSeed.pools), 'id');

  const targetDifficulties: Array<{ dungeonName: string; difficultyId: string; fileName: string; monsterIds: string[] }> = [];
  for (const fileName of collectDungeonSeedFileNames()) {
    const dungeonSeed = loadSeed(fileName);
    for (const dungeonValue of asArray(dungeonSeed.dungeons)) {
      const dungeon = asObject(dungeonValue);
      const dungeonDef = asObject(dungeon?.def);
      if (!dungeon || !dungeonDef) continue;
      if (asText(dungeonDef.min_realm) !== targetRealm) continue;

      for (const difficultyValue of asArray(dungeon.difficulties)) {
        const difficulty = asObject(difficultyValue);
        if (!difficulty) continue;
        if (asText(difficulty.name) !== '普通') continue;
        if (asText(difficulty.min_realm) !== targetRealm) continue;

        const monsterIds = new Set<string>();
        for (const stageValue of asArray(difficulty.stages)) {
          const stage = asObject(stageValue);
          if (!stage) continue;
          for (const waveValue of asArray(stage.waves)) {
            const wave = asObject(waveValue);
            if (!wave) continue;
            for (const monsterRefValue of asArray(wave.monsters)) {
              const monsterRef = asObject(monsterRefValue);
              const monsterId = asText(monsterRef?.monster_def_id);
              if (monsterId) monsterIds.add(monsterId);
            }
          }
        }

        targetDifficulties.push({
          dungeonName: asText(dungeonDef.name) || fileName,
          difficultyId: asText(difficulty.id),
          fileName,
          monsterIds: Array.from(monsterIds),
        });
      }
    }
  }

  assert.ok(targetDifficulties.length > 0, `未找到境界为 ${targetRealm} 的普通秘境`);

  for (const difficulty of targetDifficulties) {
    let canDropBook = false;

    for (const monsterId of difficulty.monsterIds) {
      const monster = monsterById.get(monsterId);
      assert.ok(monster, `${difficulty.fileName} 引用了不存在怪物: ${monsterId}`);
      const dropPoolId = asText(monster.drop_pool_id);
      if (!dropPoolId) continue;
      const itemIds = collectMergedPoolItemIds(dropPoolId, dropPoolById, commonPoolById);
      if (itemIds.has(BOOK_ITEM_ID)) {
        canDropBook = true;
        break;
      }
    }

    assert.equal(
      canDropBook,
      true,
      `${difficulty.dungeonName}(${difficulty.difficultyId}) 未配置 ${BOOK_ITEM_ID} 掉落`,
    );
  }
});
