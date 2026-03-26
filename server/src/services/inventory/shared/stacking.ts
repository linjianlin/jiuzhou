/**
 * 普通堆叠实例判定工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一归一化 `metadata / quality / qualityRank` 的“空语义”判定，供背包整理、自动堆叠、性能索引复用。
 * - 做什么：把“哪些实例可视为普通可堆叠实例”的规则集中在一个模块里，避免 JS 与 SQL 各写一套条件后逐渐漂移。
 * - 不做什么：不负责数据库查询、不直接执行堆叠写入，也不处理绑定态分组规则。
 *
 * 输入/输出：
 * - 输入：实例的 `metadataText / quality / qualityRank` 原始值。
 * - 输出：布尔值，表示这些字段是否都属于“空语义”，可参与普通堆叠。
 *
 * 数据流/状态流：
 * - 调用方先从数据库或内存镜像读出实例字段；
 * - 本模块负责把不同来源的空值形态归一成统一语义；
 * - 调用方再基于该结果决定是否纳入普通堆叠分组。
 *
 * 关键边界条件与坑点：
 * 1. `qualityRank = 0`、空字符串质量、`metadata::text = 'null'` 在业务语义上都应视为“未设置”，否则会把普通实例误判为特殊实例。
 * 2. 非空 `metadata` 仍必须排除在普通堆叠之外，避免把真实带实例特征的数据错误合并。
 */

type PlainStackingState = {
  metadataText: string | null;
  quality: string | null;
  qualityRank: number | null;
};

type PlainStackingSqlColumns = {
  metadata: string;
  quality: string;
  qualityRank: string;
};

const isPlainMetadataText = (metadataText: string | null): boolean => {
  if (metadataText === null) return true;
  const normalized = metadataText.trim().toLowerCase();
  return normalized.length === 0 || normalized === "null";
};

const isPlainQuality = (quality: string | null): boolean => {
  if (quality === null) return true;
  return quality.trim().length === 0;
};

const isPlainQualityRank = (qualityRank: number | null): boolean => {
  if (qualityRank === null) return true;
  const normalized = Number(qualityRank);
  if (!Number.isFinite(normalized)) return true;
  return normalized <= 0;
};

const buildPlainMetadataSql = (metadataColumn: string): string => {
  return `(${metadataColumn} IS NULL OR LOWER(BTRIM(${metadataColumn}::text)) = 'null')`;
};

const buildPlainQualitySql = (qualityColumn: string): string => {
  return `(${qualityColumn} IS NULL OR BTRIM(${qualityColumn}) = '')`;
};

const buildPlainQualityRankSql = (qualityRankColumn: string): string => {
  return `(${qualityRankColumn} IS NULL OR ${qualityRankColumn} <= 0)`;
};

export const isPlainStackingState = ({
  metadataText,
  quality,
  qualityRank,
}: PlainStackingState): boolean => {
  return (
    isPlainMetadataText(metadataText) &&
    isPlainQuality(quality) &&
    isPlainQualityRank(qualityRank)
  );
};

export const buildPlainStackingSqlPredicate = ({
  metadata,
  quality,
  qualityRank,
}: PlainStackingSqlColumns): string => {
  return [
    buildPlainMetadataSql(metadata),
    buildPlainQualitySql(quality),
    buildPlainQualityRankSql(qualityRank),
  ].join("\nAND ");
};
