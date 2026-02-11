import { query } from '../config/database.js';

const sectDefTableSQL = `
CREATE TABLE IF NOT EXISTS sect_def (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(64) UNIQUE NOT NULL,
  leader_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  level INTEGER NOT NULL DEFAULT 1,
  exp BIGINT NOT NULL DEFAULT 0,
  funds BIGINT NOT NULL DEFAULT 0,
  reputation BIGINT NOT NULL DEFAULT 0,
  build_points INTEGER NOT NULL DEFAULT 0,
  announcement TEXT,
  description TEXT,
  icon VARCHAR(256),
  join_type VARCHAR(32) NOT NULL DEFAULT 'apply',
  join_min_realm VARCHAR(64) NOT NULL DEFAULT '凡人',
  member_count INTEGER NOT NULL DEFAULT 1,
  max_members INTEGER NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sect_def IS '宗门定义表';
COMMENT ON COLUMN sect_def.id IS '宗门ID';
COMMENT ON COLUMN sect_def.name IS '宗门名称（唯一）';
COMMENT ON COLUMN sect_def.leader_id IS '宗主角色ID';
COMMENT ON COLUMN sect_def.level IS '宗门等级';
COMMENT ON COLUMN sect_def.exp IS '宗门经验';
COMMENT ON COLUMN sect_def.funds IS '宗门资金';
COMMENT ON COLUMN sect_def.reputation IS '宗门声望';
COMMENT ON COLUMN sect_def.build_points IS '建设点';
COMMENT ON COLUMN sect_def.announcement IS '宗门公告';
COMMENT ON COLUMN sect_def.description IS '宗门简介';
COMMENT ON COLUMN sect_def.icon IS '宗门图标';
COMMENT ON COLUMN sect_def.join_type IS '加入方式（open/apply/invite）';
COMMENT ON COLUMN sect_def.join_min_realm IS '加入最低境界';
COMMENT ON COLUMN sect_def.member_count IS '当前成员数';
COMMENT ON COLUMN sect_def.max_members IS '最大成员数';
COMMENT ON COLUMN sect_def.created_at IS '创建时间';
COMMENT ON COLUMN sect_def.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_sect_def_name ON sect_def(name);
CREATE INDEX IF NOT EXISTS idx_sect_def_leader ON sect_def(leader_id);
`;

const sectMemberTableSQL = `
CREATE TABLE IF NOT EXISTS sect_member (
  id BIGSERIAL PRIMARY KEY,
  sect_id VARCHAR(64) NOT NULL REFERENCES sect_def(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
  position VARCHAR(32) NOT NULL DEFAULT 'disciple',
  contribution BIGINT NOT NULL DEFAULT 0,
  weekly_contribution INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sect_member IS '宗门成员表';
COMMENT ON COLUMN sect_member.id IS '成员记录ID';
COMMENT ON COLUMN sect_member.sect_id IS '宗门ID';
COMMENT ON COLUMN sect_member.character_id IS '角色ID（唯一，只能加入一个宗门）';
COMMENT ON COLUMN sect_member.position IS '职位（leader/vice_leader/elder/elite/disciple）';
COMMENT ON COLUMN sect_member.contribution IS '累计贡献';
COMMENT ON COLUMN sect_member.weekly_contribution IS '本周贡献';
COMMENT ON COLUMN sect_member.joined_at IS '加入时间';

CREATE INDEX IF NOT EXISTS idx_sect_member_sect ON sect_member(sect_id);
CREATE INDEX IF NOT EXISTS idx_sect_member_char ON sect_member(character_id);
`;

const sectApplicationTableSQL = `
CREATE TABLE IF NOT EXISTS sect_application (
  id BIGSERIAL PRIMARY KEY,
  sect_id VARCHAR(64) NOT NULL REFERENCES sect_def(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  message TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_at TIMESTAMPTZ,
  handled_by INTEGER REFERENCES characters(id) ON DELETE SET NULL
);

COMMENT ON TABLE sect_application IS '宗门申请表';
COMMENT ON COLUMN sect_application.id IS '申请记录ID';
COMMENT ON COLUMN sect_application.sect_id IS '宗门ID';
COMMENT ON COLUMN sect_application.character_id IS '申请角色ID';
COMMENT ON COLUMN sect_application.message IS '申请留言';
COMMENT ON COLUMN sect_application.status IS '申请状态（pending/approved/rejected/cancelled）';
COMMENT ON COLUMN sect_application.created_at IS '申请时间';
COMMENT ON COLUMN sect_application.handled_at IS '处理时间';
COMMENT ON COLUMN sect_application.handled_by IS '处理人角色ID';

CREATE INDEX IF NOT EXISTS idx_sect_application_sect_status ON sect_application(sect_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sect_application_character ON sect_application(character_id, created_at DESC);
`;

