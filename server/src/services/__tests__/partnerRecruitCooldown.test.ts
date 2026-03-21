/**
 * 伙伴招募冷却规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证伙伴招募冷却时间的统一计算与开发环境绕过规则，确保状态接口与创建任务校验使用同一套规则。
 * 2. 不做什么：不覆盖数据库查询、不覆盖路由层，只验证共享纯函数计算结果。
 *
 * 输入/输出：
 * - 输入：最近一次招募开始时间、当前时间、是否显式绕过冷却。
 * - 输出：冷却结束时间、剩余秒数、是否仍处于冷却中，以及当前环境下的冷却小时数。
 *
 * 数据流/状态流：
 * 最近一次招募时间 -> 共享冷却规则 -> 状态接口 / 创建任务校验。
 *
 * 关键边界条件与坑点：
 * 1. 无招募记录时必须返回“当前可招募”，否则新角色会被错误拦截。
 * 2. 开发环境绕过冷却时仍要维持同一返回结构，避免前端展示和服务端拦截口径分裂。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PARTNER_RECRUIT_COOLDOWN_HOURS,
  buildPartnerRecruitCooldownState,
  shouldPartnerRecruitApplyCooldown,
  shouldBypassPartnerRecruitCooldown,
} from '../shared/partnerRecruitRules.js';

const NOW_ISO = '2026-03-08T12:00:00.000Z';
const NOW = new Date(NOW_ISO);

test('shouldBypassPartnerRecruitCooldown: 所有环境默认都应保留正式冷却', () => {
  assert.equal(shouldBypassPartnerRecruitCooldown('production'), false);
  assert.equal(shouldBypassPartnerRecruitCooldown('development'), false);
  assert.equal(shouldBypassPartnerRecruitCooldown(undefined), false);
});

test('buildPartnerRecruitCooldownState: 生产口径下无招募记录时不应进入冷却', () => {
  const state = buildPartnerRecruitCooldownState(null, NOW, { bypassCooldown: false });

  assert.equal(state.cooldownHours, PARTNER_RECRUIT_COOLDOWN_HOURS);
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.cooldownRemainingSeconds, 0);
  assert.equal(state.isCoolingDown, false);
});

test('buildPartnerRecruitCooldownState: 生产口径下 168 小时内应返回剩余冷却秒数', () => {
  const state = buildPartnerRecruitCooldownState('2026-03-08T06:00:00.000Z', NOW, { bypassCooldown: false });

  assert.equal(state.cooldownHours, PARTNER_RECRUIT_COOLDOWN_HOURS);
  assert.equal(state.cooldownUntil, '2026-03-15T06:00:00.000Z');
  assert.equal(state.cooldownRemainingSeconds, 583_200);
  assert.equal(state.isCoolingDown, true);
});

test('buildPartnerRecruitCooldownState: 月卡激活时应缩短 10% 招募冷却', () => {
  const state = buildPartnerRecruitCooldownState(
    '2026-03-08T06:00:00.000Z',
    NOW,
    { bypassCooldown: false, cooldownReductionRate: 0.1 } as {
      bypassCooldown: boolean;
      cooldownReductionRate: number;
    },
  );

  assert.equal(state.cooldownHours, 151.2);
  assert.equal(state.cooldownUntil, '2026-03-14T13:12:00.000Z');
  assert.equal(state.cooldownRemainingSeconds, 522_720);
  assert.equal(state.isCoolingDown, true);
});

test('buildPartnerRecruitCooldownState: 开发口径下应直接返回无冷却状态', () => {
  const state = buildPartnerRecruitCooldownState('2026-03-08T06:00:00.000Z', NOW, { bypassCooldown: true });

  assert.equal(state.cooldownHours, 0);
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.cooldownRemainingSeconds, 0);
  assert.equal(state.isCoolingDown, false);
});

test('shouldPartnerRecruitApplyCooldown: 生成失败或退款后不应继续占用招募冷却', () => {
  assert.equal(shouldPartnerRecruitApplyCooldown('pending'), true);
  assert.equal(shouldPartnerRecruitApplyCooldown('generated_draft'), true);
  assert.equal(shouldPartnerRecruitApplyCooldown('accepted'), true);
  assert.equal(shouldPartnerRecruitApplyCooldown('discarded'), true);
  assert.equal(shouldPartnerRecruitApplyCooldown('failed'), false);
  assert.equal(shouldPartnerRecruitApplyCooldown('refunded'), false);
  assert.equal(shouldPartnerRecruitApplyCooldown(null), false);
});
