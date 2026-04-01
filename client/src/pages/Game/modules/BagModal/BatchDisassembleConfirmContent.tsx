import type { FC } from 'react';

import type { BatchDisassembleConfirmViewModel } from './batchDisassembleConfirmShared';

/**
 * 批量分解确认内容组件
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染批量分解确认弹窗的摘要与待分解名称列表。
 * 2. 做什么：用同一套结构同时服务桌面端和移动端分解确认，避免两个入口各写一份列表样式。
 * 3. 不做什么：不决定候选物品、不处理确认按钮点击，也不承载任何请求状态。
 *
 * 输入 / 输出：
 * - 输入：`BatchDisassembleConfirmViewModel`，包含标题摘要与已聚合的名称条目。
 * - 输出：确认弹窗 `content` 区域可直接挂载的 React 节点。
 *
 * 数据流 / 状态流：
 * batchCandidates -> `buildBatchDisassembleConfirmViewModel` -> 本组件渲染摘要与列表 -> `modal.confirm` 展示。
 *
 * 复用设计说明：
 * - “即将分解哪些物品”属于稳定的确认展示结构，独立组件后，桌面端与移动端只保留触发和提交逻辑，避免重复 JSX。
 * - 该组件只消费纯数据，不依赖背包状态，后续其它确认入口可直接传入同一 view model 复用。
 *
 * 关键边界条件与坑点：
 * 1. 候选物品较多时列表必须限制最大高度并允许内部滚动，否则确认框会挤压屏幕，影响移动端点击确认。
 * 2. 列表只展示聚合后的名称，不再次展示筛选规则，避免把“如何命中候选”与“确认哪些物品”两类信息混在一起。
 */

interface BatchDisassembleConfirmContentProps {
  viewModel: BatchDisassembleConfirmViewModel;
}

const listContainerStyle = {
  maxHeight: 240,
  overflowY: 'auto' as const,
  padding: 12,
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.04)',
};

const listItemStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '6px 0',
};

const summaryStyle = {
  marginBottom: 12,
  color: 'rgba(255,255,255,0.88)',
};

const hintStyle = {
  marginBottom: 8,
  color: 'rgba(255,255,255,0.65)',
};

const qtyStyle = {
  flexShrink: 0,
  color: 'rgba(255,255,255,0.65)',
};

const BatchDisassembleConfirmContent: FC<BatchDisassembleConfirmContentProps> = ({ viewModel }) => {
  return (
    <div>
      <div style={summaryStyle}>{viewModel.summaryText}</div>
      <div style={hintStyle}>即将分解的物品：</div>
      <div style={listContainerStyle}>
        {viewModel.entries.map((entry) => (
          <div key={entry.name} style={listItemStyle}>
            <span>{entry.name}</span>
            <span style={qtyStyle}>×{entry.qty}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default BatchDisassembleConfirmContent;
