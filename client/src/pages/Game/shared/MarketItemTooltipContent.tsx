import { useMemo } from 'react';
import EquipmentAffixTooltipList from './EquipmentAffixTooltipList';
import { formatSignedNumber, formatSignedPercent } from './formatAttr';
import { PERCENT_ATTR_KEYS, coerceAffixes, formatScalar, limitLines, normalizeText } from './itemMetaFormat';
import { getItemQualityMeta } from './itemQuality';
import { getItemTaxonomyLabel } from './itemTaxonomy';
import './itemTooltip.scss';

/**
 * 作用：
 * - 统一“坊市风格”物品 Tooltip 的结构、文案映射与属性展示，避免坊市/仓库重复维护两套实现。
 * - 不做什么：不负责数据请求、图标解析、业务按钮行为，仅消费上游已经整理好的物品展示数据。
 *
 * 输入/输出：
 * - 输入：`MarketTooltipItemData`，包含名称、品质、分类、词条、效果与基础属性等展示字段。
 * - 输出：统一 `.item-tooltip-*` 结构的 React 节点，可直接作为 antd Tooltip/Drawer 内容。
 *
 * 数据流/状态流：
 * - 各业务模块（Market/Warehouse）先把各自 DTO 映射为 `MarketTooltipItemData`。
 * - 本组件只做纯展示计算（useMemo）并输出统一 UI，样式由 `itemTooltip.scss` 提供单一来源。
 *
 * 边界条件与坑点：
 * - `equipReqRealm` 明确不进入 Tag 区，统一改为“装备信息”里的普通文本行，避免需求境界被误读成标签属性。
 * - `baseAttrs/effectDefs/affixes` 来自后端动态结构，组件仅做展示层容错解析，不改业务语义。
 * - 分类/部位/用途字段若为英文且无法映射，会自动隐藏，避免 Tooltip 出现技术字段噪声。
 */

export type MarketTooltipCategory = string;

type TooltipTag = {
  text: string;
  qualityClassName?: string;
};

const hasLatin = (value: string): boolean => /[A-Za-z]/.test(value);
const RATING_SUFFIX = '_rating';

const translateKey = (key: string): string | null => {
  const k = key.trim();
  const m: Record<string, string> = {
    type: '类型',
    value: '数值',
    amount: '数量',
    qty: '数量',
    chance: '概率',
    duration: '持续时间',
    cooldown: '冷却',
    seconds: '秒数',
    percent: '百分比',
    desc: '描述',
    description: '描述',
    name: '名称',

    max_qixue: '气血上限',
    max_lingqi: '灵气上限',
    qixue: '气血',
    lingqi: '灵气',

    wugong: '物攻',
    fagong: '法攻',
    wufang: '物防',
    fafang: '法防',
    mingzhong: '命中',
    shanbi: '闪避',
    zhaojia: '招架',
    baoji: '暴击',
    baoshang: '暴伤',
    kangbao: '抗暴',
    zengshang: '增伤',
    zhiliao: '治疗',
    jianliao: '减疗',
    xixue: '吸血',
    lengque: '冷却',
    sudu: '速度',
    qixue_huifu: '气血恢复',
    lingqi_huifu: '灵气恢复',
    kongzhi_kangxing: '控制抗性',
    jin_kangxing: '金抗性',
    mu_kangxing: '木抗性',
    shui_kangxing: '水抗性',
    huo_kangxing: '火抗性',
    tu_kangxing: '土抗性',
    fuyuan: '福源',
    shuxing_shuzhi: '属性数值',

    attack: '攻击',
    defense: '防御',
    speed: '速度',
    crit: '暴击',
    crit_rate: '暴击率',
    crit_damage: '暴击伤害',
    dodge: '闪避',
    hit: '命中',
    hp: '气血',
    mp: '灵气',
  };
  if (m[k]) return m[k];
  if (k.endsWith(RATING_SUFFIX)) {
    const baseKey = k.slice(0, -RATING_SUFFIX.length).trim();
    const baseLabel = m[baseKey];
    if (baseLabel) return `${baseLabel}等级`;
  }
  return null;
};

