import { query } from '../config/database.js';

const monthCardOwnershipTableSQL = `
CREATE TABLE IF NOT EXISTS month_card_ownership (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  month_card_id VARCHAR(64) NOT NULL,
  start_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expire_at TIMESTAMPTZ NOT NULL,
  last_claim_date DATE DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(character_id, month_card_id)
);

COMMENT ON TABLE month_card_ownership IS '角色月卡持有表';
COMMENT ON COLUMN month_card_ownership.id IS '持有记录ID';
COMMENT ON COLUMN month_card_ownership.character_id IS '角色ID';
COMMENT ON COLUMN month_card_ownership.month_card_id IS '月卡ID';
COMMENT ON COLUMN month_card_ownership.start_at IS '开始时间';
COMMENT ON COLUMN month_card_ownership.expire_at IS '到期时间';
COMMENT ON COLUMN month_card_ownership.last_claim_date IS '最后领取日期';
COMMENT ON COLUMN month_card_ownership.created_at IS '创建时间';
COMMENT ON COLUMN month_card_ownership.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_month_card_ownership_character ON month_card_ownership(character_id);
CREATE INDEX IF NOT EXISTS idx_month_card_ownership_expire ON month_card_ownership(expire_at);
`;

const monthCardClaimRecordTableSQL = `
CREATE TABLE IF NOT EXISTS month_card_claim_record (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  month_card_id VARCHAR(64) NOT NULL,
  claim_date DATE NOT NULL,
  reward_spirit_stones INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(character_id, month_card_id, claim_date)
);

COMMENT ON TABLE month_card_claim_record IS '月卡每日领取记录表';
COMMENT ON COLUMN month_card_claim_record.id IS '领取记录ID';
COMMENT ON COLUMN month_card_claim_record.character_id IS '角色ID';
COMMENT ON COLUMN month_card_claim_record.month_card_id IS '月卡ID';
COMMENT ON COLUMN month_card_claim_record.claim_date IS '领取日期';
COMMENT ON COLUMN month_card_claim_record.reward_spirit_stones IS '领取灵石数量';
COMMENT ON COLUMN month_card_claim_record.created_at IS '创建时间';

CREATE INDEX IF NOT EXISTS idx_month_card_claim_record_character_date ON month_card_claim_record(character_id, claim_date DESC);
`;

export const initMonthCardTables = async (): Promise<void> => {
  await query(monthCardOwnershipTableSQL);
  await query(monthCardClaimRecordTableSQL);
  console.log('✓ 月卡系统表检测完成');
};
