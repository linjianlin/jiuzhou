/**
 * 九州修仙录 - 物品系统数据表
 * 包含：物品定义表、物品实例表、词条池表、套装表等
 */
import { query } from '../config/database.js';

// ============================================
// 1. 物品定义表 (item_def) - 静态配置
// ============================================
const itemDefTableSQL = `
CREATE TABLE IF NOT EXISTS item_def (
  id VARCHAR(64) PRIMARY KEY,                         -- 物品唯一ID（策划配置ID）
  code VARCHAR(64),                                   -- 物品英文码（检索/埋点/脚本用）
  name VARCHAR(64) NOT NULL,                          -- 物品名称
  category VARCHAR(32) NOT NULL,                      -- 物品大类（consumable/equipment/material/skillbook/quest/other）
  sub_category VARCHAR(32),                           -- 物品子类（pill/talisman/ore/weapon/armor...）
  quality CHAR(1) NOT NULL DEFAULT '黄',              -- 品质（黄/玄/地/天）
  quality_rank INTEGER NOT NULL DEFAULT 1,            -- 品质排序值（1-4）
  quality_min CHAR(1),                                -- 品质下限（为空则按 quality）
  quality_max CHAR(1),                                -- 品质上限（为空则按 quality）
  rarity VARCHAR(16),                                 -- 稀有度（common/uncommon/rare/epic/legendary）
  level INTEGER NOT NULL DEFAULT 0,                   -- 物品等级/档位
  stack_max INTEGER NOT NULL DEFAULT 1,               -- 最大堆叠数量
  bind_type VARCHAR(16) NOT NULL DEFAULT 'none',      -- 绑定类型（none/pickup/equip/use）
  tradeable BOOLEAN NOT NULL DEFAULT true,            -- 是否可交易
  sellable BOOLEAN NOT NULL DEFAULT true,             -- 是否可出售给NPC
  sell_price_silver INTEGER NOT NULL DEFAULT 0,       -- NPC回收价（银两）
  sell_price_spirit_stones INTEGER NOT NULL DEFAULT 0,-- NPC回收价（灵石）
  icon VARCHAR(256),                                  -- 图标资源路径
  model VARCHAR(256),                                 -- 模型/外观ID
  description TEXT,                                   -- 简短描述
  long_desc TEXT,                                     -- 详细描述
  tags JSONB,                                         -- 标签（筛选、套装、流派、活动）
  
  -- 使用相关
  use_type VARCHAR(32),                               -- 使用方式（instant/target/consume_on_use）
  use_cd_round INTEGER DEFAULT 0,                     -- 使用冷却（回合数）
  use_cd_sec INTEGER DEFAULT 0,                       -- 使用冷却（秒数）
  use_limit_daily INTEGER DEFAULT 0,                  -- 每日使用次数限制
  use_limit_total INTEGER DEFAULT 0,                  -- 总使用次数限制
  use_req_realm VARCHAR(64),                          -- 使用所需最低境界
  use_req_level INTEGER DEFAULT 0,                    -- 使用所需等级
  use_req_attrs JSONB,                                -- 使用属性门槛
  
  -- 装备相关
  equip_slot VARCHAR(32),                             -- 装备槽位（weapon/head/clothes/gloves/pants/necklace/accessory/artifact）
  equip_req_realm VARCHAR(64),                        -- 装备所需最低境界
  equip_req_attrs JSONB,                              -- 装备属性门槛
  
  -- 效果与属性
  battle_skill_ids JSONB,                             -- 装备/使用提供的技能ID列表
  effect_defs JSONB,                                  -- 效果定义
  base_attrs JSONB,                                   -- 基础属性
  growth_attrs JSONB,                                 -- 成长属性/强化曲线
  
  -- 词条与镶嵌
  affix_pool_id VARCHAR(64),                          -- 随机词条池ID
  affix_count_min INTEGER DEFAULT 0,                  -- 词条数量下限（覆盖品质规则）
  affix_count_max INTEGER DEFAULT 0,                  -- 词条数量上限
  socket_max INTEGER DEFAULT 0,                       -- 镶嵌孔数量上限
  gem_slot_types JSONB,                               -- 宝石孔类型限制
  
  -- 套装与合成
  set_id VARCHAR(64),                                 -- 套装ID
  composed_from JSONB,                                -- 合成来源提示
  source_hint JSONB,                                  -- 获取途径提示
  
  -- 交易相关
  market_min_price INTEGER DEFAULT 0,                 -- 交易参考最低价
  market_max_price INTEGER DEFAULT 0,                 -- 交易参考最高价
  tax_rate NUMERIC(5,2) DEFAULT 0.00,                 -- 交易税率
  
  -- 过期与唯一
  expire_seconds INTEGER DEFAULT 0,                   -- 过期秒数（0为不过期）
  expire_at TIMESTAMPTZ,                              -- 固定过期时间
  unique_type VARCHAR(32) DEFAULT 'none',             -- 唯一规则（none/global/per_character/per_account）
  unique_limit INTEGER DEFAULT 0,                     -- 唯一数量上限
  
  -- 操作限制
  quest_only BOOLEAN NOT NULL DEFAULT false,          -- 是否任务道具
  droppable BOOLEAN NOT NULL DEFAULT true,            -- 是否可丢弃
  destroyable BOOLEAN NOT NULL DEFAULT true,          -- 是否可销毁
  mailable BOOLEAN NOT NULL DEFAULT true,             -- 是否可邮寄
  storageable BOOLEAN NOT NULL DEFAULT true,          -- 是否可仓库存放
  
  -- 运营控制
  sort_weight INTEGER NOT NULL DEFAULT 0,             -- 排序权重
  version INTEGER NOT NULL DEFAULT 1,                 -- 配置版本
  enabled BOOLEAN NOT NULL DEFAULT true,              -- 是否启用
  publish_start_at TIMESTAMPTZ,                       -- 上架开始时间
  publish_end_at TIMESTAMPTZ,                         -- 下架结束时间
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 添加表注释
COMMENT ON TABLE item_def IS '物品定义表（静态配置）';
COMMENT ON COLUMN item_def.id IS '物品唯一ID（策划配置ID）';
COMMENT ON COLUMN item_def.code IS '物品英文码（检索/埋点/脚本用）';
COMMENT ON COLUMN item_def.name IS '物品名称';
COMMENT ON COLUMN item_def.category IS '物品大类（consumable/equipment/material/skillbook/quest/other）';
COMMENT ON COLUMN item_def.sub_category IS '物品子类';
COMMENT ON COLUMN item_def.quality IS '品质（黄/玄/地/天）';
COMMENT ON COLUMN item_def.quality_rank IS '品质排序值（1黄/2玄/3地/4天）';
COMMENT ON COLUMN item_def.level IS '物品等级/档位';
COMMENT ON COLUMN item_def.stack_max IS '最大堆叠数量（不可堆叠为1）';
COMMENT ON COLUMN item_def.bind_type IS '绑定类型（none/pickup/equip/use）';
COMMENT ON COLUMN item_def.equip_slot IS '装备槽位（weapon/head/clothes/gloves/pants/necklace/accessory/artifact）';
COMMENT ON COLUMN item_def.affix_pool_id IS '随机词条池ID';
COMMENT ON COLUMN item_def.set_id IS '套装ID';
COMMENT ON COLUMN item_def.enabled IS '是否启用（下架为false）';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_item_def_category ON item_def(category);
CREATE INDEX IF NOT EXISTS idx_item_def_quality ON item_def(quality);
CREATE INDEX IF NOT EXISTS idx_item_def_equip_slot ON item_def(equip_slot);
CREATE INDEX IF NOT EXISTS idx_item_def_set_id ON item_def(set_id);
CREATE INDEX IF NOT EXISTS idx_item_def_enabled ON item_def(enabled);
`;


