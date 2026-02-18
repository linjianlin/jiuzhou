/**
 * 作用：统一处理前端物品品质（黄/玄/地/天）的解析、展示文案与样式类名。
 * 不做什么：不负责品质数值计算与排序，仅做 UI 展示所需的轻量映射。
 */

export type ItemQualityKey = 'huang' | 'xuan' | 'di' | 'tian';
export type ItemQualityName = '黄' | '玄' | '地' | '天';

export type ItemQualityMeta = {
  key: ItemQualityKey;
  name: ItemQualityName;
  label: string;
  className: string;
  color: string;
};

const QUALITY_KEY_TO_NAME: Record<ItemQualityKey, ItemQualityName> = {
  huang: '黄',
  xuan: '玄',
  di: '地',
  tian: '天',
};

const QUALITY_KEY_TO_LABEL: Record<ItemQualityKey, string> = {
  huang: '黄品',
  xuan: '玄品',
  di: '地品',
  tian: '天品',
};

const QUALITY_KEY_TO_COLOR: Record<ItemQualityKey, string> = {
  huang: 'var(--rarity-huang)',
  xuan: 'var(--rarity-xuan)',
  di: 'var(--rarity-di)',
  tian: 'var(--rarity-tian)',
};

const RAW_TO_QUALITY_KEY: Record<string, ItemQualityKey> = {
  黄: 'huang',
  玄: 'xuan',
  地: 'di',
  天: 'tian',
  huang: 'huang',
  xuan: 'xuan',
  di: 'di',
  tian: 'tian',
};

const parseQualityKey = (value: unknown): ItemQualityKey | null => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const direct = RAW_TO_QUALITY_KEY[raw] ?? RAW_TO_QUALITY_KEY[raw.toLowerCase()];
  if (direct) return direct;

  const withoutSuffix = raw.endsWith('品') ? raw.slice(0, -1) : raw;
  const normalized = withoutSuffix.toLowerCase().startsWith('q-')
    ? withoutSuffix.toLowerCase().slice(2)
    : withoutSuffix.toLowerCase();
  return RAW_TO_QUALITY_KEY[withoutSuffix] ?? RAW_TO_QUALITY_KEY[normalized] ?? null;
};

export const getItemQualityMeta = (value: unknown): ItemQualityMeta | null => {
  const key = parseQualityKey(value);
  if (!key) return null;

  const name = QUALITY_KEY_TO_NAME[key];
  return {
    key,
    name,
    label: QUALITY_KEY_TO_LABEL[key],
    className: `item-quality--${key}`,
    color: QUALITY_KEY_TO_COLOR[key],
  };
};

export const normalizeItemQualityName = (
  value: unknown,
  fallback: ItemQualityName = '黄',
): ItemQualityName => {
  const meta = getItemQualityMeta(value);
  return meta?.name ?? fallback;
};
