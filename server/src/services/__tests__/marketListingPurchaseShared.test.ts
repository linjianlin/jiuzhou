/**
 * 坊市购买共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定坊市“部分购买 + 下架按剩余比例退手续费”的共享计算规则。
 * 2. 做什么：保证服务层创建挂单、购买挂单、下架挂单都能复用同一套数量与金额口径。
 * 3. 不做什么：不访问数据库，不验证 SQL 执行结果；这里只测试纯函数规则。
 *
 * 输入/输出：
 * - 输入：挂单数量、购买数量、单价、原始手续费、剩余数量。
 * - 输出：规范化购买数量、成交总价、退款手续费。
 *
 * 数据流/状态流：
 * - 测试用例 -> 共享纯函数 -> 返回数量/金额结果 -> 断言业务规则。
 *
 * 关键边界条件与坑点：
 * 1. 服务端购买数量不应静默夹紧，超过挂单数量或非正整数都必须返回 null，由业务层拒绝请求。
 * 2. 手续费退款必须向下取整，避免部分成交多次下架/结算后累计退款超过原始手续费。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMarketListingRefundFee,
  calculateMarketTradeTotalPrice,
  normalizeMarketBuyQuantity,
} from '../shared/marketListingPurchaseShared.js';

test('购买数量应限制为 1 到当前挂单数量之间的正整数', () => {
  assert.equal(normalizeMarketBuyQuantity(1, 5), 1);
  assert.equal(normalizeMarketBuyQuantity(5, 5), 5);
  assert.equal(normalizeMarketBuyQuantity(0, 5), null);
  assert.equal(normalizeMarketBuyQuantity(6, 5), null);
  assert.equal(normalizeMarketBuyQuantity(1.5, 5), null);
});

test('成交总价应按本次购买数量与单价计算', () => {
  assert.equal(calculateMarketTradeTotalPrice(88n, 3), 264n);
  assert.equal(calculateMarketTradeTotalPrice(1n, 1), 1n);
});

test('下架手续费应按剩余未成交比例向下取整退还', () => {
  assert.equal(calculateMarketListingRefundFee(55n, 10, 6), 33n);
  assert.equal(calculateMarketListingRefundFee(55n, 10, 1), 5n);
  assert.equal(calculateMarketListingRefundFee(55n, 10, 0), 0n);
});
