use std::collections::HashMap;
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

use crate::application::static_data::seed::read_seed_json;
use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::inventory::InventoryRouteServices;

static INVENTORY_ITEM_DEF_INDEX: OnceLock<
    Result<HashMap<String, InventoryItemDefinitionView>, String>,
> = OnceLock::new();

const DEFAULT_BAG_CAPACITY: i32 = 100;
const DEFAULT_WAREHOUSE_CAPACITY: i32 = 1000;
const INVENTORY_ITEMS_PAGE_SIZE_MAX: i64 = 200;

/**
 * inventory 最小只读应用服务。
 *
 * 作用：
 * 1. 做什么：为 `/api/inventory/info`、`/api/inventory/bag/snapshot`、`/api/inventory/items` 提供统一只读查询入口。
 * 2. 做什么：实例数据走 PostgreSQL，静态物品定义走 Node 权威 `item_def.json` 并做模块级缓存，避免每次请求重复解析种子。
 * 3. 不做什么：不实现 inventory mutation，不补套装/词条 roll/生成功法等更大富化链路，也不伪造不存在的字段。
 *
 * 输入 / 输出：
 * - 输入：`character_id`，以及列表查询额外接收 `location/page/page_size`。
 * - 输出：`InventoryInfoView`、`InventoryBagSnapshotView`、`InventoryItemsPageView`。
 *
 * 数据流 / 状态流：
 * - 路由层完成鉴权与角色解析 -> 本服务查询 `inventory/item_instance`
 * - -> 统一按 `item_def_id` 从静态索引补最小定义视图
 * - -> 路由层继续包装为 Node 兼容 success envelope。
 *
 * 复用设计说明：
 * - `info/items/bag snapshot` 共用同一套实例查询与静态定义富化，避免三个 handler 各自重复拼 SQL、重复构建 `item_def_id -> def` 映射。
 * - 静态定义索引放在模块级 `OnceLock`，高频打开背包时不会重复读大 JSON 文件；背包快照也复用同一索引，减少双列表重复工作。
 *
 * 关键边界条件与坑点：
 * 1. `location` 合法性由路由层维持 Node 文案；服务层只接受已经归一化的枚举，避免校验逻辑分散。
 * 2. 静态定义缺失时必须继续返回物品实例本体并让 `def` 为 `null/缺失`，不能为了凑字段伪造定义。
 */
#[derive(Debug, Clone)]
pub struct RustInventoryReadService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InventoryLocation {
    Bag,
    Warehouse,
    Equipped,
}

