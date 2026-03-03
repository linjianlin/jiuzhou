/**
 * 悟道系统进度表初始化
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：创建并维护 `character_insight_progress`，作为悟道等级与累计消耗经验的唯一数据源。
 * 2) 不做什么：不承载悟道业务规则，不处理经验扣减与属性结算。
 *
 * 输入/输出：
 * - 输入：无（初始化阶段调用）。
 * - 输出：数据库表结构与索引/注释创建结果。
 *
 * 数据流/状态流：
 * initTables() -> initInsightTables() -> CREATE TABLE / COMMENT / INDEX。
 *
 * 关键边界条件与坑点：
 * 1) `character_id` 使用 UNIQUE，确保一个角色只有一条悟道进度记录。
 * 2) 只维护结构，不做历史兼容迁移分支；历史数据由业务层按需插入初始行。
 */
import { query } from '../config/database.js';

const insightProgressTableSQL = `
CREATE TABLE IF NOT EXISTS character_insight_progress (
  character_id BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  level BIGINT NOT NULL DEFAULT 0,
  total_exp_spent BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE character_insight_progress IS '角色悟道进度表（经验长期消耗系统）';
COMMENT ON COLUMN character_insight_progress.character_id IS '角色ID（唯一）';
COMMENT ON COLUMN character_insight_progress.level IS '悟道等级（无上限）';
COMMENT ON COLUMN character_insight_progress.total_exp_spent IS '累计消耗经验';
COMMENT ON COLUMN character_insight_progress.created_at IS '创建时间';
COMMENT ON COLUMN character_insight_progress.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_character_insight_progress_level ON character_insight_progress(level);
`;

export const initInsightTables = async (): Promise<void> => {
  await query(insightProgressTableSQL);
  console.log('✓ 悟道系统表检测完成');
};