// ============================================
// 2. 物品实例表 (item_instance) - 动态数据
// ============================================
const itemInstanceTableSQL = `
CREATE TABLE IF NOT EXISTS item_instance (
  id BIGSERIAL PRIMARY KEY,                           -- 物品实例ID
  owner_user_id BIGINT NOT NULL,                      -- 拥有者用户ID
  owner_character_id BIGINT,                          -- 拥有者角色ID（账号共享仓库可为空）
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id), -- 对应物品定义ID
  qty INTEGER NOT NULL DEFAULT 1,                     -- 数量（堆叠）
  quality CHAR(1),                                    -- 实例品质（装备生成结果；为空则按定义表）
  quality_rank INTEGER,                               -- 实例品质排序值（为空则按定义表）
  
  -- 绑定状态
  bind_type VARCHAR(16) NOT NULL DEFAULT 'none',      -- 实例绑定状态
  bind_owner_user_id BIGINT,                          -- 绑定到的用户ID
  bind_owner_character_id BIGINT,                     -- 绑定到的角色ID
  
  -- 位置信息
  location VARCHAR(16) NOT NULL DEFAULT 'bag',        -- 位置（bag/warehouse/equipped/mail/auction）
  location_slot INTEGER,                              -- 位置格子
  equipped_slot VARCHAR(32),                          -- 装备槽位（若已装备）
  
  -- 强化与精炼
  strengthen_level INTEGER DEFAULT 0,                 -- 强化等级
  refine_level INTEGER DEFAULT 0,                     -- 精炼等级
  
  -- 镶嵌与词条
  socketed_gems JSONB,                                -- 已镶嵌宝石信息
  random_seed BIGINT,                                 -- 随机种子
  affixes JSONB,                                      -- 随机词条结果
  identified BOOLEAN NOT NULL DEFAULT true,           -- 是否已鉴定
  
  -- 其他
  custom_name VARCHAR(64),                            -- 自定义名称
  locked BOOLEAN NOT NULL DEFAULT false,              -- 是否锁定
  expire_at TIMESTAMPTZ,                              -- 实例过期时间
  
  -- 来源追溯
  obtained_from VARCHAR(32),                          -- 获取来源（drop/quest/shop/craft/mail/admin）
  obtained_ref_id VARCHAR(64),                        -- 来源引用ID
  metadata JSONB,                                     -- 扩展字段
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 添加表注释
COMMENT ON TABLE item_instance IS '物品实例表（动态数据）';
COMMENT ON COLUMN item_instance.id IS '物品实例ID';
COMMENT ON COLUMN item_instance.owner_user_id IS '拥有者用户ID';
COMMENT ON COLUMN item_instance.owner_character_id IS '拥有者角色ID';
COMMENT ON COLUMN item_instance.item_def_id IS '物品定义ID';
COMMENT ON COLUMN item_instance.qty IS '数量（堆叠数量）';
COMMENT ON COLUMN item_instance.location IS '位置（bag/warehouse/equipped/mail/auction）';
COMMENT ON COLUMN item_instance.location_slot IS '位置格子（从0开始）';
COMMENT ON COLUMN item_instance.equipped_slot IS '装备槽位（已装备时记录）';
COMMENT ON COLUMN item_instance.strengthen_level IS '强化等级';
COMMENT ON COLUMN item_instance.affixes IS '随机词条结果（JSONB）';
COMMENT ON COLUMN item_instance.locked IS '是否锁定（防误操作）';
COMMENT ON COLUMN item_instance.obtained_from IS '获取来源类型';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_item_instance_owner ON item_instance(owner_user_id, owner_character_id);
CREATE INDEX IF NOT EXISTS idx_item_instance_item_def ON item_instance(item_def_id);
CREATE INDEX IF NOT EXISTS idx_item_instance_location ON item_instance(location);
CREATE INDEX IF NOT EXISTS idx_item_instance_equipped ON item_instance(equipped_slot) WHERE equipped_slot IS NOT NULL;
`;

