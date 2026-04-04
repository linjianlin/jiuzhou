/**
 * 装备基础双攻种子测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定 `equipment_def.json` 中所有提供基础物攻或法攻的装备定义，确保本次翻倍直接落在 seed 数据层。
 * - 做什么：把“哪些装备带基础双攻、每件应是多少”集中到单一断言入口，避免后续再把同类数值漂散到别处维护。
 * - 不做什么：不验证隐式属性、词条、宝石、强化成长，也不覆盖角色运行时属性汇总链路。
 *
 * 输入/输出：
 * - 输入：`equipment_def.json` 静态装备定义。
 * - 输出：断言每个基础双攻装备的 `base_attrs.wugong/fagong` 等于本次翻倍后的期望值。
 *
 * 数据流/状态流：
 * - 测试先通过 `seedTestUtils.loadSeed` 统一读取装备种子；
 * - 再遍历所有装备条目，筛出声明了 `base_attrs.wugong/fagong` 的集合；
 * - 最后用集中维护的期望表逐条校验，并反向校验集合是否完整覆盖。
 *
 * 复用设计说明：
 * - 复用 `seedTestUtils` 的统一读种子与结构收窄能力，避免每个静态配置测试各写一套 JSON 解析。
 * - 通过单一 `EXPECTED_BASE_ATTACK_BY_EQUIPMENT_ID` 收口全部基础双攻断言，后续若继续调整 seed，只需修改一个映射表。
 *
 * 关键边界条件与坑点：
 * 1) 这里只校验 `base_attrs`，不能误把 `implicit_attrs`、宝石或词条里的双攻也算进来，否则会把“基础属性翻倍”改成“全来源翻倍”。
 * 2) 测试同时校验实际命中集合与期望集合完全一致，避免新增基础双攻装备后漏配断言，或者删装备后残留死数据。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { asArray, asObject, asText, loadSeed } from './seedTestUtils.js';

type BaseAttackAttrKey = 'wugong' | 'fagong';

const EXPECTED_BASE_ATTACK_BY_EQUIPMENT_ID = new Map<string, { attrKey: BaseAttackAttrKey; expected: number }>([
  ['equip-weapon-001', { attrKey: 'wugong', expected: 8 }],
  ['equip-weapon-002', { attrKey: 'wugong', expected: 22 }],
  ['equip-weapon-003', { attrKey: 'wugong', expected: 32 }],
  ['set-qingfeng-weapon', { attrKey: 'wugong', expected: 16 }],
  ['set-qingfeng-gloves', { attrKey: 'wugong', expected: 4 }],
  ['set-qingfeng-necklace', { attrKey: 'wugong', expected: 6 }],
  ['set-qingfeng-accessory', { attrKey: 'wugong', expected: 8 }],
  ['set-qingfeng-artifact', { attrKey: 'wugong', expected: 8 }],
  ['set-xuantie-weapon', { attrKey: 'wugong', expected: 22 }],
  ['set-xuantie-gloves', { attrKey: 'wugong', expected: 8 }],
  ['set-xuantie-accessory', { attrKey: 'wugong', expected: 8 }],
  ['set-zixiao-weapon', { attrKey: 'fagong', expected: 20 }],
  ['set-zixiao-gloves', { attrKey: 'fagong', expected: 6 }],
  ['set-zixiao-necklace', { attrKey: 'fagong', expected: 8 }],
  ['set-zixiao-accessory', { attrKey: 'fagong', expected: 8 }],
  ['set-zixiao-artifact', { attrKey: 'fagong', expected: 12 }],
  ['set-biluo-weapon', { attrKey: 'fagong', expected: 16 }],
  ['set-biluo-gloves', { attrKey: 'fagong', expected: 4 }],
  ['set-biluo-accessory', { attrKey: 'fagong', expected: 8 }],
  ['set-biluo-artifact', { attrKey: 'fagong', expected: 8 }],
  ['equip-weapon-004', { attrKey: 'wugong', expected: 30 }],
  ['equip-gloves-002', { attrKey: 'wugong', expected: 12 }],
  ['equip-necklace-002', { attrKey: 'wugong', expected: 10 }],
  ['equip-accessory-001', { attrKey: 'fagong', expected: 16 }],
  ['equip-artifact-002', { attrKey: 'fagong', expected: 22 }],
  ['equip-weapon-005', { attrKey: 'wugong', expected: 34 }],
  ['equip-gloves-001', { attrKey: 'wugong', expected: 16 }],
  ['equip-necklace-003', { attrKey: 'fagong', expected: 14 }],
  ['equip-accessory-002', { attrKey: 'fagong', expected: 18 }],
  ['set-chiyan-weapon', { attrKey: 'wugong', expected: 32 }],
  ['set-chiyan-gloves', { attrKey: 'wugong', expected: 20 }],
  ['set-chiyan-necklace', { attrKey: 'wugong', expected: 16 }],
  ['set-xuanwu-weapon', { attrKey: 'wugong', expected: 24 }],
  ['set-tianxuan-weapon', { attrKey: 'fagong', expected: 36 }],
  ['set-tianxuan-gloves', { attrKey: 'fagong', expected: 20 }],
  ['set-tianxuan-necklace', { attrKey: 'fagong', expected: 18 }],
  ['set-qinglian-weapon', { attrKey: 'fagong', expected: 20 }],
  ['set-pojun-weapon', { attrKey: 'wugong', expected: 40 }],
  ['set-pojun-gloves', { attrKey: 'wugong', expected: 28 }],
  ['set-pojun-necklace', { attrKey: 'wugong', expected: 22 }],
  ['set-cangyue-weapon', { attrKey: 'fagong', expected: 44 }],
  ['set-cangyue-gloves', { attrKey: 'fagong', expected: 24 }],
  ['set-cangyue-necklace', { attrKey: 'fagong', expected: 24 }],
  ['set-guiyuan-weapon', { attrKey: 'wugong', expected: 44 }],
  ['set-xuanguang-weapon', { attrKey: 'fagong', expected: 48 }],
  ['set-xuanguang-head', { attrKey: 'fagong', expected: 32 }],
  ['set-xuanguang-clothes', { attrKey: 'fagong', expected: 40 }],
  ['set-xuanguang-gloves', { attrKey: 'fagong', expected: 32 }],
  ['set-xuanguang-pants', { attrKey: 'fagong', expected: 20 }],
  ['set-xuanguang-necklace', { attrKey: 'fagong', expected: 28 }],
  ['set-xuanguang-accessory', { attrKey: 'fagong', expected: 36 }],
  ['set-ningshen-weapon', { attrKey: 'wugong', expected: 52 }],
  ['set-xuying-weapon', { attrKey: 'fagong', expected: 60 }],
  ['set-xuying-head', { attrKey: 'fagong', expected: 40 }],
  ['set-xuying-clothes', { attrKey: 'fagong', expected: 48 }],
  ['set-xuying-gloves', { attrKey: 'fagong', expected: 40 }],
  ['set-xuying-pants', { attrKey: 'fagong', expected: 24 }],
  ['set-xuying-necklace', { attrKey: 'fagong', expected: 36 }],
  ['set-xuying-accessory', { attrKey: 'fagong', expected: 44 }],
  ['set-taixu-weapon', { attrKey: 'fagong', expected: 68 }],
  ['set-taixu-head', { attrKey: 'fagong', expected: 46 }],
  ['set-taixu-clothes', { attrKey: 'fagong', expected: 54 }],
  ['set-taixu-gloves', { attrKey: 'fagong', expected: 46 }],
  ['set-taixu-pants', { attrKey: 'fagong', expected: 28 }],
  ['set-taixu-necklace', { attrKey: 'fagong', expected: 42 }],
  ['set-taixu-accessory', { attrKey: 'fagong', expected: 50 }],
  ['set-zhenhun-weapon', { attrKey: 'wugong', expected: 60 }],
  ['set-zhaogu-weapon', { attrKey: 'fagong', expected: 76 }],
  ['set-zhaogu-head', { attrKey: 'fagong', expected: 52 }],
  ['set-zhaogu-clothes', { attrKey: 'fagong', expected: 62 }],
  ['set-zhaogu-gloves', { attrKey: 'fagong', expected: 52 }],
  ['set-zhaogu-pants', { attrKey: 'fagong', expected: 36 }],
  ['set-zhaogu-necklace', { attrKey: 'fagong', expected: 48 }],
  ['set-zhaogu-accessory', { attrKey: 'fagong', expected: 56 }],
  ['set-xuanlv-weapon', { attrKey: 'wugong', expected: 68 }],
  ['set-suijing-weapon', { attrKey: 'wugong', expected: 76 }],
  ['set-suijing-head', { attrKey: 'wugong', expected: 52 }],
  ['set-suijing-clothes', { attrKey: 'wugong', expected: 62 }],
  ['set-suijing-gloves', { attrKey: 'wugong', expected: 52 }],
  ['set-suijing-pants', { attrKey: 'wugong', expected: 36 }],
  ['set-suijing-necklace', { attrKey: 'wugong', expected: 48 }],
  ['set-suijing-accessory', { attrKey: 'wugong', expected: 56 }],
  ['set-tianyan-weapon', { attrKey: 'fagong', expected: 86 }],
  ['set-tianyan-head', { attrKey: 'fagong', expected: 58 }],
  ['set-tianyan-clothes', { attrKey: 'fagong', expected: 70 }],
  ['set-tianyan-gloves', { attrKey: 'fagong', expected: 58 }],
  ['set-tianyan-pants', { attrKey: 'fagong', expected: 40 }],
  ['set-tianyan-necklace', { attrKey: 'fagong', expected: 54 }],
  ['set-tianyan-accessory', { attrKey: 'fagong', expected: 62 }],
  ['set-xuanheng-weapon', { attrKey: 'wugong', expected: 76 }],
  ['set-poxu-weapon', { attrKey: 'wugong', expected: 86 }],
  ['set-poxu-head', { attrKey: 'wugong', expected: 58 }],
  ['set-poxu-clothes', { attrKey: 'wugong', expected: 70 }],
  ['set-poxu-gloves', { attrKey: 'wugong', expected: 58 }],
  ['set-poxu-pants', { attrKey: 'wugong', expected: 40 }],
  ['set-poxu-necklace', { attrKey: 'wugong', expected: 54 }],
  ['set-poxu-accessory', { attrKey: 'wugong', expected: 62 }],
]);

test('装备种子中的基础物攻与法攻应已按翻倍规则写入', () => {
  const equipmentSeed = loadSeed('equipment_def.json');
  const actualIds = new Set<string>();

  for (const entry of asArray(equipmentSeed.items)) {
    const equipment = asObject(entry);
    assert.ok(equipment, '装备条目必须是对象');

    const equipmentId = asText(equipment.id);
    assert.ok(equipmentId, '装备条目缺少 id');

    const baseAttrs = asObject(equipment.base_attrs);
    if (!baseAttrs) continue;

    const hasWugong = typeof baseAttrs.wugong === 'number';
    const hasFagong = typeof baseAttrs.fagong === 'number';
    if (!hasWugong && !hasFagong) continue;

    actualIds.add(equipmentId);
    const expected = EXPECTED_BASE_ATTACK_BY_EQUIPMENT_ID.get(equipmentId);
    assert.ok(expected, `缺少基础双攻断言: ${equipmentId}`);

    const actualValue = baseAttrs[expected.attrKey];
    assert.equal(
      actualValue,
      expected.expected,
      `${equipmentId} 的基础${expected.attrKey === 'wugong' ? '物攻' : '法攻'}应为 ${expected.expected}`,
    );
  }

  assert.deepEqual(
    [...actualIds].sort(),
    [...EXPECTED_BASE_ATTACK_BY_EQUIPMENT_ID.keys()].sort(),
    '基础双攻装备集合应与断言表完全一致',
  );
});
