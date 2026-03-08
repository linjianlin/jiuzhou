/**
 * AI 生成功法系统动态表
 *
 * 作用：
 * 1. 保留历史研修点余额与流水表结构，避免旧库升级时报错；
 * 2. 存储 AI 生成的功法草稿/已发布定义（功法、技能、层级）；
 * 3. 存储生成功法任务状态机（pending/generated_draft/published/failed/refunded）。
 */
import { query } from '../config/database.js';

type CompatibleColumnDefinition = {
  name: string;
  definition: string;
  comment?: string;
};

const renderCompatibleColumnDefinitions = (
  columns: readonly CompatibleColumnDefinition[],
): string => columns.map(({ definition }) => `  ${definition},`).join('\n');

const buildCompatibleColumnMigrationQueries = (
  tableName: string,
  columns: readonly CompatibleColumnDefinition[],
): string[] => columns.map(
  ({ definition }) => `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${definition}`,
);

const buildCompatibleColumnCommentQueries = (
  tableName: string,
  columns: readonly CompatibleColumnDefinition[],
): string[] => columns
  .filter((column): column is CompatibleColumnDefinition & { comment: string } => typeof column.comment === 'string')
  .map(({ name, comment }) => `COMMENT ON COLUMN ${tableName}.${name} IS '${comment}'`);

const generatedTechniqueDefCompatibleColumns: readonly CompatibleColumnDefinition[] = [
  {
    name: 'display_name',
    definition: 'display_name VARCHAR(64)',
    comment: '玩家自定义展示名',
  },
  {
    name: 'normalized_name',
    definition: 'normalized_name VARCHAR(64)',
    comment: '展示名规范化结果，用于唯一性比较',
  },
  {
    name: 'is_published',
    definition: 'is_published BOOLEAN NOT NULL DEFAULT false',
    comment: '是否已发布',
  },
  {
    name: 'published_at',
    definition: 'published_at TIMESTAMPTZ',
  },
  {
    name: 'name_locked',
    definition: 'name_locked BOOLEAN NOT NULL DEFAULT false',
    comment: '名称是否锁定（首发后不可改）',
  },
];

const techniqueGenerationJobCompatibleColumns: readonly CompatibleColumnDefinition[] = [
  {
    name: 'draft_technique_id',
    definition: 'draft_technique_id VARCHAR(64)',
  },
  {
    name: 'publish_attempts',
    definition: 'publish_attempts INTEGER NOT NULL DEFAULT 0',
  },
  {
    name: 'viewed_at',
    definition: 'viewed_at TIMESTAMPTZ',
    comment: '生成成功结果首次被玩家查看时间',
  },
  {
    name: 'failed_viewed_at',
    definition: 'failed_viewed_at TIMESTAMPTZ',
    comment: '生成失败结果首次被玩家查看时间',
  },
  {
    name: 'finished_at',
    definition: 'finished_at TIMESTAMPTZ',
    comment: '异步生成任务结束时间',
  },
];

const characterResearchPointsTableSQL = `
CREATE TABLE IF NOT EXISTS character_research_points (
  character_id BIGINT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  balance_points INTEGER NOT NULL DEFAULT 0,
  total_earned_points BIGINT NOT NULL DEFAULT 0,
  total_spent_points BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE character_research_points IS '历史研修点余额表（已停用）';
COMMENT ON COLUMN character_research_points.character_id IS '角色ID';
COMMENT ON COLUMN character_research_points.balance_points IS '历史研修点余额';
COMMENT ON COLUMN character_research_points.total_earned_points IS '历史累计获得研修点';
COMMENT ON COLUMN character_research_points.total_spent_points IS '历史累计消耗研修点';
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

COMMENT ON TABLE research_points_ledger IS '历史研修点流水（已停用）';
COMMENT ON COLUMN research_points_ledger.change_points IS '历史变化值（正负）';
COMMENT ON COLUMN research_points_ledger.reason IS '历史流水原因';

CREATE INDEX IF NOT EXISTS idx_research_points_ledger_character_time
  ON research_points_ledger(character_id, created_at DESC);
`;

