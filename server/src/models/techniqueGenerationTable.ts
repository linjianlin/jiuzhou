/**
 * AI 生成功法系统动态表
 *
 * 作用：
 * 1. 存储角色研修点余额与流水；
 * 2. 存储 AI 生成的功法草稿/已发布定义（功法、技能、层级）；
 * 3. 存储生成功法任务状态机（pending/generated_draft/published/failed/refunded）。
 */
import { query } from '../config/database.js';

const characterResearchPointsTableSQL = `
CREATE TABLE IF NOT EXISTS character_research_points (
  character_id BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  balance_points INTEGER NOT NULL DEFAULT 0,
  total_earned_points BIGINT NOT NULL DEFAULT 0,
  total_spent_points BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE character_research_points IS '角色研修点余额表';
COMMENT ON COLUMN character_research_points.character_id IS '角色ID';
COMMENT ON COLUMN character_research_points.balance_points IS '当前研修点余额';
COMMENT ON COLUMN character_research_points.total_earned_points IS '累计获得研修点';
COMMENT ON COLUMN character_research_points.total_spent_points IS '累计消耗研修点';
`;

const researchPointsLedgerTableSQL = `
CREATE TABLE IF NOT EXISTS research_points_ledger (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  change_points INTEGER NOT NULL,
  reason VARCHAR(32) NOT NULL,
  ref_type VARCHAR(32),
  ref_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE research_points_ledger IS '研修点流水';
COMMENT ON COLUMN research_points_ledger.change_points IS '变化值（正负）';
COMMENT ON COLUMN research_points_ledger.reason IS '流水原因：exchange_book/generate_consume/generate_refund/admin';

CREATE INDEX IF NOT EXISTS idx_research_points_ledger_character_time
  ON research_points_ledger(character_id, created_at DESC);
`;

const generatedTechniqueDefTableSQL = `
CREATE TABLE IF NOT EXISTS generated_technique_def (
  id VARCHAR(64) PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL,
  created_by_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,

  name VARCHAR(64) NOT NULL,
  display_name VARCHAR(64),
  normalized_name VARCHAR(64),
  type VARCHAR(16) NOT NULL,
  quality VARCHAR(4) NOT NULL,
  max_layer INTEGER NOT NULL,
  required_realm VARCHAR(64) NOT NULL,
  attribute_type VARCHAR(16) NOT NULL,
  attribute_element VARCHAR(16) NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  long_desc TEXT,
  icon VARCHAR(255),

  is_published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  name_locked BOOLEAN NOT NULL DEFAULT false,

  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE generated_technique_def IS 'AI生成功法定义（草稿+已发布）';
COMMENT ON COLUMN generated_technique_def.generation_id IS '生成功法任务ID';
COMMENT ON COLUMN generated_technique_def.display_name IS '玩家自定义展示名';
COMMENT ON COLUMN generated_technique_def.normalized_name IS '展示名规范化结果，用于唯一性比较';
COMMENT ON COLUMN generated_technique_def.is_published IS '是否已发布';
COMMENT ON COLUMN generated_technique_def.name_locked IS '名称是否锁定（首发后不可改）';

CREATE INDEX IF NOT EXISTS idx_generated_technique_def_generation_id
  ON generated_technique_def(generation_id);
CREATE INDEX IF NOT EXISTS idx_generated_technique_def_published
  ON generated_technique_def(is_published, enabled, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_technique_def_normalized_name_published
  ON generated_technique_def(normalized_name)
  WHERE is_published = true AND normalized_name IS NOT NULL;
`;

const generatedSkillDefTableSQL = `
CREATE TABLE IF NOT EXISTS generated_skill_def (
  id VARCHAR(64) PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL,
  source_type VARCHAR(16) NOT NULL,
  source_id VARCHAR(64) NOT NULL,

  code VARCHAR(64),
  name VARCHAR(64) NOT NULL,
  description TEXT,
  icon VARCHAR(255),
  cost_lingqi INTEGER NOT NULL DEFAULT 0,
  cost_qixue INTEGER NOT NULL DEFAULT 0,
  cooldown INTEGER NOT NULL DEFAULT 0,
  target_type VARCHAR(32) NOT NULL,
  target_count INTEGER NOT NULL DEFAULT 1,
  damage_type VARCHAR(16),
  element VARCHAR(16) NOT NULL DEFAULT 'none',
  effects JSONB NOT NULL DEFAULT '[]'::jsonb,
  trigger_type VARCHAR(16) NOT NULL DEFAULT 'active',
  conditions JSONB,
  ai_priority INTEGER NOT NULL DEFAULT 50,
  ai_conditions JSONB,
  upgrades JSONB,
  sort_weight INTEGER NOT NULL DEFAULT 0,

  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE generated_skill_def IS 'AI生成功法技能定义';

CREATE INDEX IF NOT EXISTS idx_generated_skill_def_source
  ON generated_skill_def(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_generated_skill_def_generation_id
  ON generated_skill_def(generation_id);
`;

