import { EquipmentAffixTagRow } from '../../shared/EquipmentAffixTooltipList';
import type { EquipmentDetailLine } from './bagShared';
import './equipmentDetailAttrList.scss';

/**
 * 作用：以“分组信息面板”渲染装备属性，统一桌面/移动端结构并提升信息扫描效率。
 * 不做什么：不做业务计算、不改词条/宝石来源数据，仅消费 buildEquipmentDetailLines 的结构化结果。
 * 输入/输出：输入 EquipmentDetailLine[] + variant，输出可直接挂载在详情区域的属性分组 UI。
 * 数据流/状态流：BagModal 数据层产出 lines -> 本组件按 kind 聚合 -> 渲染无状态视图。
 * 边界条件与坑点：
 * 1) gem_effect 可能没有前置 gem 行，需降级为普通状态行，避免丢失信息。
 * 2) affix 行理论上应有 affix 数据，若缺失则回退文本渲染，避免渲染空白。
 */

type EquipmentDetailAttrListVariant = 'desktop' | 'mobile';

interface EquipmentDetailAttrListProps {
  lines: EquipmentDetailLine[];
  variant: EquipmentDetailAttrListVariant;
  className?: string;
}

type PlainLine = {
  text: string;
  label?: string;
  value?: string;
};

type GemGroup = {
  slotText: string;
  gemName: string;
  effects: PlainLine[];
};

const joinClassNames = (...parts: Array<string | null | undefined | false>): string => {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
};

export const EquipmentDetailAttrList: React.FC<EquipmentDetailAttrListProps> = ({ lines, variant, className }) => {
  const metricLines: PlainLine[] = [];
  const baseLines: PlainLine[] = [];
  const statusLines: PlainLine[] = [];
  const affixLines: Array<EquipmentDetailLine & { kind: 'affix' }> = [];
  const gemGroups: GemGroup[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.kind === 'affix') {
      affixLines.push(line);
      continue;
    }

    if (line.kind === 'progress' || line.kind === 'socket') {
      metricLines.push(line);
      continue;
    }

    if (line.kind === 'base') {
      baseLines.push(line);
      continue;
    }

    if (line.kind === 'gem') {
      const effects: PlainLine[] = [];
      let cursor = i + 1;
      while (cursor < lines.length) {
        const next = lines[cursor];
        if (next.kind === 'gem_effect') {
          effects.push(next);
          cursor += 1;
          continue;
        }
        break;
      }
      gemGroups.push({
        slotText: line.label ?? '宝石',
        gemName: line.value ?? line.text,
        effects,
      });
      i = cursor - 1;
      continue;
    }

    if (line.kind === 'gem_effect') {
      statusLines.push(line);
      continue;
    }

    statusLines.push(line);
  }

  return (
    <div className={joinClassNames('equip-attr-board', `equip-attr-board--${variant}`, className)}>
      {metricLines.length > 0 ? (
        <div className="equip-attr-panel equip-attr-panel--metrics">
          <div className="equip-attr-metric-list">
            {metricLines.map((line, idx) => (
              <div key={`${idx}-${line.text}`} className="equip-attr-metric-pill">
                <span className="equip-attr-metric-label">{line.label ?? '属性'}</span>
                <span className="equip-attr-metric-value">{line.value ?? line.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {baseLines.length > 0 ? (
        <div className="equip-attr-panel">
          <div className="equip-attr-panel-title">基础属性</div>
          <div className="equip-attr-base-grid">
            {baseLines.map((line, idx) => (
              <div key={`${idx}-${line.text}`} className="equip-attr-base-row">
                <span className="equip-attr-base-label">{line.label ?? '--'}</span>
                <span className="equip-attr-base-value">{line.value ?? line.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {gemGroups.length > 0 ? (
        <div className="equip-attr-panel">
          <div className="equip-attr-panel-title">宝石增益</div>
          <div className="equip-attr-gem-list">
            {gemGroups.map((group, idx) => (
              <div key={`${idx}-${group.slotText}-${group.gemName}`} className="equip-attr-gem-card">
                <div className="equip-attr-gem-head">
                  <span className="equip-attr-gem-slot">{group.slotText}</span>
                  <span className="equip-attr-gem-name">{group.gemName}</span>
                </div>
                {group.effects.length > 0 ? (
                  <div className="equip-attr-gem-effects">
                    {group.effects.map((effect, effectIdx) => (
                      <div key={`${idx}-${effectIdx}-${effect.text}`} className="equip-attr-gem-effect-row">
                        <span className="equip-attr-gem-effect-label">{effect.label ?? effect.text}</span>
                        <span className="equip-attr-gem-effect-value">{effect.value ?? ''}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {affixLines.length > 0 ? (
        <div className="equip-attr-panel">
          <div className="equip-attr-panel-title">词条</div>
          <div className="equip-attr-affix-list">
            {affixLines.map((line, idx) => {
              if (!line.affix) {
                return (
                  <div key={`${idx}-${line.text}`} className="equip-attr-affix-fallback">
                    {line.text}
                  </div>
                );
              }
              return (
                <div key={`${idx}-${line.text}`} className="equip-attr-affix-row-wrap">
                  <EquipmentAffixTagRow
                    tierText={line.affix.tierText}
                    bodyText={line.affix.bodyText}
                    rollPercent={line.affix.rollPercent}
                    className={joinClassNames('affix-tooltip-row', 'equip-attr-affix-row', `is-${variant}`)}
                    textClassName={joinClassNames('affix-tooltip-text', 'equip-attr-affix-text', `is-${variant}`)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {statusLines.length > 0 ? (
        <div className="equip-attr-panel">
          <div className="equip-attr-panel-title">状态</div>
          <div className="equip-attr-status-list">
            {statusLines.map((line, idx) => (
              <div key={`${idx}-${line.text}`} className="equip-attr-status-item">
                {line.label ? <span>{line.label}：</span> : null}
                <span>{line.value ?? line.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
