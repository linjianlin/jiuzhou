/**
 * 云游旧幕次数据兼容回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定旧版 `option_texts` 在服务层归一化后的输出，避免概览读取历史云游记录时再次因为结构不一致触发 500。
 * 2. 做什么：把单字符串、旧对象、容器对象这几类历史形态统一压到同一个纯函数入口，保证 DTO 组装与选项读取共用同一套兼容规则。
 * 3. 不做什么：不连接数据库，不覆盖完整 `getOverview` 或 `chooseEpisode` 事务流程，也不测试 AI 生成新结构。
 *
 * 输入 / 输出：
 * - 输入：模拟的旧版 `option_texts` 历史结构。
 * - 输出：当前服务层可稳定消费的选项文本数组。
 *
 * 数据流 / 状态流：
 * - 历史幕次原始字段 -> `normalizeEpisodeOptionTexts` -> 断言输出数组内容。
 *
 * 复用设计说明：
 * 1. 旧数据兼容被收敛到 `wander/service.ts` 的纯函数入口后，概览 DTO 组装与选项确认都直接复用，避免两个调用点各写一套兜底。
 * 2. `option_texts` 是历史数据升级后的高频变更点，把回归测试放在这里可以直接锁住服务层读取兼容，不依赖更重的集成环境。
 *
 * 关键边界条件与坑点：
 * 1. 历史数据可能不是数组，而是单字符串或单对象；这类情况必须降级成单项数组，而不是抛异常。
 * 2. 混合数组里可能带空白项或缺字段对象；归一化后必须剔除空值，避免前端展示空按钮。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEpisodeOptionTexts } from '../wander/service.js';

test('normalizeEpisodeOptionTexts: 单字符串旧数据应归一化为单项数组', () => {
  assert.deepEqual(normalizeEpisodeOptionTexts('  独自离山  '), ['独自离山']);
});

test('normalizeEpisodeOptionTexts: 旧对象形态应提取可展示文本', () => {
  assert.deepEqual(normalizeEpisodeOptionTexts({ text: ' 与故人同游 ' }), ['与故人同游']);
  assert.deepEqual(normalizeEpisodeOptionTexts({ label: '静观云海' }), ['静观云海']);
});

test('normalizeEpisodeOptionTexts: 容器对象中的历史 options 数组应被统一展开', () => {
  assert.deepEqual(
    normalizeEpisodeOptionTexts({
      options: [
        '折返宗门',
        { text: '留在山巅' },
        { label: '继续远行' },
      ],
    }),
    ['折返宗门', '留在山巅', '继续远行'],
  );
});

test('normalizeEpisodeOptionTexts: 空白项与无效对象应被过滤，避免生成空选项', () => {
  assert.deepEqual(
    normalizeEpisodeOptionTexts({
      options: [
        '  ',
        { text: '向北而行' },
        { label: '' },
        { option: '拜访旧友' },
        { value: null },
      ],
    }),
    ['向北而行', '拜访旧友'],
  );
});