const generatedTechniqueLayerTableSQL = `
CREATE TABLE IF NOT EXISTS generated_technique_layer (
  id BIGSERIAL PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL,
  technique_id VARCHAR(64) NOT NULL,
  layer INTEGER NOT NULL,

  cost_spirit_stones INTEGER NOT NULL DEFAULT 0,
  cost_exp INTEGER NOT NULL DEFAULT 0,
  cost_materials JSONB NOT NULL DEFAULT '[]'::jsonb,
  passives JSONB NOT NULL DEFAULT '[]'::jsonb,
  unlock_skill_ids TEXT[] NOT NULL DEFAULT '{}',
  upgrade_skill_ids TEXT[] NOT NULL DEFAULT '{}',
  required_realm VARCHAR(64),
  required_quest_id VARCHAR(64),
  layer_desc TEXT,

  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(technique_id, layer)
);

COMMENT ON TABLE generated_technique_layer IS 'AI生成功法层级定义';

CREATE INDEX IF NOT EXISTS idx_generated_technique_layer_technique
  ON generated_technique_layer(technique_id, layer);
CREATE INDEX IF NOT EXISTS idx_generated_technique_layer_generation_id
  ON generated_technique_layer(generation_id);
`;

const techniqueGenerationJobTableSQL = `
CREATE TABLE IF NOT EXISTS technique_generation_job (
  id VARCHAR(64) PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  week_key VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL,

  quality_rolled VARCHAR(4) NOT NULL,
  cost_points INTEGER NOT NULL,
  prompt_snapshot JSONB,
  model_name VARCHAR(64),
  attempt_count INTEGER NOT NULL DEFAULT 0,

  draft_technique_id VARCHAR(64),
  generated_technique_id VARCHAR(64),
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  draft_expire_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  failed_viewed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,

  error_code VARCHAR(32),
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE technique_generation_job IS 'AI生成功法任务表';
COMMENT ON COLUMN technique_generation_job.viewed_at IS '生成成功结果首次被玩家查看时间';
COMMENT ON COLUMN technique_generation_job.failed_viewed_at IS '生成失败结果首次被玩家查看时间';
COMMENT ON COLUMN technique_generation_job.finished_at IS '异步生成任务结束时间';

CREATE INDEX IF NOT EXISTS idx_technique_generation_job_character_week
  ON technique_generation_job(character_id, week_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_technique_generation_job_status
  ON technique_generation_job(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_technique_generation_job_unread_result
  ON technique_generation_job(character_id, status, created_at DESC)
  WHERE (status = 'generated_draft' AND viewed_at IS NULL)
     OR (status IN ('failed', 'refunded') AND failed_viewed_at IS NULL);
`;

export const initTechniqueGenerationTables = async (): Promise<void> => {
  await query(characterResearchPointsTableSQL);
  await query(researchPointsLedgerTableSQL);
  await query(generatedTechniqueDefTableSQL);
  await query(generatedSkillDefTableSQL);
  await query(generatedTechniqueLayerTableSQL);
  await query(techniqueGenerationJobTableSQL);

  // 兼容历史版本可能不存在的字段。
  await query(`ALTER TABLE generated_technique_def ADD COLUMN IF NOT EXISTS display_name VARCHAR(64)`);
  await query(`ALTER TABLE generated_technique_def ADD COLUMN IF NOT EXISTS normalized_name VARCHAR(64)`);
  await query(`ALTER TABLE generated_technique_def ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE generated_technique_def ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
  await query(`ALTER TABLE generated_technique_def ADD COLUMN IF NOT EXISTS name_locked BOOLEAN NOT NULL DEFAULT false`);

  await query(`ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS draft_technique_id VARCHAR(64)`);
  await query(`ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS publish_attempts INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ`);
  await query(`ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS failed_viewed_at TIMESTAMPTZ`);
  await query(`ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_technique_generation_job_unread_result
      ON technique_generation_job(character_id, status, created_at DESC)
      WHERE (status = 'generated_draft' AND viewed_at IS NULL)
         OR (status IN ('failed', 'refunded') AND failed_viewed_at IS NULL)
  `);

  console.log('✓ AI生成功法系统表检测完成');
};