const sectBuildingTableSQL = `
CREATE TABLE IF NOT EXISTS sect_building (
  id BIGSERIAL PRIMARY KEY,
  sect_id VARCHAR(64) NOT NULL REFERENCES sect_def(id) ON DELETE CASCADE,
  building_type VARCHAR(64) NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'normal',
  upgrade_start_at TIMESTAMPTZ,
  upgrade_end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sect_id, building_type)
);

COMMENT ON TABLE sect_building IS '宗门建筑表';
COMMENT ON COLUMN sect_building.id IS '建筑记录ID';
COMMENT ON COLUMN sect_building.sect_id IS '宗门ID';
COMMENT ON COLUMN sect_building.building_type IS '建筑类型';
COMMENT ON COLUMN sect_building.level IS '建筑等级';
COMMENT ON COLUMN sect_building.status IS '建筑状态';
COMMENT ON COLUMN sect_building.upgrade_start_at IS '升级开始时间';
COMMENT ON COLUMN sect_building.upgrade_end_at IS '升级结束时间';
COMMENT ON COLUMN sect_building.created_at IS '创建时间';
COMMENT ON COLUMN sect_building.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_sect_building_sect ON sect_building(sect_id);
`;

const sectQuestProgressTableSQL = `
CREATE TABLE IF NOT EXISTS sect_quest_progress (
  id BIGSERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  quest_id VARCHAR(64) NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress',
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(character_id, quest_id)
);

COMMENT ON TABLE sect_quest_progress IS '宗门任务进度表';
COMMENT ON COLUMN sect_quest_progress.id IS '进度记录ID';
COMMENT ON COLUMN sect_quest_progress.character_id IS '角色ID';
COMMENT ON COLUMN sect_quest_progress.quest_id IS '任务ID';
COMMENT ON COLUMN sect_quest_progress.progress IS '当前进度';
COMMENT ON COLUMN sect_quest_progress.status IS '状态（in_progress/completed/claimed）';
COMMENT ON COLUMN sect_quest_progress.accepted_at IS '接取时间';
COMMENT ON COLUMN sect_quest_progress.completed_at IS '完成时间';

CREATE INDEX IF NOT EXISTS idx_sect_quest_progress_character ON sect_quest_progress(character_id, status, accepted_at DESC);
`;

const sectLogTableSQL = `
CREATE TABLE IF NOT EXISTS sect_log (
  id BIGSERIAL PRIMARY KEY,
  sect_id VARCHAR(64) NOT NULL REFERENCES sect_def(id) ON DELETE CASCADE,
  log_type VARCHAR(32) NOT NULL,
  operator_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  target_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sect_log IS '宗门日志表';
COMMENT ON COLUMN sect_log.id IS '日志ID';
COMMENT ON COLUMN sect_log.sect_id IS '宗门ID';
COMMENT ON COLUMN sect_log.log_type IS '日志类型';
COMMENT ON COLUMN sect_log.operator_id IS '操作人角色ID';
COMMENT ON COLUMN sect_log.target_id IS '目标角色ID';
COMMENT ON COLUMN sect_log.content IS '日志内容';
COMMENT ON COLUMN sect_log.created_at IS '创建时间';

CREATE INDEX IF NOT EXISTS idx_sect_log_sect_time ON sect_log(sect_id, created_at DESC);
`;

export const initSectTables = async (): Promise<void> => {
  await query(sectDefTableSQL);
  await query(sectMemberTableSQL);
  await query(sectApplicationTableSQL);
  await query(sectBuildingTableSQL);
  await query(sectQuestProgressTableSQL);
  await query(sectLogTableSQL);
  console.log('✓ 宗门系统表检测完成');
};


