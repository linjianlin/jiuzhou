import { query } from '../config/database.js';

const characterAchievementTableSQL = `
CREATE TABLE IF NOT EXISTS character_achievement (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  achievement_id VARCHAR(64) NOT NULL,
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

const characterTitleTableSQL = `
CREATE TABLE IF NOT EXISTS character_title (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title_id VARCHAR(64) NOT NULL,
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

export const initAchievementTables = async (): Promise<void> => {
  await query(characterAchievementTableSQL);
  await query(characterAchievementPointsTableSQL);
  await query(characterTitleTableSQL);
  console.log('✓ 成就与称号系统表检测完成');
};
