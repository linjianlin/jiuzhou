/**
 * 九州修仙录 - 邮件系统数据表
 */
import { query } from '../config/database.js';

const mailTableSQL = `
CREATE TABLE IF NOT EXISTS mail (
  id BIGSERIAL PRIMARY KEY,
  
  -- 收件人
  recipient_user_id BIGINT NOT NULL,
  recipient_character_id BIGINT,
  
  -- 发件人（系统邮件为空）
  sender_type VARCHAR(16) NOT NULL DEFAULT 'system',   -- system/player/gm
  sender_user_id BIGINT,
  sender_character_id BIGINT,
  sender_name VARCHAR(64) NOT NULL DEFAULT '系统',
  
  -- 邮件内容
  mail_type VARCHAR(32) NOT NULL DEFAULT 'normal',     -- normal/reward/trade/gm
  title VARCHAR(128) NOT NULL,
  content TEXT NOT NULL,
  
  -- 附件（货币）
  attach_silver INTEGER NOT NULL DEFAULT 0,
  attach_spirit_stones INTEGER NOT NULL DEFAULT 0,
  
  -- 附件（物品）- 存储物品定义ID和数量
  attach_items JSONB,                                  -- [{item_def_id, qty, options?}]
  
  -- 附件（已生成的物品实例ID）- 领取时填充
  attach_instance_ids JSONB,
  
  -- 状态
  read_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  
  -- 过期
  expire_at TIMESTAMPTZ,
  
  -- 元数据
  source VARCHAR(64),                                  -- 来源标识（quest/event/trade/gm）
  source_ref_id VARCHAR(64),                           -- 来源引用ID
  metadata JSONB,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 表注释
COMMENT ON TABLE mail IS '邮件表';
COMMENT ON COLUMN mail.recipient_user_id IS '收件人用户ID';
COMMENT ON COLUMN mail.recipient_character_id IS '收件人角色ID（可为空表示账号级邮件）';
COMMENT ON COLUMN mail.sender_type IS '发件人类型（system/player/gm）';
COMMENT ON COLUMN mail.sender_name IS '发件人显示名称';
COMMENT ON COLUMN mail.mail_type IS '邮件类型（normal/reward/trade/gm）';
COMMENT ON COLUMN mail.attach_items IS '附件物品列表（物品定义）';
COMMENT ON COLUMN mail.attach_instance_ids IS '已生成的物品实例ID（领取后填充）';
COMMENT ON COLUMN mail.read_at IS '阅读时间';
COMMENT ON COLUMN mail.claimed_at IS '领取附件时间';
COMMENT ON COLUMN mail.deleted_at IS '删除时间（软删除）';
COMMENT ON COLUMN mail.expire_at IS '过期时间';

-- 索引
CREATE INDEX IF NOT EXISTS idx_mail_recipient ON mail(recipient_user_id, recipient_character_id);
CREATE INDEX IF NOT EXISTS idx_mail_unread ON mail(recipient_character_id, read_at) WHERE read_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_unclaimed ON mail(recipient_character_id, claimed_at) WHERE claimed_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mail_created ON mail(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_expire ON mail(expire_at) WHERE expire_at IS NOT NULL AND deleted_at IS NULL;
`;

export const initMailTable = async (): Promise<void> => {
  try {
    await query(mailTableSQL);
    console.log('✓ 邮件表检测完成');
  } catch (error) {
    console.error('✗ 邮件表初始化失败:', error);
    throw error;
  }
};