// ============================================
// 3. 词条池表 (affix_pool) - 随机词条配置
// ============================================
const affixPoolTableSQL = `
CREATE TABLE IF NOT EXISTS affix_pool (
  id VARCHAR(64) PRIMARY KEY,                         -- 词条池ID
  name VARCHAR(64) NOT NULL,                          -- 词条池名称
  description TEXT,                                   -- 词条池说明
  
  -- 抽取规则
  rules JSONB NOT NULL,                               -- 抽取规则（条数范围、重复规则、权重等）
  
  -- 词条列表
  affixes JSONB NOT NULL,                             -- 词条定义列表
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE affix_pool IS '词条池表（随机词条配置）';
COMMENT ON COLUMN affix_pool.id IS '词条池ID';
COMMENT ON COLUMN affix_pool.name IS '词条池名称';
COMMENT ON COLUMN affix_pool.rules IS '抽取规则（条数范围、重复规则、权重等）';
COMMENT ON COLUMN affix_pool.affixes IS '词条定义列表';
`;

// ============================================
// 4. 套装定义表 (item_set)
// ============================================
const itemSetTableSQL = `
CREATE TABLE IF NOT EXISTS item_set (
  id VARCHAR(64) PRIMARY KEY,                         -- 套装ID
  name VARCHAR(64) NOT NULL,                          -- 套装名称
  description TEXT,                                   -- 套装说明
  quality_rank INTEGER NOT NULL DEFAULT 1,            -- 套装档位（1-4）
  min_realm VARCHAR(64),                              -- 最低境界门槛
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE item_set IS '套装定义表';
COMMENT ON COLUMN item_set.id IS '套装ID';
COMMENT ON COLUMN item_set.name IS '套装名称';
COMMENT ON COLUMN item_set.quality_rank IS '套装强度档位';
COMMENT ON COLUMN item_set.min_realm IS '套装最低适用境界';
`;

