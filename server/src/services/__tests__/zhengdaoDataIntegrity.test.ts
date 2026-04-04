/**
 * 证道期数据完整性测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定第八章、万法天阙、万法道宫、证道期材料、掉落池与三套套装的关键引用关系，避免开放后出现断链。
 * - 做什么：额外校验“野外不掉套装、装备只从秘境链路掉落”的唯一口径，防止后续把套装误塞回公共池或地图怪掉落。
 * - 不做什么：不执行真实战斗，不验证随机掉率统计，也不覆盖 UI 文案排版。
 *
 * 输入/输出：
 * - 输入：chapter8 / dialogue8 / dungeon15 / map / npc / monster / item / equipment / drop_pool / item_set 等种子。
 * - 输出：章节开放态、跨文件引用存在性、套装闭环与掉落来源唯一性断言。
 *
 * 数据流/状态流：
 * - 先通过 seedTestUtils 统一加载并构建对象索引；
 * - 再从主线与秘境定义提取地图/NPC/怪物/物品/副本引用；
 * - 最后汇总地图怪池、公共池、秘境池与 Boss 池，锁定套装只能来自秘境链路。
 *
 * 关键边界条件与坑点：
 * 1) 地图怪虽然会接公共池，但证道期公共池里不能混入任何套装部位，否则会破坏“装备全秘境掉落”。
 * 2) 周常只有 1 条时，材料与副本链路都压在同一套 seed 上，任何一个 ID 漂移都会让主线、任务和突破同时失效，因此必须一次性锁住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getDungeonDefinitions, getDungeonDifficultiesByDungeonId } from '../staticConfigLoader.js';
import { resolveOrderedMonsters } from '../battle/shared/monsters.js';
import { loadDialogue } from '../dialogueService.js';
import { getDungeonDefById } from '../dungeon/shared/configLoader.js';
import { getEnabledMainQuestChapterById } from '../mainQuest/shared/questConfig.js';
import { getMapDefById, getRoomInMap, getRoomsInMap, isMapEnabled } from '../mapService.js';
import { getTaskDefinitionById } from '../taskDefinitionService.js';
import {
  asArray,
  asObject,
  asText,
  buildObjectMap,
  collectMergedPoolItemIds,
  loadSeed,
} from './seedTestUtils.js';

const ZHENGDAO_DUNGEON_FILE = 'dungeon_qi_cultivation_15.json';
const ZHENGDAO_DUNGEON_ID = 'dungeon-lianxu-wanfa-daogong';
const ZHENGDAO_BOSS_ID = 'monster-boss-zhengdao-taishang-lvzhu';
const ZHENGDAO_SET_IDS = ['set-tianyan', 'set-xuanheng', 'set-poxu'] as const;
const ZHENGDAO_SET_ITEM_IDS = {
  all: new Set([
    'set-tianyan-weapon',
    'set-tianyan-head',
    'set-tianyan-clothes',
    'set-tianyan-gloves',
    'set-tianyan-pants',
    'set-tianyan-necklace',
    'set-tianyan-accessory',
    'set-tianyan-artifact',
    'set-xuanheng-weapon',
    'set-xuanheng-head',
    'set-xuanheng-clothes',
    'set-xuanheng-gloves',
    'set-xuanheng-pants',
    'set-xuanheng-necklace',
    'set-xuanheng-accessory',
    'set-xuanheng-artifact',
    'set-poxu-weapon',
    'set-poxu-head',
    'set-poxu-clothes',
    'set-poxu-gloves',
    'set-poxu-pants',
    'set-poxu-necklace',
    'set-poxu-accessory',
    'set-poxu-artifact',
  ]),
  normalPieces: [
    'set-tianyan-clothes',
    'set-tianyan-gloves',
    'set-tianyan-pants',
    'set-tianyan-necklace',
    'set-tianyan-accessory',
    'set-xuanheng-clothes',
    'set-xuanheng-gloves',
    'set-xuanheng-pants',
    'set-xuanheng-necklace',
    'set-xuanheng-accessory',
    'set-poxu-clothes',
    'set-poxu-gloves',
    'set-poxu-pants',
    'set-poxu-necklace',
    'set-poxu-accessory',
  ] as const,
  hardHeads: ['set-tianyan-head', 'set-xuanheng-head', 'set-poxu-head'] as const,
  topPieces: [
    'set-tianyan-weapon',
    'set-tianyan-artifact',
    'set-xuanheng-weapon',
    'set-xuanheng-artifact',
    'set-poxu-weapon',
    'set-poxu-artifact',
  ] as const,
};
const ZHENGDAO_POOL_IDS = {
  commonPoolId: 'dp-common-monster-zhengdao',
  bossPoolId: 'dp-zhengdao-boss-taishang-lvzhu',
  normalPoolId: 'dp-dungeon-tianque-n',
  hardPoolId: 'dp-dungeon-tianque-h',
  nightmarePoolId: 'dp-dungeon-tianque-nm',
  gemBag: 'box-013',
  lingsha: 'mat-tianque-lingsha',
  fayin: 'mat-zhendao-fayin',
  hardDifficultyId: 'dd-wanfa-daogong-h',
  nightmareDifficultyId: 'dd-wanfa-daogong-nm',
} as const;
const ZHENGDAO_FIELD_MONSTER_IDS = [
  'monster-zhengdao-tianque-xunshou',
  'monster-zhengdao-lvwen-youhun',
  'monster-elite-zhengdao-zhenzhang-shi',
  'monster-elite-zhengdao-wentian-zhiju',
] as const;
const ZHENGDAO_DUNGEON_MONSTER_IDS = [
  'monster-zhengdao-daogong-shouwei',
  'monster-elite-zhengdao-zhilv-faxiang',
  ZHENGDAO_BOSS_ID,
] as const;

test('证道期主线、地图、秘境与任务应统一处于开放态', async () => {
  const mainQuestSeed = loadSeed('main_quest_chapter8.json');
  const dialogueSeed = loadSeed('dialogue_main_chapter8.json');
  const mapSeed = loadSeed('map_def.json');
  const dungeonSeed = loadSeed(ZHENGDAO_DUNGEON_FILE);
  const taskSeed = loadSeed('task_def.json');

  const chapterById = buildObjectMap(asArray(mainQuestSeed.chapters), 'id');
  const dialogueById = buildObjectMap(asArray(dialogueSeed.dialogues), 'id');
  const mapById = buildObjectMap(asArray(mapSeed.maps), 'id');
  const taskById = buildObjectMap(asArray(taskSeed.tasks), 'id');
  const chapter = chapterById.get('mq-chapter-8');
  const openingDialogue = dialogueById.get('dlg-main-8-001');
  const map = mapById.get('map-wanfa-tianque');
  const dungeonDef = asObject(asObject(asArray(dungeonSeed.dungeons)[0])?.def);
  const dailyTask = taskById.get('task-zhengdao-daily-001');
  const weeklyTask = taskById.get('task-zhengdao-weekly-001');

  assert.ok(chapter, '缺少第八章章节定义');
  assert.equal(chapter?.enabled, true, '第八章应开放');
  assert.notEqual(getEnabledMainQuestChapterById('mq-chapter-8'), null, '运行时应暴露第八章章节');

  assert.ok(openingDialogue, '缺少第八章对白定义');
  assert.equal(openingDialogue?.enabled, true, '第八章对白应开放');
  assert.notEqual(await loadDialogue('dlg-main-8-001'), null, '运行时应暴露第八章对白');

  assert.ok(map, '缺少万法天阙地图定义');
  assert.equal(map?.enabled, true, '万法天阙地图应开放');
  assert.equal(isMapEnabled(map as { enabled?: boolean | null }), true, '地图可用性判定应识别万法天阙为开放态');
  assert.notEqual(await getMapDefById('map-wanfa-tianque'), null, '运行时应可读取万法天阙地图');
  assert.notEqual((await getRoomsInMap('map-wanfa-tianque')).length, 0, '开放地图后应返回房间列表');
  assert.notEqual(await getRoomInMap('map-wanfa-tianque', 'room-tianque-outer-gate'), null, '开放地图后应返回外庭房间');

  assert.ok(dungeonDef, '缺少万法道宫秘境定义');
  assert.equal(dungeonDef?.enabled, true, '万法道宫秘境应开放');
  assert.notEqual(getDungeonDefById(ZHENGDAO_DUNGEON_ID), null, '运行时应暴露万法道宫秘境');

  assert.ok(dailyTask, '缺少证道期日常任务定义');
  assert.equal(dailyTask?.enabled, true, '证道期日常任务应开放');
  assert.notEqual(await getTaskDefinitionById('task-zhengdao-daily-001'), null, '运行时应暴露证道期日常任务');

  assert.ok(weeklyTask, '缺少证道期周常任务定义');
  assert.equal(weeklyTask?.enabled, true, '证道期周常任务应开放');
  assert.notEqual(await getTaskDefinitionById('task-zhengdao-weekly-001'), null, '运行时应暴露证道期周常任务');
});

test('第八章主线目标应只引用已存在地图/NPC/怪物/物品/秘境', () => {
  const mainQuestSeed = loadSeed('main_quest_chapter8.json');
  const dialogueSeed = loadSeed('dialogue_main_chapter8.json');
  const mapSeed = loadSeed('map_def.json');
  const npcSeed = loadSeed('npc_def.json');
  const monsterSeed = loadSeed('monster_def.json');
  const itemSeed = loadSeed('item_def.json');
  const dungeonSeed = loadSeed(ZHENGDAO_DUNGEON_FILE);

  const chapterById = buildObjectMap(asArray(mainQuestSeed.chapters), 'id');
  const sectionById = buildObjectMap(asArray(mainQuestSeed.sections), 'id');
  const dialogueById = buildObjectMap(asArray(dialogueSeed.dialogues), 'id');
  const mapById = buildObjectMap(asArray(mapSeed.maps), 'id');
  const npcById = buildObjectMap(asArray(npcSeed.npcs), 'id');
  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const itemById = buildObjectMap(asArray(itemSeed.items), 'id');
  const dungeonDef = asObject(asObject(asArray(dungeonSeed.dungeons)[0])?.def);

  assert.ok(chapterById.get('mq-chapter-8'), '缺少第八章章节定义');
  assert.equal(asText(dungeonDef?.id), ZHENGDAO_DUNGEON_ID);
  assert.equal(asArray(mainQuestSeed.sections).length, 8, '第八章应包含8个任务节');

  for (const sectionId of [
    'main-8-001',
    'main-8-002',
    'main-8-003',
    'main-8-004',
    'main-8-005',
    'main-8-006',
    'main-8-007',
    'main-8-008',
  ]) {
    const section = sectionById.get(sectionId);
    assert.ok(section, `缺少任务节: ${sectionId}`);
    assert.ok(mapById.get(asText(section?.map_id)), `${sectionId} 引用了不存在地图`);
    assert.ok(npcById.get(asText(section?.npc_id)), `${sectionId} 引用了不存在 NPC`);
    assert.ok(dialogueById.get(asText(section?.dialogue_id)), `${sectionId} 引用了不存在对话`);

    for (const objectiveEntry of asArray(section?.objectives)) {
      const objective = asObject(objectiveEntry);
      assert.ok(objective, `${sectionId} 存在非法 objectives 条目`);
      const type = asText(objective.type);
      const params = asObject(objective.params);
      assert.ok(params, `${sectionId} 的目标参数缺失`);
      if (type === 'kill_monster') {
        assert.ok(monsterById.get(asText(params.monster_id)), `${sectionId} 引用了不存在怪物`);
      }
      if (type === 'collect') {
        assert.ok(itemById.get(asText(params.item_id)), `${sectionId} 引用了不存在物品`);
      }
      if (type === 'dungeon_clear') {
        assert.equal(asText(params.dungeon_id), ZHENGDAO_DUNGEON_ID);
      }
      if (type === 'talk_npc') {
        assert.ok(npcById.get(asText(params.npc_id)), `${sectionId} talk_npc 引用了不存在 NPC`);
      }
      if (type === 'upgrade_realm') {
        assert.equal(asText(params.realm), '炼虚合道·证道期', `${sectionId} 的突破目标境界错误`);
      }
    }
  }

  const finalSection = asObject(sectionById.get('main-8-008'));
  const finalObjectives = asArray(finalSection?.objectives).map((entry) => asObject(entry));
  const finalCollectObjective = finalObjectives.find((objective) => asText(objective?.type) === 'collect');

  assert.ok(finalCollectObjective, '第八章最终任务节必须通过收集目标收束章节，不应直接要求突破');
  assert.equal(asText(asObject(finalCollectObjective?.params)?.item_id), ZHENGDAO_POOL_IDS.lingsha);
  assert.equal(Number(finalCollectObjective?.target ?? 0), 30, '第八章最终任务节应要求收集30个天阙灵砂');
  assert.equal(
    finalObjectives.some((objective) => asText(objective?.type) === 'upgrade_realm'),
    false,
    '第八章最终任务节不应直接要求突破，否则会与突破前置互锁',
  );
});

test('第八章主线对白的目标提示应与当前任务节一致', () => {
  const dialogueSeed = loadSeed('dialogue_main_chapter8.json');
  const dialogueById = buildObjectMap(asArray(dialogueSeed.dialogues), 'id');
  const expectedSystemTextByDialogueId = new Map<string, string>([
    ['dlg-main-8-001', '目标更新：抵达万法天阙，并与引痕使交谈。'],
    ['dlg-main-8-002', '目标更新：击败天阙巡狩6只、律纹游魂6只。'],
    ['dlg-main-8-003', '目标更新：收集天阙灵砂12个，并向铸纹师复命。'],
    ['dlg-main-8-004', '目标更新：通关万法道宫（普通）1次。'],
    ['dlg-main-8-005', '目标更新：击败镇章使2只、问天执炬2只。'],
    ['dlg-main-8-006', '目标更新：通关万法道宫（困难）2次。'],
    ['dlg-main-8-007', '目标更新：收集证道法印4个，并向执律天官复命。'],
    ['dlg-main-8-008', '目标更新：收集天阙灵砂30个，并向执律天官复命。'],
  ]);

  for (const [dialogueId, expectedSystemText] of expectedSystemTextByDialogueId) {
    const dialogue = asObject(dialogueById.get(dialogueId));
    assert.ok(dialogue, `缺少第八章对白定义: ${dialogueId}`);

    const systemNode = asArray(dialogue?.nodes)
      .map((node) => asObject(node))
      .find((node) => asText(node?.type) === 'system');

    assert.ok(systemNode, `${dialogueId} 缺少 system 节点`);
    assert.equal(asText(systemNode?.text), expectedSystemText, `${dialogueId} 的目标提示必须和任务节一致`);
  }
});

test('证道期秘境应只引用已存在怪物定义且可被静态加载器读到', () => {
  const dungeonSeed = loadSeed(ZHENGDAO_DUNGEON_FILE);
  const monsterSeed = loadSeed('monster_def.json');
  const monsterIds = new Set(
    asArray(monsterSeed.monsters)
      .map((row) => asObject(row))
      .map((monster) => asText(monster?.id))
      .filter(Boolean),
  );

  const referencedMonsterIds = new Set<string>();
  for (const dungeonEntry of asArray(dungeonSeed.dungeons)) {
    const dungeon = asObject(dungeonEntry);
    assert.ok(dungeon, '秘境条目必须是对象');
    for (const difficultyEntry of asArray(dungeon.difficulties)) {
      const difficulty = asObject(difficultyEntry);
      assert.ok(difficulty, '秘境难度条目必须是对象');
      for (const stageEntry of asArray(difficulty.stages)) {
        const stage = asObject(stageEntry);
        assert.ok(stage, '秘境关卡条目必须是对象');
        for (const waveEntry of asArray(stage.waves)) {
          const wave = asObject(waveEntry);
          assert.ok(wave, '秘境波次条目必须是对象');
          for (const monsterEntry of asArray(wave.monsters)) {
            const monster = asObject(monsterEntry);
            assert.ok(monster, '秘境怪物条目必须是对象');
            const monsterId = asText(monster.monster_def_id);
            if (monsterId) referencedMonsterIds.add(monsterId);
          }
        }
      }
    }
  }

  assert.deepEqual(Array.from(referencedMonsterIds).sort(), Array.from(ZHENGDAO_DUNGEON_MONSTER_IDS).sort(), '万法道宫怪物集合应保持固定');
  for (const monsterId of referencedMonsterIds) {
    assert.equal(monsterIds.has(monsterId), true, `秘境引用了不存在怪物: ${monsterId}`);
  }

  const dungeonDefs = getDungeonDefinitions();
  const dungeonDef = dungeonDefs.find((entry) => entry.id === ZHENGDAO_DUNGEON_ID);
  assert.ok(dungeonDef, '静态加载器未读到万法道宫定义');
  assert.equal(getDungeonDifficultiesByDungeonId(ZHENGDAO_DUNGEON_ID).length, 3, '万法道宫应包含3个难度');
});

test('证道期怪物掉落池、套装与装备来源应完整闭环', () => {
  const monsterSeed = loadSeed('monster_def.json');
  const dropPoolSeed = loadSeed('drop_pool.json');
  const commonPoolSeed = loadSeed('drop_pool_common.json');
  const itemSeed = loadSeed('item_def.json');
  const equipSeed = loadSeed('equipment_def.json');
  const itemSetSeed = loadSeed('item_set.json');
  const dungeonSeed = loadSeed(ZHENGDAO_DUNGEON_FILE);

  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const dropPoolById = buildObjectMap(asArray(dropPoolSeed.pools), 'id');
  const commonPoolById = buildObjectMap(asArray(commonPoolSeed.pools), 'id');
  const equipById = buildObjectMap(asArray(equipSeed.items), 'id');
  const setById = buildObjectMap(asArray(itemSetSeed.sets), 'id');

  const validItemIds = new Set<string>();
  for (const row of asArray(itemSeed.items)) {
    const item = asObject(row);
    const id = asText(item?.id);
    if (id) validItemIds.add(id);
  }
  for (const row of asArray(equipSeed.items)) {
    const equip = asObject(row);
    const id = asText(equip?.id);
    if (id) validItemIds.add(id);
  }

  assert.ok(commonPoolById.get(ZHENGDAO_POOL_IDS.commonPoolId), '缺少公共掉落池 dp-common-monster-zhengdao');

  for (const monsterId of [...ZHENGDAO_FIELD_MONSTER_IDS, ...ZHENGDAO_DUNGEON_MONSTER_IDS]) {
    const monster = monsterById.get(monsterId);
    assert.ok(monster, `缺少怪物定义: ${monsterId}`);
    const dropPoolId = asText(monster?.drop_pool_id);
    assert.ok(dropPoolId, `${monsterId} 缺少 drop_pool_id`);
    assert.ok(dropPoolById.get(dropPoolId), `${monsterId} 引用了不存在掉落池: ${dropPoolId}`);

    const mergedItemIds = collectMergedPoolItemIds(dropPoolId, dropPoolById, commonPoolById);
    for (const itemDefId of mergedItemIds) {
      assert.equal(validItemIds.has(itemDefId), true, `${dropPoolId} 引用了不存在物品: ${itemDefId}`);
    }
  }

  for (const setId of ZHENGDAO_SET_IDS) {
    const setDef = setById.get(setId);
    assert.ok(setDef, `缺少套装定义: ${setId}`);
    const pieces = asArray(setDef?.pieces);
    assert.equal(pieces.length, 8, `${setId} 应包含8件装备`);
    for (const pieceEntry of pieces) {
      const piece = asObject(pieceEntry);
      assert.ok(piece, `${setId} 存在非法 pieces 条目`);
      const itemDefId = asText(piece.item_def_id);
      assert.ok(itemDefId, `${setId} 存在空 item_def_id`);
      const equip = equipById.get(itemDefId);
      assert.ok(equip, `${setId} 引用了不存在装备: ${itemDefId}`);
      assert.equal(asText(equip?.set_id), setId, `${itemDefId} 的 set_id 应为 ${setId}`);
      assert.equal(asText(equip?.equip_req_realm), '炼虚合道·证道期', `${itemDefId} 应属于证道期装备`);
    }
  }

  for (const monsterId of ZHENGDAO_FIELD_MONSTER_IDS) {
    const monster = monsterById.get(monsterId);
    const dropPoolId = asText(monster?.drop_pool_id);
    const mergedItemIds = collectMergedPoolItemIds(dropPoolId, dropPoolById, commonPoolById);
    for (const itemDefId of mergedItemIds) {
      assert.equal(ZHENGDAO_SET_ITEM_IDS.all.has(itemDefId), false, `${monsterId} 的野外掉落不应包含套装装备：${itemDefId}`);
    }
  }

  const commonPool = commonPoolById.get(ZHENGDAO_POOL_IDS.commonPoolId);
  assert.ok(commonPool, '缺少证道期公共掉落池');
  for (const entry of asArray(commonPool?.entries)) {
    const itemDefId = asText(asObject(entry)?.item_def_id);
    assert.equal(ZHENGDAO_SET_ITEM_IDS.all.has(itemDefId), false, `证道期公共池不应包含装备：${itemDefId}`);
  }

  const normalPoolItemIds = collectMergedPoolItemIds(ZHENGDAO_POOL_IDS.normalPoolId, dropPoolById, commonPoolById);
  const hardPoolItemIds = collectMergedPoolItemIds(ZHENGDAO_POOL_IDS.hardPoolId, dropPoolById, commonPoolById);
  const nightmarePoolItemIds = collectMergedPoolItemIds(ZHENGDAO_POOL_IDS.nightmarePoolId, dropPoolById, commonPoolById);
  const bossPoolItemIds = collectMergedPoolItemIds(ZHENGDAO_POOL_IDS.bossPoolId, dropPoolById, commonPoolById);

  for (const itemDefId of ZHENGDAO_SET_ITEM_IDS.normalPieces) {
    assert.equal(normalPoolItemIds.has(itemDefId), true, `普通掉落池缺少基础部位：${itemDefId}`);
  }
  for (const itemDefId of ZHENGDAO_SET_ITEM_IDS.hardHeads) {
    assert.equal(hardPoolItemIds.has(itemDefId), true, `困难掉落池缺少头部：${itemDefId}`);
  }
  for (const itemDefId of ZHENGDAO_SET_ITEM_IDS.topPieces) {
    assert.equal(nightmarePoolItemIds.has(itemDefId) || bossPoolItemIds.has(itemDefId), true, `高阶部位未进入噩梦/Boss链路：${itemDefId}`);
  }

  const dungeonByDifficultyId = new Map<string, ReturnType<typeof asObject>>();
  for (const dungeonEntry of asArray(dungeonSeed.dungeons)) {
    const dungeon = asObject(dungeonEntry);
    if (!dungeon) continue;
    for (const difficultyEntry of asArray(dungeon.difficulties)) {
      const difficulty = asObject(difficultyEntry);
      const difficultyId = asText(difficulty?.id);
      if (!difficultyId || !difficulty) continue;
      dungeonByDifficultyId.set(difficultyId, difficulty);
    }
  }

  const hardDifficulty = dungeonByDifficultyId.get(ZHENGDAO_POOL_IDS.hardDifficultyId);
  const nightmareDifficulty = dungeonByDifficultyId.get(ZHENGDAO_POOL_IDS.nightmareDifficultyId);
  assert.ok(hardDifficulty, '缺少困难难度定义');
  assert.ok(nightmareDifficulty, '缺少噩梦难度定义');

  const hardFirstClearItems = asArray(asObject(hardDifficulty?.first_clear_rewards)?.items);
  const nightmareFirstClearItems = asArray(asObject(nightmareDifficulty?.first_clear_rewards)?.items);
  assert.equal(
    hardFirstClearItems.some((entry) => asText(asObject(entry)?.item_def_id) === 'set-tianyan-weapon'),
    true,
    '困难首通奖励缺少固定武器',
  );
  assert.equal(
    nightmareFirstClearItems.some((entry) => asText(asObject(entry)?.item_def_id) === 'set-xuanheng-artifact'),
    true,
    '噩梦首通奖励缺少固定法宝',
  );
});

test('证道期公共掉落池应掉落证道宝石袋，且产出 1 个 5~6 级宝石', () => {
  const itemSeed = loadSeed('item_def.json');
  const commonPoolSeed = loadSeed('drop_pool_common.json');
  const itemById = buildObjectMap(asArray(itemSeed.items), 'id');
  const commonPoolById = buildObjectMap(asArray(commonPoolSeed.pools), 'id');

  const gemBag = itemById.get(ZHENGDAO_POOL_IDS.gemBag);
  const commonPool = commonPoolById.get(ZHENGDAO_POOL_IDS.commonPoolId);
  const effect = asObject(asArray(gemBag?.effect_defs)[0]);
  const params = asObject(effect?.params);
  const gemBagEntry = asArray(commonPool?.entries)
    .map((entry) => asObject(entry))
    .find((entry) => asText(entry?.item_def_id) === ZHENGDAO_POOL_IDS.gemBag);

  assert.ok(gemBag, '缺少证道宝石袋定义');
  assert.equal(asText(gemBag?.name), '证道宝石袋');
  assert.equal(asText(gemBag?.category), 'consumable');
  assert.equal(asText(gemBag?.sub_category), 'box');
  assert.equal(asText(effect?.effect_type), 'loot');
  assert.equal(asText(params?.loot_type), 'random_gem');
  assert.equal(Number(params?.gems_per_use), 1, '证道宝石袋应固定产出 1 个宝石');
  assert.equal(Number(params?.min_level), 5, '证道宝石袋最低应产出 5 级宝石');
  assert.equal(Number(params?.max_level), 6, '证道宝石袋最高应产出 6 级宝石');

  assert.ok(commonPool, '缺少证道期公共掉落池');
  assert.ok(gemBagEntry, '证道期公共掉落池缺少证道宝石袋');
  assert.equal(Number(gemBagEntry?.chance), 0.04, '证道宝石袋掉率应保持 0.04');
  assert.equal(Number(gemBagEntry?.qty_min), 1, '证道宝石袋单次掉落数量最小值应为 1');
  assert.equal(Number(gemBagEntry?.qty_max), 1, '证道宝石袋单次掉落数量最大值应为 1');
});

test('证道期地图怪与 Boss 应属于正确境界，且 Boss 可被运行时解析', () => {
  const monsterSeed = loadSeed('monster_def.json');
  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');

  for (const monsterId of ZHENGDAO_FIELD_MONSTER_IDS) {
    const monster = monsterById.get(monsterId);
    assert.ok(monster, `缺少证道期地图怪定义: ${monsterId}`);
    assert.equal(asText(monster?.realm), '炼虚合道·证道期', `${monsterId} 应属于证道期`);
  }

  const boss = monsterById.get(ZHENGDAO_BOSS_ID);
  assert.ok(boss, `缺少证道期 Boss 定义: ${ZHENGDAO_BOSS_ID}`);
  assert.equal(asText(boss?.realm), '炼虚合道·证道期', `${ZHENGDAO_BOSS_ID} 应属于证道期`);
  assert.equal(asText(boss?.kind), 'boss', `${ZHENGDAO_BOSS_ID} 应属于 Boss`);

  const resolved = resolveOrderedMonsters([ZHENGDAO_BOSS_ID]);
  assert.equal(resolved.success, true, resolved.success ? '' : resolved.error);
  if (!resolved.success) return;

  const bossSkills = resolved.monsterSkillsMap[ZHENGDAO_BOSS_ID] ?? [];
  assert.ok(bossSkills.some((skill) => skill.id === 'sk-fantian-mingjing'), '太上律主应携带返天明镜运行时技能');
});
