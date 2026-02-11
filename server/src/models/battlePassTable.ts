import { query } from '../config/database.js';

const battlePassSeasonDefTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_season_def (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  max_level INTEGER NOT NULL DEFAULT 30,
  exp_per_level INTEGER NOT NULL DEFAULT 1000,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE battle_pass_season_def IS '战令赛季定义表';
COMMENT ON COLUMN battle_pass_season_def.id IS '赛季ID';
COMMENT ON COLUMN battle_pass_season_def.name IS '赛季名称';
COMMENT ON COLUMN battle_pass_season_def.start_at IS '开始时间';
COMMENT ON COLUMN battle_pass_season_def.end_at IS '结束时间';
COMMENT ON COLUMN battle_pass_season_def.max_level IS '最大等级';
COMMENT ON COLUMN battle_pass_season_def.exp_per_level IS '每级所需经验';
COMMENT ON COLUMN battle_pass_season_def.enabled IS '是否启用';
COMMENT ON COLUMN battle_pass_season_def.sort_weight IS '排序权重';
COMMENT ON COLUMN battle_pass_season_def.created_at IS '创建时间';
COMMENT ON COLUMN battle_pass_season_def.updated_at IS '更新时间';
`;

const battlePassRewardDefTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_reward_def (
  season_id VARCHAR(64) NOT NULL REFERENCES battle_pass_season_def(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  free_rewards JSONB NOT NULL DEFAULT '[]'::jsonb,
  premium_rewards JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season_id, level)
);

COMMENT ON TABLE battle_pass_reward_def IS '战令奖励定义表';
COMMENT ON COLUMN battle_pass_reward_def.season_id IS '赛季ID';
COMMENT ON COLUMN battle_pass_reward_def.level IS '等级';
COMMENT ON COLUMN battle_pass_reward_def.free_rewards IS '免费奖励列表';
COMMENT ON COLUMN battle_pass_reward_def.premium_rewards IS '特权奖励列表';
COMMENT ON COLUMN battle_pass_reward_def.created_at IS '创建时间';
COMMENT ON COLUMN battle_pass_reward_def.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_battle_pass_reward_def_season ON battle_pass_reward_def(season_id);
`;

const battlePassProgressTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_progress (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  season_id VARCHAR(64) NOT NULL REFERENCES battle_pass_season_def(id) ON DELETE RESTRICT,
  exp BIGINT NOT NULL DEFAULT 0,
  premium_unlocked BOOLEAN NOT NULL DEFAULT false,
  premium_unlocked_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (character_id, season_id)
);

COMMENT ON TABLE battle_pass_progress IS '角色战令进度表';
COMMENT ON COLUMN battle_pass_progress.character_id IS '角色ID';
COMMENT ON COLUMN battle_pass_progress.season_id IS '赛季ID';
COMMENT ON COLUMN battle_pass_progress.exp IS '当前经验';
COMMENT ON COLUMN battle_pass_progress.premium_unlocked IS '是否解锁特权';
COMMENT ON COLUMN battle_pass_progress.premium_unlocked_at IS '解锁特权时间';
COMMENT ON COLUMN battle_pass_progress.created_at IS '创建时间';
COMMENT ON COLUMN battle_pass_progress.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_battle_pass_progress_season ON battle_pass_progress(season_id);
`;

const battlePassClaimRecordTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_claim_record (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  season_id VARCHAR(64) NOT NULL REFERENCES battle_pass_season_def(id) ON DELETE RESTRICT,
  level INTEGER NOT NULL,
  track VARCHAR(16) NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (character_id, season_id, level, track)
);

COMMENT ON TABLE battle_pass_claim_record IS '战令奖励领取记录表';
COMMENT ON COLUMN battle_pass_claim_record.id IS '领取记录ID';
COMMENT ON COLUMN battle_pass_claim_record.character_id IS '角色ID';
COMMENT ON COLUMN battle_pass_claim_record.season_id IS '赛季ID';
COMMENT ON COLUMN battle_pass_claim_record.level IS '等级';
COMMENT ON COLUMN battle_pass_claim_record.track IS '奖励轨道（free/premium）';
COMMENT ON COLUMN battle_pass_claim_record.claimed_at IS '领取时间';

CREATE INDEX IF NOT EXISTS idx_battle_pass_claim_record_character ON battle_pass_claim_record(character_id, claimed_at DESC);
`;

const battlePassTaskDefTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_task_def (
  id VARCHAR(64) PRIMARY KEY,
  season_id VARCHAR(64) NOT NULL REFERENCES battle_pass_season_def(id) ON DELETE CASCADE,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL,
  description TEXT,
  task_type VARCHAR(16) NOT NULL DEFAULT 'daily',
  condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_value BIGINT NOT NULL DEFAULT 1,
  reward_exp BIGINT NOT NULL DEFAULT 0,
  reward_extra JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, code)
);