const formatLines = (value: unknown, depth: number = 0): string[] => {
  if (value === null || value === undefined) return [];
  if (depth >= 3) {
    const inline = formatScalar(value);
    return [inline || '（内容较复杂）'];
  }
  const inline = formatScalar(value);
  if (inline) return [inline];

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const out: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      const itemInline = formatScalar(item);
      if (itemInline) {
        out.push(`${i + 1}. ${itemInline}`);
        continue;
      }
      const nested = formatLines(item, depth + 1);
      if (nested.length === 0) continue;
      out.push(`${i + 1}.`);
      out.push(...nested.map((x) => `  ${x}`));
    }
    return out;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return [];
    const out: string[] = [];
    for (const [k, v] of entries) {
      const kk = translateKey(k) ?? '';
      if (!kk) continue;

      if (typeof v === 'number' && Number.isFinite(v) && PERCENT_ATTR_KEYS.has(k)) {
        out.push(`${kk}：${formatSignedPercent(v)}`);
        continue;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        out.push(`${kk}：${formatSignedNumber(v)}`);
        continue;
      }

      const vInline = formatScalar(v);
      if (vInline) {
        out.push(`${kk}：${vInline}`);
        continue;
      }
      const nested = formatLines(v, depth + 1);
      if (nested.length === 0) continue;
      out.push(`${kk}：`);
      out.push(...nested.map((x) => `  ${x}`));
    }
    return out;
  }

  return [];
};

const translateEquipSlot = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const m: Record<string, string> = {
    weapon: '武器',
    helmet: '头盔',
    head: '头部',
    armor: '衣服',
    chest: '上衣',
    pants: '裤子',
    boots: '鞋子',
    gloves: '护手',
    belt: '腰带',
    ring: '戒指',
    amulet: '项链',
    necklace: '项链',
    bracelet: '手镯',
    accessory: '饰品',
    artifact: '法宝',
  };
  if (m[raw]) return m[raw];
  if (hasLatin(raw)) return '';
  return raw;
};

const translateUseType = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const m: Record<string, string> = {
    instant: '立即生效',
    open: '可开启',
    equip: '可装备',
    passive: '被动',
    none: '无',
    use: '可使用',
    consume: '消耗',
  };
  if (m[raw]) return m[raw];
  if (hasLatin(raw)) return '';
  return raw;
};

const translateCategory = (value?: string | null): string => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const taxonomyLabel = getItemTaxonomyLabel(raw);
  if (taxonomyLabel && taxonomyLabel !== raw) return taxonomyLabel;
  if (hasLatin(raw)) return '';
  return raw;
};

export const normalizeMarketTooltipCategory = (value: unknown): MarketTooltipCategory => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized === 'all') return 'other';
  return normalized;
};

export const buildMarketTooltipCategoryLabel = (category?: string | null, subCategory?: string | null): string => {
  const main = translateCategory(category);
  const sub = translateCategory(subCategory);
  if (!main) return '';
  if (!sub || sub === main) return main;
  return `${main}/${sub}`;
};

export const ITEM_TOOLTIP_CLASS_NAMES = {
  root: 'item-tooltip-overlay game-tooltip-surface-root',
  container: 'item-tooltip-overlay-container game-tooltip-surface-container',
} as const;

export type MarketTooltipItemData = {
  name: string;
  icon: string;
  qty: number;
  quality?: unknown;
  category: MarketTooltipCategory;
  categoryLabel?: string | null;
  description?: string | null;
  longDesc?: string | null;
  effectDefs?: unknown;
  baseAttrs?: unknown;
  equipSlot?: string | null;
  equipReqRealm?: string | null;
  useType?: string | null;
  strengthenLevel?: number | null;
  refineLevel?: number | null;
  identified?: boolean;
  affixes?: unknown;
};

