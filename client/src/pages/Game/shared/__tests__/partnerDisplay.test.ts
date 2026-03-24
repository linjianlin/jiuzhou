/**
 * 伙伴展示共享工具测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴等级摘要与功法层数字样的共享口径，避免伙伴面板与坊市详情再次各自拼接字符串。
 * 2. 做什么：验证“实际层数生效时必须直接显示 DTO 的 currentLayer/maxLayer”，防止展示层回退成硬编码首层。
 * 3. 不做什么：不渲染完整组件，也不验证伙伴属性行布局。
 *
 * 输入/输出：
 * - 输入：伙伴等级相关字段、功法层数字段。
 * - 输出：统一的展示文案字符串。
 *
 * 数据流/状态流：
 * 伙伴 DTO -> partnerDisplay 共享格式化函数 -> 伙伴面板 / 坊市详情共同消费。
 *
 * 关键边界条件与坑点：
 * 1. 当伙伴生效等级低于实际等级时，摘要必须同时展示两个值，否则用户会误以为等级被吞。
 * 2. 功法层数字样必须使用真实层数，不允许再出现固定“第一层”的展示回退。
 */
import { describe, expect, it } from 'vitest';

import {
  formatPartnerLevelSummary,
  formatPartnerTechniqueLayerLabel,
  hasPartnerLevelLimitApplied,
} from '../partnerDisplay';

describe('partnerDisplay', () => {
  it('伙伴等级受境界压制时，应同时展示实际等级与生效等级', () => {
    expect(hasPartnerLevelLimitApplied({ level: 18, currentEffectiveLevel: 12 })).toBe(true);
    expect(formatPartnerLevelSummary({ level: 18, currentEffectiveLevel: 12 })).toBe('等级 18 · 生效 12');
  });

  it('功法层数字样应使用真实当前层数与最大层数', () => {
    expect(
      formatPartnerTechniqueLayerLabel({
        currentLayer: 4,
        maxLayer: 7,
      }),
    ).toBe('第 4 / 7 层');
  });
});
