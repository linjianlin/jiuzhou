import type { FC, HTMLAttributes } from 'react';
import './inventoryItemCell.scss';

/**
 * 作用：
 * - 统一背包/仓库/坊市物品格子的 DOM 结构、角标布局与品质着色入口，减少三处重复实现。
 * - 不做什么：不处理业务数据拉取、拖拽规则、上架/存取逻辑，仅负责“单个格子”的展示与交互透传。
 *
 * 输入/输出：
 * - 输入：物品图标、名称、品质类、数量、激活态、锁定/穿戴角标文案，以及原生 div 事件（点击/拖拽/键盘等）。
 * - 输出：统一结构的 React 节点；所有业务事件由外层传入并在根节点触发。
 *
 * 数据流/状态流：
 * - 上游模块（Bag/Warehouse/Market）先完成业务计算 -> 传入 props -> 组件按统一模板渲染。
 * - 组件不持有内部状态，样式状态全部由 props 映射为 class（is-active/is-empty/item-quality--*）。
 *
 * 边界条件与坑点：
 * - 无图标或空格子时，不渲染 icon/name，仅保留占位与交互壳，避免拖拽落点丢失。
 * - 同时出现“穿戴+锁定”时，锁定角标自动下移，避免角标重叠。
 * - 数量小于等于 1 默认不显示角标，避免 1/0 噪声；可通过 showQuantity 强制控制。
 */
export type InventoryItemCellProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  icon?: string | null;
  name?: string;
  qualityClassName?: string;
  quantity?: number;
  showQuantity?: boolean;
  quantityPrefix?: string;
  active?: boolean;
  empty?: boolean;
  lockedLabel?: string;
  equippedLabel?: string;
  showName?: boolean;
  className?: string;
};

const joinClassNames = (...tokens: Array<string | false | null | undefined>): string => {
  return tokens.filter(Boolean).join(' ');
};

export const InventoryItemCell: FC<InventoryItemCellProps> = ({
  icon,
  name,
  qualityClassName,
  quantity,
  showQuantity,
  quantityPrefix = '',
  active = false,
  empty = false,
  lockedLabel,
  equippedLabel,
  showName = true,
  className,
  ...rest
}) => {
  const hasIcon = typeof icon === 'string' && icon.trim().length > 0;
  const hasName = typeof name === 'string' && name.trim().length > 0;
  const normalizedQty = Number.isFinite(quantity) ? Math.max(0, Math.floor(Number(quantity))) : 0;
  const shouldShowQty = showQuantity ?? normalizedQty > 1;
  const shouldShowBody = !empty && hasIcon;

  return (
    <div
      className={joinClassNames(
        'inventory-item-cell',
        qualityClassName,
        active && 'is-active',
        empty && 'is-empty',
        className,
      )}
      {...rest}
    >
      {shouldShowQty ? <div className="inventory-item-cell__qty">{quantityPrefix}{normalizedQty}</div> : null}
      {equippedLabel ? <div className="inventory-item-cell__badge inventory-item-cell__badge--equipped">{equippedLabel}</div> : null}
      {lockedLabel ? (
        <div
          className={joinClassNames(
            'inventory-item-cell__badge',
            'inventory-item-cell__badge--locked',
            equippedLabel && 'is-with-equipped',
          )}
        >
          {lockedLabel}
        </div>
      ) : null}

      {shouldShowBody ? (
        <>
          <img className="inventory-item-cell__icon" src={icon!} alt={hasName ? name : 'item'} />
          {showName && hasName ? <div className="inventory-item-cell__name">{name}</div> : null}
        </>
      ) : (
        <div className="inventory-item-cell__empty" />
      )}
    </div>
  );
};

export default InventoryItemCell;
