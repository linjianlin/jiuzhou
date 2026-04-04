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

test('合道->证道突破配置应满足证道期前置/消耗/奖励口径，并要求先完成第八章主线', () => {
  const seed = loadSeed();
  const entry = (seed.breakthroughs ?? []).find(
    (row) => row.from === '炼神返虚·合道期' && row.to === '炼虚合道·证道期',
  );
  assert.ok(entry, '缺少 合道期->证道期 突破条目');

  const requirements = entry.requirements ?? [];
  assert.equal(requirements.some((row) => row.type === 'version_locked'), false, '证道期突破不应再保留版本锁');

  const expReq = requirements.find((row) => row.type === 'exp_min');
  assert.equal(expReq?.min, 6_400_000);

  const techniqueReq = requirements.find((row) => row.type === 'techniques_count_min_layer');
  assert.equal(techniqueReq?.minCount, 3);
  assert.equal(techniqueReq?.minLayer, 9);

  const dungeonReq = requirements.find((row) => row.type === 'dungeon_clear_min');
  assert.equal(dungeonReq?.dungeonId, 'dungeon-lianxu-wanfa-daogong');
  assert.equal(dungeonReq?.difficultyId, undefined);
  assert.equal(dungeonReq?.minCount, 4);

  const chapterReq = requirements.find((row) => row.type === 'main_quest_chapter_completed');
  assert.equal(chapterReq?.chapterId, 'mq-chapter-8');

  const lingshaReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-tianque-lingsha');
  const fayinReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-zhendao-fayin');
  assert.equal(lingshaReq?.qty, 30);
  assert.equal(fayinReq?.qty, 6);

  const costs = entry.costs ?? [];
  const spiritStoneCost = costs.find((row) => row.type === 'spirit_stones');
  const expCost = costs.find((row) => row.type === 'exp');
  const itemCost = costs.find((row) => row.type === 'items');
  assert.equal(spiritStoneCost?.amount, 30_000);
  assert.equal(expCost?.amount, 6_400_000);
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-tianque-lingsha' && row.qty === 20),
    true,
  );
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-zhendao-fayin' && row.qty === 4),
    true,
  );

  assert.equal(entry.rewards?.attributePoints, 36);
  assert.equal(entry.rewards?.pct?.max_qixue, 0.32);
  assert.equal(entry.rewards?.pct?.max_lingqi, 0.32);
  assert.equal(entry.rewards?.pct?.wugong, 0.22);
  assert.equal(entry.rewards?.pct?.fagong, 0.22);
  assert.equal(entry.rewards?.pct?.wufang, 0.22);
  assert.equal(entry.rewards?.pct?.fafang, 0.22);
  assert.equal(entry.rewards?.addPercent?.kongzhi_kangxing, 0.12);
});