const MarketItemTooltipContent: React.FC<{ item: MarketTooltipItemData }> = ({ item }) => {
  const desc = useMemo(() => {
    const longDesc = normalizeText(item.longDesc);
    const shortDesc = normalizeText(item.description);
    return longDesc || shortDesc;
  }, [item.description, item.longDesc]);

  const isEquip = item.category === 'equipment';

  const infoTags = useMemo(() => {
    const tags: TooltipTag[] = [];
    const qualityMeta = getItemQualityMeta(item.quality);
    if (qualityMeta) {
      tags.push({
        text: qualityMeta.label,
        qualityClassName: qualityMeta.className,
      });
    }

    const categoryText = normalizeText(item.categoryLabel) || getItemTaxonomyLabel(item.category);
    tags.push({ text: categoryText });

    const equipSlot = translateEquipSlot(item.equipSlot);
    if (equipSlot) tags.push({ text: `部位：${equipSlot}` });
    const useType = translateUseType(item.useType);
    if (useType) tags.push({ text: `类型：${useType}` });
    return tags;
  }, [item.category, item.categoryLabel, item.equipSlot, item.quality, item.useType]);

  const equipMetaLines = useMemo(() => {
    if (!isEquip) return [];
    const s = Math.max(0, Math.floor(Number(item.strengthenLevel) || 0));
    const r = Math.max(0, Math.floor(Number(item.refineLevel) || 0));
    const lines = [`强化：${s > 0 ? `+${s}` : s}`, `精炼：${r > 0 ? `+${r}` : r}`];
    const reqRealm = normalizeText(item.equipReqRealm);
    if (reqRealm) lines.push(`需求境界：${reqRealm}`);
    return lines;
  }, [isEquip, item.equipReqRealm, item.refineLevel, item.strengthenLevel]);

  const baseAttrLines = useMemo(() => {
    if (!isEquip) return [];
    if (!item.baseAttrs || typeof item.baseAttrs !== 'object' || Array.isArray(item.baseAttrs)) return [];
    const attrs = item.baseAttrs as Record<string, unknown>;
    const entries = Object.entries(attrs).filter(
      ([, v]) => typeof v === 'number' && Number.isFinite(v) && v !== 0,
    ) as Array<[string, number]>;
    entries.sort(([a], [b]) => a.localeCompare(b));
    const lines = entries.map(([k, v]) => {
      const label = translateKey(k) ?? (hasLatin(k) ? '' : k);
      if (!label) return '';
      const text = PERCENT_ATTR_KEYS.has(k) ? formatSignedPercent(v) : formatSignedNumber(v);
      return `${label}：${text}`;
    });
    return limitLines(lines.filter(Boolean), 10);
  }, [isEquip, item.baseAttrs]);

  const affixes = useMemo(() => coerceAffixes(item.affixes), [item.affixes]);
  const effectLines = useMemo(() => limitLines(formatLines(item.effectDefs), 10), [item.effectDefs]);

  return (
    <div className="item-tooltip">
      <div className="item-tooltip-head">
        <img className="item-tooltip-icon" src={item.icon} alt={item.name} />
        <div className="item-tooltip-title">{item.name}</div>
        {item.qty > 1 ? <div className="item-tooltip-count">x{item.qty}</div> : null}
      </div>

      {infoTags.length > 0 ? (
        <div className="item-tooltip-tags">
          {infoTags.map((tag, idx) => (
            <span
              key={`${idx}-${tag.text}`}
              className={`item-tooltip-tag${tag.qualityClassName ? ` item-tooltip-tag--quality ${tag.qualityClassName}` : ''}`}
            >
              {tag.text}
            </span>
          ))}
        </div>
      ) : null}

      {!isEquip && desc ? <div className="item-tooltip-desc">{desc}</div> : null}

      {equipMetaLines.length > 0 ? (
        <div className="item-tooltip-section">
          <div className="item-tooltip-section-title">装备信息</div>
          <div className="item-tooltip-lines">
            {equipMetaLines.map((x) => (
              <div key={x} className="item-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {isEquip ? (
        <div className="item-tooltip-section">
          <div className="item-tooltip-section-title">词条</div>
          <div className="item-tooltip-lines">
            <EquipmentAffixTooltipList
              affixes={affixes}
              identified={Boolean(item.identified)}
              maxLines={10}
              displayOptions={{
                normalPrefix: '词条',
                legendaryPrefix: '传奇词条',
                keyTranslator: translateKey,
                rejectLatinLabel: true,
                percentKeys: PERCENT_ATTR_KEYS,
                formatSignedNumber,
                formatSignedPercent,
              }}
            />
          </div>
        </div>
      ) : null}

      {effectLines.length > 0 ? (
        <div className="item-tooltip-section">
          <div className="item-tooltip-section-title">效果</div>
          <div className="item-tooltip-lines">
            {effectLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="item-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {baseAttrLines.length > 0 ? (
        <div className="item-tooltip-section">
          <div className="item-tooltip-section-title">基础属性</div>
          <div className="item-tooltip-lines">
            {baseAttrLines.map((x, idx) => (
              <div key={`${idx}-${x}`} className="item-tooltip-line">
                {x}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default MarketItemTooltipContent;
