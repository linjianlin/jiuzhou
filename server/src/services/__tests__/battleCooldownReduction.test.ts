import test from 'node:test';
import assert from 'node:assert/strict';
import { applySkillCooldownAfterCast } from '../../battle/utils/cooldown.js';
import type { BattleAttrs, BattleUnit } from '../../battle/types.js';

const createAttrs = (lengque: number): BattleAttrs => ({
  max_qixue: 1000,
  max_lingqi: 200,
  wugong: 100,
  fagong: 100,
  wufang: 80,
  fafang: 80,
  sudu: 100,
  mingzhong: 0.9,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 1.5,
  jianbaoshang: 0,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
});

const createUnit = (lengque: number): BattleUnit => {
  const attrs = createAttrs(lengque);
  return {
    id: 'player-1',
    name: '测试角色',
    type: 'player',
    sourceId: 1,
    baseAttrs: { ...attrs },
    currentAttrs: { ...attrs },
    qixue: attrs.max_qixue,
    lingqi: attrs.max_lingqi,
    shields: [],
    buffs: [],
    marks: [],
    momentum: null,
    skills: [],
    skillCooldowns: {},
    skillCooldownDiscountBank: {},
    setBonusEffects: [],
    controlDiminishing: {},
    isAlive: true,
    canAct: true,
    stats: {
      damageDealt: 0,
      damageTaken: 0,
      healingDone: 0,
      healingReceived: 0,
      killCount: 0,
    },
  };
};

test('小额冷却缩减不会首发直接跨整回合', () => {
  const unit = createUnit(0.03);
  const actualCooldown = applySkillCooldownAfterCast(unit, 'skill-a', 2);

  assert.equal(actualCooldown, 2);
  assert.equal(unit.skillCooldowns['skill-a'], 2);
  assert.equal(unit.skillCooldownDiscountBank['skill-a'], 0.06);
});

test('累计折扣池攒满后会兑现整回合冷却收益', () => {
  const unit = createUnit(0.2);
  const actualCooldowns: number[] = [];

  for (let i = 0; i < 5; i++) {
    actualCooldowns.push(applySkillCooldownAfterCast(unit, 'skill-a', 3));
  }

  assert.deepEqual(actualCooldowns, [3, 2, 3, 2, 2]);
  assert.equal(actualCooldowns.reduce((sum, value) => sum + value, 0), 12);
  assert.equal(unit.skillCooldownDiscountBank['skill-a'], undefined);
});

test('恢复态缺少冷却折扣池时会在施法前自动补齐', () => {
  const unit = createUnit(0.1);
  const recoveredUnit = unit as BattleUnit & {
    skillCooldownDiscountBank?: Record<string, number>;
  };
  Reflect.deleteProperty(recoveredUnit, 'skillCooldownDiscountBank');

  const actualCooldown = applySkillCooldownAfterCast(unit, 'skill-a', 2);

  assert.equal(actualCooldown, 2);
  assert.equal(unit.skillCooldowns['skill-a'], 2);
  assert.deepEqual(unit.skillCooldownDiscountBank, {
    'skill-a': 0.2,
  });
});
