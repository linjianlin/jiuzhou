/**
 * 暴击防御向装备词缀池覆盖测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证暴伤减免词缀已进入承载暴击防御向副词条的装备池，并按统一缩放比例复用同池抗暴词缀的数值梯度。
 * 2) 不做什么：不验证运行时掉落概率，不覆盖战斗公式，也不校验所有词缀池的完整内容。
 *
 * 输入/输出：
 * - 输入：`affix_pool.json` 种子文件中的目标词缀池与词缀定义。
 * - 输出：布尔断言，确认 `jianbaoshang_flat` 的存在性、展示字段与档位口径正确。
 *
 * 数据流/状态流：
 * 装备词缀种子 -> 静态配置加载 -> 洗炼/掉落共用词缀池；本测试直接锁定种子层，避免运行时才发现漏配。
 *
 * 关键边界条件与坑点：
 * 1) 暴伤减免只应进入已经承载暴击防御向副词条的池，不能为了“全覆盖”扩散到明显偏输出的武器池。
 * 2) 数值若另起一套档位，后续很容易和抗暴词缀拉开强度口径；这里锁定为同池 `kangbao_flat × 0.7`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAffixByKeyAndSlot, loadNormalizedAffixPools } from './seedTestUtils.js';

const CRIT_DEFENSE_SLOTS = [
  'head',
  'accessory',
] as const;
const CRIT_DAMAGE_RESIST_SCALE = 0.7;

const scaleTierValue = (value: number): number => {
  return Number((value * CRIT_DAMAGE_RESIST_SCALE).toFixed(6));
};

test('暴伤减免词缀应进入暴击防御向装备池，并按 0.7 系数复用同池抗暴档位口径', () => {
  const pools = loadNormalizedAffixPools();
  const pool = pools.find((row) => row.id === 'ap-equipment');
  assert.ok(pool, '缺少词条池: ap-equipment');

  for (const equipSlot of CRIT_DEFENSE_SLOTS) {
    const critResistAffix = findAffixByKeyAndSlot(pool, 'jianbaoshang_flat', equipSlot);
    const critDefenseAffix = findAffixByKeyAndSlot(pool, 'kangbao_flat', equipSlot);

    assert.ok(critResistAffix, `${equipSlot} 缺少 jianbaoshang_flat`);
    assert.ok(critDefenseAffix, `${equipSlot} 缺少 kangbao_flat 参照词缀`);

    assert.equal(critResistAffix.name, '暴伤减免+');
    assert.equal(critResistAffix.apply_type, 'flat');
    assert.equal(critResistAffix.group, critDefenseAffix.group);
    assert.equal(critResistAffix.weight, critDefenseAffix.weight);
    assert.deepEqual(
      critResistAffix.tiers,
      critDefenseAffix.tiers.map((tier) => ({
        tier: tier.tier,
        min: scaleTierValue(tier.min),
        max: scaleTierValue(tier.max),
        realm_rank_min: tier.realm_rank_min,
      })),
    );
    assert.deepEqual(critResistAffix.modifiers, [{ attr_key: 'jianbaoshang_rating' }]);
  }
});
