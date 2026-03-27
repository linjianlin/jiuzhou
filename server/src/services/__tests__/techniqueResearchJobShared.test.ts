/**
 * 研修任务共享状态映射测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证研修任务从数据库行映射到前端可用状态时，未查看红点与结果态语义稳定。
 * 2. 不做什么：不覆盖数据库查询、worker 执行和路由层，只验证共享纯函数规则。
 *
 * 输入/输出：
 * - 输入：任务状态、查看时间、草稿预览等原始字段。
 * - 输出：`buildTechniqueResearchJobState` 返回的 `hasUnreadResult`、`resultStatus` 与 `currentJob`。
 *
 * 数据流/状态流：
 * 原始任务行 -> 共享状态映射函数 -> 研修面板/主界面红点统一消费。
 *
 * 关键边界条件与坑点：
 * 1. `refunded` 虽然不是生成成功，但对前端而言仍应归为“失败结果待查看”，避免玩家无感知。
 * 2. `pending` 永远不亮红点，否则会把“生成中”误判为“有结果待处理”。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTechniqueResearchJobState,
  type TechniqueResearchJobStateInput,
} from '../shared/techniqueResearchJobShared.js';

const buildInput = (
  overrides: Partial<TechniqueResearchJobStateInput> = {},
): TechniqueResearchJobStateInput => ({
  generationId: 'gen-1',
  status: 'pending',
  quality: '玄',
  modelName: null,
  burningWordPrompt: null,
  draftTechniqueId: null,
  draftExpireAt: null,
  startedAt: '2026-03-07T10:00:00.000Z',
  finishedAt: null,
  viewedAt: null,
  failedViewedAt: null,
  errorMessage: null,
  preview: null,
  ...overrides,
});

test('generated_draft 且未查看时应返回成功结果红点', () => {
  const state = buildTechniqueResearchJobState(
    buildInput({
      status: 'generated_draft',
      modelName: 'gpt-4o-mini',
      burningWordPrompt: '焰',
      draftTechniqueId: 'tech-gen-1',
      finishedAt: '2026-03-07T10:01:00.000Z',
      preview: {
        draftTechniqueId: 'tech-gen-1',
        aiSuggestedName: '玄霜剑典',
        quality: '玄',
        type: '武技',
        maxLayer: 5,
        description: '凝霜化锋，先守后攻。',
        longDesc: '长描述',
        skillNames: [],
        skills: [],
      },
    }),
  );

  assert.equal(state.hasUnreadResult, true);
  assert.equal(state.resultStatus, 'generated_draft');
  assert.equal(state.currentJob?.preview?.aiSuggestedName, '玄霜剑典');
  assert.equal(state.currentJob?.modelName, 'gpt-4o-mini');
  assert.equal(state.currentJob?.burningWordPrompt, '焰');
});

test('generated_draft 已查看后不应继续亮红点', () => {
  const state = buildTechniqueResearchJobState(
    buildInput({
      status: 'generated_draft',
      viewedAt: '2026-03-07T10:02:00.000Z',
      draftTechniqueId: 'tech-gen-1',
      finishedAt: '2026-03-07T10:01:00.000Z',
      preview: {
        draftTechniqueId: 'tech-gen-1',
        aiSuggestedName: '玄霜剑典',
        quality: '玄',
        type: '武技',
        maxLayer: 5,
        description: '凝霜化锋，先守后攻。',
        longDesc: '长描述',
        skillNames: [],
        skills: [],
      },
    }),
  );

  assert.equal(state.hasUnreadResult, false);
  assert.equal(state.resultStatus, 'generated_draft');
});

test('failed 未查看时应映射为失败结果红点', () => {
  const state = buildTechniqueResearchJobState(
    buildInput({
      status: 'failed',
      finishedAt: '2026-03-07T10:01:00.000Z',
      errorMessage: 'AI 生成异常，已自动退款',
    }),
  );

  assert.equal(state.hasUnreadResult, true);
  assert.equal(state.resultStatus, 'failed');
  assert.equal(state.currentJob?.errorMessage, 'AI 生成异常，已自动退款');
});

test('refunded 未查看时也应视为失败结果待查看', () => {
  const state = buildTechniqueResearchJobState(
    buildInput({
      status: 'refunded',
      finishedAt: '2026-03-07T10:01:00.000Z',
      errorMessage: '草稿已过期，系统自动退款',
    }),
  );

  assert.equal(state.hasUnreadResult, true);
  assert.equal(state.resultStatus, 'failed');
});

test('pending 仅表示生成中，不应亮红点', () => {
  const state = buildTechniqueResearchJobState(buildInput());

  assert.equal(state.hasUnreadResult, false);
  assert.equal(state.resultStatus, null);
  assert.equal(state.currentJob?.status, 'pending');
});