impl InventoryLocation {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "bag" => Some(Self::Bag),
            "warehouse" => Some(Self::Warehouse),
            "equipped" => Some(Self::Equipped),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bag => "bag",
            Self::Warehouse => "warehouse",
            Self::Equipped => "equipped",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InventoryInfoView {
    pub bag_capacity: i32,
    pub warehouse_capacity: i32,
    pub bag_used: i32,
    pub warehouse_used: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InventoryItemDefinitionView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_category: Option<String>,
    pub can_disassemble: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack_max: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_desc: Option<String>,
    pub tags: Value,
    pub effect_defs: Value,
    pub base_attrs: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equip_slot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_req_realm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equip_req_realm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_req_level: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_limit_daily: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_limit_total: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket_max: Option<i32>,
    pub gem_slot_types: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gem_level: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InventoryItemView {
    pub id: i64,
    pub item_def_id: String,
    pub qty: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_rank: Option<i32>,
    pub location: InventoryLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_slot: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equipped_slot: Option<String>,
    pub strengthen_level: i32,
    pub refine_level: i32,
    pub affixes: Value,
    pub identified: bool,
    pub locked: bool,
    pub bind_type: String,
    pub socketed_gems: Value,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub def: Option<InventoryItemDefinitionView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InventoryItemsPageView {
    pub items: Vec<InventoryItemView>,
    pub total: i64,
    pub page: i64,
    #[serde(rename = "pageSize")]
    pub page_size: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InventoryBagSnapshotView {
    pub info: InventoryInfoView,
    #[serde(rename = "bagItems")]
    pub bag_items: Vec<InventoryItemView>,
    #[serde(rename = "equippedItems")]
    pub equipped_items: Vec<InventoryItemView>,
}

#[derive(Debug, Clone, Deserialize)]
struct StaticItemDefFile {
    items: Vec<StaticItemDefSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct StaticItemDefSeed {
    id: String,
    name: String,
    category: String,
    sub_category: Option<String>,
    quality: Option<String>,
    stack_max: Option<i32>,
    icon: Option<String>,
    description: Option<String>,
    long_desc: Option<String>,
    tags: Option<Value>,
    effect_defs: Option<Value>,
    base_attrs: Option<Value>,
    equip_slot: Option<String>,
    use_type: Option<String>,
    use_req_realm: Option<String>,
    equip_req_realm: Option<String>,
    use_req_level: Option<i32>,
    use_limit_daily: Option<i32>,
    use_limit_total: Option<i32>,
    socket_max: Option<i32>,
    gem_slot_types: Option<Value>,
    gem_level: Option<i32>,
    set_id: Option<String>,
    disassemblable: Option<bool>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone)]
struct InventoryItemRow {
    item: InventoryItemView,
    total: i64,
}

impl RustInventoryReadService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_inventory_info_impl(
        &self,
        character_id: i64,
    ) -> Result<InventoryInfoView, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              i.bag_capacity,
              i.warehouse_capacity,
              COALESCE(usage.bag_used, 0)::int AS bag_used,
              COALESCE(usage.warehouse_used, 0)::int AS warehouse_used
            FROM inventory i
            LEFT JOIN (
              SELECT
                owner_character_id,
                COUNT(DISTINCT location_slot) FILTER (WHERE location = 'bag')::int AS bag_used,
                COUNT(DISTINCT location_slot) FILTER (WHERE location = 'warehouse')::int AS warehouse_used
              FROM item_instance
              WHERE owner_character_id = $1
                AND location IN ('bag', 'warehouse')
                AND location_slot IS NOT NULL
                AND location_slot >= 0
              GROUP BY owner_character_id
            ) AS usage
              ON usage.owner_character_id = i.character_id
            WHERE i.character_id = $1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        if let Some(row) = row {
            return Ok(InventoryInfoView {
                bag_capacity: row.get("bag_capacity"),
                warehouse_capacity: row.get("warehouse_capacity"),
                bag_used: row.get("bag_used"),
                warehouse_used: row.get("warehouse_used"),
            });
        }

        sqlx::query(
            r#"
            INSERT INTO inventory (character_id, bag_capacity, warehouse_capacity)
            VALUES ($1, $2, $3)
            ON CONFLICT (character_id) DO NOTHING
            "#,
        )
        .bind(character_id)
        .bind(DEFAULT_BAG_CAPACITY)
        .bind(DEFAULT_WAREHOUSE_CAPACITY)
        .execute(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        Ok(InventoryInfoView {
            bag_capacity: DEFAULT_BAG_CAPACITY,
            warehouse_capacity: DEFAULT_WAREHOUSE_CAPACITY,
            bag_used: 0,
            warehouse_used: 0,
        })
    }

    async fn get_inventory_items_impl(
        &self,
        character_id: i64,
        location: InventoryLocation,
        page: i64,
        page_size: i64,
    ) -> Result<InventoryItemsPageView, BusinessError> {
        let normalized_page = page.max(1);
        let normalized_page_size = page_size.clamp(1, INVENTORY_ITEMS_PAGE_SIZE_MAX);
        let offset = (normalized_page - 1) * normalized_page_size;
        let rows = self
            .load_inventory_items_by_location(character_id, location, normalized_page_size, offset)
            .await?;
        let total = rows.first().map(|row| row.total).unwrap_or(0);
        let items = rows.into_iter().map(|row| row.item).collect();

        Ok(InventoryItemsPageView {
            items,
            total,
            page: normalized_page,
            page_size: normalized_page_size,
        })
    }

    async fn get_bag_inventory_snapshot_impl(
        &self,
        character_id: i64,
    ) -> Result<InventoryBagSnapshotView, BusinessError> {
        let (info, bag_rows, equipped_rows) = tokio::try_join!(
            self.get_inventory_info_impl(character_id),
            self.load_inventory_items_by_location(character_id, InventoryLocation::Bag, 200, 0),
            self.load_inventory_items_by_location(
                character_id,
                InventoryLocation::Equipped,
                200,
                0
            ),
        )?;

        Ok(InventoryBagSnapshotView {
            info,
            bag_items: bag_rows.into_iter().map(|row| row.item).collect(),
            equipped_items: equipped_rows.into_iter().map(|row| row.item).collect(),
        })
    }

    async fn load_inventory_items_by_location(
        &self,
        character_id: i64,
        location: InventoryLocation,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<InventoryItemRow>, BusinessError> {
        let static_index = inventory_item_def_index()?;
        let rows = sqlx::query(
            r#"
            SELECT
              ii.id,
              ii.item_def_id,
              ii.qty,
              ii.quality,
              ii.quality_rank,
              ii.location,
              ii.location_slot,
              ii.equipped_slot,
              COALESCE(ii.strengthen_level, 0) AS strengthen_level,
              COALESCE(ii.refine_level, 0) AS refine_level,
              ii.socketed_gems,
              ii.affixes,
              COALESCE(ii.identified, TRUE) AS identified,
              COALESCE(ii.locked, FALSE) AS locked,
              ii.bind_type,
              to_char(ii.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              COUNT(*) OVER()::bigint AS total_count
            FROM item_instance ii
            WHERE ii.owner_character_id = $1
              AND ii.location = $2
            ORDER BY ii.location_slot NULLS LAST, ii.created_at DESC
            LIMIT $3 OFFSET $4
            "#,
        )
        .bind(character_id)
        .bind(location.as_str())
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_sql_business_error)?;

        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let item_def_id = row.get::<String, _>("item_def_id");
            let def = static_index.get(item_def_id.as_str()).cloned();
            items.push(InventoryItemRow {
                item: InventoryItemView {
                    id: row.get("id"),
                    item_def_id,
                    qty: row.get("qty"),
                    quality: row.try_get::<Option<String>, _>("quality").unwrap_or(None),
                    quality_rank: row
                        .try_get::<Option<i32>, _>("quality_rank")
                        .unwrap_or(None),
                    location,
                    location_slot: row
                        .try_get::<Option<i32>, _>("location_slot")
                        .unwrap_or(None),
                    equipped_slot: row
                        .try_get::<Option<String>, _>("equipped_slot")
                        .unwrap_or(None),
                    strengthen_level: row.get("strengthen_level"),
                    refine_level: row.get("refine_level"),
                    affixes: row
                        .try_get::<Option<Value>, _>("affixes")
                        .unwrap_or(None)
                        .unwrap_or(Value::Null),
                    identified: row.get("identified"),
                    locked: row.get("locked"),
                    bind_type: row.get("bind_type"),
                    socketed_gems: row
                        .try_get::<Option<Value>, _>("socketed_gems")
                        .unwrap_or(None)
                        .unwrap_or(Value::Null),
                    created_at: row.get("created_at"),
                    def,
                },
                total: row.get("total_count"),
            });
        }
        Ok(items)
    }
}

impl InventoryRouteServices for RustInventoryReadService {
    fn get_inventory_info<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryInfoView, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.get_inventory_info_impl(character_id).await })
    }

