/**
 * 洞府研修冷却规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证研修冷却时间的统一计算与文案格式化，确保状态接口与创建任务前校验使用同一套规则。
 * 2. 不做什么：不覆盖数据库查询、不覆盖路由层，只验证纯函数计算结果。
 *
 * 输入/输出：
 * - 输入：最近一次研修开始时间、当前时间、剩余秒数。
 * - 输出：冷却结束时间、剩余秒数、是否仍处于冷却中，以及统一剩余时间文案。
 *
 * 数据流/状态流：
 * 最近一次研修时间 -> 冷却计算模块 -> 状态接口 / 创建任务校验。
 *
 * 关键边界条件与坑点：
 * 1. 无最近一次研修记录时必须直接返回“无冷却”，否则新角色会被错误拦截。
 * 2. 冷却剩余秒数需要向上取整，避免仅剩零点几秒时前端已显示可开始、服务端却仍拦截。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TECHNIQUE_RESEARCH_COOLDOWN_HOURS,
  buildTechniqueResearchCooldownState,
  formatTechniqueResearchCooldownRemaining,
  shouldBypassTechniqueResearchCooldown,
  shouldTechniqueResearchApplyCooldown,
} from '../shared/techniqueResearchCooldown.js';

const NOW_ISO = '2026-03-08T12:00:00.000Z';
const NOW = new Date(NOW_ISO);

test('shouldBypassTechniqueResearchCooldown: 仅本地开发环境应跳过正式冷却', () => {
  assert.equal(shouldBypassTechniqueResearchCooldown('production'), false);
  assert.equal(shouldBypassTechniqueResearchCooldown('development'), true);
  assert.equal(shouldBypassTechniqueResearchCooldown('test'), false);
  assert.equal(shouldBypassTechniqueResearchCooldown(undefined), false);
});

test('buildTechniqueResearchCooldownState: 无最近研修记录时不应进入冷却', () => {
  const state = buildTechniqueResearchCooldownState(null, NOW, { bypassCooldown: false });

  assert.equal(state.cooldownHours, TECHNIQUE_RESEARCH_COOLDOWN_HOURS);
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.cooldownRemainingSeconds, 0);
  assert.equal(state.isCoolingDown, false);
});

test('buildTechniqueResearchCooldownState: 72 小时内应返回剩余冷却秒数', () => {
  const state = buildTechniqueResearchCooldownState('2026-03-07T12:00:00.000Z', NOW, { bypassCooldown: false });

  assert.equal(state.cooldownHours, TECHNIQUE_RESEARCH_COOLDOWN_HOURS);
  assert.equal(state.cooldownUntil, '2026-03-10T12:00:00.000Z');
  assert.equal(state.cooldownRemainingSeconds, 172_800);
  assert.equal(state.isCoolingDown, true);
});

test('buildTechniqueResearchCooldownState: 月卡激活时应缩短 10% 研修冷却', () => {
  const state = buildTechniqueResearchCooldownState(
    '2026-03-07T12:00:00.000Z',
    NOW,
    { bypassCooldown: false, cooldownReductionRate: 0.1 } as {
      bypassCooldown: boolean;
      cooldownReductionRate: number;
    },
  );

  assert.equal(state.cooldownHours, 64.8);
  assert.equal(state.cooldownUntil, '2026-03-10T04:48:00.000Z');
  assert.equal(state.cooldownRemainingSeconds, 146_880);
  assert.equal(state.isCoolingDown, true);
});

test('buildTechniqueResearchCooldownState: 超过冷却后应允许再次领悟', () => {
  const state = buildTechniqueResearchCooldownState('2026-03-05T11:59:59.000Z', NOW, { bypassCooldown: false });

  assert.equal(state.cooldownUntil, '2026-03-08T11:59:59.000Z');
  assert.equal(state.cooldownRemainingSeconds, 0);
  assert.equal(state.isCoolingDown, false);
});

test('buildTechniqueResearchCooldownState: 显式跳过冷却时应直接返回无冷却状态', () => {
  const state = buildTechniqueResearchCooldownState('2026-03-07T12:00:00.000Z', NOW, { bypassCooldown: true });

  assert.equal(state.cooldownHours, 0);
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.cooldownRemainingSeconds, 0);
  assert.equal(state.isCoolingDown, false);
});

test('shouldTechniqueResearchApplyCooldown: 失败结果不应继续占用研修冷却', () => {
  assert.equal(shouldTechniqueResearchApplyCooldown('pending'), true);
  assert.equal(shouldTechniqueResearchApplyCooldown('generated_draft'), true);
  assert.equal(shouldTechniqueResearchApplyCooldown('published'), true);
  assert.equal(shouldTechniqueResearchApplyCooldown('refunded'), true);
  assert.equal(shouldTechniqueResearchApplyCooldown('failed'), false);
  assert.equal(shouldTechniqueResearchApplyCooldown(null), false);
});

test('formatTechniqueResearchCooldownRemaining: 应输出紧凑的中文剩余时间', () => {
  assert.equal(formatTechniqueResearchCooldownRemaining(172_800), '2天');
  assert.equal(formatTechniqueResearchCooldownRemaining(90_061), '1天1小时1分');
  assert.equal(formatTechniqueResearchCooldownRemaining(3_661), '1小时1分');
  assert.equal(formatTechniqueResearchCooldownRemaining(59), '59秒');
});
