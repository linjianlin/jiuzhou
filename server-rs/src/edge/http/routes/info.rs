use std::{future::Future, pin::Pin};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use serde_json::Value;

use crate::application::info::service::{get_item_taxonomy_snapshot, get_static_target_detail};
use crate::application::static_data::catalog::GameItemTaxonomyDto;
use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * info 静态配置路由。
 *
 * 作用：
 * 1. 做什么：提供 `/item-taxonomy` 与 `/:type/:id`，复刻 Node 当前仍对外暴露的 info 只读合同。
 * 2. 做什么：把 `参数错误`、`对象不存在` 与 success envelope 这些 HTTP 语义固定在这一层，应用服务只负责提供数据。
 * 3. 不做什么：不扩展到其它路由簇，也不在这里实现战斗、采集或角色计算等非 info 读取逻辑。
 *
 * 输入 / 输出：
 * - 输入：taxonomy 无参数；详情接口输入 `type` 与 `id`。
 * - 输出：`{ success:true, data:{ taxonomy } }` 或 `{ success:true, data:{ target } }`；无效类型返回 `400 参数错误`，查无对象返回 `404 对象不存在`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `InfoRouteServices` -> 路由层统一序列化 Node 兼容 envelope。
 *
 * 复用设计说明：
 * - taxonomy 与 target DTO 由路由/应用服务/测试共用，字段清单和错误文案只维护一份，避免后续客户端依赖的 shape 漂移。
 *
 * 关键边界条件与坑点：
 * 1. `type` 只允许 `npc|monster|item|player`，不能把未知值降级成 404，否则会破坏 Node 端现有参数校验语义。
 * 2. 服务层失败必须继续显式返回 `服务器错误`，不能把失败伪装成 `对象不存在` 或空 taxonomy。
 */
#[derive(Debug, Clone, Serialize)]
struct ItemTaxonomyPayload {
    taxonomy: GameItemTaxonomyDto,
}

#[derive(Debug, Clone, Serialize)]
struct InfoTargetPayload {
    target: InfoTargetView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InfoTargetType {
    Npc,
    Monster,
    Item,
    Player,
}

impl InfoTargetType {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "npc" => Some(Self::Npc),
            "monster" => Some(Self::Monster),
            "item" => Some(Self::Item),
            "player" => Some(Self::Player),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InfoTargetStatsEntry {
    pub label: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InfoTargetDropEntry {
    pub name: String,
    pub quality: String,
    pub chance: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InfoTargetEquipmentEntry {
    pub slot: String,
    pub name: String,
    pub quality: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InfoTargetTechniqueEntry {
    pub name: String,
    pub level: String,
    #[serde(rename = "type")]
    pub technique_type: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum InfoTargetView {
    Npc {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(rename = "titleDescription", skip_serializing_if = "Option::is_none")]
        title_description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        desc: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drops: Option<Vec<InfoTargetDropEntry>>,
    },
    Monster {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(rename = "titleDescription", skip_serializing_if = "Option::is_none")]
        title_description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_attrs: Option<std::collections::BTreeMap<String, f64>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attr_variance: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attr_multiplier_min: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attr_multiplier_max: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stats: Option<Vec<InfoTargetStatsEntry>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drops: Option<Vec<InfoTargetDropEntry>>,
    },
    Item {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        object_kind: Option<String>,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(rename = "titleDescription", skip_serializing_if = "Option::is_none")]
        title_description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        desc: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stats: Option<Vec<InfoTargetStatsEntry>>,
    },
    Player {
        id: String,
        name: String,
        #[serde(rename = "monthCardActive", skip_serializing_if = "Option::is_none")]
        month_card_active: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(rename = "titleDescription", skip_serializing_if = "Option::is_none")]
        title_description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stats: Option<Vec<InfoTargetStatsEntry>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        equipment: Option<Vec<InfoTargetEquipmentEntry>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        techniques: Option<Vec<InfoTargetTechniqueEntry>>,
    },
}

pub trait InfoRouteServices: Send + Sync {
    fn get_item_taxonomy<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<GameItemTaxonomyDto, BusinessError>> + Send + 'a>>;

    fn get_target_detail<'a>(
        &'a self,
        target_type: InfoTargetType,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<InfoTargetView>, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopInfoRouteServices;

impl InfoRouteServices for NoopInfoRouteServices {
    fn get_item_taxonomy<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<GameItemTaxonomyDto, BusinessError>> + Send + 'a>> {
        Box::pin(async move { get_item_taxonomy_snapshot() })
    }

    fn get_target_detail<'a>(
        &'a self,
        target_type: InfoTargetType,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<InfoTargetView>, BusinessError>> + Send + 'a>> {
        Box::pin(async move { get_static_target_detail(target_type, id) })
    }
}

pub fn build_info_router() -> Router<AppState> {
    Router::new()
        .route("/item-taxonomy", get(item_taxonomy_handler))
        .route("/{type}/{id}", get(info_target_detail_handler))
}

async fn item_taxonomy_handler(State(state): State<AppState>) -> Result<Response, BusinessError> {
    let taxonomy = state.info_services.get_item_taxonomy().await?;
    Ok(success(ItemTaxonomyPayload {
        taxonomy,
    }))
}

async fn info_target_detail_handler(
    State(state): State<AppState>,
    Path((target_type, id)): Path<(String, String)>,
) -> Result<Response, BusinessError> {
    let Some(target_type) = InfoTargetType::parse(target_type.as_str()) else {
        return Err(BusinessError::new("参数错误"));
    };
    let Some(target) = state.info_services.get_target_detail(target_type, id.as_str()).await? else {
        return Err(BusinessError::with_status("对象不存在", StatusCode::NOT_FOUND));
    };
    Ok(success(InfoTargetPayload { target }))
}
