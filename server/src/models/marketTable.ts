import { query } from '../config/database.js';

const marketListingTableSQL = `
CREATE TABLE IF NOT EXISTS market_listing (
  id BIGSERIAL PRIMARY KEY,
  seller_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_instance_id BIGINT REFERENCES item_instance(id) ON DELETE SET NULL,
  item_def_id VARCHAR(64) NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_spirit_stones BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  buyer_user_id BIGINT REFERENCES users(id),
  buyer_character_id BIGINT REFERENCES characters(id),
  listed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sold_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE market_listing IS '坊市上架表';
COMMENT ON COLUMN market_listing.id IS '上架ID';
COMMENT ON COLUMN market_listing.seller_user_id IS '卖家用户ID';
COMMENT ON COLUMN market_listing.seller_character_id IS '卖家角色ID';
COMMENT ON COLUMN market_listing.item_instance_id IS '上架物品实例ID';
COMMENT ON COLUMN market_listing.item_def_id IS '物品定义ID';
COMMENT ON COLUMN market_listing.qty IS '上架数量';
COMMENT ON COLUMN market_listing.unit_price_spirit_stones IS '单价（灵石）';
COMMENT ON COLUMN market_listing.status IS '状态（active/sold/cancelled）';
COMMENT ON COLUMN market_listing.buyer_user_id IS '买家用户ID';
COMMENT ON COLUMN market_listing.buyer_character_id IS '买家角色ID';
COMMENT ON COLUMN market_listing.listed_at IS '上架时间';
COMMENT ON COLUMN market_listing.sold_at IS '售出时间';
COMMENT ON COLUMN market_listing.cancelled_at IS '下架时间';
COMMENT ON COLUMN market_listing.updated_at IS '更新时间';

CREATE INDEX IF NOT EXISTS idx_market_listing_status_listed_at ON market_listing(status, listed_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_listing_item_def_id ON market_listing(item_def_id);
CREATE INDEX IF NOT EXISTS idx_market_listing_seller_character ON market_listing(seller_character_id);
CREATE INDEX IF NOT EXISTS idx_market_listing_buyer_character ON market_listing(buyer_character_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_market_listing_active_item_instance
  ON market_listing(item_instance_id)
  WHERE status = 'active';
`;

const marketTradeRecordTableSQL = `
CREATE TABLE IF NOT EXISTS market_trade_record (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT REFERENCES market_listing(id),
  buyer_user_id BIGINT NOT NULL REFERENCES users(id),
  buyer_character_id BIGINT NOT NULL REFERENCES characters(id),
  seller_user_id BIGINT NOT NULL REFERENCES users(id),
  seller_character_id BIGINT NOT NULL REFERENCES characters(id),
  item_def_id VARCHAR(64) NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_spirit_stones BIGINT NOT NULL,
  total_price_spirit_stones BIGINT NOT NULL,
  tax_spirit_stones BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE market_trade_record IS '坊市交易记录表';
COMMENT ON COLUMN market_trade_record.id IS '交易记录ID';
COMMENT ON COLUMN market_trade_record.listing_id IS '上架ID';
COMMENT ON COLUMN market_trade_record.buyer_user_id IS '买家用户ID';
COMMENT ON COLUMN market_trade_record.buyer_character_id IS '买家角色ID';
COMMENT ON COLUMN market_trade_record.seller_user_id IS '卖家用户ID';
COMMENT ON COLUMN market_trade_record.seller_character_id IS '卖家角色ID';
COMMENT ON COLUMN market_trade_record.item_def_id IS '物品定义ID';
COMMENT ON COLUMN market_trade_record.qty IS '成交数量';
COMMENT ON COLUMN market_trade_record.unit_price_spirit_stones IS '成交单价（灵石）';
COMMENT ON COLUMN market_trade_record.total_price_spirit_stones IS '成交总价（灵石）';
COMMENT ON COLUMN market_trade_record.tax_spirit_stones IS '税费（灵石）';
COMMENT ON COLUMN market_trade_record.created_at IS '成交时间';

CREATE INDEX IF NOT EXISTS idx_market_trade_record_buyer_time ON market_trade_record(buyer_character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_trade_record_seller_time ON market_trade_record(seller_character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_trade_record_item_def_id ON market_trade_record(item_def_id);
`;

export const initMarketTable = async (): Promise<void> => {
  await query(marketListingTableSQL);
  await query(marketTradeRecordTableSQL);

  await query(`ALTER TABLE market_listing DROP CONSTRAINT IF EXISTS market_listing_item_def_id_fkey`);
  await query(`ALTER TABLE market_trade_record DROP CONSTRAINT IF EXISTS market_trade_record_item_def_id_fkey`);

  // 迁移：将 item_instance_id 外键从 ON DELETE RESTRICT 改为 ON DELETE SET NULL
  try {
    const fkCheck = await query(`
      SELECT con.conname, col.is_nullable
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN information_schema.columns col
        ON col.table_name = 'market_listing' AND col.column_name = 'item_instance_id'
      WHERE rel.relname = 'market_listing'
        AND con.conname = 'market_listing_item_instance_id_fkey'
        AND con.confdeltype = 'r'
    `);
    if (fkCheck.rows.length > 0) {
      await query(`ALTER TABLE market_listing DROP CONSTRAINT market_listing_item_instance_id_fkey`);
      await query(`ALTER TABLE market_listing ALTER COLUMN item_instance_id DROP NOT NULL`);
      await query(`ALTER TABLE market_listing ADD CONSTRAINT market_listing_item_instance_id_fkey FOREIGN KEY (item_instance_id) REFERENCES item_instance(id) ON DELETE SET NULL`);
      console.log('  ✓ market_listing.item_instance_id 外键已迁移为 ON DELETE SET NULL');
    }
  } catch (e) {
    // 约束不存在或已迁移，忽略
  }

  console.log('✓ 坊市系统表检测完成');
};
