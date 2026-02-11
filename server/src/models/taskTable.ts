import { query } from '../config/database.js';

const taskDefTableSQL = `
CREATE TABLE IF NOT EXISTS task_def (
  id VARCHAR(64) PRIMARY KEY,
  category VARCHAR(16) NOT NULL DEFAULT 'main',
  title VARCHAR(128) NOT NULL,
  realm VARCHAR(64) NOT NULL DEFAULT '凡人',
  description TEXT,
  giver_npc_id VARCHAR(64),
  map_id VARCHAR(64),
  room_id VARCHAR(64),
  objectives JSONB NOT NULL DEFAULT '[]'::jsonb,
  rewards JSONB NOT NULL DEFAULT '[]'::jsonb,
  prereq_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE task_def IS '任务定义表（主线/支线/日常/活动，静态配置）';
COMMENT ON COLUMN task_def.id IS '任务ID';
COMMENT ON COLUMN task_def.category IS '任务类别（main主线/side支线/daily日常/event活动）';
COMMENT ON COLUMN task_def.title IS '任务标题';
COMMENT ON COLUMN task_def.description IS '任务描述';
COMMENT ON COLUMN task_def.giver_npc_id IS '发布NPC ID（可为空）';
COMMENT ON COLUMN task_def.map_id IS '任务发生地图ID（可为空）';
COMMENT ON COLUMN task_def.room_id IS '任务发生房间ID（可为空）';
COMMENT ON COLUMN task_def.objectives IS '任务目标列表（JSON）';
COMMENT ON COLUMN task_def.rewards IS '任务奖励列表（JSON）';
COMMENT ON COLUMN task_def.prereq_task_ids IS '前置任务ID列表（JSON）';
COMMENT ON COLUMN task_def.enabled IS '是否启用';
COMMENT ON COLUMN task_def.sort_weight IS '排序权重';
COMMENT ON COLUMN task_def.version IS '配置版本';
COMMENT ON COLUMN task_def.created_at IS '创建时间';
COMMENT ON COLUMN task_def.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_task_def_category_enabled ON task_def(category, enabled, sort_weight DESC);

ALTER TABLE task_def ADD COLUMN IF NOT EXISTS realm VARCHAR(64) NOT NULL DEFAULT '凡人';
COMMENT ON COLUMN task_def.realm IS '推荐境界';
ALTER TABLE task_def DROP COLUMN IF EXISTS level;
`;

const characterTaskProgressTableSQL = `
CREATE TABLE IF NOT EXISTS character_task_progress (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  task_id VARCHAR(64) NOT NULL REFERENCES task_def(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'ongoing',
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  tracked BOOLEAN NOT NULL DEFAULT false,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (character_id, task_id)
);

COMMENT ON TABLE character_task_progress IS '角色任务进度表';
COMMENT ON COLUMN character_task_progress.id IS '进度记录ID';
COMMENT ON COLUMN character_task_progress.character_id IS '角色ID';
COMMENT ON COLUMN character_task_progress.task_id IS '任务ID';
COMMENT ON COLUMN character_task_progress.status IS '任务状态（ongoing进行中/claimable可领取/completed已完成/claimed已领取）';
COMMENT ON COLUMN character_task_progress.progress IS '进度数据（JSON）';
COMMENT ON COLUMN character_task_progress.tracked IS '是否追踪';
COMMENT ON COLUMN character_task_progress.accepted_at IS '接取时间';
COMMENT ON COLUMN character_task_progress.completed_at IS '完成时间';
COMMENT ON COLUMN character_task_progress.claimed_at IS '领取时间';
COMMENT ON COLUMN character_task_progress.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_character_task_progress_character_status ON character_task_progress(character_id, status, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_character_task_progress_tracked ON character_task_progress(character_id, tracked);
`;

export const initTaskTables = async (): Promise<void> => {
  await query(taskDefTableSQL);
  await query(characterTaskProgressTableSQL);
  console.log('✓ 任务系统表检测完成');
};

