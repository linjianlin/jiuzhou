import assert from 'node:assert/strict';
import test from 'node:test';

import type { CharacterComputedRow } from '../characterComputedService.js';
import type { OnlineBattleCharacterSnapshot } from '../onlineBattleProjectionService.js';
import * as projectionService from '../onlineBattleProjectionService.js';
import {
  applyBattleFailureResourceLossByCharacterIds,
  buildBattleStartRecoveredResourceState,
  buildFailureReducedResourceState,
  buildVictoryRecoveredResourceState,
  recoverBattleStartResourcesByUserIds,
  restoreCharacterResourcesAfterVictoryByCharacterIds,
} from '../battle/shared/resourceRecovery.js';

const createComputedRow = (
  overrides: Partial<CharacterComputedRow>,
): CharacterComputedRow => ({
  id: 2001,
  user_id: 1001,
  nickname: '测试角色',
  title: '',
  gender: 'male',
  avatar: null,
  auto_cast_skills: false,
  auto_disassemble_enabled: false,
  auto_disassemble_rules: null,
  dungeon_no_stamina_cost: false,
  spirit_stones: 0,
  silver: 0,
  stamina: 0,
  stamina_max: 100,
  realm: '炼气期',
  sub_realm: null,
  exp: 0,
  attribute_points: 0,
  jing: 10,
  qi: 10,
  shen: 10,
  attribute_type: 'none',
  attribute_element: 'none',
  current_map_id: 'map-1',
  current_room_id: 'room-1',
  max_qixue: 100,
  max_lingqi: 80,
  wugong: 0,
  fagong: 0,
  wufang: 0,
  fafang: 0,
  mingzhong: 0,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 0,
  jianbaoshang: 0,
  jianfantan: 0,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque: 0,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
  sudu: 0,
  fuyuan: 1,
  qixue: 60,
  lingqi: 10,
  ...overrides,
});

const createSnapshot = (
  overrides: Omit<Partial<OnlineBattleCharacterSnapshot>, 'computed' | 'loadout'> & {
    computed?: Partial<CharacterComputedRow>;
    loadout?: OnlineBattleCharacterSnapshot['loadout'];
  },
): OnlineBattleCharacterSnapshot => {
  const computed = createComputedRow({
    id: overrides.computed?.id ?? overrides.characterId ?? 2001,
    user_id: overrides.computed?.user_id ?? overrides.userId ?? 1001,
    ...overrides.computed,
  });

  return {
    characterId: overrides.characterId ?? computed.id,
    userId: overrides.userId ?? computed.user_id,
    computed,
    loadout: overrides.loadout ?? {
      setBonusEffects: [],
      skills: [],
    },
    activePartner: overrides.activePartner ?? null,
    teamId: overrides.teamId ?? null,
    isTeamLeader: overrides.isTeamLeader ?? false,
  };
};

test('buildBattleStartRecoveredResourceState: 应把气血回满并把灵气抬到至少一半', () => {
  const nextState = buildBattleStartRecoveredResourceState(
    createComputedRow({
      max_qixue: 120,
      qixue: 30,
      max_lingqi: 90,
      lingqi: 10,
    }),
  );

  assert.deepEqual(nextState, {
    qixue: 120,
    lingqi: 45,
  });
});

test('buildVictoryRecoveredResourceState: 应按最大气血的三成治疗且不超过上限', () => {
  const nextState = buildVictoryRecoveredResourceState(
    createComputedRow({
      max_qixue: 100,
      qixue: 80,
      lingqi: 33,
    }),
  );

  assert.deepEqual(nextState, {
    qixue: 100,
    lingqi: 33,
  });
});

test('buildFailureReducedResourceState: 应按最大气血一成扣减且保底剩余 1 点', () => {
  const nextState = buildFailureReducedResourceState(
    createComputedRow({
      max_qixue: 95,
      qixue: 8,
      lingqi: 27,
    }),
  );

  assert.deepEqual(nextState, {
    qixue: 1,
    lingqi: 27,
  });
});