// ============================================
// 5. 套装件映射表 (item_set_piece)
// ============================================
const itemSetPieceTableSQL = `
CREATE TABLE IF NOT EXISTS item_set_piece (
  id BIGSERIAL PRIMARY KEY,
  set_id VARCHAR(64) NOT NULL REFERENCES item_set(id),-- 套装ID
  equip_slot VARCHAR(32) NOT NULL,                    -- 装备槽位
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id), -- 套装件物品ID
  piece_key VARCHAR(32) NOT NULL,                     -- 套装件唯一键
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(set_id, equip_slot)
);

COMMENT ON TABLE item_set_piece IS '套装件映射表';
COMMENT ON COLUMN item_set_piece.set_id IS '套装ID';
COMMENT ON COLUMN item_set_piece.equip_slot IS '装备槽位';
COMMENT ON COLUMN item_set_piece.item_def_id IS '套装件物品ID';
COMMENT ON COLUMN item_set_piece.piece_key IS '套装件唯一键';

CREATE INDEX IF NOT EXISTS idx_item_set_piece_set ON item_set_piece(set_id);
`;

// ============================================
// 6. 套装加成表 (item_set_bonus)
// ============================================
const itemSetBonusTableSQL = `
CREATE TABLE IF NOT EXISTS item_set_bonus (
  id BIGSERIAL PRIMARY KEY,
  set_id VARCHAR(64) NOT NULL REFERENCES item_set(id),-- 套装ID
  piece_count INTEGER NOT NULL,                       -- 触发件数阈值
  effect_defs JSONB NOT NULL,                         -- 套装加成效果定义
  priority INTEGER NOT NULL DEFAULT 0,                -- 优先级
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(set_id, piece_count)
);

COMMENT ON TABLE item_set_bonus IS '套装加成表';
COMMENT ON COLUMN item_set_bonus.set_id IS '套装ID';
COMMENT ON COLUMN item_set_bonus.piece_count IS '触发件数阈值';
COMMENT ON COLUMN item_set_bonus.effect_defs IS '套装加成效果定义';
COMMENT ON COLUMN item_set_bonus.priority IS '与其他效果叠加顺序';

CREATE INDEX IF NOT EXISTS idx_item_set_bonus_set ON item_set_bonus(set_id);
`;


