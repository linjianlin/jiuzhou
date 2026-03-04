import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Requirement = {
  type?: string;
  min?: number;
  minCount?: number;
  minLayer?: number;
  dungeonId?: string;
  difficultyId?: string;
  chapterId?: string;
  itemDefId?: string;
  qty?: number;
};

type Cost = {
  type?: string;
  amount?: number;
  items?: Array<{ itemDefId?: string; qty?: number }>;
};

type Breakthrough = {
  from?: string;
  to?: string;
  requirements?: Requirement[];
  costs?: Cost[];
  rewards?: {
    attributePoints?: number;
    pct?: Record<string, number>;
    addPercent?: Record<string, number>;
  };
};

type RealmBreakthroughSeed = {
  realmOrder?: string[];
  breakthroughs?: Breakthrough[];
};

const loadSeed = (): RealmBreakthroughSeed => {
  const candidatePaths = [
    resolve(process.cwd(), 'server/src/data/seeds/realm_breakthrough.json'),
    resolve(process.cwd(), 'src/data/seeds/realm_breakthrough.json'),
  ];
  const seedPath = candidatePaths.find((filePath) => existsSync(filePath));
  assert.ok(seedPath, '未找到 realm_breakthrough.json');
  return JSON.parse(readFileSync(seedPath, 'utf-8')) as RealmBreakthroughSeed;
};

test('养神->还虚突破配置应满足还虚一期前置/消耗/奖励口径', () => {
  const seed = loadSeed();
  const entry = (seed.breakthroughs ?? []).find(
    (row) => row.from === '炼神返虚·养神期' && row.to === '炼神返虚·还虚期',
  );
  assert.ok(entry, '缺少 养神期->还虚期 突破条目');

  const requirements = entry.requirements ?? [];
  assert.equal(requirements.some((row) => row.type === 'version_locked'), false, '不应存在版本锁前置');

  const expReq = requirements.find((row) => row.type === 'exp_min');
  assert.equal(expReq?.min, 3_350_000);

  const techniqueReq = requirements.find((row) => row.type === 'techniques_count_min_layer');
  assert.equal(techniqueReq?.minCount, 2);
  assert.equal(techniqueReq?.minLayer, 9);

  const dungeonReq = requirements.find((row) => row.type === 'dungeon_clear_min');
  assert.equal(dungeonReq?.dungeonId, 'dungeon-lianshen-huixu-tiantai');
  assert.equal(dungeonReq?.difficultyId, 'dd-huixu-tiantai-h');
  assert.equal(dungeonReq?.minCount, 3);

  const chapterReq = requirements.find((row) => row.type === 'main_quest_chapter_completed');
  assert.equal(chapterReq?.chapterId, 'mq-chapter-6');

  const itemXushiReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-xushi-jinghe');
  const itemDanReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-huanxu-dan');
  assert.equal(itemXushiReq?.qty, 18);
  assert.equal(itemDanReq?.qty, 4);

  const costs = entry.costs ?? [];
  const spiritStoneCost = costs.find((row) => row.type === 'spirit_stones');
  const expCost = costs.find((row) => row.type === 'exp');
  const itemCost = costs.find((row) => row.type === 'items');
  assert.equal(spiritStoneCost?.amount, 13_800);
  assert.equal(expCost?.amount, 3_350_000);
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-xushi-jinghe' && row.qty === 12),
    true,
  );
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-huanxu-dan' && row.qty === 3),
    true,
  );

  assert.equal(entry.rewards?.attributePoints, 24);
  assert.equal(entry.rewards?.pct?.max_qixue, 0.27);
  assert.equal(entry.rewards?.pct?.max_lingqi, 0.27);
  assert.equal(entry.rewards?.pct?.wugong, 0.156);
  assert.equal(entry.rewards?.pct?.fagong, 0.156);
  assert.equal(entry.rewards?.pct?.wufang, 0.156);
  assert.equal(entry.rewards?.pct?.fafang, 0.156);
  assert.equal(entry.rewards?.addPercent?.kongzhi_kangxing, 0.072);
});
