/**
 * 云游旧版待选幕次失效回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“旧版缺少三选项结果的 pending 幕次应失效收口”的判定，避免历史脏数据继续阻塞重新生成新的云游。
 * 2. 做什么：用纯函数测试把 active story 与 latest episode 的组合规则固定住，确保只有真正的 legacy pending 才会被收口。
 * 3. 不做什么：不连接数据库，不覆盖完整事务更新流程，也不改变新版三选项幕次的正常阻塞语义。
 *
 * 输入 / 输出：
 * - 输入：当前 active story 状态与最新幕次的关键字段。
 * - 输出：是否应把旧 active story 标记为失效完成。
 *
 * 数据流 / 状态流：
 * - story + latestEpisode -> `shouldInvalidateLegacyPendingStory` -> 布尔结果断言。
 *
 * 复用设计说明：
 * 1. 旧幕次失效规则被收敛成纯函数后，`getOverview`、生成入口与持久化入口都共享同一判断，避免多处手写 legacy 条件。
 * 2. 这里锁定“旧 pending 才失效、有效三选项 pending 继续阻塞”的边界，减少后续状态机漂移。
 *
 * 关键边界条件与坑点：
 * 1. 只有 `status = active` 且最新幕次仍未选择时，旧结构才应该触发失效；已完成故事或无故事不能误伤。
 * 2. 新版合法三选项 pending 幕次必须继续保留等待抉择的行为，不能被这次修复误判成失效。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldBlockGenerationForLatestEpisode,
  shouldInvalidateLegacyPendingStory,
} from '../wander/service.js';

const buildStory = (status: 'active' | 'finished' = 'active') => ({
  status,
});

const buildEpisode = (overrides: Partial<{
  chosen_option_index: number | null;
  option_resolutions: Array<{
    summary: string;
    isEnding: boolean;
    endingType: 'none' | 'good' | 'neutral' | 'tragic' | 'bizarre';
    rewardTitleName: string;
    rewardTitleDesc: string;
    rewardTitleColor: string;
    rewardTitleEffects: Record<string, number>;
  }> | null;
  is_ending: boolean;
}> = {}) => ({
  chosen_option_index: null,
  option_resolutions: null,
  is_ending: false,
  ...overrides,
});

test('shouldInvalidateLegacyPendingStory: active story + 缺少 option_resolutions 的旧 pending 幕次应失效', () => {
  assert.equal(
    shouldInvalidateLegacyPendingStory({
      activeStory: buildStory(),
      latestEpisode: buildEpisode(),
    }),
    true,
  );
});

test('shouldInvalidateLegacyPendingStory: active story + 合法三选项 pending 幕次不应失效', () => {
  assert.equal(
    shouldInvalidateLegacyPendingStory({
      activeStory: buildStory(),
      latestEpisode: buildEpisode({
        option_resolutions: [
          {
            summary: '向东远行',
            isEnding: false,
            endingType: 'none',
            rewardTitleName: '',
            rewardTitleDesc: '',
            rewardTitleColor: '',
            rewardTitleEffects: {},
          },
          {
            summary: '停驻山门',
            isEnding: false,
            endingType: 'none',
            rewardTitleName: '',
            rewardTitleDesc: '',
            rewardTitleColor: '',
            rewardTitleEffects: {},
          },
          {
            summary: '拜访旧友',
            isEnding: false,
            endingType: 'none',
            rewardTitleName: '',
            rewardTitleDesc: '',
            rewardTitleColor: '',
            rewardTitleEffects: {},
          },
        ],
      }),
    }),
    false,
  );
});

test('shouldInvalidateLegacyPendingStory: 非 active 故事不应再触发失效', () => {
  assert.equal(
    shouldInvalidateLegacyPendingStory({
      activeStory: buildStory('finished'),
      latestEpisode: buildEpisode(),
    }),
    false,
  );
});

test('shouldInvalidateLegacyPendingStory: 已选择幕次不应触发失效', () => {
  assert.equal(
    shouldInvalidateLegacyPendingStory({
      activeStory: buildStory(),
      latestEpisode: buildEpisode({ chosen_option_index: 1 }),
    }),
    false,
  );
});

test('shouldBlockGenerationForLatestEpisode: 合法三选项 pending 幕次应继续阻塞新生成', () => {
  assert.equal(
    shouldBlockGenerationForLatestEpisode(
      buildEpisode({
        option_resolutions: [
          {
            summary: '向东远行',
            isEnding: false,
            endingType: 'none',
            rewardTitleName: '',
            rewardTitleDesc: '',
            rewardTitleColor: '',
            rewardTitleEffects: {},
          },
          {
            summary: '停驻山门',
            isEnding: false,
            endingType: 'none',
            rewardTitleName: '',
            rewardTitleDesc: '',
            rewardTitleColor: '',
            rewardTitleEffects: {},
          },
          {
            summary: '拜访旧友',
            isEnding: false,
            endingType: 'none',
            rewardTitleName: '',
            rewardTitleDesc: '',
            rewardTitleColor: '',
            rewardTitleEffects: {},
          },
        ],
      }),
    ),
    true,
  );
});

test('shouldBlockGenerationForLatestEpisode: legacy pending 幕次不应再阻塞新生成', () => {
  assert.equal(shouldBlockGenerationForLatestEpisode(buildEpisode()), false);
});
