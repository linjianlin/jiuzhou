import { query } from '../config/database.js';

const arenaRatingTableSQL = `
CREATE TABLE IF NOT EXISTS arena_rating (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1000,
  win_count INTEGER NOT NULL DEFAULT 0,
  lose_count INTEGER NOT NULL DEFAULT 0,
  last_battle_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE arena_rating IS '竞技场积分表（每个角色的积分与胜负统计）';
COMMENT ON COLUMN arena_rating.character_id IS '角色ID';
COMMENT ON COLUMN arena_rating.rating IS '当前积分（默认1000）';
COMMENT ON COLUMN arena_rating.win_count IS '胜场次数';
COMMENT ON COLUMN arena_rating.lose_count IS '败场次数';
COMMENT ON COLUMN arena_rating.last_battle_at IS '最近一次战斗时间';
COMMENT ON COLUMN arena_rating.created_at IS '创建时间';
COMMENT ON COLUMN arena_rating.updated_at IS '更新时间';
`;

const arenaBattleTableSQL = `
CREATE TABLE IF NOT EXISTS arena_battle (
  battle_id VARCHAR(128) PRIMARY KEY,
  challenger_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  opponent_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'running',
  result VARCHAR(16),
  delta_score INTEGER NOT NULL DEFAULT 0,
  score_before INTEGER,
  score_after INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

COMMENT ON TABLE arena_battle IS '竞技场挑战记录表（每次挑战一条记录）';
COMMENT ON COLUMN arena_battle.battle_id IS '战斗ID（与战斗系统battleId一致）';
COMMENT ON COLUMN arena_battle.challenger_character_id IS '挑战者角色ID';
COMMENT ON COLUMN arena_battle.opponent_character_id IS '被挑战者角色ID';
COMMENT ON COLUMN arena_battle.status IS '状态（running进行中/finished已结算）';
COMMENT ON COLUMN arena_battle.result IS '结果（win胜/lose败/draw平）';
COMMENT ON COLUMN arena_battle.delta_score IS '积分变化（胜+10，败-5，最低0）';
COMMENT ON COLUMN arena_battle.score_before IS '结算前积分';
COMMENT ON COLUMN arena_battle.score_after IS '结算后积分';
COMMENT ON COLUMN arena_battle.created_at IS '创建时间';
COMMENT ON COLUMN arena_battle.finished_at IS '结算时间';

CREATE INDEX IF NOT EXISTS idx_arena_battle_challenger_time ON arena_battle(challenger_character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arena_battle_opponent_time ON arena_battle(opponent_character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arena_battle_status_time ON arena_battle(status, created_at DESC);
`;

export const initArenaTables = async (): Promise<void> => {
  await query(arenaRatingTableSQL);
  await query(arenaBattleTableSQL);
  console.log('✓ 竞技场系统表检测完成');
};

