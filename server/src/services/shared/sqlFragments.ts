/**
 * SQL 片段集合
 *
 * 作用：
 * - 统一维护可复用的字段清单，避免同一字段列表在多个查询里重复粘贴。
 * - 降低字段增删时漏改风险。
 */
export const CHARACTER_BASE_COLUMNS_SQL = `
id,
user_id,
nickname,
title,
gender,
avatar,
auto_cast_skills,
auto_disassemble_enabled,
auto_disassemble_rules,
dungeon_no_stamina_cost,
spirit_stones,
silver,
stamina,
realm,
sub_realm,
exp,
attribute_points,
jing,
qi,
shen,
attribute_type,
attribute_element,
current_map_id,
current_room_id
`;
