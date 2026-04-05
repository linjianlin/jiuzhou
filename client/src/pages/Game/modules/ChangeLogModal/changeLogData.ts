/**
 * 更新日志静态数据源。
 *
 * 作用：
 * 1. 集中维护游戏版本、发布日期与更新条目 HTML 片段，作为“更新日志”页面的唯一内容入口。
 * 2. 只负责描述静态内容，不处理版本排序、默认选中、统计汇总或界面展示逻辑。
 * 3. 不做什么：不发请求、不读运行时状态，也不混入 React 组件或样式结构。
 *
 * 输入 / 输出：
 * - 输入：无，模块内直接声明受控的前端静态数据。
 * - 输出：`CHANGE_LOG_ENTRIES` 与相关类型，供共享派生层统一整理成视图模型。
 *
 * 数据流 / 状态流：
 * 静态版本数据 -> `changeLogShared.ts` 派生排序与摘要 -> `ChangeLogModal` 渲染版本列表与详情。
 *
 * 复用设计说明：
 * 1. 版本内容独立于 UI 组件，后续只补数据即可更新页面，避免每次改日志都进入 JSX 修改。
 * 2. 详情结构统一为 HTML 字符串数组后，列表摘要和正文都能消费同一份源数据，不会再维护多层分组映射。
 * 3. 高变化点是“版本内容本身”，因此集中放在数据文件中，减少和布局代码的耦合。
 *
 * 关键边界条件与坑点：
 * 1. `releasedAt` 必须全局唯一且可解析，否则会破坏列表选中态与排序结果。
 * 2. 更新条目只允许维护受控 HTML 字符串，且来源必须是当前仓库内的静态数据，不能接用户输入。
 */

export interface ChangeLogEntrySource {
  releasedAt: string;
  sections: readonly string[];
}

export const CHANGE_LOG_ENTRIES: readonly ChangeLogEntrySource[] = [
  {
    releasedAt: '2026-04-05',
    sections: [
      '洞府研修模型调整，停用 KIMI 2.5、Grok 4.20 Beta，目前暂时仅剩 Gemini 3.1 Pro',
      '<div class="my-4 border-t border-gray-200 dark:border-gray-700"></div>',
      '优化成就界面，称号单独成一个菜单项展示，增加称号搜索功能',
      '优化伙伴列表界面，按品阶分组显示',
      '<div class="my-4 border-t border-gray-200 dark:border-gray-700"></div>',
      '修复部分任务无法完成的异常问题',
      '升级云游奇遇功能，增加概率带入活跃玩家的情况',
      '下调洞府研修的功法残页消耗',
      '<div class="my-4 border-t border-gray-200 dark:border-gray-700"></div>',
      '开放证道期相关内容',
      '洞府研修模型调整，停用 GPT 5.4、Claude Opus 4.6、GLM 5 Turbo',
      '所有装备基础物攻、法攻数值翻倍',
      '<div class="text-red-500">针对近期产出的血量百分比倍率技能后续将会进行适当的调整</div> ',
    ],
  },
];
