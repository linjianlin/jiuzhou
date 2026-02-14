import { query } from '../config/database.js';

const dungeonInstanceTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_instance (
  id VARCHAR(64) PRIMARY KEY,
  dungeon_id VARCHAR(64) NOT NULL,                    -- 秘境ID（静态配置ID）
  difficulty_id VARCHAR(64) NOT NULL,                 -- 难度ID（静态配置ID）
  creator_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  team_id VARCHAR(64) REFERENCES teams(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'preparing',
  current_stage INTEGER NOT NULL DEFAULT 1,
  current_wave INTEGER NOT NULL DEFAULT 1,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  time_spent_sec INTEGER NOT NULL DEFAULT 0,
  total_damage BIGINT NOT NULL DEFAULT 0,
  death_count INTEGER NOT NULL DEFAULT 0,
  rewards_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  instance_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dungeon_instance IS '副本秘境实例表';
COMMENT ON COLUMN dungeon_instance.id IS '实例ID';
COMMENT ON COLUMN dungeon_instance.dungeon_id IS '秘境ID（静态配置ID）';
COMMENT ON COLUMN dungeon_instance.difficulty_id IS '难度ID（静态配置ID）';
COMMENT ON COLUMN dungeon_instance.creator_id IS '创建者角色ID';
COMMENT ON COLUMN dungeon_instance.team_id IS '队伍ID';
COMMENT ON COLUMN dungeon_instance.status IS '状态（preparing/running/cleared/failed/abandoned）';
COMMENT ON COLUMN dungeon_instance.current_stage IS '当前关卡序号';
COMMENT ON COLUMN dungeon_instance.current_wave IS '当前波次序号';
COMMENT ON COLUMN dungeon_instance.participants IS '参与者列表';
COMMENT ON COLUMN dungeon_instance.start_time IS '开始时间';
COMMENT ON COLUMN dungeon_instance.end_time IS '结束时间';
COMMENT ON COLUMN dungeon_instance.time_spent_sec IS '耗时（秒）';
COMMENT ON COLUMN dungeon_instance.total_damage IS '总伤害';
COMMENT ON COLUMN dungeon_instance.death_count IS '死亡次数';
COMMENT ON COLUMN dungeon_instance.rewards_claimed IS '是否已领取奖励';
COMMENT ON COLUMN dungeon_instance.instance_data IS '实例数据（进度、状态等）';
COMMENT ON COLUMN dungeon_instance.created_at IS '创建时间';

CREATE INDEX IF NOT EXISTS idx_dungeon_instance_creator ON dungeon_instance(creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dungeon_instance_status ON dungeon_instance(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dungeon_instance_team ON dungeon_instance(team_id);
`;

const dungeonRecordTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_record (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  dungeon_id VARCHAR(64) NOT NULL,                    -- 秘境ID（静态配置ID）
  difficulty_id VARCHAR(64) NOT NULL,                 -- 难度ID（静态配置ID）
  instance_id VARCHAR(64) REFERENCES dungeon_instance(id) ON DELETE SET NULL,
  result VARCHAR(32) NOT NULL,
  time_spent_sec INTEGER NOT NULL DEFAULT 0,
  damage_dealt BIGINT NOT NULL DEFAULT 0,
  damage_taken BIGINT NOT NULL DEFAULT 0,
  healing_done BIGINT NOT NULL DEFAULT 0,
  death_count INTEGER NOT NULL DEFAULT 0,
  score VARCHAR(1),
  rewards JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_first_clear BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dungeon_record IS '副本秘境通关记录表';
COMMENT ON COLUMN dungeon_record.id IS '记录ID';
COMMENT ON COLUMN dungeon_record.character_id IS '角色ID';
COMMENT ON COLUMN dungeon_record.dungeon_id IS '秘境ID（静态配置ID）';
COMMENT ON COLUMN dungeon_record.difficulty_id IS '难度ID（静态配置ID）';
COMMENT ON COLUMN dungeon_record.instance_id IS '实例ID';
COMMENT ON COLUMN dungeon_record.result IS '结果（cleared/failed/abandoned）';
COMMENT ON COLUMN dungeon_record.time_spent_sec IS '耗时（秒）';
COMMENT ON COLUMN dungeon_record.damage_dealt IS '造成伤害';
COMMENT ON COLUMN dungeon_record.damage_taken IS '承受伤害';
COMMENT ON COLUMN dungeon_record.healing_done IS '治疗量';
COMMENT ON COLUMN dungeon_record.death_count IS '死亡次数';
COMMENT ON COLUMN dungeon_record.score IS '评分（S/A/B/C/D）';
COMMENT ON COLUMN dungeon_record.rewards IS '获得奖励';
COMMENT ON COLUMN dungeon_record.is_first_clear IS '是否首通';
COMMENT ON COLUMN dungeon_record.completed_at IS '完成时间';

CREATE INDEX IF NOT EXISTS idx_dungeon_record_char ON dungeon_record(character_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dungeon_record_dungeon ON dungeon_record(dungeon_id, completed_at DESC);
`;

const dungeonEntryCountTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_entry_count (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  dungeon_id VARCHAR(64) NOT NULL,                    -- 秘境ID（静态配置ID）
  daily_count INTEGER NOT NULL DEFAULT 0,
  weekly_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_daily_reset DATE,
  last_weekly_reset DATE,
  UNIQUE(character_id, dungeon_id)
);

COMMENT ON TABLE dungeon_entry_count IS '副本秘境次数统计表';
COMMENT ON COLUMN dungeon_entry_count.id IS '主键';
COMMENT ON COLUMN dungeon_entry_count.character_id IS '角色ID';
COMMENT ON COLUMN dungeon_entry_count.dungeon_id IS '秘境ID（静态配置ID）';
COMMENT ON COLUMN dungeon_entry_count.daily_count IS '今日次数';
COMMENT ON COLUMN dungeon_entry_count.weekly_count IS '本周次数';
COMMENT ON COLUMN dungeon_entry_count.total_count IS '总次数';
COMMENT ON COLUMN dungeon_entry_count.last_daily_reset IS '上次日重置日期';
COMMENT ON COLUMN dungeon_entry_count.last_weekly_reset IS '上次周重置日期';

CREATE INDEX IF NOT EXISTS idx_dungeon_entry_count_char ON dungeon_entry_count(character_id);
CREATE INDEX IF NOT EXISTS idx_dungeon_entry_count_dungeon ON dungeon_entry_count(dungeon_id);
`;

export const initDungeonTables = async (): Promise<void> => {
  try {
    console.log('  → 副本秘境定义/难度/关卡/波次改为静态JSON加载，跳过建表');

    await query(dungeonInstanceTableSQL);
    console.log('  → 副本秘境实例表检测完成');

    await query(dungeonRecordTableSQL);
    console.log('  → 副本秘境记录表检测完成');

    await query(dungeonEntryCountTableSQL);
    console.log('  → 副本秘境次数表检测完成');

    await query('ALTER TABLE dungeon_instance DROP CONSTRAINT IF EXISTS dungeon_instance_difficulty_id_fkey');
    await query('ALTER TABLE dungeon_record DROP CONSTRAINT IF EXISTS dungeon_record_difficulty_id_fkey');
    await query('ALTER TABLE dungeon_instance DROP CONSTRAINT IF EXISTS dungeon_instance_dungeon_id_fkey');
    await query('ALTER TABLE dungeon_record DROP CONSTRAINT IF EXISTS dungeon_record_dungeon_id_fkey');
    await query('ALTER TABLE dungeon_entry_count DROP CONSTRAINT IF EXISTS dungeon_entry_count_dungeon_id_fkey');

    console.log('✓ 副本秘境系统表检测完成');
  } catch (error) {
    console.error('✗ 副本秘境系统表初始化失败:', error);
    throw error;
  }
};
