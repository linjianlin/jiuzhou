import { query } from '../config/database.js';

const dungeonDefTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_def (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  type VARCHAR(32) NOT NULL,
  category VARCHAR(32),
  description TEXT,
  icon VARCHAR(256),
  background VARCHAR(256),
  min_players INTEGER NOT NULL DEFAULT 1,
  max_players INTEGER NOT NULL DEFAULT 4,
  min_realm VARCHAR(64),
  recommended_realm VARCHAR(64),
  unlock_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  daily_limit INTEGER NOT NULL DEFAULT 0,
  weekly_limit INTEGER NOT NULL DEFAULT 0,
  stamina_cost INTEGER NOT NULL DEFAULT 0,
  time_limit_sec INTEGER NOT NULL DEFAULT 0,
  revive_limit INTEGER NOT NULL DEFAULT 3,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dungeon_def IS '副本秘境定义表';
COMMENT ON COLUMN dungeon_def.id IS '秘境ID';
COMMENT ON COLUMN dungeon_def.name IS '秘境名称';
COMMENT ON COLUMN dungeon_def.type IS '类型（material/equipment/trial/challenge/event）';
COMMENT ON COLUMN dungeon_def.category IS '分类（五行/流派/境界等）';
COMMENT ON COLUMN dungeon_def.description IS '秘境描述';
COMMENT ON COLUMN dungeon_def.icon IS '图标';
COMMENT ON COLUMN dungeon_def.background IS '背景图';
COMMENT ON COLUMN dungeon_def.min_players IS '最少人数';
COMMENT ON COLUMN dungeon_def.max_players IS '最多人数';
COMMENT ON COLUMN dungeon_def.min_realm IS '最低境界要求';
COMMENT ON COLUMN dungeon_def.recommended_realm IS '推荐境界';
COMMENT ON COLUMN dungeon_def.unlock_condition IS '解锁条件';
COMMENT ON COLUMN dungeon_def.daily_limit IS '每日次数限制（0=不限）';
COMMENT ON COLUMN dungeon_def.weekly_limit IS '每周次数限制（0=不限）';
COMMENT ON COLUMN dungeon_def.stamina_cost IS '体力消耗';
COMMENT ON COLUMN dungeon_def.time_limit_sec IS '时间限制（秒，0=不限）';
COMMENT ON COLUMN dungeon_def.revive_limit IS '复活次数限制';
COMMENT ON COLUMN dungeon_def.tags IS '标签';
COMMENT ON COLUMN dungeon_def.sort_weight IS '排序权重';
COMMENT ON COLUMN dungeon_def.enabled IS '是否启用';
COMMENT ON COLUMN dungeon_def.version IS '版本';
COMMENT ON COLUMN dungeon_def.created_at IS '创建时间';

CREATE INDEX IF NOT EXISTS idx_dungeon_def_enabled_sort ON dungeon_def(enabled, sort_weight DESC);
CREATE INDEX IF NOT EXISTS idx_dungeon_def_type ON dungeon_def(type);
`;

const dungeonDifficultyTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_difficulty (
  id VARCHAR(64) PRIMARY KEY,
  dungeon_id VARCHAR(64) NOT NULL REFERENCES dungeon_def(id) ON DELETE CASCADE,
  name VARCHAR(32) NOT NULL,
  difficulty_rank INTEGER NOT NULL,
  monster_level_add INTEGER NOT NULL DEFAULT 0,
  monster_attr_mult NUMERIC(8,4) NOT NULL DEFAULT 1.0,
  reward_mult NUMERIC(8,4) NOT NULL DEFAULT 1.0,
  min_realm VARCHAR(64),
  unlock_prev_difficulty BOOLEAN NOT NULL DEFAULT FALSE,
  first_clear_rewards JSONB NOT NULL DEFAULT '{}'::jsonb,
  drop_pool_id VARCHAR(64),
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE dungeon_difficulty IS '副本秘境难度配置表';
COMMENT ON COLUMN dungeon_difficulty.id IS '难度ID';
COMMENT ON COLUMN dungeon_difficulty.dungeon_id IS '秘境ID';
COMMENT ON COLUMN dungeon_difficulty.name IS '难度名称（普通/困难/地狱/炼狱）';
COMMENT ON COLUMN dungeon_difficulty.difficulty_rank IS '难度等级（1-5）';
COMMENT ON COLUMN dungeon_difficulty.monster_level_add IS '怪物等级加成';
COMMENT ON COLUMN dungeon_difficulty.monster_attr_mult IS '怪物属性倍率';
COMMENT ON COLUMN dungeon_difficulty.reward_mult IS '奖励倍率';
COMMENT ON COLUMN dungeon_difficulty.min_realm IS '最低境界要求';
COMMENT ON COLUMN dungeon_difficulty.unlock_prev_difficulty IS '是否需要通关前一难度';
COMMENT ON COLUMN dungeon_difficulty.first_clear_rewards IS '首通奖励';
COMMENT ON COLUMN dungeon_difficulty.drop_pool_id IS '掉落池ID';
COMMENT ON COLUMN dungeon_difficulty.enabled IS '是否启用';

CREATE INDEX IF NOT EXISTS idx_dungeon_difficulty_dungeon ON dungeon_difficulty(dungeon_id, difficulty_rank);
CREATE INDEX IF NOT EXISTS idx_dungeon_difficulty_enabled ON dungeon_difficulty(enabled);
`;

const dungeonStageTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_stage (
  id VARCHAR(64) PRIMARY KEY,
  difficulty_id VARCHAR(64) NOT NULL REFERENCES dungeon_difficulty(id) ON DELETE CASCADE,
  stage_index INTEGER NOT NULL,
  name VARCHAR(64),
  type VARCHAR(32) NOT NULL,
  description TEXT,
  time_limit_sec INTEGER NOT NULL DEFAULT 0,
  clear_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  fail_condition JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage_rewards JSONB NOT NULL DEFAULT '{}'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE(difficulty_id, stage_index)
);

COMMENT ON TABLE dungeon_stage IS '副本秘境关卡配置表';
COMMENT ON COLUMN dungeon_stage.id IS '关卡ID';
COMMENT ON COLUMN dungeon_stage.difficulty_id IS '难度ID';
COMMENT ON COLUMN dungeon_stage.stage_index IS '关卡序号';
COMMENT ON COLUMN dungeon_stage.name IS '关卡名称';
COMMENT ON COLUMN dungeon_stage.type IS '关卡类型（battle/boss/event/rest）';
COMMENT ON COLUMN dungeon_stage.description IS '关卡描述';
COMMENT ON COLUMN dungeon_stage.time_limit_sec IS '本关时间限制（秒，0=不限）';
COMMENT ON COLUMN dungeon_stage.clear_condition IS '通关条件';
COMMENT ON COLUMN dungeon_stage.fail_condition IS '失败条件';
COMMENT ON COLUMN dungeon_stage.stage_rewards IS '关卡奖励';
COMMENT ON COLUMN dungeon_stage.events IS '事件配置';

CREATE INDEX IF NOT EXISTS idx_dungeon_stage_difficulty ON dungeon_stage(difficulty_id, stage_index);
CREATE INDEX IF NOT EXISTS idx_dungeon_stage_type ON dungeon_stage(type);
`;

const dungeonWaveTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_wave (
  id BIGSERIAL PRIMARY KEY,
  stage_id VARCHAR(64) NOT NULL REFERENCES dungeon_stage(id) ON DELETE CASCADE,
  wave_index INTEGER NOT NULL,
  spawn_delay_sec INTEGER NOT NULL DEFAULT 0,
  monsters JSONB NOT NULL DEFAULT '[]'::jsonb,
  wave_rewards JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(stage_id, wave_index)
);

COMMENT ON TABLE dungeon_wave IS '副本秘境波次配置表';
COMMENT ON COLUMN dungeon_wave.id IS '主键';
COMMENT ON COLUMN dungeon_wave.stage_id IS '关卡ID';
COMMENT ON COLUMN dungeon_wave.wave_index IS '波次序号';
COMMENT ON COLUMN dungeon_wave.spawn_delay_sec IS '出怪延迟（秒）';
COMMENT ON COLUMN dungeon_wave.monsters IS '怪物配置列表';
COMMENT ON COLUMN dungeon_wave.wave_rewards IS '波次奖励';

CREATE INDEX IF NOT EXISTS idx_dungeon_wave_stage ON dungeon_wave(stage_id, wave_index);
`;

const dungeonInstanceTableSQL = `
CREATE TABLE IF NOT EXISTS dungeon_instance (
  id VARCHAR(64) PRIMARY KEY,
  dungeon_id VARCHAR(64) NOT NULL REFERENCES dungeon_def(id) ON DELETE RESTRICT,
  difficulty_id VARCHAR(64) NOT NULL REFERENCES dungeon_difficulty(id) ON DELETE RESTRICT,
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
COMMENT ON COLUMN dungeon_instance.dungeon_id IS '秘境ID';
COMMENT ON COLUMN dungeon_instance.difficulty_id IS '难度ID';
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
  dungeon_id VARCHAR(64) NOT NULL REFERENCES dungeon_def(id) ON DELETE RESTRICT,
  difficulty_id VARCHAR(64) NOT NULL REFERENCES dungeon_difficulty(id) ON DELETE RESTRICT,
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
COMMENT ON COLUMN dungeon_record.dungeon_id IS '秘境ID';
COMMENT ON COLUMN dungeon_record.difficulty_id IS '难度ID';
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
  dungeon_id VARCHAR(64) NOT NULL REFERENCES dungeon_def(id) ON DELETE CASCADE,
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
COMMENT ON COLUMN dungeon_entry_count.dungeon_id IS '秘境ID';
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
    await query(dungeonDefTableSQL);
    console.log('  → 副本秘境定义表检测完成');

    await query(dungeonDifficultyTableSQL);
    console.log('  → 副本秘境难度表检测完成');

    await query(dungeonStageTableSQL);
    console.log('  → 副本秘境关卡表检测完成');

    await query(dungeonWaveTableSQL);
    console.log('  → 副本秘境波次表检测完成');

    await query(dungeonInstanceTableSQL);
    console.log('  → 副本秘境实例表检测完成');

    await query(dungeonRecordTableSQL);
    console.log('  → 副本秘境记录表检测完成');

    await query(dungeonEntryCountTableSQL);
    console.log('  → 副本秘境次数表检测完成');

    console.log('✓ 副本秘境系统表检测完成');
  } catch (error) {
    console.error('✗ 副本秘境系统表初始化失败:', error);
    throw error;
  }
};


