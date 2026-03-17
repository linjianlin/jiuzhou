/**
 * 任务奖励提示文案回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定任务领取后的系统提示格式，确保前端统一 formatter 优先使用后端返回的中文展示名。
 * 2. 做什么：覆盖银两、灵石、物品混合奖励场景，防止后续有人在业务组件里重新拼一版英文 ID 文案。
 * 3. 不做什么：不请求接口、不验证任务流转状态，也不覆盖主线奖励 formatter。
 *
 * 输入/输出：
 * - 输入：`claimTaskReward` 返回的奖励数组片段。
 * - 输出：`formatTaskRewardsToText` 生成的系统提示文本。
 *
 * 数据流/状态流：
 * 任务领取响应 DTO -> `formatTaskRewardsToText` -> `Game` / `TaskModal` 聊天系统提示。
 *
 * 关键边界条件与坑点：
 * 1. 物品奖励同时带 `itemDefId` 与 `itemName` 时，必须始终优先展示 `itemName`，否则用户会看到英文 ID 回退。
 * 2. 数量为 0 的货币奖励应被忽略，避免系统提示出现无意义的“+0”噪音。
 */
import { describe, expect, it } from 'vitest';

import { formatTaskRewardsToText } from '../../shared/taskRewardText';

describe('formatTaskRewardsToText', () => {
  it('应优先使用后端返回的物品中文名，而不是 itemDefId', () => {
    const text = formatTaskRewardsToText([
      { type: 'item', itemDefId: 'mat-lingmo', itemName: '灵墨', qty: 3 },
    ]);

    expect(text).toBe('物品「灵墨」×3');
  });

  it('应忽略 0 数量货币，并按统一格式输出混合奖励', () => {
    const text = formatTaskRewardsToText([
      { type: 'silver', amount: 1200 },
      { type: 'spirit_stones', amount: 0 },
      { type: 'item', itemDefId: 'book-generated-technique', itemName: '《归虚诀》秘卷', qty: 1 },
    ]);

    expect(text).toBe('银两 +1,200，物品「《归虚诀》秘卷」×1');
  });

  it('应忽略数量非法或非正数的物品奖励，避免展示错误数量', () => {
    const text = formatTaskRewardsToText([
      { type: 'item', itemDefId: 'mat-a', itemName: '甲', qty: 0 },
      { type: 'item', itemDefId: 'mat-b', itemName: '乙', qty: -3 },
      { type: 'item', itemDefId: 'mat-c', itemName: '丙', qty: Number.NaN },
      { type: 'item', itemDefId: 'mat-d', itemName: '丁', qty: 2 },
    ]);

    expect(text).toBe('物品「丁」×2');
  });
});
