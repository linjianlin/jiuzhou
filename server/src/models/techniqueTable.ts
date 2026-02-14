/**
 * 九州修仙录 - 功法系统动态数据表
 *
 * 说明：
 * 1. 功法定义/技能定义/功法层级已改为静态 JSON 直读，不再建表。
 * 2. 仅保留角色维度的动态数据表。
 */
import { query } from '../config/database.js';

// ============================================
// 1. 角色功法表（动态）
// ============================================
const characterTechniqueTableSQL = `
CREATE TABLE IF NOT EXISTS character_technique (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  technique_id VARCHAR(64) NOT NULL,

  current_layer INTEGER DEFAULT 1,                    -- 当前层数
  slot_type VARCHAR(10),                              -- 装备槽：main/sub/null(未装备)
  slot_index INTEGER,                                 -- 副功法槽位 1-3（main时为null）

  -- 来源追溯
  obtained_from VARCHAR(32),                          -- 获取来源：drop/shop/quest/sect/gift/admin
  obtained_ref_id VARCHAR(64),                        -- 来源引用ID

  acquired_at TIMESTAMPTZ DEFAULT NOW(),              -- 获得时间
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(character_id, technique_id)
);

COMMENT ON TABLE character_technique IS '角色功法表（动态数据）';
COMMENT ON COLUMN character_technique.character_id IS '角色ID';
COMMENT ON COLUMN character_technique.technique_id IS '功法ID（静态配置ID）';
COMMENT ON COLUMN character_technique.current_layer IS '当前修炼层数';
COMMENT ON COLUMN character_technique.slot_type IS '装备槽类型：main主功法/sub副功法/null未装备';
COMMENT ON COLUMN character_technique.slot_index IS '副功法槽位索引 1-3';

CREATE INDEX IF NOT EXISTS idx_char_tech_char ON character_technique(character_id);
CREATE INDEX IF NOT EXISTS idx_char_tech_slot ON character_technique(character_id, slot_type);
CREATE INDEX IF NOT EXISTS idx_char_tech_equipped ON character_technique(character_id) WHERE slot_type IS NOT NULL;
`;

// ============================================
// 2. 角色技能槽表（动态）
// ============================================
const characterSkillSlotTableSQL = `
CREATE TABLE IF NOT EXISTS character_skill_slot (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL,                        -- 槽位 1-10
  skill_id VARCHAR(64) NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(character_id, slot_index),
  UNIQUE(character_id, skill_id)
);

COMMENT ON TABLE character_skill_slot IS '角色技能槽表';
COMMENT ON COLUMN character_skill_slot.character_id IS '角色ID';
COMMENT ON COLUMN character_skill_slot.slot_index IS '技能槽位 1-10';
COMMENT ON COLUMN character_skill_slot.skill_id IS '装配的技能ID（静态配置ID）';

CREATE INDEX IF NOT EXISTS idx_char_skill_char ON character_skill_slot(character_id);
`;

export const initTechniqueTables = async (): Promise<void> => {
  try {
    console.log('  → 功法/技能/层级定义改为静态JSON加载，跳过建表');

    await query(characterTechniqueTableSQL);
    await query(characterSkillSlotTableSQL);

    await query('ALTER TABLE character_technique DROP CONSTRAINT IF EXISTS character_technique_technique_id_fkey');
    await query('ALTER TABLE character_skill_slot DROP CONSTRAINT IF EXISTS character_skill_slot_skill_id_fkey');

    console.log('✓ 功法系统表检测完成');
  } catch (error) {
    console.error('✗ 功法系统表初始化失败:', error);
    throw error;
  }
};
