/**
 * 属性加减档位共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证角色属性面板统一复用 `1 / 5 / 10` 档位配置，避免 `PlayerInfo` 的加点和减点按钮各自维护一份数字常量。
 * 2. 做什么：验证当前档位在“增加”和“减少”两种操作下的可用性判断保持一致，避免前端把超额请求继续发给接口。
 * 3. 不做什么：不渲染真实面板，也不覆盖按钮视觉样式，只锁定共享规则模块本身。
 *
 * 输入/输出：
 * - 输入：档位、当前剩余属性点、当前属性值、操作类型。
 * - 输出：档位列表、按钮文案，以及当前操作是否允许提交。
 *
 * 数据流/状态流：
 * PlayerInfo 选择档位 -> attributePointStep 共享规则 -> 基础属性加减按钮禁用态与 aria-label。
 *
 * 关键边界条件与坑点：
 * 1. `+5 / +10` 与 `-5 / -10` 必须共用同一套档位定义，不能分别写死，否则后续改动很容易漏改一侧。
 * 2. 当前端档位大于剩余属性点或当前属性值时，应直接禁用按钮，避免把本可前置拦住的无效请求继续打到后端。
 */
import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTE_POINT_STEP_OPTIONS,
  canAdjustAttributePointByStep,
  getAttributePointActionLabel,
} from '../PlayerInfo/attributePointStep';

describe('attributePointStep', () => {
  it('应统一暴露 1 5 10 三档，供加点和减点共用', () => {
    expect(ATTRIBUTE_POINT_STEP_OPTIONS).toEqual([1, 5, 10]);
  });

  it('应根据当前档位判断增加和减少操作是否可用', () => {
    expect(canAdjustAttributePointByStep({
      action: 'add',
      step: 5,
      attributePoints: 7,
      currentValue: 2,
    })).toBe(true);

    expect(canAdjustAttributePointByStep({
      action: 'add',
      step: 10,
      attributePoints: 7,
      currentValue: 2,
    })).toBe(false);

    expect(canAdjustAttributePointByStep({
      action: 'remove',
      step: 5,
      attributePoints: 7,
      currentValue: 5,
    })).toBe(true);

    expect(canAdjustAttributePointByStep({
      action: 'remove',
      step: 10,
      attributePoints: 7,
      currentValue: 5,
    })).toBe(false);
  });

  it('应为两类操作生成带档位的无障碍标签', () => {
    expect(getAttributePointActionLabel('add', '精', 5)).toBe('增加5点精');
    expect(getAttributePointActionLabel('remove', '神', 10)).toBe('减少10点神');
  });
});
