import type { WanderStoryDto } from '../../../../services/api';

/**
 * 云游故事阅读流视图模型
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把 `WanderStoryDto` 收敛成“引子 + 分幕正文 + 抉择尾句 + 选择后收束”的连续阅读结构，供故事回顾区直接渲染。
 * 2. 做什么：集中维护每幕正文尾句与收束段显示规则，避免 JSX、测试或后续复用入口各自手写一遍文案拼装。
 * 3. 不做什么：不改写后端返回内容，不推导冷却状态，也不决定视觉样式。
 *
 * 输入 / 输出：
 * - 输入：单个 `WanderStoryDto`。
 * - 输出：稳定的故事阅读流对象，包含故事引子与按幕排序的正文条目。
 *
 * 数据流 / 状态流：
 * - `WanderModal` 读取 `storyForHistory`
 * - 本模块把 story 转成阅读流
 * - 弹窗只消费阅读流字段完成渲染，不再在 render 期重复拼接正文尾句
 *
 * 复用设计说明：
 * 1. 故事回顾后续如果要在首页、称号详情或日志页复用同一套“小说式正文”展示，只需要复用这个纯函数，不必复制拼接规则。
 * 2. 高变更点集中在这里：一旦抉择文案、章节标签或终幕标记变化，只改一个模块即可，避免展示层多处维护。
 *
 * 关键边界条件与坑点：
 * 1. 未选择的幕次不能伪造结果，必须明确输出“尚未作出抉择”的状态文案，避免把剧情写死。
 * 2. 阅读流正文必须优先使用 `opening`；`summary` 只能作为选择后的余波/尾声补段，不能反客为主替代正文。
 */

export interface WanderStoryReaderEntry {
  key: string;
  chapterLabel: string;
  title: string;
  content: string;
  choiceLine: string;
  aftermath: string | null;
  isEnding: boolean;
  isChoicePending: boolean;
}

export interface WanderStoryReaderModel {
  premise: string;
  entries: WanderStoryReaderEntry[];
}

const buildWanderStoryAftermath = (params: {
  summary: string;
  isChoicePending: boolean;
}): string | null => {
  const summary = params.summary.trim();
  if (params.isChoicePending || !summary) {
    return null;
  }

  return summary;
};

export const buildWanderStoryReaderModel = (story: WanderStoryDto): WanderStoryReaderModel => {
  return {
    premise: story.premise,
    entries: story.episodes.map((episode) => {
      const isChoicePending = episode.chosenOptionText === null;
      const aftermath = buildWanderStoryAftermath({
        summary: episode.summary,
        isChoicePending,
      });

      return {
        key: episode.id,
        chapterLabel: `第 ${episode.dayIndex} 幕`,
        title: episode.title,
        content: episode.opening,
        choiceLine: episode.chosenOptionText
          ? `你在此处选择了「${episode.chosenOptionText}」。`
          : '此幕抉择尚未落定。',
        aftermath,
        isEnding: episode.isEnding,
        isChoicePending,
      };
    }),
  };
};
