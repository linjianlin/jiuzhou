import { query } from '../config/database.js';

const battlePassProgressTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_progress (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  season_id VARCHAR(64) NOT NULL,
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
  season_id VARCHAR(64) NOT NULL,
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

const battlePassTaskProgressTableSQL = `
CREATE TABLE IF NOT EXISTS battle_pass_task_progress (
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  season_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(64) NOT NULL,
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
  await query(battlePassProgressTableSQL);
  await query(battlePassClaimRecordTableSQL);
  await query(battlePassTaskProgressTableSQL);
  await query('ALTER TABLE battle_pass_claim_record DROP CONSTRAINT IF EXISTS battle_pass_claim_record_season_id_fkey');
  console.log('✓ 战令系统表检测完成');
};
