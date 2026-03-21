/**
 * BattleArea 战场网格尺寸计算
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一根据容器宽度和单位数量推导战场列数、尺寸档位、状态标签可见性，避免战斗双方各自手写一套布局判断。
 * - 做什么：把“每个阵营最多 2 行 5 列”的规则和“卡片等比例缩放倍率”收口在一个纯函数里，让 BattleArea 与样式层共享同一口径。
 * - 不做什么：不直接读取 DOM，不负责 React state，也不输出具体 CSS。
 *
 * 输入/输出：
 * - 输入：`unitCount`（当前阵营实际渲染槽位数量）、`occupiedColumnCount`（当前阵营实际占用列数）、`containerWidth` / `containerHeight`（战场内容区宽高）。
 * - 输出：BattleFieldLayout，包含列数、行数、尺寸档位、卡片最终缩放系数、状态标签开关与标签数量上限。
 *
 * 数据流/状态流：
 * - BattleTeamPanel 通过 ResizeObserver 得到容器宽度
 * - 容器宽高 + 棋盘槽位数 + 已占列数 -> 本模块推导布局
 * - 布局结果 -> 网格列数 / 卡片尺寸 class / 等比例缩放 / Buff 标签显示策略
 *
 * 关键边界条件与坑点：
 * 1. 单位数量超过 10 不属于当前战场规范，本模块只保证 1~10 的布局稳定；超出时仍按最多 5 列推导，但不为异常输入追加兼容分支。
 * 2. 初次挂载时容器宽高可能暂时为 0，此时会先落入最紧凑档位，等待 ResizeObserver 回填后再稳定到正确尺寸。
 * 3. 固定 2x5 棋盘和“最终渲染倍率”是两件事：前者负责排兵规则，后者同时约束卡片框体与内部内容，避免只缩外框不缩内容。
 */

export type BattleFieldCardSize = 'showcase' | 'wide' | 'standard' | 'compact' | 'dense';

export type BattleFieldLayout = {
  columns: number;
  rows: number;
  size: BattleFieldCardSize;
  cardScale: number;
  showStatusRow: boolean;
  statusTagLimit: number;
};

export const BATTLE_FIELD_MAX_COLUMNS = 5;
export const BATTLE_FIELD_MAX_ROWS = 2;

const BATTLE_FIELD_GAP_PX = 10;
const BATTLE_FIELD_VERTICAL_PADDING_PX = 8;
const BATTLE_CARD_ASPECT_RATIO = 5 / 4;
const BATTLE_CARD_BASE_WIDTH_PX: Record<BattleFieldCardSize, number> = {
  showcase: 182,
  wide: 160,
  standard: 136,
  compact: 122,
  dense: 104,
};
const BATTLE_CARD_MIN_SCALE = 0.4;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const resolveBattleColumns = (unitCount: number): number => {
  const normalizedCount = clamp(Math.floor(unitCount) || 0, 1, BATTLE_FIELD_MAX_COLUMNS * BATTLE_FIELD_MAX_ROWS);
  if (normalizedCount <= BATTLE_FIELD_MAX_COLUMNS) return normalizedCount;
  return Math.ceil(normalizedCount / BATTLE_FIELD_MAX_ROWS);
};

const resolveCardSizeByWidth = (effectiveSlotWidth: number): BattleFieldCardSize => {
  if (effectiveSlotWidth >= 188) return 'showcase';
  if (effectiveSlotWidth >= 150) return 'wide';
  if (effectiveSlotWidth >= 120) return 'standard';
  if (effectiveSlotWidth >= 94) return 'compact';
  return 'dense';
};

const resolveCardSizeByHeight = (effectiveSlotHeight: number): BattleFieldCardSize => {
  if (effectiveSlotHeight >= 192) return 'showcase';
  if (effectiveSlotHeight >= 160) return 'wide';
  if (effectiveSlotHeight >= 132) return 'standard';
  if (effectiveSlotHeight >= 104) return 'compact';
  return 'dense';
};

const CARD_SIZE_RANK: Record<BattleFieldCardSize, number> = {
  showcase: 4,
  wide: 3,
  standard: 2,
  compact: 1,
  dense: 0,
};