// ============================================
// 7. 物品效果表 (item_def_effect) - 可选扩展
// ============================================
const itemDefEffectTableSQL = `
CREATE TABLE IF NOT EXISTS item_def_effect (
  id BIGSERIAL PRIMARY KEY,
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id), -- 物品定义ID
  trigger_type VARCHAR(32) NOT NULL,                  -- 触发时机（use/equip/unequip/battle_start/turn_start/on_hit/on_be_hit/on_kill/on_death）
  target_type VARCHAR(32) NOT NULL DEFAULT 'self',    -- 目标规则（self/enemy/ally/team/random）
  effect_type VARCHAR(32) NOT NULL,                   -- 效果类型（damage/heal/shield/buff/debuff/control/summon/dispel/resource）
  element VARCHAR(16),                                -- 元素（金木水火土/阴阳/无）
  value NUMERIC(12,4) DEFAULT 0,                      -- 数值（基础值）
  scale_key VARCHAR(32),                              -- 加成属性（wugong/fagong/maxQixue等）
  scale_rate NUMERIC(8,4) DEFAULT 0,                  -- 加成系数
  duration_round INTEGER DEFAULT 0,                   -- 回合持续（0为即时）
  stack_max INTEGER DEFAULT 1,                        -- 最大叠加层数
  dispel_tag VARCHAR(32),                             -- 可被驱散标签
  hit_rule JSONB,                                     -- 命中/豁免规则
  params JSONB,                                       -- 其他参数
  sort_order INTEGER NOT NULL DEFAULT 0,              -- 执行顺序
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE item_def_effect IS '物品效果表';
COMMENT ON COLUMN item_def_effect.item_def_id IS '物品定义ID';
COMMENT ON COLUMN item_def_effect.trigger_type IS '触发时机';
COMMENT ON COLUMN item_def_effect.effect_type IS '效果类型';
COMMENT ON COLUMN item_def_effect.duration_round IS '回合持续（0为即时）';

CREATE INDEX IF NOT EXISTS idx_item_def_effect_item ON item_def_effect(item_def_id);
`;

// ============================================
// 8. 物品基础属性表 (item_def_attr) - 可选扩展
// ============================================
const itemDefAttrTableSQL = `
CREATE TABLE IF NOT EXISTS item_def_attr (
  id BIGSERIAL PRIMARY KEY,
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id), -- 物品定义ID
  attr_key VARCHAR(32) NOT NULL,                      -- 属性键（qixue/maxQixue/wugong/fagong等）
  attr_value NUMERIC(12,4) NOT NULL DEFAULT 0,        -- 属性值
  apply_type VARCHAR(16) NOT NULL DEFAULT 'flat',     -- 生效方式（flat/percent）
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE item_def_attr IS '物品基础属性表';
COMMENT ON COLUMN item_def_attr.item_def_id IS '物品定义ID';
COMMENT ON COLUMN item_def_attr.attr_key IS '属性键';
COMMENT ON COLUMN item_def_attr.attr_value IS '属性值';
COMMENT ON COLUMN item_def_attr.apply_type IS '生效方式（flat固定值/percent百分比）';

CREATE INDEX IF NOT EXISTS idx_item_def_attr_item ON item_def_attr(item_def_id);
`;

