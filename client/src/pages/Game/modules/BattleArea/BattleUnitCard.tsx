/**
 * BattleArea 单位卡片组件
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：封装战斗单位框体、血灵条、浮字和状态标签，让敌我双方都复用同一张卡片结构。
 * - 做什么：根据外部传入的尺寸档位切换卡片密度，保证 1~10 单位时都能用同一套组件完成展示。
 * - 不做什么：不管理战斗状态同步，不决定网格列数，也不处理选中目标之外的业务逻辑。
 *
 * 输入/输出：
 * - 输入：单位数据、所属阵营、尺寸档位、选中/行动态、浮字列表、点击回调。
 * - 输出：可直接挂入战场网格的 React 节点。
 *
 * 数据流/状态流：
 * - BattleArea / BattleTeamPanel 提供单位与布局结果
 * - 本组件内部只做展示层格式化
 * - 点击事件回抛给 BattleArea 改写选中目标
 *
 * 关键边界条件与坑点：
 * 1. Buff 标签显示开关必须由布局层控制，卡片自身不能私自再做一套“空间够不够”的判断，否则敌我两边会出现口径漂移。
 * 2. 死亡单位仍需保留卡片占位，否则 2 行 5 列阵型会在战斗过程中不断跳动，影响目标选择和视觉稳定性。
 */

import { memo, type CSSProperties } from 'react';
import PlayerName from '../../shared/PlayerName';
import { resolveBattleUnitBackgroundImage } from './battleUnitBackground';
import type { BattleFieldCardSize } from './battleFieldLayout';
import { resolveBattleUnitStatusTags } from './battleUnitStatusTags';
import type { BattleFloatText, BattleUnit } from './types';

type BattleTeamSide = 'enemy' | 'ally';

interface BattleUnitCardProps {
  unit: BattleUnit;
  team: BattleTeamSide;
  size: BattleFieldCardSize;
  showAvatarBackground: boolean;
  showStatusRow: boolean;
  statusTagLimit: number;
  active?: boolean;
  floats?: BattleFloatText[];
  selected?: boolean;
  onToggleUnit: (unitId: string) => void;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const toPercent = (value: number, total: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
};

const StatBar: React.FC<{
  value: number;
  total: number;
  tone: 'hp' | 'qi';
}> = ({ value, total, tone }) => {
  const percent = toPercent(value, total);
  return (
    <div className={`battle-bar battle-bar-${tone}`}>
      <div className="battle-bar-track">
        <div className="battle-bar-fill" style={{ width: `${percent}%` }} />
        <span className="battle-bar-value battle-bar-value-overlay">
          {Math.max(0, Math.floor(value))}
        </span>
      </div>
    </div>
  );
};

export const BattleUnitCard: React.FC<BattleUnitCardProps> = memo(({
  unit,
  team,
  size,
  showAvatarBackground,
  showStatusRow,
  statusTagLimit,
  active,
  floats,
  selected,
  onToggleUnit,
}) => {
  const dead = (Number(unit.hp) || 0) <= 0;
  const statusTags = resolveBattleUnitStatusTags(unit.buffs, statusTagLimit);
  const backgroundImage = resolveBattleUnitBackgroundImage(unit, showAvatarBackground);
  const handleToggleUnit = () => {
    onToggleUnit(unit.id);
  };

  return (
    <div
      className={`battle-unit-card size-${size} ${backgroundImage ? 'has-avatar-background' : ''} ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${dead ? 'dead' : ''}`}
      data-team={team}
      data-unit-type={unit.unitType}
      role="button"
      tabIndex={0}
      onClick={handleToggleUnit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handleToggleUnit();
      }}
    >
      {backgroundImage ? (
        <div className="battle-unit-avatar-background" aria-hidden="true">
          <img className="battle-unit-avatar-image" src={backgroundImage} alt="" />
        </div>
      ) : null}

      <div className="battle-floats">
        {(floats ?? []).map((floatText) => (
          <div
            key={floatText.id}
            className={`battle-float ${floatText.value < 0 ? 'neg' : 'pos'}`}
            style={{ '--dx': `${floatText.dx}px` } as CSSProperties}
          >
            {floatText.value < 0 ? `${floatText.value}` : `+${floatText.value}`}
          </div>
        ))}
      </div>

      <div className="battle-unit-frame">
        <div className="battle-unit-head">
          <div className="battle-unit-title">
            <div className="battle-unit-name">
              <PlayerName
                name={unit.name}
                monthCardActive={unit.monthCardActive}
                ellipsis
              />
            </div>
          </div>
        </div>

        {showStatusRow && statusTags.length > 0 ? (
          <div className="battle-unit-status-row">
            {statusTags.map((tag) => (
              <span
                key={tag.id}
                className={`battle-unit-status-tag tone-${tag.tone}`}
                title={tag.label}
              >
                {tag.label}
              </span>
            ))}
          </div>
        ) : null}

        <div className="battle-unit-bars">
          <StatBar value={unit.hp} total={unit.maxHp} tone="hp" />
          <StatBar value={unit.qi} total={unit.maxQi} tone="qi" />
        </div>
      </div>
    </div>
  );
});
