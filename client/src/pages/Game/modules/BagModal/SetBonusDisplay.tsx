import type { SetInfo } from './bagShared';
import './setBonusDisplay.scss';

/**
 * 作用：将套装效果重构为“分档效果卡片”视图，快速表达当前激活状态。
 * 不做什么：不做套装规则计算，激活状态仍完全依赖 setInfo.bonuses[].active。
 * 输入/输出：输入 SetInfo 与 variant，输出可直接嵌入详情面板的套装展示 UI。
 * 数据流/状态流：setInfo -> 组件内部排序与进度计算 -> 无状态渲染。
 * 边界条件与坑点：
 * 1) pieceCount 可能不是连续值，进度节点按真实阈值渲染，不能假定 2/4/6/8 固定档位。
 * 2) pieceCount 可能重复或无序，渲染前统一排序，避免展示顺序跳动。
 */

type SetBonusDisplayVariant = 'desktop' | 'mobile';

interface SetBonusDisplayProps {
  setInfo: SetInfo;
  variant: SetBonusDisplayVariant;
  className?: string;
}

const joinClassNames = (...parts: Array<string | null | undefined | false>): string => {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
};

export const SetBonusDisplay: React.FC<SetBonusDisplayProps> = ({ setInfo, variant, className }) => {
  if (setInfo.bonuses.length <= 0) return null;

  const bonuses = [...setInfo.bonuses].sort((a, b) => a.pieceCount - b.pieceCount);
  const maxPiece = bonuses[bonuses.length - 1]?.pieceCount ?? 0;

  return (
    <div className={joinClassNames('set-bonus-board', `set-bonus-board--${variant}`, className)}>
      <div className="set-bonus-board-head">
        <div className="set-bonus-board-name">{setInfo.setName}</div>
        <div className="set-bonus-board-count">{setInfo.equippedCount} / {maxPiece}</div>
      </div>

      <div className="set-bonus-stage-list">
        {bonuses.map((bonus) => (
          <div
            key={`${bonus.pieceCount}-${bonus.lines.join('|')}`}
            className={joinClassNames('set-bonus-stage', bonus.active ? 'is-active' : 'is-inactive')}
          >
            <div className="set-bonus-stage-head">
              <span className="set-bonus-stage-piece">{bonus.pieceCount} 件效果</span>
              <span className="set-bonus-stage-state">{bonus.active ? '已激活' : '未激活'}</span>
            </div>
            <div className="set-bonus-stage-lines">
              {bonus.lines.map((line, idx) => (
                <div key={`${bonus.pieceCount}-${idx}-${line}`} className="set-bonus-stage-line">{line}</div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