test('recoverBattleStartResourcesByUserIds: 应批量读取后统一写回战前资源', async (t) => {
  let batchCallCount = 0;
  let persistedSnapshots: OnlineBattleCharacterSnapshot[] = [];

  t.mock.method(
    projectionService,
    'getOnlineBattleCharacterSnapshotsByUserIds',
    async () => {
      batchCallCount += 1;
      return new Map<number, OnlineBattleCharacterSnapshot>([
        [
          1001,
          createSnapshot({
            characterId: 2001,
            userId: 1001,
            computed: {
              id: 2001,
              user_id: 1001,
              max_qixue: 120,
              qixue: 50,
              max_lingqi: 80,
              lingqi: 10,
            },
          }),
        ],
        [
          1002,
          createSnapshot({
            characterId: 2002,
            userId: 1002,
            computed: {
              id: 2002,
              user_id: 1002,
              max_qixue: 90,
              qixue: 88,
              max_lingqi: 60,
              lingqi: 40,
            },
          }),
        ],
      ]);
    },
  );
  t.mock.method(
    projectionService,
    'persistOnlineBattleCharacterSnapshotsBatch',
    async (snapshots: OnlineBattleCharacterSnapshot[]) => {
      persistedSnapshots = snapshots;
    },
  );

  await recoverBattleStartResourcesByUserIds([1001, 1002, 1001]);

  assert.equal(batchCallCount, 1);
  assert.deepEqual(
    persistedSnapshots.map((snapshot) => ({
      characterId: snapshot.characterId,
      next: {
        qixue: snapshot.computed.qixue,
        lingqi: snapshot.computed.lingqi,
      },
    })),
    [
      {
        characterId: 2001,
        next: { qixue: 120, lingqi: 40 },
      },
      {
        characterId: 2002,
        next: { qixue: 90, lingqi: 40 },
      },
    ],
  );
});

test('restoreCharacterResourcesAfterVictoryByCharacterIds: 应批量读取并按三成回血后统一批量写回', async (t) => {
  let batchCallCount = 0;
  let persistedSnapshots: OnlineBattleCharacterSnapshot[] = [];

  t.mock.method(
    projectionService,
    'getOnlineBattleCharacterSnapshotsByCharacterIds',
    async () => {
      batchCallCount += 1;
      return new Map<number, OnlineBattleCharacterSnapshot>([
        [
          2001,
          createSnapshot({
            characterId: 2001,
            userId: 1001,
            computed: {
              id: 2001,
              user_id: 1001,
              qixue: 20,
              max_qixue: 100,
              lingqi: 18,
            },
          }),
        ],
        [
          2002,
          createSnapshot({
            characterId: 2002,
            userId: 1002,
            computed: {
              id: 2002,
              user_id: 1002,
              qixue: 95,
              max_qixue: 100,
              lingqi: 55,
            },
          }),
        ],
      ]);
    },
  );
  t.mock.method(
    projectionService,
    'persistOnlineBattleCharacterSnapshotsBatch',
    async (snapshots: OnlineBattleCharacterSnapshot[]) => {
      persistedSnapshots = snapshots;
    },
  );

  await restoreCharacterResourcesAfterVictoryByCharacterIds([2001, 2002, 2001]);

  assert.equal(batchCallCount, 1);
  assert.deepEqual(
    persistedSnapshots.map((snapshot) => ({
      characterId: snapshot.characterId,
      next: {
        qixue: snapshot.computed.qixue,
        lingqi: snapshot.computed.lingqi,
      },
    })),
    [
      {
        characterId: 2001,
        next: { qixue: 50, lingqi: 18 },
      },
      {
        characterId: 2002,
        next: { qixue: 100, lingqi: 55 },
      },
    ],
  );
});

test('applyBattleFailureResourceLossByCharacterIds: 应批量读取后统一扣减失败惩罚气血', async (t) => {
  let batchCallCount = 0;
  let persistedSnapshots: OnlineBattleCharacterSnapshot[] = [];

  t.mock.method(
    projectionService,
    'getOnlineBattleCharacterSnapshotsByCharacterIds',
    async () => {
      batchCallCount += 1;
      return new Map<number, OnlineBattleCharacterSnapshot>([
        [
          2001,
          createSnapshot({
            characterId: 2001,
            userId: 1001,
            computed: {
              id: 2001,
              user_id: 1001,
              qixue: 30,
              max_qixue: 100,
              lingqi: 18,
            },
          }),
        ],
        [
          2002,
          createSnapshot({
            characterId: 2002,
            userId: 1002,
            computed: {
              id: 2002,
              user_id: 1002,
              qixue: 7,
              max_qixue: 80,
              lingqi: 55,
            },
          }),
        ],
      ]);
    },
  );
  t.mock.method(
    projectionService,
    'persistOnlineBattleCharacterSnapshotsBatch',
    async (snapshots: OnlineBattleCharacterSnapshot[]) => {
      persistedSnapshots = snapshots;
    },
  );

  await applyBattleFailureResourceLossByCharacterIds([2001, 2002, 2001]);

  assert.equal(batchCallCount, 1);
  assert.deepEqual(
    persistedSnapshots.map((snapshot) => ({
      characterId: snapshot.characterId,
      next: {
        qixue: snapshot.computed.qixue,
        lingqi: snapshot.computed.lingqi,
      },
    })),
    [
      {
        characterId: 2001,
        next: { qixue: 20, lingqi: 18 },
      },
      {
        characterId: 2002,
        next: { qixue: 1, lingqi: 55 },
      },
    ],
  );
});
