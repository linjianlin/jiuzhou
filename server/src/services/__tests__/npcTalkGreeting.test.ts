/**
 * npcTalkGreeting 开场文案回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 NPC 弹窗首屏文案必须跟当前主线阶段一致，避免未来任务台词提前剧透。
 * 2. 做什么：验证当前主线命中同一 NPC 时，会优先读取该任务节的主线对白，而不是复用静态 talk tree。
 * 3. 不做什么：不访问数据库，不验证 NPC 按钮状态，也不覆盖完整主线推进流程。
 *
 * 输入/输出：
 * - 输入：NPC 标识、当前主线任务节与阶段、以及 talk tree greeting 文案。
 * - 输出：`resolveNpcTalkGreetingLines` 返回的首屏文案数组。
 *
 * 数据流/状态流：
 * 测试直接调用共享解析函数
 * -> 函数读取静态主线/对白配置
 * -> 返回 NPC 弹窗应展示的首屏文案
 * -> 断言文案是否与当前任务节一致。
 *
 * 关键边界条件与坑点：
 * 1. 第一节主线对白以 narration 开场，测试必须确保解析函数会跳过旁白，找到首个 NPC 节点。
 * 2. 村长这种多次参与主线的 NPC，最容易把第二节文案泄露到第一节场景，所以需要单独锁住“未来任务必须静音”。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNpcTalkGreetingLines } from '../shared/npcTalkGreeting.js';

test('resolveNpcTalkGreetingLines: 当前主线未轮到该 NPC 时，不应泄露未来任务 greeting', () => {
  const result = resolveNpcTalkGreetingLines({
    npcId: 'npc-village-elder',
    currentSectionId: 'main-1-001',
    currentSectionStatus: 'objectives',
    talkTreeLines: [
      '你来了。青云村虽小，却也暗流涌动。',
      '若想在这世道立足，先练胆，再练心。',
    ],
  });

  assert.deepEqual(result, []);
});

test('resolveNpcTalkGreetingLines: 当前主线命中引路童子时，应跳过旁白并展示首条 NPC 对白', () => {
  const result = resolveNpcTalkGreetingLines({
    npcId: 'npc-guide',
    currentSectionId: 'main-1-001',
    currentSectionStatus: 'not_started',
    talkTreeLines: [
      '欢迎来到青云村！修行之路漫漫，先从认识这里开始吧。',
      '你若有疑问，尽管问我。',
    ],
  });

  assert.deepEqual(result, [
    '欢迎来到青云村！修行之路漫漫，先从认识这里开始吧。\n（童子热情地指向北方）\n村中广场在北边，村长大人就在那里。\n你若有疑问，尽管问我。',
  ]);
});

test('resolveNpcTalkGreetingLines: 当前主线命中村长时，应展示当前任务节对白而不是第二节固定 greeting', () => {
  const result = resolveNpcTalkGreetingLines({
    npcId: 'npc-village-elder',
    currentSectionId: 'main-1-003',
    currentSectionStatus: 'objectives',
    talkTreeLines: [
      '你来了。青云村虽小，却也暗流涌动。',
      '若想在这世道立足，先练胆，再练心。',
    ],
  });

  assert.deepEqual(result, [
    '不错，看来你有些天赋。\n最近林中空地出现了野猪，比野兔凶猛得多。\n有村民被它们伤到了，你能去处理一下吗？',
  ]);
});
