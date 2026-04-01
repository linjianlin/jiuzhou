/**
 * 云游奇遇共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定云游奇遇“生产 1 小时冷却、开发环境直通、同日多次生成推进虚拟 dayKey”这三条共享规则。
 * 2. 做什么：保证概览、创建任务与 worker 复用同一套纯函数时，不会再回退成按自然日限制或重新隐藏生产入口。
 * 3. 不做什么：不连接数据库，不覆盖路由和服务层查询，也不验证前端展示文案。
 *
 * 输入/输出：
 * - 输入：运行环境、最近一次幕次创建时间、最近一次幕次 dayKey、当前时间。
 * - 输出：是否跳过冷却、冷却结束时间、剩余秒数、是否仍在冷却，以及下一次可写入的 dayKey。
 *
 * 数据流/状态流：
 * 服务层/worker 输入时间信息 -> `wander/rules.ts` 纯函数 -> 测试断言正式冷却与虚拟 dayKey 结果。
 *
 * 复用设计说明：
 * 1. 这组测试直接覆盖共享规则模块，避免相同断言在服务层测试里重复出现。
 * 2. 生产冷却和 dayKey 递增是所有云游入口的共同依赖，因此在这里集中锁定最稳妥。
 *
 * 关键边界条件与坑点：
 * 1. 开发环境跳过冷却时仍要返回同一结构，否则概览接口与创建任务会出现字段漂移。
 * 2. 同日内再次生成时必须推进到下一天的虚拟 dayKey，否则数据库唯一索引会阻止第二幕落库。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WANDER_COOLDOWN_HOURS,
  buildWanderCooldownState,
  formatWanderCooldownRemaining,
  resolveWanderGenerationDayKey,
  shouldBypassWanderCooldown,
} from '../wander/rules.js';

const NOW = new Date('2026-04-01T12:00:00.000Z');

test('shouldBypassWanderCooldown: 仅 development 环境应跳过正式冷却', () => {
  assert.equal(shouldBypassWanderCooldown('production'), false);
  assert.equal(shouldBypassWanderCooldown('development'), true);
  assert.equal(shouldBypassWanderCooldown('test'), false);
  assert.equal(shouldBypassWanderCooldown(undefined), false);
});

test('buildWanderCooldownState: 生产口径下 1 小时内应返回剩余冷却', () => {
  const state = buildWanderCooldownState('2026-04-01T11:30:00.000Z', NOW, false);

  assert.equal(state.cooldownHours, WANDER_COOLDOWN_HOURS);
  assert.equal(state.cooldownUntil, '2026-04-01T12:30:00.000Z');
  assert.equal(state.cooldownRemainingSeconds, 1_800);
  assert.equal(state.isCoolingDown, true);
});

test('buildWanderCooldownState: 超过 1 小时后应允许继续生成', () => {
  const state = buildWanderCooldownState('2026-04-01T10:59:59.000Z', NOW, false);

  assert.equal(state.cooldownUntil, '2026-04-01T11:59:59.000Z');
  assert.equal(state.cooldownRemainingSeconds, 0);
  assert.equal(state.isCoolingDown, false);
});

test('buildWanderCooldownState: 开发口径下应直接返回无冷却状态', () => {
  const state = buildWanderCooldownState('2026-04-01T11:45:00.000Z', NOW, true);

  assert.equal(state.cooldownHours, 0);
  assert.equal(state.cooldownUntil, null);
  assert.equal(state.cooldownRemainingSeconds, 0);
  assert.equal(state.isCoolingDown, false);
});

test('formatWanderCooldownRemaining: 应输出紧凑中文剩余时间', () => {
  assert.equal(formatWanderCooldownRemaining(3_661), '1小时1分');
  assert.equal(formatWanderCooldownRemaining(125), '2分5秒');
  assert.equal(formatWanderCooldownRemaining(59), '59秒');
});

test('resolveWanderGenerationDayKey: 同日再次生成时应推进到下一虚拟日期', () => {
  assert.equal(resolveWanderGenerationDayKey(null, NOW), '2026-04-01');
  assert.equal(resolveWanderGenerationDayKey('2026-03-31', NOW), '2026-04-01');
  assert.equal(resolveWanderGenerationDayKey('2026-04-01', NOW), '2026-04-02');
  assert.equal(resolveWanderGenerationDayKey('2026-04-03', NOW), '2026-04-04');
});
