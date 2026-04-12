/**
 * 战斗内最大气血同步回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证 buff、debuff、光环导致的 `max_qixue/max_lingqi` 变化，会同步增减当前 `qixue/lingqi`。
 * 2. 做什么：锁住 debuff 压死单位、死亡单位不因上限提升被动复活、资源上限回退后当前值同步回退等关键边界。
 * 3. 不做什么：不覆盖完整伤害公式、不验证 UI 展示，也不测试战斗外角色投影资源缓存。
 *
 * 输入/输出：
 * - 输入：最小 BattleUnit/BattleState、属性型 buff/debuff、以及一条被动光环技能。
 * - 输出：断言 `currentAttrs.max_qixue/max_lingqi`、`qixue/lingqi`、`isAlive` 在重算后的收敛结果。
 *
 * 数据流/状态流：
 * addBuff/removeBuff/startBattle -> recalculateUnitAttrs -> 资源同步 helper -> qixue/lingqi/isAlive 收敛。
 *
 * 复用设计说明：
 * - 通过 battleTestUtils 统一构造单位与战斗状态，避免每个用例重复拼接基础属性与状态壳子。
 * - buff 构造集中在本文件本地 helper，便于继续覆盖 max_qixue/max_lingqi 等上限类测试时复用同一输入模式。
 * - 高变化点集中在 `attrKey/value/category/tags`，避免把断言语义散落到多个旧测试文件里。
 *
 * 关键边界条件与坑点：
 * 1. 已死亡单位即使因为 buff/光环提升最大气血，也不能被动复活，否则会破坏现有死亡状态机。
 * 2. debuff 或 buff 移除导致 `qixue <= 0` 时，必须同步置死，而 `lingqi` 仅做资源范围收敛，二者语义不能混淆。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BattleEngine } from '../../battle/battleEngine.js';
import { addBuff, removeBuff } from '../../battle/modules/buff.js';
import type { ActiveBuff, BattleSkill } from '../../battle/types.js';
import { createState, createUnit } from './battleTestUtils.js';

const createAttrBuff = (params: {
  id: string;
  buffDefId?: string;
  type: 'buff' | 'debuff';
  attr: 'max_qixue' | 'max_lingqi';
  value: number;
  category?: string;
  tags?: string[];
}): Omit<ActiveBuff, 'remainingDuration' | 'stacks'> => ({
  id: params.id,
  buffDefId: params.buffDefId ?? params.id,
  name: params.id,
  type: params.type,
  category: params.category ?? 'attr',
  sourceUnitId: 'source-unit',
  maxStacks: 1,
  attrModifiers: [{
    attr: params.attr,
    value: params.value,
    mode: 'flat',
  }],
  tags: params.tags ?? [],
  dispellable: true,
});

const PASSIVE_MAX_QIXUE_AURA_SKILL: BattleSkill = {
  id: 'skill-passive-max-qixue-aura',
  name: '玄脉生息阵',
  source: 'technique',
  cost: {},
  cooldown: 0,
  targetType: 'self',
  targetCount: 1,
  damageType: undefined,
  element: 'none',
  effects: [{
    type: 'buff',
    buffKey: 'buff-max-qixue-aura',
    buffKind: 'aura',
    auraTarget: 'all_ally',
    auraEffects: [{
      type: 'buff',
      buffKey: 'buff-max-qixue-up',
      buffKind: 'attr',
      attrKey: 'max_qixue',
      applyType: 'flat',
      value: 300,
      duration: 1,
    }],
  }],
  triggerType: 'passive',
  aiPriority: 10,
};

test('增益 buff 提高最大气血时应同步提高当前气血', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.qixue = 800;

  addBuff(unit, createAttrBuff({
    id: 'buff-max-qixue-up',
    type: 'buff',
    attr: 'max_qixue',
    value: 300,
  }), 2);

  assert.equal(unit.currentAttrs.max_qixue, 1500);
  assert.equal(unit.qixue, 1100);
  assert.equal(unit.isAlive, true);
});

test('减益 debuff 降低最大气血时应同步降低当前气血', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.qixue = 900;

  addBuff(unit, createAttrBuff({
    id: 'debuff-max-qixue-down',
    type: 'debuff',
    attr: 'max_qixue',
    value: -400,
  }), 2);

  assert.equal(unit.currentAttrs.max_qixue, 800);
  assert.equal(unit.qixue, 500);
  assert.equal(unit.isAlive, true);
});

test('降低最大气血把当前气血压到 0 以下时应直接置死', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.qixue = 200;

  addBuff(unit, createAttrBuff({
    id: 'debuff-max-qixue-lethal',
    type: 'debuff',
    attr: 'max_qixue',
    value: -300,
  }), 2);

  assert.equal(unit.currentAttrs.max_qixue, 900);
  assert.equal(unit.qixue, 0);
  assert.equal(unit.isAlive, false);
});

test('已死亡单位不应因为最大气血提高被动复活', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.qixue = 0;
  unit.isAlive = false;

  addBuff(unit, createAttrBuff({
    id: 'buff-max-qixue-revive-check',
    type: 'buff',
    attr: 'max_qixue',
    value: 300,
  }), 2);

  assert.equal(unit.currentAttrs.max_qixue, 1500);
  assert.equal(unit.qixue, 0);
  assert.equal(unit.isAlive, false);
});

test('移除提高最大气血的 buff 后应同步回退当前气血', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.qixue = 900;

  addBuff(unit, createAttrBuff({
    id: 'buff-max-qixue-up-removal',
    type: 'buff',
    attr: 'max_qixue',
    value: 300,
  }), 2);

  assert.equal(unit.currentAttrs.max_qixue, 1500);
  assert.equal(unit.qixue, 1200);

  const removed = removeBuff(unit, 'buff-max-qixue-up-removal');

  assert.equal(removed, true);
  assert.equal(unit.currentAttrs.max_qixue, 1200);
  assert.equal(unit.qixue, 900);
  assert.equal(unit.isAlive, true);
});

test('被动光环提高最大气血时应同步提高友方当前气血', () => {
  const player = createUnit({ id: 'player-1', name: '主角' });
  player.qixue = 700;
  const partner = createUnit({ id: 'partner-1', name: '伙伴', type: 'partner' });
  const enemy = createUnit({ id: 'monster-1', name: '敌人', type: 'monster' });

  partner.skills = [PASSIVE_MAX_QIXUE_AURA_SKILL];

  const state = createState({
    attacker: [player, partner],
    defender: [enemy],
  });

  const engine = new BattleEngine(state);
  engine.startBattle();

  assert.equal(player.currentAttrs.max_qixue, 1500);
  assert.equal(player.qixue, 1000);
  assert.equal(player.isAlive, true);
});

test('增益 buff 提高最大灵气时应同步提高当前灵气', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.lingqi = 120;

  addBuff(unit, createAttrBuff({
    id: 'buff-max-lingqi-up',
    type: 'buff',
    attr: 'max_lingqi',
    value: 80,
  }), 2);

  assert.equal(unit.currentAttrs.max_lingqi, 320);
  assert.equal(unit.lingqi, 200);
});

test('减益 debuff 降低最大灵气时应同步降低当前灵气', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.lingqi = 150;

  addBuff(unit, createAttrBuff({
    id: 'debuff-max-lingqi-down',
    type: 'debuff',
    attr: 'max_lingqi',
    value: -90,
  }), 2);

  assert.equal(unit.currentAttrs.max_lingqi, 150);
  assert.equal(unit.lingqi, 60);
});

test('降低最大灵气把当前灵气压到 0 以下时应归零而非置死', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.lingqi = 40;

  addBuff(unit, createAttrBuff({
    id: 'debuff-max-lingqi-empty',
    type: 'debuff',
    attr: 'max_lingqi',
    value: -80,
  }), 2);

  assert.equal(unit.currentAttrs.max_lingqi, 160);
  assert.equal(unit.lingqi, 0);
  assert.equal(unit.isAlive, true);
});

test('移除提高最大灵气的 buff 后应同步回退当前灵气', () => {
  const unit = createUnit({ id: 'player-1', name: '主角' });
  unit.lingqi = 100;

  addBuff(unit, createAttrBuff({
    id: 'buff-max-lingqi-up-removal',
    type: 'buff',
    attr: 'max_lingqi',
    value: 80,
  }), 2);

  assert.equal(unit.currentAttrs.max_lingqi, 320);
  assert.equal(unit.lingqi, 180);

  const removed = removeBuff(unit, 'buff-max-lingqi-up-removal');

  assert.equal(removed, true);
  assert.equal(unit.currentAttrs.max_lingqi, 240);
  assert.equal(unit.lingqi, 100);
  assert.equal(unit.isAlive, true);
});
