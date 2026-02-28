/**
 * PgTextArrayLiteral — 挂机模块 TEXT[] 参数编码工具
 *
 * 作用：
 *   统一将 string[] 编码为 PostgreSQL TEXT[] 字面量，供 SQL 参数绑定使用。
 *   不负责数据库写入，也不做业务层校验。
 *
 * 输入/输出：
 *   - toPgTextArrayLiteral(values: string[]) => string
 *     输入字符串数组，输出 PostgreSQL TEXT[] 字面量，例如 {"a","b"}。
 *
 * 数据流：
 *   执行器战斗结果中的 monsterIds（string[]）→ 编码工具 → SQL 参数 → idle_battle_batches.monster_ids
 *
 * 关键边界条件与坑点：
 *   1. 不能使用 JSON 数组格式（["a"]），TEXT[] 列需要 PostgreSQL 数组字面量格式（{"a"}）。
 *   2. 元素中的反斜杠和双引号必须转义，否则会触发 malformed array literal。
 */

/**
 * 将字符串数组编码为 PostgreSQL TEXT[] 字面量。
 */
export function toPgTextArrayLiteral(values: string[]): string {
  const escaped = values.map((value) =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return `{${escaped.join(',')}}`;
}
