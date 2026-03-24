/**
 * 伙伴展示共享工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护伙伴头像、元素、属性展示格式、战斗属性可见列表与“当前值 + 成长值”属性行，供伙伴面板与伙伴坊市复用。
 * 2. 做什么：把伙伴展示层高频变化的格式化规则收口，避免不同界面各写一套标签、属性摘要和成长值拼接逻辑。
 * 3. 不做什么：不处理弹窗状态，不发请求，也不决定伙伴按钮文案。
 *
 * 输入/输出：
 * - 输入：伙伴 DTO、属性键值。
 * - 输出：可直接展示的图标地址、属性文案、可见属性列表和属性行数据。
 *
 * 数据流/状态流：
 * - partner api DTO -> 本模块格式化 -> PartnerModal / MarketModal 渲染。
 *
 * 关键边界条件与坑点：
 * 1. 百分比属性与恢复属性的展示规则必须共用，否则伙伴面板和坊市摘要会出现同属性不同文案。
 * 2. 成长值必须读取服务端 `levelAttrGains`，不能混用 `growth` 字段，否则“当前值 + 成长值”会和真实升级增量不一致。
 */
import type {
  PartnerBaseAttrsDto,
  PartnerComputedAttrsDto,
  PartnerDisplayDto,
} from '../../../services/api';
import { formatPercent, formatRecovery } from './formatAttr';
import { getAttrLabel, isPercentAttrKey } from './attrDisplay';
import { formatElementLabel } from './elementTheme';
import { DEFAULT_ICON, resolveIconUrl } from './resolveIcon';

export const PARTNER_COMBAT_ATTR_ORDER: Array<keyof PartnerBaseAttrsDto> = [
  'max_qixue',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'jianbaoshang',
  'jianfantan',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'sudu',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'qixue_huifu',
  'lingqi_huifu',
];

export const getPartnerAttrLabel = (
  attrKey: keyof PartnerComputedAttrsDto | string,
): string => {
  return getAttrLabel(attrKey);
};

export const formatPartnerAttrValue = (
  attrKey: keyof PartnerComputedAttrsDto | string,
  value: number,
): string => {
  if (isPercentAttrKey(attrKey)) {
    return formatPercent(value);
  }
  return formatRecovery(value);
};

export const formatPartnerElementLabel = (element: string): string => {
  return formatElementLabel(element, '无属性');
};

export const getPartnerDisplayName = (
  partner: Pick<PartnerDisplayDto, 'nickname' | 'name'>,
): string => {
  return String(partner.nickname || '').trim() || partner.name;
};

export const hasPartnerLevelLimitApplied = (
  partner: Pick<PartnerDisplayDto, 'level' | 'currentEffectiveLevel'>,
): boolean => {
  return Number(partner.currentEffectiveLevel) > 0
    && Number(partner.currentEffectiveLevel) < Number(partner.level);
};

export const formatPartnerLevelSummary = (
  partner: Pick<PartnerDisplayDto, 'level' | 'currentEffectiveLevel'>,
): string => {
  if (hasPartnerLevelLimitApplied(partner)) {
    return `等级 ${partner.level} · 生效 ${partner.currentEffectiveLevel}`;
  }
  return `等级 ${partner.level}`;
};

export const resolvePartnerAvatar = (avatar: string | null): string => {
  return resolveIconUrl(avatar, DEFAULT_ICON);
};

export const getPartnerVisibleCombatAttrs = (
  computedAttrs: PartnerComputedAttrsDto,
): Array<{ key: keyof PartnerBaseAttrsDto; value: number }> => {
  return PARTNER_COMBAT_ATTR_ORDER
    .map((key) => ({ key, value: Number(computedAttrs[key]) || 0 }))
    .filter((entry) => entry.value !== 0);
};

export const getPartnerVisibleBaseAttrs = (
  baseAttrs: PartnerBaseAttrsDto,
  compareAttrs?: PartnerBaseAttrsDto,
): Array<{ key: keyof PartnerBaseAttrsDto; value: number }> => {
  return PARTNER_COMBAT_ATTR_ORDER
    .map((key) => ({
      key,
      value: Number(baseAttrs[key]) || 0,
      compareValue: Number(compareAttrs?.[key]) || 0,
    }))
    .filter((entry) => entry.value !== 0 || entry.compareValue !== 0)
    .map(({ key, value }) => ({ key, value }));
};

export type PartnerCombatAttrRow = {
  key: keyof PartnerBaseAttrsDto;
  label: string;
  valueText: string;
  growthText: string | null;
};

export const buildPartnerCombatAttrRows = (
  partner: PartnerDisplayDto,
): PartnerCombatAttrRow[] => {
  return getPartnerVisibleCombatAttrs(partner.computedAttrs).map((entry) => {
    const growthValue = Number(partner.levelAttrGains[entry.key]) || 0;
    return {
      key: entry.key,
      label: getPartnerAttrLabel(entry.key),
      valueText: formatPartnerAttrValue(entry.key, entry.value),
      growthText: growthValue > 0
        ? formatPartnerAttrValue(entry.key, growthValue)
        : null,
    };
  });
};