// ============================================
// 9. 合成配方表 (item_recipe)
// ============================================
const itemRecipeTableSQL = `
CREATE TABLE IF NOT EXISTS item_recipe (
  id VARCHAR(64) PRIMARY KEY,                         -- 配方ID
  name VARCHAR(64) NOT NULL,                          -- 配方名称
  recipe_type VARCHAR(32) NOT NULL,                   -- 配方类型（craft/refine/decompose/upgrade）
  
  -- 产出
  product_item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id), -- 产出物品ID
  product_qty INTEGER NOT NULL DEFAULT 1,             -- 产出数量
  product_quality_min CHAR(1),                        -- 产出品质下限
  product_quality_max CHAR(1),                        -- 产出品质上限
  
  -- 消耗
  cost_silver INTEGER NOT NULL DEFAULT 0,             -- 消耗银两
  cost_spirit_stones INTEGER NOT NULL DEFAULT 0,      -- 消耗灵石
  cost_exp INTEGER NOT NULL DEFAULT 0,                -- 消耗经验
  cost_items JSONB,                                   -- 消耗材料列表
  
  -- 要求
  req_realm VARCHAR(64),                              -- 境界要求
  req_level INTEGER DEFAULT 0,                        -- 等级要求
  req_building VARCHAR(64),                           -- 建筑/功能要求
  
  -- 成功率
  success_rate NUMERIC(5,2) NOT NULL DEFAULT 100.00,  -- 成功率（百分比）
  fail_return_rate NUMERIC(5,2) DEFAULT 0.00,         -- 失败返还率
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE item_recipe IS '合成配方表';
COMMENT ON COLUMN item_recipe.id IS '配方ID';
COMMENT ON COLUMN item_recipe.recipe_type IS '配方类型（craft合成/refine精炼/decompose分解/upgrade升级）';
COMMENT ON COLUMN item_recipe.product_item_def_id IS '产出物品ID';
COMMENT ON COLUMN item_recipe.cost_items IS '消耗材料列表';
COMMENT ON COLUMN item_recipe.success_rate IS '成功率（百分比）';

CREATE INDEX IF NOT EXISTS idx_item_recipe_product ON item_recipe(product_item_def_id);
CREATE INDEX IF NOT EXISTS idx_item_recipe_type ON item_recipe(recipe_type);
`;

// ============================================
// 10. 掉落规则表 (drop_rule)
// ============================================
const dropRuleTableSQL = `
CREATE TABLE IF NOT EXISTS drop_rule (
  id BIGSERIAL PRIMARY KEY,
  source_type VARCHAR(32) NOT NULL,                   -- 来源类型（monster/boss/dungeon/chest/idle/quest）
  source_id VARCHAR(64) NOT NULL,                     -- 来源配置ID
  
  -- 掉落物
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id), -- 掉落物品ID
  chance NUMERIC(8,4) NOT NULL DEFAULT 100.0000,      -- 掉落概率（百分比）
  qty_min INTEGER NOT NULL DEFAULT 1,                 -- 数量下限
  qty_max INTEGER NOT NULL DEFAULT 1,                 -- 数量上限
  
  -- 品质控制（装备专用）
  quality_weights JSONB,                              -- 品质权重（{"黄":70,"玄":25,"地":4,"天":1}）
  
  -- 保底
  pity_group VARCHAR(64),                             -- 保底组ID
  pity_count INTEGER DEFAULT 0,                       -- 保底次数
  
  -- 条件
  req_realm VARCHAR(64),                              -- 境界要求
  req_level_min INTEGER DEFAULT 0,                    -- 等级下限
  req_level_max INTEGER DEFAULT 0,                    -- 等级上限
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE drop_rule IS '掉落规则表';
COMMENT ON COLUMN drop_rule.source_type IS '来源类型（monster/boss/dungeon/chest/idle/quest）';
COMMENT ON COLUMN drop_rule.source_id IS '来源配置ID';
COMMENT ON COLUMN drop_rule.item_def_id IS '掉落物品ID';
COMMENT ON COLUMN drop_rule.chance IS '掉落概率（百分比）';
COMMENT ON COLUMN drop_rule.quality_weights IS '品质权重';
COMMENT ON COLUMN drop_rule.pity_group IS '保底组ID';

CREATE INDEX IF NOT EXISTS idx_drop_rule_source ON drop_rule(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_drop_rule_item ON drop_rule(item_def_id);
`;


