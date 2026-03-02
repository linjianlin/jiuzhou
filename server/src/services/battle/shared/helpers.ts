/**
 * 战斗模块内部工具函数
 *
 * 作用：提供 battle 模块专用的类型转换、去重、随机数等基础工具。
 * 不做什么：不承载业务逻辑，纯函数无副作用。
 *
 * 复用点：monsters.ts / skills.ts / effects.ts / preparation.ts 等子模块共用。
 *
 * 边界条件：
 * 1) toNumber 返回 null 表示无法转换，而非 NaN 或默认值，调用方需自行处理。
 * 2) uniqueStringIds 保持原序、去重、过滤空串。
 */

/** unknown -> Record<string, unknown>（排除 null 和数组） */
export function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** unknown -> number | null（严格有限数字） */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** unknown -> string（trim 后返回，非字符串返回空串） */
export function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** unknown -> number | undefined（null 转为 undefined，用于可选属性） */
export function toOptionalNumber(value: unknown): number | undefined {
  const n = toNumber(value);
  return n === null ? undefined : n;
}

/** 字符串数组去重、trim、过滤空串，保持原序 */
export function uniqueStringIds(ids: string[]): string[] {
  return [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
}

/** 含边界的随机整数（min 和 max 都包含） */
export function randomIntInclusive(min: number, max: number): number {
  const mn = Math.ceil(min);
  const mx = Math.floor(max);
  return Math.floor(Math.random() * (mx - mn + 1)) + mn;
}
