import type { FC } from 'react';
import type { MarketEquipmentSummaryItem } from './marketEquipmentSummary';

/**
 * 作用：
 * - 统一渲染坊市列表里的装备成长摘要标签，避免桌面列表与移动端卡片重复维护同一段 DOM 结构。
 * - 不做什么：不生成业务文案、不判断装备类型，只负责把上游已经整理好的摘要项渲染成统一样式。
 *
 * 输入/输出：
 * - 输入：`items` 摘要项数组，以及可选 `className`。
 * - 输出：可直接插入坊市列表的标签容器；无摘要项时返回 `null`。
 *
 * 数据流/状态流：
 * - `MarketModal` 先调用 `buildMarketEquipmentSummary`。
 * - 本组件只消费摘要项数组并输出统一的标签结构。
 *
 * 边界条件与坑点：
 * 1. 空数组直接不渲染，保证非装备物品布局不被撑开。
 * 2. `key` 与 `text` 均来自共享摘要工具，渲染层不再重复拼装字符串，避免桌面/移动端文案漂移。
 */

type MarketEquipmentSummaryProps = {
  items: MarketEquipmentSummaryItem[];
  className?: string;
};

const MarketEquipmentSummary: FC<MarketEquipmentSummaryProps> = ({
  items,
  className = 'market-equipment-summary',
}) => {
  if (items.length <= 0) {
    return null;
  }

  return (
    <div className={className}>
      {items.map((item) => (
        <span key={item.key} className="market-equipment-summary__item">
          {item.text}
        </span>
      ))}
    </div>
  );
};

export default MarketEquipmentSummary;
