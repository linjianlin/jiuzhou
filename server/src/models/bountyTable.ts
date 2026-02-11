import { query } from '../config/database.js';

const bountyDefTableSQL = `
CREATE TABLE IF NOT EXISTS bounty_def (
  id VARCHAR(64) PRIMARY KEY,
  pool VARCHAR(32) NOT NULL DEFAULT 'daily',
  task_id VARCHAR(64) NOT NULL REFERENCES task_def(id) ON DELETE CASCADE,
  title VARCHAR(128) NOT NULL,
  description TEXT,
  claim_policy VARCHAR(16) NOT NULL DEFAULT 'limited',
  max_claims INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bounty_def IS '悬赏定义表（用于每日随机刷新等，静态配置）';
COMMENT ON COLUMN bounty_def.id IS '悬赏定义ID';
COMMENT ON COLUMN bounty_def.pool IS '悬赏池（daily每日刷新等）';
COMMENT ON COLUMN bounty_def.task_id IS '关联任务ID（task_def.id）';
COMMENT ON COLUMN bounty_def.title IS '悬赏标题';
COMMENT ON COLUMN bounty_def.description IS '悬赏描述';
COMMENT ON COLUMN bounty_def.claim_policy IS '接取规则（unique唯一/limited限次/unlimited不限）';
COMMENT ON COLUMN bounty_def.max_claims IS '总接取次数上限（limited时使用，0表示不限制）';
COMMENT ON COLUMN bounty_def.weight IS '抽取权重（越大越容易被抽到）';
COMMENT ON COLUMN bounty_def.enabled IS '是否启用';
COMMENT ON COLUMN bounty_def.version IS '配置版本';
COMMENT ON COLUMN bounty_def.created_at IS '创建时间';
COMMENT ON COLUMN bounty_def.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_bounty_def_pool_enabled ON bounty_def(pool, enabled, weight DESC, id ASC);
`;

const bountyInstanceTableSQL = `
CREATE TABLE IF NOT EXISTS bounty_instance (
  id BIGSERIAL PRIMARY KEY,
  source_type VARCHAR(16) NOT NULL DEFAULT 'daily',
  bounty_def_id VARCHAR(64) REFERENCES bounty_def(id) ON DELETE SET NULL,
  task_id VARCHAR(64) NOT NULL REFERENCES task_def(id) ON DELETE CASCADE,
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
COMMENT ON COLUMN bounty_instance.task_id IS '关联任务ID（task_def.id）';
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
  await query(bountyDefTableSQL);
  await query(bountyInstanceTableSQL);
  await query(bountyClaimTableSQL);
  console.log('✓ 悬赏系统表检测完成');
};

