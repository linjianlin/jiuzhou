/**
 * BattleArea 阵营面板组件
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：收口单个阵营的网格布局、容器尺寸观测与单位卡片列表渲染，避免敌方/我方两段 JSX 重复维护同一套结构。
 * - 做什么：在容器宽度变化时重新推导 2 行 5 列布局，使战场卡片能按尺寸档位自适应缩放。
 * - 不做什么：不持有战斗业务状态，不直接修改 BattleArea 的选中目标，只把点击事件抛回上层。
 *
 * 输入/输出：
 * - 输入：阵营类型、单位列表、空态文案、当前行动/选中单位 ID、浮字映射、点击回调。
 * - 输出：单个阵营的 `<section>` 面板。
 *
 * 数据流/状态流：
 * - BattleArea 传入单位与选中状态
 * - 本组件通过 ResizeObserver 读取内容区宽度
 * - 宽高 + 实际渲染列数 + 实际占列数 -> battleFieldLayout -> BattleUnitCard 列表
 *
 * 关键边界条件与坑点：
 * 1. 容器宽度观测必须绑定到面板内容区而不是 window，只有这样左右布局变化、抽屉开合等局部尺寸变化才会触发正确重排。
 * 2. 空面板也要保留同一个 section 结构，避免战斗切换时 DOM 层级抖动导致滚动位置和视觉过渡不稳定。
 */

import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BattleUnitCard } from './BattleUnitCard';
import { resolveBattleFieldFormation } from './battleFieldFormation';
import { resolveBattleFieldLayout } from './battleFieldLayout';
import type { BattleFloatText, BattleUnit } from './types';

type BattleTeamSide = 'enemy' | 'ally';

interface BattleTeamPanelProps {
  team: BattleTeamSide;
  units: BattleUnit[];
  emptyText: string;
  showAvatarBackground: boolean;
  activeUnitId: string | null;
  selectedUnitId: string | null;
  floatsByUnit: Record<string, BattleFloatText[]>;
  onToggleUnit: (unitId: string) => void;
}

export const BattleTeamPanel: React.FC<BattleTeamPanelProps> = memo(({
  team,
  units,
  emptyText,
  showAvatarBackground,
  activeUnitId,
  selectedUnitId,
  floatsByUnit,
  onToggleUnit,
}) => {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) return;

    const update = () => {
      const nextWidth = Math.floor(element.clientWidth);
      const nextHeight = Math.floor(element.clientHeight);
      setContainerSize((prev) => (
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight }
      ));
    };

    update();

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  const layout = useMemo(
    () => {
      const formation = resolveBattleFieldFormation(team, units);
      return {
        formation,
        layout: resolveBattleFieldLayout({
          unitCount: formation.renderCells.length,
          occupiedColumnCount: formation.occupiedColumnCount,
          containerWidth: containerSize.width,
          containerHeight: containerSize.height,
          columns: formation.renderColumns,
          rows: formation.rows,
        }),
      };
    },
    [containerSize.height, containerSize.width, team, units],
  );

  return (
    <section className={`battle-panel battle-panel-${team}`}>
      <div ref={innerRef} className="battle-panel-inner">
        <div
          className={`battle-units battle-units-${layout.layout.size} ${layout.layout.showStatusRow ? 'has-status-row' : 'without-status-row'}`}
          style={{
            '--battle-team-columns': String(layout.formation.renderColumns),
            '--battle-team-rows': String(layout.formation.rows),
            '--battle-card-scale': String(layout.layout.cardScale),
          } as CSSProperties}
        >
          {layout.formation.renderCells.map((unit, index) => (
            unit ? (
              <BattleUnitCard
                key={unit.id}
                unit={unit}
                team={team}
                size={layout.layout.size}
                showAvatarBackground={showAvatarBackground}
                showStatusRow={layout.layout.showStatusRow}
                statusTagLimit={layout.layout.statusTagLimit}
                active={activeUnitId === unit.id}
                selected={selectedUnitId === unit.id}
                floats={floatsByUnit[unit.id]}
                onToggleUnit={onToggleUnit}
              />
            ) : (
              <div key={`battle-slot-empty-${team}-${index}`} className="battle-unit-slot-empty" aria-hidden="true" />
            )
          ))}
          {units.length === 0 ? <div className="battle-empty">{emptyText}</div> : null}
        </div>
      </div>
    </section>
  );
});
