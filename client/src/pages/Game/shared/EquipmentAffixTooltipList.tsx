import { Tag } from 'antd';
import { useMemo, type CSSProperties } from 'react';
import './affixTooltipShared.scss';
import {
  buildEquipmentAffixDisplayText,
  type BuildEquipmentAffixDisplayTextOptions,
  type EquipmentAffixTextInput,
} from './equipmentAffixText';
import {
  formatAffixRollPercent,
  getAffixRollColor,
  getAffixRollPercent,
} from './equipmentAffixRoll';

/**
 * 作用：统一 tooltip 内装备词条的展示结构（T级 Tag + 百分比 Tag + 文本）。
 * 输入：词条数组、是否已鉴定、词条文案构建参数。
 * 输出：可直接渲染的词条列表 UI；当未鉴定或无词条时返回占位文案。
 */

export type EquipmentAffixTooltipDisplayOptions = Omit<
  BuildEquipmentAffixDisplayTextOptions,
  'normalPrefix' | 'legendaryPrefix'
> & {
  normalPrefix?: string;
  legendaryPrefix?: string;
};

type EquipmentAffixTooltipListProps = {
  affixes: EquipmentAffixTextInput[];
  identified: boolean;
  displayOptions: EquipmentAffixTooltipDisplayOptions;
  maxLines?: number;
  emptyText?: string;
  unidentifiedText?: string;
};

type TooltipAffixLine = {
  id: string;
  tierText: string;
  bodyText: string;
  rollPercent: number | null;
};

type EquipmentAffixTagRowProps = {
  tierText: string;
  bodyText: string;
  rollPercent: number | null;
  className?: string;
  textClassName?: string;
};

/**
 * 作用：渲染单行词条的统一结构（T级 Tag + 百分比 Tag + 文本）。
 * 注意：为兼容多场景，支持外部覆写行容器和文本 className。
 */
export const EquipmentAffixTagRow: React.FC<EquipmentAffixTagRowProps> = ({
  tierText,
  bodyText,
  rollPercent,
  className = 'affix-tooltip-row',
  textClassName = 'affix-tooltip-text',
}) => {
  const rollColor = getAffixRollColor(rollPercent);
  const rollTagStyle: CSSProperties | undefined = rollColor
    ? {
        color: rollColor,
        borderColor: rollColor,
        ['--affix-roll-color' as string]: rollColor,
      }
    : undefined;
  return (
    <div className={className}>
      <Tag className="affix-tooltip-tag affix-tooltip-tier-tag">{tierText}</Tag>
      <Tag className="affix-tooltip-tag affix-tooltip-roll-tag" style={rollTagStyle}>
        {formatAffixRollPercent(rollPercent)}
      </Tag>
      <span className={textClassName}>{bodyText}</span>
    </div>
  );
};

export const EquipmentAffixTooltipList: React.FC<EquipmentAffixTooltipListProps> = ({
  affixes,
  identified,
  displayOptions,
  maxLines,
  emptyText = '无',
  unidentifiedText = '未鉴定',
}) => {
  const {
    normalPrefix = '词条',
    legendaryPrefix = '传奇词条',
    keyLabelMap,
    keyTranslator,
    fallbackLabel,
    rejectLatinLabel,
    percentKeys,
    formatSignedNumber,
    formatSignedPercent,
  } = displayOptions;

  const lines = useMemo(() => {
    const sorted = [...affixes].sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));
    const out: TooltipAffixLine[] = [];

    for (let index = 0; index < sorted.length; index += 1) {
      const affix = sorted[index];
      const displayText = buildEquipmentAffixDisplayText(affix, {
        normalPrefix,
        legendaryPrefix,
        keyLabelMap,
        keyTranslator,
        fallbackLabel,
        rejectLatinLabel,
        percentKeys,
        formatSignedNumber,
        formatSignedPercent,
      });
      if (!displayText) continue;

      const bodyText = `${displayText.label}${displayText.valueText ? ` ${displayText.valueText}` : ''}`;
      out.push({
        id: `${affix.key ?? displayText.label}-${index}`,
        tierText: displayText.tierText,
        bodyText,
        rollPercent: getAffixRollPercent(affix),
      });
    }

    if (!Number.isFinite(maxLines ?? NaN)) return out;
    const lineLimit = Math.max(0, Math.floor(maxLines ?? 0));
    if (lineLimit <= 0) return [];
    return out.slice(0, lineLimit);
  }, [
    affixes,
    fallbackLabel,
    formatSignedNumber,
    formatSignedPercent,
    keyLabelMap,
    keyTranslator,
    legendaryPrefix,
    maxLines,
    normalPrefix,
    percentKeys,
    rejectLatinLabel,
  ]);

  if (!identified) {
    return <div className="affix-tooltip-empty">{unidentifiedText}</div>;
  }
  if (lines.length <= 0) {
    return <div className="affix-tooltip-empty">{emptyText}</div>;
  }

  return (
    <div className="affix-tooltip-lines">
      {lines.map((line) => (
        <EquipmentAffixTagRow
          key={line.id}
          tierText={line.tierText}
          bodyText={line.bodyText}
          rollPercent={line.rollPercent}
        />
      ))}
    </div>
  );
};

export default EquipmentAffixTooltipList;
