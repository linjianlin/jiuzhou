import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type SeedFile = Record<string, unknown>;

const resolveSeedPath = (filename: string): string => {
  const candidatePaths = [
    resolve(process.cwd(), `server/src/data/seeds/${filename}`),
    resolve(process.cwd(), `src/data/seeds/${filename}`),
  ];
  const seedPath = candidatePaths.find((filePath) => existsSync(filePath));
  assert.ok(seedPath, `未找到种子文件: ${filename}`);
  return seedPath;
};

const loadSeed = <T extends SeedFile>(filename: string): T => {
  const seedPath = resolveSeedPath(filename);
  return JSON.parse(readFileSync(seedPath, 'utf-8')) as T;
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const asArray = <T = unknown>(value: unknown): T[] => {
  if (!Array.isArray(value)) return [];
  return value as T[];
};

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

test('新秘境应仅引用已存在怪物定义', () => {
  const dungeonSeed = loadSeed<{ dungeons?: unknown[] }>('dungeon_qi_cultivation_13.json');
  const monsterSeed = loadSeed<{ monsters?: Array<{ id?: string }> }>('monster_def.json');
  const monsterIds = new Set(
    asArray<{ id?: string }>(monsterSeed.monsters)
      .map((row) => asText(row.id))
      .filter(Boolean),
  );

  const referencedMonsterIds = new Set<string>();
  for (const dungeonEntry of asArray(dungeonSeed.dungeons)) {
    const difficulties = asArray(asObject(dungeonEntry).difficulties);
    for (const difficulty of difficulties) {
      const stages = asArray(asObject(difficulty).stages);
      for (const stage of stages) {
        const waves = asArray(asObject(stage).waves);
        for (const wave of waves) {
          const monsters = asArray(asObject(wave).monsters);
          for (const monster of monsters) {
            const monsterId = asText(asObject(monster).monster_def_id);
            if (monsterId) referencedMonsterIds.add(monsterId);
          }
        }
      }
    }
  }

  assert.ok(referencedMonsterIds.size > 0, '还虚天台应至少引用1个怪物');
  for (const monsterId of referencedMonsterIds) {
    assert.equal(monsterIds.has(monsterId), true, `秘境引用了不存在怪物: ${monsterId}`);
  }
});

test('还虚新怪物应引用有效掉落池', () => {
  const monsterSeed = loadSeed<{ monsters?: unknown[] }>('monster_def.json');
  const dropPoolSeed = loadSeed<{ pools?: Array<{ id?: string }> }>('drop_pool.json');
  const dropPoolIds = new Set(
    asArray<{ id?: string }>(dropPoolSeed.pools)
      .map((row) => asText(row.id))
      .filter(Boolean),
  );

  const expectedMonsters = [
    'monster-huanxu-rift-blade',
    'monster-huanxu-xushi-wisp',
    'monster-elite-huanxu-mark-warden',
    'monster-elite-huanxu-null-priest',
    'monster-boss-huanxu-guixu-lord',
  ];

  const monsterById = new Map<string, Record<string, unknown>>();
  for (const row of asArray(monsterSeed.monsters)) {
    const obj = asObject(row);
    const id = asText(obj.id);
    if (!id) continue;
    monsterById.set(id, obj);
  }

  for (const monsterId of expectedMonsters) {
    const monster = monsterById.get(monsterId);
    assert.ok(monster, `缺少怪物定义: ${monsterId}`);
    const dropPoolId = asText(monster.drop_pool_id);
    assert.ok(dropPoolId, `${monsterId} 缺少 drop_pool_id`);
    assert.equal(dropPoolIds.has(dropPoolId), true, `${monsterId} 引用了不存在掉落池: ${dropPoolId}`);
  }
});

test('还虚掉落池应仅引用已存在物品（含装备定义）', () => {
  const dropPoolSeed = loadSeed<{ pools?: unknown[] }>('drop_pool.json');
  const commonPoolSeed = loadSeed<{ pools?: unknown[] }>('drop_pool_common.json');
  const itemSeed = loadSeed<{ items?: Array<{ id?: string }> }>('item_def.json');
  const equipSeed = loadSeed<{ items?: Array<{ id?: string }> }>('equipment_def.json');

  const validItemIds = new Set<string>();
  for (const row of asArray<{ id?: string }>(itemSeed.items)) {
    const id = asText(row.id);
    if (id) validItemIds.add(id);
  }
  for (const row of asArray<{ id?: string }>(equipSeed.items)) {
    const id = asText(row.id);
    if (id) validItemIds.add(id);
  }

  const poolById = new Map<string, Record<string, unknown>>();
  for (const row of asArray(dropPoolSeed.pools)) {
    const obj = asObject(row);
    const id = asText(obj.id);
    if (!id) continue;
    poolById.set(id, obj);
  }
  const commonPoolById = new Map<string, Record<string, unknown>>();
  for (const row of asArray(commonPoolSeed.pools)) {
    const obj = asObject(row);
    const id = asText(obj.id);
    if (!id) continue;
    commonPoolById.set(id, obj);
  }

  const huixuPoolIds = Array.from(poolById.keys()).filter(
    (id) => id.startsWith('dp-huanxu-') || id.startsWith('dp-dungeon-huixu-'),
  );
  assert.ok(huixuPoolIds.length > 0, '缺少还虚掉落池 dp-huanxu-* / dp-dungeon-huixu-*');

  const referencedItemIds = new Set<string>();
  const referencedCommonPoolIds = new Set<string>();
  for (const poolId of huixuPoolIds) {
    const pool = poolById.get(poolId);
    assert.ok(pool, `缺少掉落池: ${poolId}`);
    for (const entry of asArray(asObject(pool).entries)) {
      const itemDefId = asText(asObject(entry).item_def_id);
      if (itemDefId) referencedItemIds.add(itemDefId);
    }
    for (const commonPoolIdRaw of asArray(asObject(pool).common_pool_ids)) {
      const commonPoolId = asText(commonPoolIdRaw);
      if (commonPoolId) referencedCommonPoolIds.add(commonPoolId);
    }
  }

  assert.equal(referencedCommonPoolIds.has('dp-common-monster-huanxu'), true, '还虚掉落池应接入公共池 dp-common-monster-huanxu');
  const huixuCommonPool = commonPoolById.get('dp-common-monster-huanxu');
  assert.ok(huixuCommonPool, '缺少公共掉落池 dp-common-monster-huanxu');
  for (const entry of asArray(asObject(huixuCommonPool).entries)) {
    const itemDefId = asText(asObject(entry).item_def_id);
    if (itemDefId) referencedItemIds.add(itemDefId);
  }

  for (const itemDefId of referencedItemIds) {
    assert.equal(validItemIds.has(itemDefId), true, `掉落池引用了不存在物品: ${itemDefId}`);
  }
});

test('还虚新套装应完整引用8件装备且装备 set_id 一致', () => {
  const itemSetSeed = loadSeed<{ sets?: unknown[] }>('item_set.json');
  const equipSeed = loadSeed<{ items?: unknown[] }>('equipment_def.json');
  const equipById = new Map<string, Record<string, unknown>>();
  for (const row of asArray(equipSeed.items)) {
    const obj = asObject(row);
    const id = asText(obj.id);
    if (!id) continue;
    equipById.set(id, obj);
  }

  const expectedSetIds = ['set-taixu', 'set-zhenhun'];
  const setById = new Map<string, Record<string, unknown>>();
  for (const row of asArray(itemSetSeed.sets)) {
    const obj = asObject(row);
    const id = asText(obj.id);
    if (!id) continue;
    setById.set(id, obj);
  }

  for (const setId of expectedSetIds) {
    const setDef = setById.get(setId);
    assert.ok(setDef, `缺少套装定义: ${setId}`);
    const pieces = asArray(asObject(setDef).pieces);
    assert.equal(pieces.length, 8, `${setId} 应包含8件装备`);
    for (const piece of pieces) {
      const itemDefId = asText(asObject(piece).item_def_id);
      assert.ok(itemDefId, `${setId} 存在空 item_def_id`);
      const equip = equipById.get(itemDefId);
      assert.ok(equip, `${setId} 引用了不存在装备: ${itemDefId}`);
      assert.equal(asText(equip?.set_id), setId, `${itemDefId} 的 set_id 应为 ${setId}`);
    }
  }
});
