import assert from 'node:assert/strict';
import test from 'node:test';

import type { CharacterComputedRow } from '../characterComputedService.js';
import * as characterComputedService from '../characterComputedService.js';
import {
  buildBattleStartRecoveredResourceState,
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

test('recoverBattleStartResourcesByUserIds: 应批量读取后统一写回战前资源', async (t) => {
  let batchCallCount = 0;
  const writes: Array<{ characterId: number; next: { qixue: number; lingqi: number } }> = [];

  t.mock.method(
    characterComputedService,
    'getCharacterComputedBatchByUserIds',
    async () => {
      batchCallCount += 1;
      return new Map<number, CharacterComputedRow>([
        [
          1001,
          createComputedRow({
            id: 2001,
            user_id: 1001,
            max_qixue: 120,
            qixue: 50,
            max_lingqi: 80,
            lingqi: 10,
          }),
        ],
        [
          1002,
          createComputedRow({
            id: 2002,
            user_id: 1002,
            max_qixue: 90,
            qixue: 88,
            max_lingqi: 60,
            lingqi: 40,
          }),
        ],
      ]);
    },
  );
  t.mock.method(
    characterComputedService,
    'setCharacterResourcesByComputedRow',
    async (
      computed: CharacterComputedRow,
      next: { qixue: number; lingqi: number },
    ) => {
      writes.push({
        characterId: computed.id,
        next,
      });
      return next;
    },
  );

  await recoverBattleStartResourcesByUserIds([1001, 1002, 1001]);

  assert.equal(batchCallCount, 1);
  assert.deepEqual(writes, [
    {
      characterId: 2001,
      next: { qixue: 120, lingqi: 40 },
    },
    {
      characterId: 2002,
      next: { qixue: 90, lingqi: 40 },
    },
  ]);
});

test('restoreCharacterResourcesAfterVictoryByCharacterIds: 应批量读取并按三成回血写回', async (t) => {
  let batchCallCount = 0;
  const writes: Array<{ characterId: number; next: { qixue: number; lingqi: number } }> = [];

  t.mock.method(
    characterComputedService,
    'getCharacterComputedBatchByCharacterIds',
    async () => {
      batchCallCount += 1;
      return new Map<number, CharacterComputedRow>([
        [
          2001,
          createComputedRow({
            id: 2001,
            qixue: 20,
            max_qixue: 100,
            lingqi: 18,
          }),
        ],
        [
          2002,
          createComputedRow({
            id: 2002,
            qixue: 95,
            max_qixue: 100,
            lingqi: 55,
          }),
        ],
      ]);
    },
  );
  t.mock.method(
    characterComputedService,
    'setCharacterResourcesByComputedRow',
    async (
      computed: CharacterComputedRow,
      next: { qixue: number; lingqi: number },
    ) => {
      writes.push({
        characterId: computed.id,
        next,
      });
      return next;
    },
  );

  await restoreCharacterResourcesAfterVictoryByCharacterIds([2001, 2002, 2001]);

  assert.equal(batchCallCount, 1);
  assert.deepEqual(writes, [
    {
      characterId: 2001,
      next: { qixue: 50, lingqi: 18 },
    },
    {
      characterId: 2002,
      next: { qixue: 100, lingqi: 55 },
    },
  ]);
});
