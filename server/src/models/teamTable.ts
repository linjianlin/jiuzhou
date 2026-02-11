import { query } from '../config/database.js';

/**
 * 九州修仙录 - 组队系统数据表
 * 包含：队伍表、队伍成员表、入队申请表、入队邀请表
 */

// 队伍表
const teamTableSQL = `
CREATE TABLE IF NOT EXISTS teams (
  id VARCHAR(64) PRIMARY KEY,                         -- 队伍ID (UUID)
  name VARCHAR(50) NOT NULL,                          -- 队伍名称
  leader_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE, -- 队长角色ID
  goal VARCHAR(50) DEFAULT '组队冒险',                -- 队伍目标
  join_min_realm VARCHAR(50) DEFAULT '凡人',          -- 申请最低境界要求
  auto_join_enabled BOOLEAN DEFAULT FALSE,            -- 是否开启自动入队
  auto_join_min_realm VARCHAR(50) DEFAULT '凡人',     -- 自动入队最低境界
  max_members INTEGER DEFAULT 5,                      -- 最大成员数
  current_map_id VARCHAR(64) DEFAULT NULL,            -- 队伍当前地图ID（用于附近队伍查询）
  is_public BOOLEAN DEFAULT TRUE,                     -- 是否公开（大厅可见）
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 创建时间
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP      -- 更新时间
);

-- 添加表注释
COMMENT ON TABLE teams IS '队伍表';
COMMENT ON COLUMN teams.id IS '队伍ID (UUID)';
COMMENT ON COLUMN teams.name IS '队伍名称';
COMMENT ON COLUMN teams.leader_id IS '队长角色ID';
COMMENT ON COLUMN teams.goal IS '队伍目标';
COMMENT ON COLUMN teams.join_min_realm IS '申请最低境界要求';
COMMENT ON COLUMN teams.auto_join_enabled IS '是否开启自动入队';
COMMENT ON COLUMN teams.auto_join_min_realm IS '自动入队最低境界';
COMMENT ON COLUMN teams.max_members IS '最大成员数';
COMMENT ON COLUMN teams.current_map_id IS '队伍当前地图ID';
COMMENT ON COLUMN teams.is_public IS '是否公开';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_teams_leader_id ON teams(leader_id);
CREATE INDEX IF NOT EXISTS idx_teams_current_map_id ON teams(current_map_id);
CREATE INDEX IF NOT EXISTS idx_teams_is_public ON teams(is_public);
`;

// 队伍成员表
const teamMemberTableSQL = `
CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,                              -- 记录ID
  team_id VARCHAR(64) NOT NULL REFERENCES teams(id) ON DELETE CASCADE, -- 队伍ID
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE, -- 角色ID
  role VARCHAR(20) DEFAULT 'member',                  -- 角色：leader/member
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,      -- 加入时间
  
  UNIQUE(team_id, character_id),                      -- 同一队伍不能重复加入
  UNIQUE(character_id)                                -- 一个角色只能在一个队伍
);

-- 添加表注释
COMMENT ON TABLE team_members IS '队伍成员表';
COMMENT ON COLUMN team_members.team_id IS '队伍ID';
COMMENT ON COLUMN team_members.character_id IS '角色ID';
COMMENT ON COLUMN team_members.role IS '角色：leader队长/member队员';
COMMENT ON COLUMN team_members.joined_at IS '加入时间';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_character_id ON team_members(character_id);
`;

// 入队申请表
const teamApplicationTableSQL = `
CREATE TABLE IF NOT EXISTS team_applications (
  id VARCHAR(64) PRIMARY KEY,                         -- 申请ID (UUID)
  team_id VARCHAR(64) NOT NULL REFERENCES teams(id) ON DELETE CASCADE, -- 队伍ID
  applicant_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE, -- 申请者角色ID
  message VARCHAR(200) DEFAULT NULL,                  -- 申请留言
  status VARCHAR(20) DEFAULT 'pending',               -- 状态：pending/approved/rejected/expired
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 申请时间
  handled_at TIMESTAMP DEFAULT NULL,                  -- 处理时间
  
  UNIQUE(team_id, applicant_id, status)               -- 同一队伍同一状态不能重复申请
);

-- 添加表注释
COMMENT ON TABLE team_applications IS '入队申请表';
COMMENT ON COLUMN team_applications.team_id IS '队伍ID';
COMMENT ON COLUMN team_applications.applicant_id IS '申请者角色ID';
COMMENT ON COLUMN team_applications.message IS '申请留言';
COMMENT ON COLUMN team_applications.status IS '状态：pending待处理/approved已通过/rejected已拒绝/expired已过期';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_team_applications_team_id ON team_applications(team_id);
CREATE INDEX IF NOT EXISTS idx_team_applications_applicant_id ON team_applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_team_applications_status ON team_applications(status);
`;

// 入队邀请表
const teamInvitationTableSQL = `
CREATE TABLE IF NOT EXISTS team_invitations (
  id VARCHAR(64) PRIMARY KEY,                         -- 邀请ID (UUID)
  team_id VARCHAR(64) NOT NULL REFERENCES teams(id) ON DELETE CASCADE, -- 队伍ID
  inviter_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE, -- 邀请者角色ID
  invitee_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE, -- 被邀请者角色ID
  message VARCHAR(200) DEFAULT NULL,                  -- 邀请留言
  status VARCHAR(20) DEFAULT 'pending',               -- 状态：pending/accepted/rejected/expired
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,     -- 邀请时间
  handled_at TIMESTAMP DEFAULT NULL,                  -- 处理时间
  
  UNIQUE(team_id, invitee_id, status)                 -- 同一队伍同一状态不能重复邀请
);

-- 添加表注释
COMMENT ON TABLE team_invitations IS '入队邀请表';
COMMENT ON COLUMN team_invitations.team_id IS '队伍ID';
COMMENT ON COLUMN team_invitations.inviter_id IS '邀请者角色ID';
COMMENT ON COLUMN team_invitations.invitee_id IS '被邀请者角色ID';
COMMENT ON COLUMN team_invitations.message IS '邀请留言';
COMMENT ON COLUMN team_invitations.status IS '状态：pending待处理/accepted已接受/rejected已拒绝/expired已过期';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_team_invitations_team_id ON team_invitations(team_id);
CREATE INDEX IF NOT EXISTS idx_team_invitations_invitee_id ON team_invitations(invitee_id);
CREATE INDEX IF NOT EXISTS idx_team_invitations_status ON team_invitations(status);
`;

// 初始化组队相关表
export const initTeamTables = async (): Promise<void> => {
  try {
    // 创建队伍表
    await query(teamTableSQL);
    console.log('  → 队伍表检测完成');

    // 创建队伍成员表
    await query(teamMemberTableSQL);
    console.log('  → 队伍成员表检测完成');

    // 创建入队申请表
    await query(teamApplicationTableSQL);
    console.log('  → 入队申请表检测完成');

    // 创建入队邀请表
    await query(teamInvitationTableSQL);
    console.log('  → 入队邀请表检测完成');

    console.log('✓ 组队系统表检测完成');
  } catch (error) {
    console.error('✗ 组队系统表初始化失败:', error);
    throw error;
  }
};

