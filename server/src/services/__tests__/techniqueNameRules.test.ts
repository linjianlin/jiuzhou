/**
 * 作用（做什么 / 不做什么）：
 * - 做什么：校验功法自定义命名规则（长度、字符白名单、规范化、敏感词）。
 * - 不做什么：不覆盖数据库唯一索引与并发发布行为，这部分由集成测试验证。
 *
 * 输入/输出：
 * - 输入：原始名称字符串。
 * - 输出：`validateTechniqueCustomName` 的 success/code/message 与 `normalizeTechniqueName` 结果。
 *
 * 数据流/状态流：
 * 原始输入 -> 名称规范化 -> 格式校验 -> 敏感词匹配 -> 返回结果。
 *
 * 关键边界条件与坑点：
 * 1) 规范化会把全角空格与连续空白归一，避免“视觉不同、语义同名”的绕过。
 * 2) 英文大小写会统一为小写参与比较，保证全服唯一判定稳定。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTechniqueNameRulesView,
  normalizeTechniqueName,
  validateTechniqueCustomName,
} from '../shared/techniqueNameRules.js';

test('名称规范化应处理空白与英文大小写', () => {
  assert.equal(normalizeTechniqueName('  A\u3000B   C  '), 'a b c');
});

test('合法名称应通过校验并自动添加前缀', async () => {
  const result = await validateTechniqueCustomName('太虚剑诀');
  const prefix = getTechniqueNameRulesView().fixedPrefix;
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.normalizedName, `${prefix.toLowerCase()}太虚剑诀`);
  assert.equal(result.displayName, `${prefix}太虚剑诀`);
});

test('长度越界应返回 NAME_INVALID', async () => {
  const shortName = await validateTechniqueCustomName('剑');
  assert.equal(shortName.success, false);
  if (!shortName.success) {
    assert.equal(shortName.code, 'NAME_INVALID');
  }

  const longName = await validateTechniqueCustomName('一二三四五六七八九十一二三四五');
  assert.equal(longName.success, false);
  if (!longName.success) {
    assert.equal(longName.code, 'NAME_INVALID');
  }
});

test('非法字符应返回 NAME_INVALID', async () => {
  const result = await validateTechniqueCustomName('天雷剑诀1');
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.code, 'NAME_INVALID');
  }
});

test('敏感词应返回 NAME_SENSITIVE', async () => {
  const result = await validateTechniqueCustomName('管理员');
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.code, 'NAME_SENSITIVE');
  }
});
