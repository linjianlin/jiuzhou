import { query } from '../config/database.js';

const bountyInstanceTableSQL = `
CREATE TABLE IF NOT EXISTS bounty_instance (
  id BIGSERIAL PRIMARY KEY,
  source_type VARCHAR(16) NOT NULL DEFAULT 'daily',
  bounty_def_id VARCHAR(64),
  task_id VARCHAR(64) NOT NULL,
  title VARCHAR(128) NOT NULL,
  description TEXT,
  claim_policy VARCHAR(16) NOT NULL DEFAULT 'limited',
  max_claims INTEGER NOT NULL DEFAULT 0,
  claimed_count INTEGER NOT NULL DEFAULT 0,
  refresh_date DATE,
  expires_at TIMESTAMPTZ,
  published_by_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  spirit_stones_reward BIGINT NOT NULL DEFAULT 0,
  silver_reward BIGINT NOT NULL DEFAULT 0,
  spirit_stones_fee BIGINT NOT NULL DEFAULT 0,
  silver_fee BIGINT NOT NULL DEFAULT 0,
  required_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bounty_instance IS '悬赏实例表（每日刷新/玩家发布，动态数据）';
COMMENT ON COLUMN bounty_instance.id IS '悬赏实例ID';
COMMENT ON COLUMN bounty_instance.source_type IS '来源类型（daily每日/ player玩家）';
COMMENT ON COLUMN bounty_instance.bounty_def_id IS '关联悬赏定义ID（每日刷新来源）';
COMMENT ON COLUMN bounty_instance.task_id IS '关联任务ID（静态或动态）';
COMMENT ON COLUMN bounty_instance.title IS '悬赏标题';
COMMENT ON COLUMN bounty_instance.description IS '悬赏描述';
COMMENT ON COLUMN bounty_instance.claim_policy IS '接取规则（unique唯一/limited限次/unlimited不限）';
COMMENT ON COLUMN bounty_instance.max_claims IS '总接取次数上限（limited时使用，0表示不限制）';
COMMENT ON COLUMN bounty_instance.claimed_count IS '已接取次数';
COMMENT ON COLUMN bounty_instance.refresh_date IS '每日刷新日期（source_type=daily时）';
COMMENT ON COLUMN bounty_instance.expires_at IS '过期时间（可为空）';
COMMENT ON COLUMN bounty_instance.published_by_character_id IS '发布者角色ID（玩家发布时）';
COMMENT ON COLUMN bounty_instance.created_at IS '创建时间';
COMMENT ON COLUMN bounty_instance.updated_at IS '更新时间';

ALTER TABLE bounty_instance ADD COLUMN IF NOT EXISTS spirit_stones_reward BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bounty_instance ADD COLUMN IF NOT EXISTS silver_reward BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bounty_instance ADD COLUMN IF NOT EXISTS spirit_stones_fee BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bounty_instance ADD COLUMN IF NOT EXISTS silver_fee BIGINT NOT NULL DEFAULT 0;
ALTER TABLE bounty_instance ADD COLUMN IF NOT EXISTS required_items JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN bounty_instance.spirit_stones_reward IS '灵石悬赏奖励（玩家发布）';
COMMENT ON COLUMN bounty_instance.silver_reward IS '银两悬赏奖励（玩家发布）';
COMMENT ON COLUMN bounty_instance.spirit_stones_fee IS '灵石手续费（10%）';
COMMENT ON COLUMN bounty_instance.silver_fee IS '银两手续费（10%）';
COMMENT ON COLUMN bounty_instance.required_items IS '提交材料要求（JSON数组：item_def_id/name/qty）';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bounty_instance_daily_def_date ON bounty_instance(source_type, refresh_date, bounty_def_id);
CREATE INDEX IF NOT EXISTS idx_bounty_instance_daily_date ON bounty_instance(source_type, refresh_date, id DESC);
CREATE INDEX IF NOT EXISTS idx_bounty_instance_expires ON bounty_instance(expires_at);
`;

const bountyClaimTableSQL = `
CREATE TABLE IF NOT EXISTS bounty_claim (
  id BIGSERIAL PRIMARY KEY,
  bounty_instance_id BIGINT NOT NULL REFERENCES bounty_instance(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL DEFAULT 'claimed',
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bounty_instance_id, character_id)
);

COMMENT ON TABLE bounty_claim IS '悬赏接取记录表（记录角色对悬赏的接取情况）';
COMMENT ON COLUMN bounty_claim.id IS '接取记录ID';
COMMENT ON COLUMN bounty_claim.bounty_instance_id IS '悬赏实例ID';
COMMENT ON COLUMN bounty_claim.character_id IS '角色ID';
COMMENT ON COLUMN bounty_claim.status IS '状态（claimed已接取/completed已完成/rewarded已领奖/canceled已取消）';
COMMENT ON COLUMN bounty_claim.claimed_at IS '接取时间';
COMMENT ON COLUMN bounty_claim.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_bounty_claim_character ON bounty_claim(character_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bounty_claim_instance ON bounty_claim(bounty_instance_id, claimed_at DESC);
`;

export const initBountyTables = async (): Promise<void> => {
  await query(bountyInstanceTableSQL);
  await query(bountyClaimTableSQL);
  await query('ALTER TABLE bounty_instance DROP CONSTRAINT IF EXISTS bounty_instance_bounty_def_id_fkey');
  await query('ALTER TABLE bounty_instance DROP CONSTRAINT IF EXISTS bounty_instance_task_id_fkey');
  console.log('✓ 悬赏系统表检测完成');
};
