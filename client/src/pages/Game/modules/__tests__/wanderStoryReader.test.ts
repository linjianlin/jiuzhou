/**
 * 云游故事阅读流收束段测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定故事回顾中“尾声/余波”只在玩家已作出选择后展示，避免未选幕次被提前写成结果。
 * 2. 做什么：验证收束段只保留正文，不再额外渲染标签，保证阅读流层级稳定。
 * 3. 不做什么：不挂载 React 组件，不校验样式，也不覆盖接口请求流程。
 *
 * 输入 / 输出：
 * - 输入：构造的 `WanderStoryDto`。
 * - 输出：`buildWanderStoryReaderModel` 的阅读流条目。
 *
 * 数据流 / 状态流：
 * - 测试故事 DTO -> `buildWanderStoryReaderModel` -> 断言条目的选择尾句与收束字段。
 *
 * 复用设计说明：
 * - 尾声显示规则集中在 `storyReader` 纯函数，这里直接命中唯一入口，能避免 JSX 结构变动导致规则失锁。
 * - 后续若再调整终幕文案或余波标签，只需要同步这一个测试入口。
 *
 * 关键边界条件与坑点：
 * 1. 未选择幕次即使 summary 非空，也不能渲染收束段，否则会把玩家未确认的结果提前泄露。
 * 2. 收束段已经去掉额外标签，因此测试必须直接锁定正文存在性，而不是再依赖标签文案。
 */
import { describe, expect, it } from 'vitest';
import type { WanderStoryDto } from '../../../../services/api';
import { buildWanderStoryReaderModel } from '../WanderModal/storyReader';

const buildStory = (): WanderStoryDto => ({
  id: 'wander-story-1',
  status: 'active',
  theme: '雨夜借灯',
  premise: '你在夜雨中误入断桥旧祠，桥上桥下皆有异动。',
  summary: '',
  episodeCount: 2,
  rewardTitleId: null,
  finishedAt: null,
  createdAt: '2026-04-02T00:00:00.000Z',
  updatedAt: '2026-04-02T00:00:00.000Z',
  episodes: [
    {
      id: 'wander-episode-1',
      dayKey: '2026-04-02',
      dayIndex: 1,
      title: '桥下窥影',
      opening: '夜雨压桥，你在破庙檐下收住衣角，却见桥下暗潮与对岸灯影同时逼近。',
      options: [
        { index: 0, text: '先借檐避雨，再试探来意' },
        { index: 1, text: '绕到桥下暗查灵息' },
        { index: 2, text: '收敛气机，静观其变' },
      ],
      chosenOptionIndex: 0,
      chosenOptionText: '先借檐避雨，再试探来意',
      summary: '你先稳住桥上气机，逼得来客先开口，却也惊动了桥下潜伏的异物。',
      isEnding: false,
      endingType: 'none',
      rewardTitleName: null,
      rewardTitleDesc: null,
      createdAt: '2026-04-02T00:00:00.000Z',
      chosenAt: '2026-04-02T00:05:00.000Z',
    },
    {
      id: 'wander-episode-2',
      dayKey: '2026-04-03',
      dayIndex: 2,
      title: '断桥定局',
      opening: '桥身欲裂，旧祠阴火映得河面幽蓝，最终抉择已压到你面前。',
      options: [
        { index: 0, text: '引桥下异物冲向来客' },
        { index: 1, text: '先斩来客，再回身镇桥' },
        { index: 2, text: '以神识借祠火反压双方' },
      ],
      chosenOptionIndex: null,
      chosenOptionText: null,
      summary: '这一段 summary 不应在未选择前提前展示。',
      isEnding: true,
      endingType: 'none',
      rewardTitleName: null,
      rewardTitleDesc: null,
      createdAt: '2026-04-03T00:00:00.000Z',
      chosenAt: null,
    },
  ],
});

describe('buildWanderStoryReaderModel', () => {
  it('已选择幕次应展示收束正文，未选择幕次不应提前展示尾声', () => {
    const model = buildWanderStoryReaderModel(buildStory());

    expect(model.entries[0].aftermath).toContain('逼得来客先开口');
    expect(model.entries[1].aftermath).toBeNull();
  });

  it('已选择终幕也应只保留收束正文本身', () => {
    const story = buildStory();
    story.episodes[1] = {
      ...story.episodes[1],
      chosenOptionIndex: 1,
      chosenOptionText: '先斩来客，再回身镇桥',
      summary: '你先斩断来客借桥引动的邪法，再回身镇住桥下暗潮，雨夜因而收束成一段险极而成的缘法。',
      endingType: 'good',
      rewardTitleName: '断桥镇潮',
      rewardTitleDesc: '断桥一战后，余威仍镇河潮。',
    };

    const model = buildWanderStoryReaderModel(story);

    expect(model.entries[1].aftermath).toContain('雨夜因而收束');
  });
});