const generatedTechniqueDefTableSQL = `
CREATE TABLE IF NOT EXISTS generated_technique_def (
  id VARCHAR(64) PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL,
  created_by_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,

  name VARCHAR(64) NOT NULL,
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

${renderCompatibleColumnDefinitions(generatedTechniqueDefCompatibleColumns)}

  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE generated_technique_def IS 'AI生成功法定义（草稿+已发布）';
COMMENT ON COLUMN generated_technique_def.generation_id IS '生成功法任务ID';

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

  generated_technique_id VARCHAR(64),
  draft_expire_at TIMESTAMPTZ,
${renderCompatibleColumnDefinitions(techniqueGenerationJobCompatibleColumns)}

  error_code VARCHAR(32),
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE technique_generation_job IS 'AI生成功法任务表';
`;

const techniqueGenerationJobIndexQueries = [
  `CREATE INDEX IF NOT EXISTS idx_technique_generation_job_character_week
     ON technique_generation_job(character_id, week_key, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_technique_generation_job_status
     ON technique_generation_job(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_technique_generation_job_unread_result
     ON technique_generation_job(character_id, status, created_at DESC)
     WHERE (status = 'generated_draft' AND viewed_at IS NULL)
        OR (status IN ('failed', 'refunded') AND failed_viewed_at IS NULL)`,
] as const;

const generatedTechniqueDefIndexQueries = [
  `CREATE INDEX IF NOT EXISTS idx_generated_technique_def_generation_id
     ON generated_technique_def(generation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_generated_technique_def_published
     ON generated_technique_def(is_published, enabled, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_technique_def_normalized_name_published
     ON generated_technique_def(normalized_name)
     WHERE is_published = true AND normalized_name IS NOT NULL`,
] as const;

/**
 * 功法表初始化迁移查询
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：返回生成功法相关表的兼容升级 SQL，确保旧表先补列，再执行依赖这些列的注释与索引。
 * 2. 不做什么：不直接执行 SQL，也不处理事务边界，执行顺序由 `initTechniqueGenerationTables` 统一串行驱动。
 *
 * 输入/输出：
 * - 输入：无，使用本文件集中维护的列定义与索引定义。
 * - 输出：按安全顺序排列的 SQL 语句数组。
 *
 * 数据流/状态流：
 * 兼容列定义 -> 生成 ALTER/COMMENT/INDEX SQL -> 表初始化函数顺序执行 -> 新旧库结构统一。
 *
 * 关键边界条件与坑点：
 * 1. 旧库上 `CREATE TABLE IF NOT EXISTS` 不会补列，所以任何依赖新增列的 COMMENT/INDEX 都必须放在 ADD COLUMN 之后。
 * 2. 列定义是建表与补列的单一数据源，避免以后新增字段时只改一处导致启动阶段再次出现“表已存在但列不存在”的问题。
 */
export const getTechniqueGenerationCompatibilityQueries = (): string[] => [
  ...buildCompatibleColumnMigrationQueries(
    'generated_technique_def',
    generatedTechniqueDefCompatibleColumns,
  ),
  ...buildCompatibleColumnCommentQueries(
    'generated_technique_def',
    generatedTechniqueDefCompatibleColumns,
  ),
  ...generatedTechniqueDefIndexQueries,
  ...buildCompatibleColumnMigrationQueries(
    'technique_generation_job',
    techniqueGenerationJobCompatibleColumns,
  ),
  ...buildCompatibleColumnCommentQueries(
    'technique_generation_job',
    techniqueGenerationJobCompatibleColumns,
  ),
  ...techniqueGenerationJobIndexQueries,
];

export const initTechniqueGenerationTables = async (): Promise<void> => {
  await query(characterResearchPointsTableSQL);
  await query(researchPointsLedgerTableSQL);
  await query(generatedTechniqueDefTableSQL);
  await query(generatedSkillDefTableSQL);
  await query(generatedTechniqueLayerTableSQL);
  await query(techniqueGenerationJobTableSQL);

  for (const migrationQuery of getTechniqueGenerationCompatibilityQueries()) {
    await query(migrationQuery);
  }

  console.log('✓ AI生成功法系统表检测完成');
};
