/**
 * attrDisplay 共享映射回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证共享属性映射保留主界面装备 tooltip 仍会用到的 `jing/qi/shen` 中文标签。
 * 2) 不做什么：不覆盖属性排序、百分比判断或其他面板格式化逻辑，只锁定这次共享映射替换后的标签回归。
 *
 * 输入/输出：
 * - 输入：属性 key 字符串。
 * - 输出：共享映射返回的中文标签。
 *
 * 数据流/状态流：
 * Game/index.tsx 装备 tooltip / 词条展示 -> attrDisplay.getAttrLabel -> 本测试断言返回值稳定。
 *
 * 关键边界条件与坑点：
 * 1) `jing/qi/shen` 不在当前角色二级属性注册表里，但装备词条池仍会产出，不能因为共享化被误删。
 * 2) 这里验证的是共享入口本身，若未来某个业务层再做局部覆写，必须单独在对应模块补测试。
 */
import { describe, expect, it } from 'vitest';
import { getAttrLabel } from '../attrDisplay';

describe('attrDisplay', () => {
  it('共享属性映射应保留精气神标签，避免主界面装备提示回退到原始 key', () => {
    expect(getAttrLabel('jing')).toBe('精');
    expect(getAttrLabel('qi')).toBe('气');
    expect(getAttrLabel('shen')).toBe('神');
  });

  it('共享属性映射应覆盖功法被动里的暴伤减免与反伤减免标签', () => {
    expect(getAttrLabel('jianbaoshang')).toBe('暴伤减免');
    expect(getAttrLabel('jianfantan')).toBe('反伤减免');
  });
});