COMMENT ON TABLE battle_pass_task_def IS '战令任务定义表';
COMMENT ON COLUMN battle_pass_task_def.id IS '任务ID';
COMMENT ON COLUMN battle_pass_task_def.season_id IS '赛季ID';
COMMENT ON COLUMN battle_pass_task_def.code IS '任务编码（同赛季唯一）';
COMMENT ON COLUMN battle_pass_task_def.name IS '任务名称';
COMMENT ON COLUMN battle_pass_task_def.description IS '任务描述';
COMMENT ON COLUMN battle_pass_task_def.task_type IS '任务类型（daily/weekly/season）';
COMMENT ON COLUMN battle_pass_task_def.condition IS '完成条件（事件与参数）';
COMMENT ON COLUMN battle_pass_task_def.target_value IS '目标值';
COMMENT ON COLUMN battle_pass_task_def.reward_exp IS '奖励战令经验';
COMMENT ON COLUMN battle_pass_task_def.reward_extra IS '额外奖励（列表）';
COMMENT ON COLUMN battle_pass_task_def.enabled IS '是否启用';
COMMENT ON COLUMN battle_pass_task_def.sort_weight IS '排序权重';
COMMENT ON COLUMN battle_pass_task_def.created_at IS '创建时间';
COMMENT ON COLUMN battle_pass_task_def.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_battle_pass_task_def_season_type ON battle_pass_task_def(season_id, task_type, enabled);
`;

const battlePassTaskProgressTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_task_progress (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  season_id VARCHAR(64) NOT NULL REFERENCES battle_pass_season_def(id) ON DELETE RESTRICT,
  task_id VARCHAR(64) NOT NULL REFERENCES battle_pass_task_def(id) ON DELETE CASCADE,
  progress_value BIGINT NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ DEFAULT NULL,
  claimed BOOLEAN NOT NULL DEFAULT false,
  claimed_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (character_id, season_id, task_id)
);

COMMENT ON TABLE battle_pass_task_progress IS '角色战令任务进度表';
COMMENT ON COLUMN battle_pass_task_progress.character_id IS '角色ID';
COMMENT ON COLUMN battle_pass_task_progress.season_id IS '赛季ID';
COMMENT ON COLUMN battle_pass_task_progress.task_id IS '任务ID';
COMMENT ON COLUMN battle_pass_task_progress.progress_value IS '当前进度值';
COMMENT ON COLUMN battle_pass_task_progress.completed IS '是否完成';
COMMENT ON COLUMN battle_pass_task_progress.completed_at IS '完成时间';
COMMENT ON COLUMN battle_pass_task_progress.claimed IS '是否已领取';
COMMENT ON COLUMN battle_pass_task_progress.claimed_at IS '领取时间';
COMMENT ON COLUMN battle_pass_task_progress.created_at IS '创建时间';
COMMENT ON COLUMN battle_pass_task_progress.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_battle_pass_task_progress_character ON battle_pass_task_progress(character_id, season_id, claimed, completed);
`;

export const initBattlePassTables = async (): Promise<void> => {
  await query(battlePassSeasonDefTableSQL);
  await query(battlePassRewardDefTableSQL);
  await query(battlePassProgressTableSQL);
  await query(battlePassClaimRecordTableSQL);
  await query(battlePassTaskDefTableSQL);
  await query(battlePassTaskProgressTableSQL);
  console.log('✓ 战令系统表检测完成');
};