// ============================================
// 11. 商店上架表 (shop_listing)
// ============================================
const shopListingTableSQL = `
CREATE TABLE IF NOT EXISTS shop_listing (
  id BIGSERIAL PRIMARY KEY,
  shop_id VARCHAR(64) NOT NULL,                       -- 商店ID
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id), -- 商品物品ID
  
  -- 价格
  price_silver INTEGER NOT NULL DEFAULT 0,            -- 银两价格
  price_spirit_stones INTEGER NOT NULL DEFAULT 0,     -- 灵石价格
  price_special JSONB,                                -- 特殊货币价格
  
  -- 限购
  limit_daily INTEGER DEFAULT 0,                      -- 每日限购（0不限）
  limit_weekly INTEGER DEFAULT 0,                     -- 每周限购
  limit_total INTEGER DEFAULT 0,                      -- 总限购
  stock INTEGER DEFAULT -1,                           -- 库存（-1无限）
  
  -- 条件
  req_realm VARCHAR(64),                              -- 境界要求
  req_level INTEGER DEFAULT 0,                        -- 等级要求
  req_vip INTEGER DEFAULT 0,                          -- VIP等级要求
  
  -- 排序与展示
  sort_weight INTEGER NOT NULL DEFAULT 0,
  display_tag VARCHAR(32),                            -- 展示标签（hot/new/discount）
  discount_rate NUMERIC(5,2) DEFAULT 100.00,          -- 折扣率
  
  -- 运营控制
  version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true,
  publish_start_at TIMESTAMPTZ,
  publish_end_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE shop_listing IS '商店上架表';
COMMENT ON COLUMN shop_listing.shop_id IS '商店ID';
COMMENT ON COLUMN shop_listing.item_def_id IS '商品物品ID';
COMMENT ON COLUMN shop_listing.price_silver IS '银两价格';
COMMENT ON COLUMN shop_listing.price_spirit_stones IS '灵石价格';
COMMENT ON COLUMN shop_listing.limit_daily IS '每日限购（0不限）';

CREATE INDEX IF NOT EXISTS idx_shop_listing_shop ON shop_listing(shop_id);
CREATE INDEX IF NOT EXISTS idx_shop_listing_item ON shop_listing(item_def_id);
`;

// ============================================
// 12. 物品使用冷却表 (item_use_cooldown)
// ============================================
const itemUseCooldownTableSQL = `
CREATE TABLE IF NOT EXISTS item_use_cooldown (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id) ON DELETE CASCADE,
  cooldown_until TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(character_id, item_def_id)
);

COMMENT ON TABLE item_use_cooldown IS '物品使用冷却表';
COMMENT ON COLUMN item_use_cooldown.character_id IS '角色ID';
COMMENT ON COLUMN item_use_cooldown.item_def_id IS '物品定义ID';
COMMENT ON COLUMN item_use_cooldown.cooldown_until IS '冷却结束时间';

CREATE INDEX IF NOT EXISTS idx_item_use_cooldown_char ON item_use_cooldown(character_id);
CREATE INDEX IF NOT EXISTS idx_item_use_cooldown_item ON item_use_cooldown(item_def_id);
`;

// ============================================
// 13. 物品使用次数表 (item_use_count)
// ============================================
const itemUseCountTableSQL = `
CREATE TABLE IF NOT EXISTS item_use_count (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_def_id VARCHAR(64) NOT NULL REFERENCES item_def(id) ON DELETE CASCADE,

  daily_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_daily_reset DATE NOT NULL DEFAULT CURRENT_DATE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(character_id, item_def_id)
);

COMMENT ON TABLE item_use_count IS '物品使用次数表';
COMMENT ON COLUMN item_use_count.character_id IS '角色ID';
COMMENT ON COLUMN item_use_count.item_def_id IS '物品定义ID';
COMMENT ON COLUMN item_use_count.daily_count IS '当日使用次数';
COMMENT ON COLUMN item_use_count.total_count IS '累计使用次数';
COMMENT ON COLUMN item_use_count.last_daily_reset IS '最后一次日重置日期';

CREATE INDEX IF NOT EXISTS idx_item_use_count_char ON item_use_count(character_id);
CREATE INDEX IF NOT EXISTS idx_item_use_count_item ON item_use_count(item_def_id);
`;

// ============================================
// 需要检查的字段列表（用于表结构升级）
// ============================================
const itemDefColumnsToCheck = [
  { name: 'affix_count_min', type: 'INTEGER DEFAULT 0', comment: '词条数量下限' },
  { name: 'affix_count_max', type: 'INTEGER DEFAULT 0', comment: '词条数量上限' },
  { name: 'quality_min', type: 'CHAR(1)', comment: '品质下限（为空则按 quality）' },
  { name: 'quality_max', type: 'CHAR(1)', comment: '品质上限（为空则按 quality）' },
];