const pickSmallerCardSize = (left: BattleFieldCardSize, right: BattleFieldCardSize): BattleFieldCardSize => {
  return CARD_SIZE_RANK[left] <= CARD_SIZE_RANK[right] ? left : right;
};

const resolveSparseCardScale = (occupiedColumnCount: number, size: BattleFieldCardSize): number => {
  if (occupiedColumnCount <= 1) {
    if (size === 'showcase') return 1.08;
    if (size === 'wide') return 1.06;
    if (size === 'standard') return 1.04;
    return 1.02;
  }

  if (occupiedColumnCount === 2) {
    if (size === 'showcase') return 1.06;
    if (size === 'wide') return 1.04;
    if (size === 'standard') return 1.03;
    return 1.01;
  }

  if (occupiedColumnCount === 3) {
    if (size === 'showcase') return 1.03;
    if (size === 'wide') return 1.02;
    return 1;
  }

  return 1;
};

const resolveCardFitScale = (
  size: BattleFieldCardSize,
  effectiveSlotWidth: number,
  effectiveSlotHeight: number,
  sparseScale: number,
): number => {
  // 用同一倍率同时约束卡片框体和内部 token，避免只缩外层宽度导致内容比例失衡。
  const baseWidth = BATTLE_CARD_BASE_WIDTH_PX[size];
  const baseHeight = baseWidth / BATTLE_CARD_ASPECT_RATIO;
  const widthScale = effectiveSlotWidth / baseWidth;
  const heightScale = effectiveSlotHeight / baseHeight;
  return clamp(Math.min(sparseScale, widthScale, heightScale), BATTLE_CARD_MIN_SCALE, sparseScale);
};

export const resolveBattleFieldLayout = (params: {
  unitCount: number;
  occupiedColumnCount: number;
  containerWidth: number;
  containerHeight: number;
  columns?: number;
  rows?: number;
}): BattleFieldLayout => {
  const normalizedCount = clamp(Math.floor(params.unitCount) || 0, 1, BATTLE_FIELD_MAX_COLUMNS * BATTLE_FIELD_MAX_ROWS);
  const normalizedOccupiedColumnCount = clamp(
    Math.floor(params.occupiedColumnCount) || 0,
    1,
    BATTLE_FIELD_MAX_COLUMNS,
  );
  const columns = clamp(
    Math.floor(params.columns ?? resolveBattleColumns(normalizedCount)) || 1,
    1,
    BATTLE_FIELD_MAX_COLUMNS,
  );
  const rows = clamp(
    Math.floor(params.rows ?? Math.ceil(normalizedCount / columns)) || 1,
    1,
    BATTLE_FIELD_MAX_ROWS,
  );
  const width = Math.max(0, Math.floor(params.containerWidth));
  const height = Math.max(0, Math.floor(params.containerHeight));
  const slotWidthRaw = columns > 0
    ? (width - BATTLE_FIELD_GAP_PX * Math.max(0, columns - 1)) / columns
    : width;
  const slotHeightRaw = rows > 0
    ? (height - BATTLE_FIELD_GAP_PX * Math.max(0, rows - 1)) / rows
    : height;
  const densityPenalty = normalizedOccupiedColumnCount >= 5 ? 8 : 0;
  const effectiveSlotWidth = Math.max(40, Math.floor(slotWidthRaw - densityPenalty));
  const effectiveSlotHeight = Math.max(40, Math.floor(slotHeightRaw - BATTLE_FIELD_VERTICAL_PADDING_PX));
  const size = pickSmallerCardSize(
    resolveCardSizeByWidth(effectiveSlotWidth),
    resolveCardSizeByHeight(effectiveSlotHeight),
  );
  const sparseScale = resolveSparseCardScale(normalizedOccupiedColumnCount, size);
  const cardScale = resolveCardFitScale(size, effectiveSlotWidth, effectiveSlotHeight, sparseScale);
  const showStatusRow = effectiveSlotWidth >= 118 && effectiveSlotHeight >= 120;

  const statusTagLimit =
    !showStatusRow ? 0
      : size === 'showcase' ? 4
        : size === 'wide' ? 3
          : size === 'standard' ? 3
            : 2;

  return {
    columns,
    rows,
    size,
    cardScale,
    showStatusRow,
    statusTagLimit,
  };
};
