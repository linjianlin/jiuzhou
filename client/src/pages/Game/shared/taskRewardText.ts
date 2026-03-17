/**
 * 任务奖励文本格式化工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一把普通任务/日常周常领取接口返回的奖励结果格式化成系统提示文案，避免 `Game` 与 `TaskModal` 各写一套。
 * 2. 做什么：优先消费后端已经解析好的展示名，杜绝前端在提示里直接露出 `itemDefId` 这类英文 ID。
 * 3. 不做什么：不请求接口、不决定 toast 文案，也不处理主线奖励（主线已有独立 formatter）。
 *
 * 输入/输出：
 * - 输入：`/task/claim` 返回的奖励数组。
 * - 输出：适合直接拼进系统聊天的单行文本。
 *
 * 数据流/状态流：
 * `claimTaskReward` 响应 -> 本文件 -> `Game/index.tsx` / `TaskModal/index.tsx` 系统提示。
 *
 * 关键边界条件与坑点：
 * 1. 奖励项可能为空或数量为 0，此时必须跳过，避免出现“银两 +0”这类噪音提示。
 * 2. 后端若未来新增奖励类型，当前 formatter 只会忽略未识别项；新增展示规则必须集中补在这里，不能回到业务组件内分叉。
 */
import type { ClaimTaskRewardResponse } from '../../../services/api/task-achievement';

type TaskClaimReward = NonNullable<ClaimTaskRewardResponse['data']>['rewards'][number];

export const formatTaskRewardsToText = (
  rewards: TaskClaimReward[] | null | undefined,
): string => {
  const list = Array.isArray(rewards) ? rewards : [];
  const parts: string[] = [];

  for (const reward of list) {
    if (reward.type === 'silver') {
      if (reward.amount > 0) parts.push(`银两 +${reward.amount.toLocaleString()}`);
      continue;
    }

    if (reward.type === 'spirit_stones') {
      if (reward.amount > 0) parts.push(`灵石 +${reward.amount.toLocaleString()}`);
      continue;
    }

    if (reward.type !== 'item') continue;
    const itemDefId = String(reward.itemDefId || '').trim();
    const itemName = String(reward.itemName || '').trim();
    const qty = Math.floor(Number(reward.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const name = itemName || itemDefId;
    if (!name) continue;
    parts.push(`物品「${name}」×${qty.toLocaleString()}`);
  }

  return parts.join('，');
};
