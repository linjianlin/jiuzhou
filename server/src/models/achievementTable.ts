import { query } from '../config/database.js';

const achievementDefTableSQL = `
CREATE TABLE IF NOT EXISTS achievement_def (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category VARCHAR(32) NOT NULL DEFAULT 'combat',
  rarity VARCHAR(32) NOT NULL DEFAULT 'common',
  points INTEGER NOT NULL DEFAULT 0,
  icon VARCHAR(256),
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  prerequisite_id VARCHAR(64),
  track_type VARCHAR(16) NOT NULL DEFAULT 'counter',
  track_key VARCHAR(128) NOT NULL,
  target_value INTEGER NOT NULL DEFAULT 1,
  target_list JSONB NOT NULL DEFAULT '[]'::jsonb,
  rewards JSONB NOT NULL DEFAULT '[]'::jsonb,
  title_id VARCHAR(64),
  sort_weight INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_achievement_prerequisite
    FOREIGN KEY (prerequisite_id) REFERENCES achievement_def(id)
    ON DELETE SET NULL
);

COMMENT ON TABLE achievement_def IS '成就定义表（静态配置）';
COMMENT ON COLUMN achievement_def.id IS '成就ID';
COMMENT ON COLUMN achievement_def.name IS '成就名称';
COMMENT ON COLUMN achievement_def.description IS '成就描述';
COMMENT ON COLUMN achievement_def.category IS '成就分类';
COMMENT ON COLUMN achievement_def.rarity IS '稀有度';
COMMENT ON COLUMN achievement_def.points IS '成就点数';
COMMENT ON COLUMN achievement_def.icon IS '图标';
COMMENT ON COLUMN achievement_def.hidden IS '是否隐藏';
COMMENT ON COLUMN achievement_def.prerequisite_id IS '前置成就ID';
COMMENT ON COLUMN achievement_def.track_type IS '追踪类型：counter/flag/multi';
COMMENT ON COLUMN achievement_def.track_key IS '追踪键';
COMMENT ON COLUMN achievement_def.target_value IS '目标值（counter/flag）';
COMMENT ON COLUMN achievement_def.target_list IS '目标列表（multi）';
COMMENT ON COLUMN achievement_def.rewards IS '奖励配置';
COMMENT ON COLUMN achievement_def.title_id IS '达成后可解锁称号ID（领取时发放）';
COMMENT ON COLUMN achievement_def.sort_weight IS '排序权重';
COMMENT ON COLUMN achievement_def.enabled IS '是否启用';
COMMENT ON COLUMN achievement_def.version IS '配置版本';

CREATE INDEX IF NOT EXISTS idx_achievement_def_category_enabled
  ON achievement_def(category, enabled, sort_weight DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_achievement_def_track_key
  ON achievement_def(track_key);
`;

const characterAchievementTableSQL = `
CREATE TABLE IF NOT EXISTS character_achievement (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  achievement_id VARCHAR(64) NOT NULL REFERENCES achievement_def(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress',
  progress INTEGER NOT NULL DEFAULT 0,
  progress_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(character_id, achievement_id)
);

COMMENT ON TABLE character_achievement IS '角色成就进度表';
COMMENT ON COLUMN character_achievement.status IS '状态：in_progress/completed/claimed';
COMMENT ON COLUMN character_achievement.progress IS '数值进度';
COMMENT ON COLUMN character_achievement.progress_data IS '扩展进度（multi）';

CREATE INDEX IF NOT EXISTS idx_character_achievement_character
  ON character_achievement(character_id, achievement_id);
CREATE INDEX IF NOT EXISTS idx_character_achievement_status
  ON character_achievement(character_id, status, updated_at DESC);
`;

const characterAchievementPointsTableSQL = `
CREATE TABLE IF NOT EXISTS character_achievement_points (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  total_points INTEGER NOT NULL DEFAULT 0,
  combat_points INTEGER NOT NULL DEFAULT 0,
  cultivation_points INTEGER NOT NULL DEFAULT 0,
  exploration_points INTEGER NOT NULL DEFAULT 0,
  social_points INTEGER NOT NULL DEFAULT 0,
  collection_points INTEGER NOT NULL DEFAULT 0,
  claimed_thresholds JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE character_achievement_points IS '角色成就点数统计表';
COMMENT ON COLUMN character_achievement_points.claimed_thresholds IS '已领取点数阈值';
`;

const titleDefTableSQL = `
CREATE TABLE IF NOT EXISTS title_def (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rarity VARCHAR(32) NOT NULL DEFAULT 'common',
  color VARCHAR(32),
  icon VARCHAR(256),
  effects JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type VARCHAR(32),
  source_id VARCHAR(64),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE title_def IS '称号定义表';
COMMENT ON COLUMN title_def.effects IS '称号属性效果定义';

CREATE INDEX IF NOT EXISTS idx_title_def_source
  ON title_def(source_type, source_id);
`;

const characterTitleTableSQL = `
CREATE TABLE IF NOT EXISTS character_title (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title_id VARCHAR(64) NOT NULL REFERENCES title_def(id) ON DELETE CASCADE,
  is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(character_id, title_id)
);

COMMENT ON TABLE character_title IS '角色称号拥有与装备状态';

CREATE INDEX IF NOT EXISTS idx_character_title_character
  ON character_title(character_id, obtained_at DESC);
CREATE INDEX IF NOT EXISTS idx_character_title_equipped
  ON character_title(character_id, is_equipped);
`;

const achievementPointsRewardDefTableSQL = `
CREATE TABLE IF NOT EXISTS achievement_points_reward_def (
  id VARCHAR(64) PRIMARY KEY,
  points_threshold INTEGER NOT NULL UNIQUE,
  name VARCHAR(64) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rewards JSONB NOT NULL DEFAULT '[]'::jsonb,
  title_id VARCHAR(64),
  sort_weight INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_points_reward_title
    FOREIGN KEY (title_id) REFERENCES title_def(id)
    ON DELETE SET NULL
);

COMMENT ON TABLE achievement_points_reward_def IS '成就点数阈值奖励定义';
COMMENT ON COLUMN achievement_points_reward_def.points_threshold IS '领取阈值';

CREATE INDEX IF NOT EXISTS idx_achievement_points_reward_enabled
  ON achievement_points_reward_def(enabled, points_threshold ASC, sort_weight DESC);
`;

export const initAchievementTables = async (): Promise<void> => {
  await query(achievementDefTableSQL);
  await query(characterAchievementTableSQL);
  await query(characterAchievementPointsTableSQL);
  await query(titleDefTableSQL);
  await query(characterTitleTableSQL);
  await query(achievementPointsRewardDefTableSQL);
  console.log('✓ 成就与称号系统表检测完成');
};