    fn get_bag_inventory_snapshot<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryBagSnapshotView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_bag_inventory_snapshot_impl(character_id).await })
    }

    fn get_inventory_items<'a>(
        &'a self,
        character_id: i64,
        location: InventoryLocation,
        page: i64,
        page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryItemsPageView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.get_inventory_items_impl(character_id, location, page, page_size)
                .await
        })
    }
}

fn inventory_item_def_index(
) -> Result<&'static HashMap<String, InventoryItemDefinitionView>, BusinessError> {
    let result = INVENTORY_ITEM_DEF_INDEX.get_or_init(|| {
        read_seed_json::<StaticItemDefFile>("item_def.json")
            .map(|file| {
                let mut map = HashMap::with_capacity(file.items.len());
                for item in file
                    .items
                    .into_iter()
                    .filter(|item| item.enabled != Some(false))
                {
                    map.insert(
                        item.id.clone(),
                        InventoryItemDefinitionView {
                            id: item.id,
                            name: item.name,
                            icon: item.icon,
                            quality: item.quality,
                            category: item.category,
                            sub_category: item.sub_category,
                            can_disassemble: item.disassemblable != Some(false),
                            stack_max: item.stack_max,
                            description: item.description,
                            long_desc: item.long_desc,
                            tags: item.tags.unwrap_or(Value::Null),
                            effect_defs: item.effect_defs.unwrap_or(Value::Null),
                            base_attrs: item.base_attrs.unwrap_or(Value::Null),
                            equip_slot: item.equip_slot,
                            use_type: item.use_type,
                            use_req_realm: item.use_req_realm,
                            equip_req_realm: item.equip_req_realm,
                            use_req_level: item.use_req_level,
                            use_limit_daily: item.use_limit_daily,
                            use_limit_total: item.use_limit_total,
                            socket_max: item.socket_max,
                            gem_slot_types: item.gem_slot_types.unwrap_or(Value::Null),
                            gem_level: item.gem_level,
                            set_id: item.set_id,
                        },
                    );
                }
                map
            })
            .map_err(|error| error.to_string())
    });

    match result {
        Ok(index) => Ok(index),
        Err(error) => Err(internal_string_business_error(error.clone())),
    }
}

fn internal_sql_business_error(error: sqlx::Error) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}

fn internal_string_business_error(error: String) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}