const itemInstanceColumnsToCheck = [
  { name: 'identified', type: 'BOOLEAN NOT NULL DEFAULT true', comment: '是否已鉴定' },
  { name: 'quality', type: 'CHAR(1)', comment: '实例品质（为空则按定义表）' },
  { name: 'quality_rank', type: 'INTEGER', comment: '实例品质排序值（为空则按定义表）' },
];

// 检查并添加缺失字段
const checkAndAddItemDefColumns = async () => {
  for (const col of itemDefColumnsToCheck) {
    try {
      const checkSQL = `
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'item_def' AND column_name = $1
      `;
      const result = await query(checkSQL, [col.name]);
      
      if (result.rows.length === 0) {
        const addSQL = `ALTER TABLE item_def ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`;
        await query(addSQL);
        
        const commentSQL = `COMMENT ON COLUMN item_def.${col.name} IS '${col.comment}'`;
        await query(commentSQL);
        
        console.log(`物品定义表已添加缺失字段: ${col.name}`);
      }
    } catch (error) {
      console.error(`检查字段 ${col.name} 时出错:`, error);
    }
  }
};

const checkAndAddItemInstanceColumns = async () => {
  for (const col of itemInstanceColumnsToCheck) {
    try {
      const checkSQL = `
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'item_instance' AND column_name = $1
      `;
      const result = await query(checkSQL, [col.name]);
      
      if (result.rows.length === 0) {
        const addSQL = `ALTER TABLE item_instance ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`;
        await query(addSQL);
        
        const commentSQL = `COMMENT ON COLUMN item_instance.${col.name} IS '${col.comment}'`;
        await query(commentSQL);
        
        console.log(`物品实例表已添加缺失字段: ${col.name}`);
      }
    } catch (error) {
      console.error(`检查字段 ${col.name} 时出错:`, error);
    }
  }
};

// ============================================
// 初始化物品系统表
// ============================================
export const initItemTables = async (): Promise<void> => {
  try {
    // 1. 创建物品定义表
    await query(itemDefTableSQL);
    
    // 2. 创建物品实例表
    await query(itemInstanceTableSQL);
    
    // 3. 创建词条池表
    await query(affixPoolTableSQL);
    
    // 4. 创建套装定义表
    await query(itemSetTableSQL);
    
    // 5. 创建套装件映射表
    await query(itemSetPieceTableSQL);
    
    // 6. 创建套装加成表
    await query(itemSetBonusTableSQL);
    
    // 7. 创建物品效果表
    await query(itemDefEffectTableSQL);
    
    // 8. 创建物品属性表
    await query(itemDefAttrTableSQL);
    
    // 9. 创建合成配方表
    await query(itemRecipeTableSQL);
    
    // 10. 创建掉落规则表
    await query(dropRuleTableSQL);
    
    // 11. 创建商店上架表
    await query(shopListingTableSQL);

    // 12. 创建物品使用冷却表
    await query(itemUseCooldownTableSQL);

    // 13. 创建物品使用次数表
    await query(itemUseCountTableSQL);
    
    // 检查并补齐缺失字段
    await checkAndAddItemDefColumns();
    await checkAndAddItemInstanceColumns();

    await query("COMMENT ON COLUMN item_def.quality_min IS '品质下限（为空则按 quality）';");
    await query("COMMENT ON COLUMN item_def.quality_max IS '品质上限（为空则按 quality）';");
    await query("COMMENT ON COLUMN item_instance.identified IS '是否已鉴定';");
    await query("COMMENT ON COLUMN item_instance.quality IS '实例品质（为空则按定义表）';");
    await query("COMMENT ON COLUMN item_instance.quality_rank IS '实例品质排序值（为空则按定义表）';");
    
    console.log('✓ 物品系统表检测完成');
  } catch (error) {
    console.error('✗ 物品系统表初始化失败:', error);
    throw error;
  }
};

