use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use serde::Deserialize;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};

use crate::application::static_data::realm::normalize_realm_keeping_unknown;
use crate::application::static_data::seed::{
    list_seed_files_with_prefix, read_seed_json, seed_file_path,
};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::realm::{
    RealmBreakthroughDataView, RealmCostView, RealmOverviewView, RealmRequirementStatus,
    RealmRequirementView, RealmRewardView, RealmRouteServices, RealmSpentItemView,
};
use crate::shared::error::AppError;

static REALM_BREAKTHROUGH_CONFIG: OnceLock<Result<RealmBreakthroughConfig, String>> =
    OnceLock::new();
static REALM_ITEM_META_MAP: OnceLock<Result<HashMap<String, ItemMeta>, String>> = OnceLock::new();
static REALM_TECHNIQUE_NAME_MAP: OnceLock<Result<HashMap<String, String>, String>> =
    OnceLock::new();
static REALM_DUNGEON_META: OnceLock<Result<DungeonMetaCatalog, String>> = OnceLock::new();

const BREAKTHROUGH_NUMERIC_REWARD_DEFS: [(&str, &str); 6] = [
    ("max_qixue", "最大气血"),
    ("max_lingqi", "最大灵气"),
    ("wugong", "物攻"),
    ("fagong", "法攻"),
    ("wufang", "物防"),
    ("fafang", "法防"),
];
const BREAKTHROUGH_ADD_PERCENT_REWARD_DEFS: [(&str, &str); 1] = [("kongzhi_kangxing", "控制抗性")];

/**
 * realm 境界突破应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `realmService` 的总览读取与突破写入，输出 `/api/realm/overview|breakthrough` 需要的统一业务结果。
 * 2. 做什么：把配置读取、条件评估、扣费与境界写库收敛到单一服务，避免路由层或后续调用方各自维护一套规则。
 * 3. 不做什么：不处理尚未迁移到 Rust 的主线推进、成就累计、角色缓存失效与排行快照刷新副作用。
 *
 * 输入 / 输出：
 * - 输入：`user_id`，以及突破接口额外接收的目标境界字符串。
 * - 输出：Node 兼容的 `ServiceResultResponse<RealmOverviewView | RealmBreakthroughDataView>`。
 *
 * 数据流 / 状态流：
 * - 路由完成鉴权 -> 本服务读取 `realm_breakthrough.json` 与角色/功法/背包/秘境记录
 * - 总览路径只读评估条件与消耗，突破路径在事务内锁定角色与材料再写库
 * - 返回固定协议给 HTTP 层。
 *
 * 复用设计说明：
 * - 物品/功法/秘境名称索引与突破配置全部前置到模块级缓存，overview 与 breakthrough 共用同一份索引，避免重复扫描多个 seeds。
 * - 条件视图、消耗视图、奖励视图与写入前校验复用同一套评估逻辑，避免“预览能过、真正突破失败口径不同”的重复实现。
 *
 * 关键边界条件与坑点：
 * 1. 角色当前境界、经验、灵石和材料消耗必须在事务里二次校验，不能只依赖预览阶段的读结果，否则并发请求会造成双花。
 * 2. 目前 Rust 侧未迁移 Node 的主线/成就/快照刷新副作用，因此本服务只保证突破主链路与数据一致性，不会假装这些副作用已经存在。
 */
#[derive(Debug, Clone)]
pub struct RustRealmRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Deserialize)]
struct RealmBreakthroughConfigFile {
    #[serde(rename = "realmOrder")]
    realm_order: Vec<String>,
    breakthroughs: Vec<BreakthroughConfig>,
}

#[derive(Debug, Clone, Deserialize)]
struct BreakthroughConfig {
    from: String,
    to: String,
    #[serde(default)]
    requirements: Vec<BreakthroughRequirement>,
    #[serde(default)]
    costs: Vec<BreakthroughCost>,
    rewards: Option<RewardConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
enum BreakthroughRequirement {
    #[serde(rename = "exp_min")]
    ExpMin { id: String, title: String, min: i64 },
    #[serde(rename = "spirit_stones_min")]
    SpiritStonesMin { id: String, title: String, min: i64 },
    #[serde(rename = "technique_layer_min")]
    TechniqueLayerMin {
        id: String,
        title: String,
        #[serde(rename = "techniqueId")]
        technique_id: String,
        #[serde(rename = "minLayer")]
        min_layer: i32,
    },
    #[serde(rename = "main_technique_layer_min")]
    MainTechniqueLayerMin {
        id: String,
        title: String,
        #[serde(rename = "minLayer")]
        min_layer: i32,
    },
    #[serde(rename = "main_and_sub_technique_layer_min")]
    MainAndSubTechniqueLayerMin {
        id: String,
        title: String,
        #[serde(rename = "minLayer")]
        min_layer: i32,
    },
    #[serde(rename = "techniques_count_min_layer")]
    TechniquesCountMinLayer {
        id: String,
        title: String,
        #[serde(rename = "minCount")]
        min_count: i32,
        #[serde(rename = "minLayer")]
        min_layer: i32,
    },
    #[serde(rename = "item_qty_min")]
    ItemQtyMin {
        id: String,
        title: String,
        #[serde(rename = "itemDefId")]
        item_def_id: String,
        qty: i32,
    },
    #[serde(rename = "dungeon_clear_min")]
    DungeonClearMin {
        id: String,
        title: String,
        #[serde(rename = "minCount")]
        min_count: i32,
        #[serde(rename = "dungeonId")]
        dungeon_id: Option<String>,
        #[serde(rename = "difficultyId")]
        difficulty_id: Option<String>,
    },
    #[serde(rename = "main_quest_chapter_completed")]
    MainQuestChapterCompleted {
        id: String,
        title: String,
        #[serde(rename = "chapterId")]
        chapter_id: String,
    },
    #[serde(rename = "version_locked")]
    VersionLocked {
        id: String,
        title: String,
        reason: Option<String>,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
enum BreakthroughCost {
    #[serde(rename = "exp")]
    Exp { amount: i64 },
    #[serde(rename = "spirit_stones")]
    SpiritStones { amount: i64 },
    #[serde(rename = "items")]
    Items { items: Vec<BreakthroughItemCost> },
}

#[derive(Debug, Clone, Deserialize)]
struct BreakthroughItemCost {
    #[serde(rename = "itemDefId")]
    item_def_id: String,
    qty: i32,
}

#[derive(Debug, Clone, Deserialize)]
struct RewardConfig {
    #[serde(rename = "attributePoints")]
    attribute_points: Option<i32>,
    flat: Option<BTreeMap<String, f64>>,
    pct: Option<BTreeMap<String, f64>>,
    #[serde(rename = "addPercent")]
    add_percent: Option<BTreeMap<String, f64>>,
}

#[derive(Debug, Clone)]
struct RealmBreakthroughConfig {
    config_path: String,
    realm_order: Vec<String>,
    breakthroughs_by_from: HashMap<String, BreakthroughConfig>,
}

#[derive(Debug, Clone)]
struct CharacterRealmState {
    character_id: i64,
    current_realm: String,
    exp: i64,
    spirit_stones: i64,
    attribute_points: i32,
}

#[derive(Debug, Clone, Default)]
struct CostResolution {
    exp: i64,
    spirit_stones: i64,
    items: Vec<BreakthroughItemCost>,
    view: Vec<RealmCostView>,
    affordable: bool,
}

#[derive(Debug, Clone)]
struct ItemMeta {
    name: String,
    icon: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct DungeonMetaCatalog {
    dungeon_name_by_id: HashMap<String, String>,
    difficulty_name_by_id: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeedFile {
    items: Vec<ItemSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeed {
    id: String,
    name: String,
    icon: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueSeedFile {
    techniques: Vec<TechniqueSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueSeed {
    id: String,
    name: String,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonSeedFile {
    dungeons: Option<Vec<DungeonSeedEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonSeedEntry {
    def: Option<DungeonDefSeed>,
    difficulties: Option<Vec<DungeonDifficultySeed>>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonDefSeed {
    id: String,
    name: String,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonDifficultySeed {
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
}

impl RustRealmRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_overview_impl(
        &self,
        user_id: i64,
    ) -> Result<ServiceResultResponse<RealmOverviewView>, BusinessError> {
        let config = load_realm_breakthrough_config().map_err(internal_business_error)?;
        let Some(state) = load_character_state(&self.pool, user_id)
            .await
            .map_err(internal_business_error)?
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };
        let next_realm = get_next_realm_name(&config.realm_order, state.current_realm.as_str());
        let breakthrough = next_realm.as_ref().and_then(|_| {
            config
                .breakthroughs_by_from
                .get(state.current_realm.as_str())
        });
        let requirements = if let Some(rule) = breakthrough {
            evaluate_requirements(&self.pool, &state, &rule.requirements)
                .await
                .map_err(internal_business_error)?
        } else {
            Vec::new()
        };
        let costs = if let Some(rule) = breakthrough {
            resolve_costs(
                &self.pool,
                Some(state.character_id),
                Some(state.exp),
                Some(state.spirit_stones),
                &rule.costs,
            )
            .await
            .map_err(internal_business_error)?
        } else {
            CostResolution::default()
        };
        let rewards = breakthrough
            .map(|rule| build_rewards_view(rule.rewards.as_ref()))
            .transpose()
            .map_err(internal_business_error)?
            .unwrap_or_default();
        let can_breakthrough = next_realm.is_some()
            && breakthrough.is_some()
            && requirements
                .iter()
                .all(|requirement| requirement.status == RealmRequirementStatus::Done)
            && costs.affordable;

        Ok(ServiceResultResponse::new(
            true,
            Some("ok".to_string()),
            Some(RealmOverviewView {
                config_path: Some(config.config_path.clone()),
                realm_order: config.realm_order.clone(),
                current_realm: state.current_realm.clone(),
                current_index: get_realm_index(&config.realm_order, state.current_realm.as_str()),
                next_realm,
                exp: state.exp,
                spirit_stones: state.spirit_stones,
                requirements,
                costs: costs.view,
                rewards,
                can_breakthrough,
            }),
        ))
    }

    async fn breakthrough_to_next_realm_impl(
        &self,
        user_id: i64,
    ) -> Result<ServiceResultResponse<RealmBreakthroughDataView>, BusinessError> {
        let config = load_realm_breakthrough_config().map_err(internal_business_error)?;
        let Some(preview_state) = load_character_state(&self.pool, user_id)
            .await
            .map_err(internal_business_error)?
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };
        let Some(next_realm) =
            get_next_realm_name(&config.realm_order, preview_state.current_realm.as_str())
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("已达最高境界".to_string()),
                None,
            ));
        };
        let Some(rule) = config
            .breakthroughs_by_from
            .get(preview_state.current_realm.as_str())
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("下一境界配置不存在".to_string()),
                None,
            ));
        };
        if rule.to != next_realm {
            return Ok(ServiceResultResponse::new(
                false,
                Some("下一境界配置不存在".to_string()),
                None,
            ));
        }

        let preview_requirements =
            evaluate_requirements(&self.pool, &preview_state, &rule.requirements)
                .await
                .map_err(internal_business_error)?;
        if let Some(unmet) = preview_requirements
            .iter()
            .find(|requirement| requirement.status != RealmRequirementStatus::Done)
        {
            return Ok(ServiceResultResponse::new(
                false,
                Some(build_requirement_failure_message(unmet)),
                None,
            ));
        }

        let preview_costs = resolve_costs(
            &self.pool,
            Some(preview_state.character_id),
            Some(preview_state.exp),
            Some(preview_state.spirit_stones),
            &rule.costs,
        )
        .await
        .map_err(internal_business_error)?;
        if preview_state.exp < preview_costs.exp {
            return Ok(ServiceResultResponse::new(
                false,
                Some(format!("经验不足，需要 {}", preview_costs.exp)),
                None,
            ));
        }
        if preview_state.spirit_stones < preview_costs.spirit_stones {
            return Ok(ServiceResultResponse::new(
                false,
                Some(format!("灵石不足，需要 {}", preview_costs.spirit_stones)),
                None,
            ));
        }

        let mut transaction = self.pool.begin().await.map_err(sqlx_business_error)?;
        let Some(locked_state) = load_character_state_for_update(&mut transaction, user_id)
            .await
            .map_err(internal_business_error)?
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };
        if locked_state.current_realm != preview_state.current_realm {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色状态已变化，请重试".to_string()),
                None,
            ));
        }
        if locked_state.exp < preview_costs.exp {
            return Ok(ServiceResultResponse::new(
                false,
                Some(format!("经验不足，需要 {}", preview_costs.exp)),
                None,
            ));
        }
        if locked_state.spirit_stones < preview_costs.spirit_stones {
            return Ok(ServiceResultResponse::new(
                false,
                Some(format!("灵石不足，需要 {}", preview_costs.spirit_stones)),
                None,
            ));
        }

        consume_cost_items(
            &mut transaction,
            locked_state.character_id,
            &preview_costs.items,
        )
        .await?;

        let reward_attribute_points = rule
            .rewards
            .as_ref()
            .and_then(|reward| reward.attribute_points)
            .unwrap_or(0)
            .max(0);
        let new_exp = locked_state.exp - preview_costs.exp;
        let new_spirit_stones = locked_state.spirit_stones - preview_costs.spirit_stones;
        let new_attribute_points = locked_state.attribute_points + reward_attribute_points;

        sqlx::query(
            r#"
            UPDATE characters
            SET realm = $2,
                sub_realm = NULL,
                exp = $3,
                spirit_stones = $4,
                attribute_points = $5,
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(locked_state.character_id)
        .bind(&rule.to)
        .bind(new_exp)
        .bind(new_spirit_stones)
        .bind(new_attribute_points)
        .execute(&mut *transaction)
        .await
        .map_err(sqlx_business_error)?;

        transaction.commit().await.map_err(sqlx_business_error)?;

        Ok(ServiceResultResponse::new(
            true,
            Some(format!("突破至{}成功", rule.to)),
            Some(RealmBreakthroughDataView {
                from_realm: locked_state.current_realm,
                new_realm: rule.to.clone(),
                spent_exp: preview_costs.exp,
                spent_spirit_stones: preview_costs.spirit_stones,
                spent_items: build_spent_item_views(&preview_costs.items)
                    .map_err(internal_business_error)?,
                gained_attribute_points: reward_attribute_points,
                current_exp: new_exp,
                current_spirit_stones: new_spirit_stones,
            }),
        ))
    }

    async fn breakthrough_to_target_realm_impl(
        &self,
        user_id: i64,
        target_realm: String,
    ) -> Result<ServiceResultResponse<RealmBreakthroughDataView>, BusinessError> {
        let normalized_target = target_realm.trim().to_string();
        if normalized_target.is_empty() {
            return Ok(ServiceResultResponse::new(
                false,
                Some("目标境界无效".to_string()),
                None,
            ));
        }
        let config = load_realm_breakthrough_config().map_err(internal_business_error)?;
        if !config
            .realm_order
            .iter()
            .any(|realm| realm == &normalized_target)
        {
            return Ok(ServiceResultResponse::new(
                false,
                Some("目标境界未开放".to_string()),
                None,
            ));
        }
        let Some(state) = load_character_state(&self.pool, user_id)
            .await
            .map_err(internal_business_error)?
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        };
        let Some(next_realm) =
            get_next_realm_name(&config.realm_order, state.current_realm.as_str())
        else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("已达最高境界".to_string()),
                None,
            ));
        };
        if next_realm != normalized_target {
            return Ok(ServiceResultResponse::new(
                false,
                Some("只能突破到下一境界".to_string()),
                None,
            ));
        }
        self.breakthrough_to_next_realm_impl(user_id).await
    }
}

impl RealmRouteServices for RustRealmRouteService {
    fn get_overview<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RealmOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.get_overview_impl(user_id).await })
    }

    fn breakthrough_to_next_realm<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<RealmBreakthroughDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.breakthrough_to_next_realm_impl(user_id).await })
    }

    fn breakthrough_to_target_realm<'a>(
        &'a self,
        user_id: i64,
        target_realm: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<RealmBreakthroughDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.breakthrough_to_target_realm_impl(user_id, target_realm)
                .await
        })
    }
}

fn load_realm_breakthrough_config() -> Result<&'static RealmBreakthroughConfig, AppError> {
    let result = REALM_BREAKTHROUGH_CONFIG
        .get_or_init(|| build_realm_breakthrough_config().map_err(|error| error.to_string()));
    result
        .as_ref()
        .map_err(|message| AppError::Config(message.clone()))
}

fn build_realm_breakthrough_config() -> Result<RealmBreakthroughConfig, AppError> {
    let config_path = seed_file_path("realm_breakthrough.json");
    let raw: RealmBreakthroughConfigFile = read_seed_json("realm_breakthrough.json")?;
    let mut breakthroughs_by_from = HashMap::with_capacity(raw.breakthroughs.len());
    for rule in raw.breakthroughs {
        breakthroughs_by_from.insert(rule.from.clone(), rule);
    }
    Ok(RealmBreakthroughConfig {
        config_path: config_path.to_string_lossy().into_owned(),
        realm_order: raw.realm_order,
        breakthroughs_by_from,
    })
}

fn load_item_meta_map() -> Result<&'static HashMap<String, ItemMeta>, AppError> {
    let result = REALM_ITEM_META_MAP
        .get_or_init(|| build_item_meta_map().map_err(|error| error.to_string()));
    result
        .as_ref()
        .map_err(|message| AppError::Config(message.clone()))
}

fn build_item_meta_map() -> Result<HashMap<String, ItemMeta>, AppError> {
    let raw: ItemSeedFile = read_seed_json("item_def.json")?;
    let mut map = HashMap::with_capacity(raw.items.len());
    for item in raw.items {
        if item.enabled == Some(false) {
            continue;
        }
        map.insert(
            item.id.clone(),
            ItemMeta {
                name: item.name,
                icon: item.icon.filter(|value| !value.trim().is_empty()),
            },
        );
    }
    Ok(map)
}

fn load_technique_name_map() -> Result<&'static HashMap<String, String>, AppError> {
    let result = REALM_TECHNIQUE_NAME_MAP
        .get_or_init(|| build_technique_name_map().map_err(|error| error.to_string()));
    result
        .as_ref()
        .map_err(|message| AppError::Config(message.clone()))
}

fn build_technique_name_map() -> Result<HashMap<String, String>, AppError> {
    let raw: TechniqueSeedFile = read_seed_json("technique_def.json")?;
    let mut map = HashMap::with_capacity(raw.techniques.len());
    for technique in raw.techniques {
        if technique.enabled == Some(false) {
            continue;
        }
        map.insert(technique.id, technique.name);
    }
    Ok(map)
}

fn load_dungeon_meta_catalog() -> Result<&'static DungeonMetaCatalog, AppError> {
    let result = REALM_DUNGEON_META
        .get_or_init(|| build_dungeon_meta_catalog().map_err(|error| error.to_string()));
    result
        .as_ref()
        .map_err(|message| AppError::Config(message.clone()))
}

fn build_dungeon_meta_catalog() -> Result<DungeonMetaCatalog, AppError> {
    let file_names = list_seed_files_with_prefix("dungeon_")?;
    let mut dungeon_name_by_id = HashMap::new();
    let mut difficulty_name_by_id = HashMap::new();
    for file_name in file_names {
        let raw: DungeonSeedFile = read_seed_json(file_name.as_str())?;
        let Some(entries) = raw.dungeons else {
            continue;
        };
        for entry in entries {
            if let Some(definition) = entry.def {
                if definition.enabled != Some(false) {
                    dungeon_name_by_id.insert(definition.id, definition.name);
                }
            }
            if let Some(difficulties) = entry.difficulties {
                for difficulty in difficulties {
                    if difficulty.enabled == Some(false) {
                        continue;
                    }
                    if let Some(name) = difficulty.name.filter(|value| !value.trim().is_empty()) {
                        difficulty_name_by_id.insert(difficulty.id, name);
                    }
                }
            }
        }
    }
    Ok(DungeonMetaCatalog {
        dungeon_name_by_id,
        difficulty_name_by_id,
    })
}

async fn load_character_state(
    pool: &sqlx::PgPool,
    user_id: i64,
) -> Result<Option<CharacterRealmState>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT id, realm, sub_realm, exp, spirit_stones, attribute_points
        FROM characters
        WHERE user_id = $1
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(build_character_state))
}

async fn load_character_state_for_update(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: i64,
) -> Result<Option<CharacterRealmState>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT id, realm, sub_realm, exp, spirit_stones, attribute_points
        FROM characters
        WHERE user_id = $1
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(build_character_state))
}

fn build_character_state(row: sqlx::postgres::PgRow) -> CharacterRealmState {
    let realm = row.try_get::<Option<String>, _>("realm").ok().flatten();
    let sub_realm = row.try_get::<Option<String>, _>("sub_realm").ok().flatten();
    CharacterRealmState {
        character_id: row.get("id"),
        current_realm: normalize_realm_keeping_unknown(realm.as_deref(), sub_realm.as_deref()),
        exp: row
            .try_get::<Option<i64>, _>("exp")
            .ok()
            .flatten()
            .unwrap_or(0),
        spirit_stones: row
            .try_get::<Option<i64>, _>("spirit_stones")
            .ok()
            .flatten()
            .unwrap_or(0),
        attribute_points: row
            .try_get::<Option<i32>, _>("attribute_points")
            .ok()
            .flatten()
            .unwrap_or(0),
    }
}

fn get_realm_index(realm_order: &[String], current_realm: &str) -> usize {
    realm_order
        .iter()
        .position(|realm| realm == current_realm)
        .unwrap_or(0)
}

fn get_next_realm_name(realm_order: &[String], current_realm: &str) -> Option<String> {
    let index = get_realm_index(realm_order, current_realm);
    realm_order.get(index + 1).cloned()
}

async fn evaluate_requirements(
    pool: &sqlx::PgPool,
    state: &CharacterRealmState,
    requirements: &[BreakthroughRequirement],
) -> Result<Vec<RealmRequirementView>, AppError> {
    let item_meta = load_item_meta_map()?;
    let technique_names = load_technique_name_map()?;
    let dungeon_meta = load_dungeon_meta_catalog()?;

    let mut item_ids = BTreeSet::new();
    let mut technique_ids = BTreeSet::new();
    let mut dungeon_keys = BTreeSet::new();
    let mut need_sub_techniques = false;
    let mut need_completed_chapters = false;

    for requirement in requirements {
        match requirement {
            BreakthroughRequirement::ItemQtyMin { item_def_id, .. } => {
                item_ids.insert(item_def_id.clone());
            }
            BreakthroughRequirement::TechniqueLayerMin { technique_id, .. } => {
                technique_ids.insert(technique_id.clone());
            }
            BreakthroughRequirement::MainAndSubTechniqueLayerMin { .. } => {
                need_sub_techniques = true;
            }
            BreakthroughRequirement::DungeonClearMin {
                dungeon_id,
                difficulty_id,
                ..
            } => {
                dungeon_keys.insert((
                    dungeon_id.clone().unwrap_or_default(),
                    difficulty_id.clone().unwrap_or_default(),
                ));
            }
            BreakthroughRequirement::MainQuestChapterCompleted { .. } => {
                need_completed_chapters = true;
            }
            BreakthroughRequirement::ExpMin { .. }
            | BreakthroughRequirement::SpiritStonesMin { .. }
            | BreakthroughRequirement::MainTechniqueLayerMin { .. }
            | BreakthroughRequirement::TechniquesCountMinLayer { .. }
            | BreakthroughRequirement::VersionLocked { .. }
            | BreakthroughRequirement::Unsupported => {}
        }
    }

    let technique_layers = load_technique_layers(
        pool,
        state.character_id,
        &technique_ids.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    let main_technique = load_main_technique(pool, state.character_id).await?;
    let sub_techniques = if need_sub_techniques {
        load_sub_techniques(pool, state.character_id).await?
    } else {
        Vec::new()
    };
    let technique_count_cache =
        load_technique_count_cache(pool, state.character_id, requirements).await?;
    let item_qty_map = load_item_qty_map(
        pool,
        state.character_id,
        &item_ids.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    let dungeon_clear_count_map = load_dungeon_clear_count_map(
        pool,
        state.character_id,
        &dungeon_keys.into_iter().collect::<Vec<_>>(),
    )
    .await?;
    let completed_chapters = if need_completed_chapters {
        load_completed_chapters(pool, state.character_id).await?
    } else {
        BTreeSet::new()
    };

    let mut views = Vec::with_capacity(requirements.len());
    for requirement in requirements {
        let view = match requirement {
            BreakthroughRequirement::ExpMin { id, title, min } => {
                let done = state.exp >= *min;
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail: format!("经验 ≥ {}（当前 {}）", min, state.exp),
                    status: if done {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: None,
                    source_ref: None,
                }
            }
            BreakthroughRequirement::SpiritStonesMin { id, title, min } => {
                let done = state.spirit_stones >= *min;
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail: format!("灵石 ≥ {}（当前 {}）", min, state.spirit_stones),
                    status: if done {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: None,
                    source_ref: None,
                }
            }
            BreakthroughRequirement::TechniqueLayerMin {
                id,
                title,
                technique_id,
                min_layer,
            } => {
                let current_layer = technique_layers.get(technique_id).copied().unwrap_or(0);
                let technique_name = technique_names
                    .get(technique_id)
                    .cloned()
                    .unwrap_or_else(|| technique_id.clone());
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail: format!(
                        "{technique_name} ≥ {} 层（当前 {}）",
                        min_layer, current_layer
                    ),
                    status: if current_layer >= *min_layer {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: None,
                    source_ref: None,
                }
            }
            BreakthroughRequirement::MainTechniqueLayerMin {
                id,
                title,
                min_layer,
            } => {
                let current_layer = main_technique
                    .as_ref()
                    .map(|entry| entry.layer)
                    .unwrap_or(0);
                let detail = if let Some(main) = &main_technique {
                    format!(
                        "{}（主功法）≥ {} 层（当前 {}）",
                        main.name, min_layer, current_layer
                    )
                } else {
                    format!("未装备主功法（需要 ≥ {} 层）", min_layer)
                };
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail,
                    status: if current_layer >= *min_layer {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: None,
                    source_ref: None,
                }
            }
            BreakthroughRequirement::MainAndSubTechniqueLayerMin {
                id,
                title,
                min_layer,
            } => {
                let best_sub = sub_techniques
                    .iter()
                    .max_by_key(|technique| technique.layer);
                let main_ok = main_technique
                    .as_ref()
                    .map(|technique| technique.layer >= *min_layer)
                    .unwrap_or(false);
                let sub_ok = sub_techniques
                    .iter()
                    .any(|technique| technique.layer >= *min_layer);
                let detail = if let Some(main) = &main_technique {
                    let sub_text = if let Some(sub) = best_sub {
                        format!("{}（副{} 当前 {}）", sub.name, sub.slot_index, sub.layer)
                    } else {
                        "未装备副功法".to_string()
                    };
                    format!(
                        "{}（主 当前 {}）≥{}；{} ≥{}",
                        main.name, main.layer, min_layer, sub_text, min_layer
                    )
                } else {
                    format!(
                        "未装备主功法（需要主功法≥{}且副功法≥{}）",
                        min_layer, min_layer
                    )
                };
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail,
                    status: if main_ok && sub_ok {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: None,
                    source_ref: None,
                }
            }
            BreakthroughRequirement::TechniquesCountMinLayer {
                id,
                title,
                min_count,
                min_layer,
            } => {
                let current_count = technique_count_cache.get(min_layer).copied().unwrap_or(0);
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail: format!(
                        "至少 {} 门功法 ≥ {} 层（当前 {}）",
                        min_count, min_layer, current_count
                    ),
                    status: if current_count >= *min_count {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: None,
                    source_ref: None,
                }
            }
            BreakthroughRequirement::ItemQtyMin {
                id,
                title,
                item_def_id,
                qty,
            } => {
                let current_qty = item_qty_map.get(item_def_id).copied().unwrap_or(0);
                let item_name = item_meta
                    .get(item_def_id)
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| item_def_id.clone());
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail: format!("{item_name} × {}（当前 {}）", qty, current_qty),
                    status: if current_qty >= *qty {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: None,
                    source_ref: None,
                }
            }
            BreakthroughRequirement::DungeonClearMin {
                id,
                title,
                min_count,
                dungeon_id,
                difficulty_id,
            } => {
                let dungeon_key = (
                    dungeon_id.clone().unwrap_or_default(),
                    difficulty_id.clone().unwrap_or_default(),
                );
                let clear_count = dungeon_clear_count_map
                    .get(&dungeon_key)
                    .copied()
                    .unwrap_or(0);
                let scope_text = build_dungeon_scope_text(
                    dungeon_meta,
                    dungeon_id.as_deref(),
                    difficulty_id.as_deref(),
                );
                RealmRequirementView {
                    id: id.clone(),
                    title: title.clone(),
                    detail: format!(
                        "{scope_text} 通关 ≥ {} 次（当前 {}）",
                        min_count, clear_count
                    ),
                    status: if clear_count >= *min_count {
                        RealmRequirementStatus::Done
                    } else {
                        RealmRequirementStatus::Todo
                    },
                    source_type: Some("dungeon_record".to_string()),
                    source_ref: Some(build_dungeon_source_ref(
                        dungeon_id.as_deref(),
                        difficulty_id.as_deref(),
                    )),
                }
            }
            BreakthroughRequirement::MainQuestChapterCompleted {
                id,
                title,
                chapter_id,
            } => RealmRequirementView {
                id: id.clone(),
                title: title.clone(),
                detail: format!(
                    "{}（当前{}）",
                    chapter_id,
                    if completed_chapters.contains(chapter_id) {
                        "已完成"
                    } else {
                        "未完成"
                    }
                ),
                status: if completed_chapters.contains(chapter_id) {
                    RealmRequirementStatus::Done
                } else {
                    RealmRequirementStatus::Todo
                },
                source_type: Some("main_quest".to_string()),
                source_ref: Some(format!("chapter:{chapter_id}")),
            },
            BreakthroughRequirement::VersionLocked { id, title, reason } => RealmRequirementView {
                id: id.clone(),
                title: title.clone(),
                detail: reason
                    .as_ref()
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
                    .unwrap_or_else(|| "当前版本暂未开放".to_string()),
                status: RealmRequirementStatus::Todo,
                source_type: Some("version_gate".to_string()),
                source_ref: Some("realm:version_gate".to_string()),
            },
            BreakthroughRequirement::Unsupported => RealmRequirementView {
                id: "unsupported".to_string(),
                title: "条件".to_string(),
                detail: "条件未接入".to_string(),
                status: RealmRequirementStatus::Unknown,
                source_type: None,
                source_ref: None,
            },
        };
        views.push(view);
    }
    Ok(views)
}

async fn load_technique_layers(
    pool: &sqlx::PgPool,
    character_id: i64,
    technique_ids: &[String],
) -> Result<HashMap<String, i32>, AppError> {
    if technique_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        r#"
        SELECT technique_id, current_layer
        FROM character_technique
        WHERE character_id = $1
          AND technique_id = ANY($2)
        "#,
    )
    .bind(character_id)
    .bind(technique_ids)
    .fetch_all(pool)
    .await?;
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        map.insert(
            row.get::<String, _>("technique_id"),
            row.try_get::<Option<i32>, _>("current_layer")
                .ok()
                .flatten()
                .unwrap_or(0),
        );
    }
    Ok(map)
}

#[derive(Debug, Clone)]
struct EquippedTechnique {
    name: String,
    layer: i32,
    slot_index: i32,
}

async fn load_main_technique(
    pool: &sqlx::PgPool,
    character_id: i64,
) -> Result<Option<EquippedTechnique>, AppError> {
    let technique_names = load_technique_name_map()?;
    let row = sqlx::query(
        r#"
        SELECT technique_id, current_layer
        FROM character_technique
        WHERE character_id = $1
          AND slot_type = 'main'
        ORDER BY id ASC
        LIMIT 1
        "#,
    )
    .bind(character_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| {
        let technique_id = row.get::<String, _>("technique_id");
        EquippedTechnique {
            name: technique_names
                .get(&technique_id)
                .cloned()
                .unwrap_or(technique_id),
            layer: row
                .try_get::<Option<i32>, _>("current_layer")
                .ok()
                .flatten()
                .unwrap_or(0),
            slot_index: 0,
        }
    }))
}

async fn load_sub_techniques(
    pool: &sqlx::PgPool,
    character_id: i64,
) -> Result<Vec<EquippedTechnique>, AppError> {
    let technique_names = load_technique_name_map()?;
    let rows = sqlx::query(
        r#"
        SELECT technique_id, current_layer, slot_index
        FROM character_technique
        WHERE character_id = $1
          AND slot_type = 'sub'
        ORDER BY slot_index ASC, id ASC
        "#,
    )
    .bind(character_id)
    .fetch_all(pool)
    .await?;
    let mut techniques = Vec::with_capacity(rows.len());
    for row in rows {
        let technique_id = row.get::<String, _>("technique_id");
        techniques.push(EquippedTechnique {
            name: technique_names
                .get(&technique_id)
                .cloned()
                .unwrap_or(technique_id),
            layer: row
                .try_get::<Option<i32>, _>("current_layer")
                .ok()
                .flatten()
                .unwrap_or(0),
            slot_index: row
                .try_get::<Option<i32>, _>("slot_index")
                .ok()
                .flatten()
                .unwrap_or(0),
        });
    }
    Ok(techniques)
}

async fn load_technique_count_cache(
    pool: &sqlx::PgPool,
    character_id: i64,
    requirements: &[BreakthroughRequirement],
) -> Result<HashMap<i32, i32>, AppError> {
    let mut target_layers = BTreeSet::new();
    for requirement in requirements {
        if let BreakthroughRequirement::TechniquesCountMinLayer { min_layer, .. } = requirement {
            target_layers.insert(*min_layer);
        }
    }
    if target_layers.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        r#"
        SELECT current_layer
        FROM character_technique
        WHERE character_id = $1
        "#,
    )
    .bind(character_id)
    .fetch_all(pool)
    .await?;
    let mut levels = Vec::with_capacity(rows.len());
    for row in rows {
        levels.push(
            row.try_get::<Option<i32>, _>("current_layer")
                .ok()
                .flatten()
                .unwrap_or(0),
        );
    }
    let mut cache = HashMap::with_capacity(target_layers.len());
    for target in target_layers {
        let count = levels.iter().filter(|level| **level >= target).count() as i32;
        cache.insert(target, count);
    }
    Ok(cache)
}

async fn load_item_qty_map(
    pool: &sqlx::PgPool,
    character_id: i64,
    item_ids: &[String],
) -> Result<HashMap<String, i32>, AppError> {
    if item_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        r#"
        SELECT item_def_id, COALESCE(SUM(qty), 0)::int AS qty
        FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND item_def_id = ANY($2)
        GROUP BY item_def_id
        "#,
    )
    .bind(character_id)
    .bind(item_ids)
    .fetch_all(pool)
    .await?;
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        map.insert(
            row.get::<String, _>("item_def_id"),
            row.get::<i32, _>("qty"),
        );
    }
    Ok(map)
}

async fn load_dungeon_clear_count_map(
    pool: &sqlx::PgPool,
    character_id: i64,
    keys: &[(String, String)],
) -> Result<HashMap<(String, String), i32>, AppError> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        r#"
        SELECT dungeon_id, difficulty_id, COUNT(1)::int AS cnt
        FROM dungeon_record
        WHERE character_id = $1
          AND result = 'cleared'
        GROUP BY dungeon_id, difficulty_id
        "#,
    )
    .bind(character_id)
    .fetch_all(pool)
    .await?;

    let mut exact_map = HashMap::with_capacity(rows.len());
    let mut by_dungeon = HashMap::<String, i32>::new();
    let mut by_difficulty = HashMap::<String, i32>::new();
    let mut all_count = 0;
    for row in rows {
        let dungeon_id = row.get::<String, _>("dungeon_id");
        let difficulty_id = row.get::<String, _>("difficulty_id");
        let count = row.get::<i32, _>("cnt");
        exact_map.insert((dungeon_id.clone(), difficulty_id.clone()), count);
        *by_dungeon.entry(dungeon_id).or_insert(0) += count;
        *by_difficulty.entry(difficulty_id).or_insert(0) += count;
        all_count += count;
    }

    let mut result = HashMap::with_capacity(keys.len());
    for (dungeon_id, difficulty_id) in keys {
        let count = if dungeon_id.is_empty() && difficulty_id.is_empty() {
            all_count
        } else if !dungeon_id.is_empty() && difficulty_id.is_empty() {
            by_dungeon.get(dungeon_id).copied().unwrap_or(0)
        } else if dungeon_id.is_empty() && !difficulty_id.is_empty() {
            by_difficulty.get(difficulty_id).copied().unwrap_or(0)
        } else {
            exact_map
                .get(&(dungeon_id.clone(), difficulty_id.clone()))
                .copied()
                .unwrap_or(0)
        };
        result.insert((dungeon_id.clone(), difficulty_id.clone()), count);
    }
    Ok(result)
}

async fn load_completed_chapters(
    pool: &sqlx::PgPool,
    character_id: i64,
) -> Result<BTreeSet<String>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT completed_chapters
        FROM character_main_quest_progress
        WHERE character_id = $1
        LIMIT 1
        "#,
    )
    .bind(character_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(BTreeSet::new());
    };
    let raw = row
        .try_get::<Option<Value>, _>("completed_chapters")
        .ok()
        .flatten();
    let mut chapters = BTreeSet::new();
    if let Some(Value::Array(entries)) = raw {
        for entry in entries {
            if let Some(chapter_id) = entry
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                chapters.insert(chapter_id.to_string());
            }
        }
    }
    Ok(chapters)
}

async fn resolve_costs(
    pool: &sqlx::PgPool,
    character_id: Option<i64>,
    current_exp: Option<i64>,
    current_spirit_stones: Option<i64>,
    costs: &[BreakthroughCost],
) -> Result<CostResolution, AppError> {
    let item_meta = load_item_meta_map()?;
    let mut exp = 0_i64;
    let mut spirit_stones = 0_i64;
    let mut item_totals = BTreeMap::<String, i32>::new();
    for cost in costs {
        match cost {
            BreakthroughCost::Exp { amount } => {
                exp += (*amount).max(0);
            }
            BreakthroughCost::SpiritStones { amount } => {
                spirit_stones += (*amount).max(0);
            }
            BreakthroughCost::Items { items } => {
                for item in items {
                    if item.qty <= 0 {
                        continue;
                    }
                    *item_totals.entry(item.item_def_id.clone()).or_insert(0) += item.qty;
                }
            }
        }
    }

    let item_ids = item_totals.keys().cloned().collect::<Vec<_>>();
    let item_qty_map = if let Some(character_id) = character_id {
        load_item_qty_map(pool, character_id, &item_ids).await?
    } else {
        HashMap::new()
    };

    let mut view = Vec::with_capacity(2 + item_totals.len());
    let exp_status = current_exp.map(|value| {
        if value >= exp {
            RealmRequirementStatus::Done
        } else {
            RealmRequirementStatus::Todo
        }
    });
    if exp > 0 {
        view.push(RealmCostView {
            id: "cost-exp".to_string(),
            title: "经验".to_string(),
            detail: current_exp
                .map(|current| format!("需要 {exp}（当前 {current}）"))
                .unwrap_or_else(|| exp.to_string()),
            cost_type: "exp".to_string(),
            status: exp_status.clone(),
            amount: Some(exp),
            item_def_id: None,
            item_name: None,
            item_icon: None,
            qty: None,
        });
    }
    let spirit_status = current_spirit_stones.map(|value| {
        if value >= spirit_stones {
            RealmRequirementStatus::Done
        } else {
            RealmRequirementStatus::Todo
        }
    });
    if spirit_stones > 0 {
        view.push(RealmCostView {
            id: "cost-spirit-stones".to_string(),
            title: "灵石".to_string(),
            detail: current_spirit_stones
                .map(|current| format!("需要 {spirit_stones}（当前 {current}）"))
                .unwrap_or_else(|| spirit_stones.to_string()),
            cost_type: "spirit_stones".to_string(),
            status: spirit_status.clone(),
            amount: Some(spirit_stones),
            item_def_id: None,
            item_name: None,
            item_icon: None,
            qty: None,
        });
    }
    for (item_def_id, qty) in item_totals {
        let item = item_meta.get(&item_def_id);
        let current_qty = item_qty_map.get(&item_def_id).copied();
        let status = current_qty.map(|value| {
            if value >= qty {
                RealmRequirementStatus::Done
            } else {
                RealmRequirementStatus::Todo
            }
        });
        view.push(RealmCostView {
            id: format!("cost-item-{item_def_id}"),
            title: item
                .map(|entry| entry.name.clone())
                .unwrap_or_else(|| item_def_id.clone()),
            detail: current_qty
                .map(|current| format!("×{qty}（当前 {current}）"))
                .unwrap_or_else(|| format!("×{qty}")),
            cost_type: "item".to_string(),
            status,
            amount: None,
            item_def_id: Some(item_def_id.clone()),
            item_name: item.map(|entry| entry.name.clone()),
            item_icon: item.and_then(|entry| entry.icon.clone()),
            qty: Some(qty),
        });
    }
    let affordable = view
        .iter()
        .all(|cost| cost.status != Some(RealmRequirementStatus::Todo));
    let items = view
        .iter()
        .filter_map(|cost| {
            let item_def_id = cost.item_def_id.clone()?;
            Some(BreakthroughItemCost {
                item_def_id,
                qty: cost.qty.unwrap_or(0),
            })
        })
        .collect::<Vec<_>>();
    Ok(CostResolution {
        exp,
        spirit_stones,
        items,
        view,
        affordable,
    })
}

fn build_rewards_view(rewards: Option<&RewardConfig>) -> Result<Vec<RealmRewardView>, AppError> {
    let Some(rewards) = rewards else {
        return Ok(Vec::new());
    };
    let mut view = Vec::new();
    let attribute_points = rewards.attribute_points.unwrap_or(0).max(0);
    if attribute_points > 0 {
        view.push(RealmRewardView {
            id: "ap".to_string(),
            title: "属性点".to_string(),
            detail: format!("+{attribute_points}"),
        });
    }
    if let Some(flat) = &rewards.flat {
        for (key, title) in BREAKTHROUGH_NUMERIC_REWARD_DEFS {
            let value = flat.get(key).copied().unwrap_or(0.0);
            if value == 0.0 {
                continue;
            }
            view.push(RealmRewardView {
                id: format!("flat-{key}"),
                title: title.to_string(),
                detail: format_signed_number(value),
            });
        }
    }
    if let Some(pct) = &rewards.pct {
        for (key, title) in BREAKTHROUGH_NUMERIC_REWARD_DEFS {
            let value = pct.get(key).copied().unwrap_or(0.0);
            if value == 0.0 {
                continue;
            }
            view.push(RealmRewardView {
                id: format!("pct-{key}"),
                title: title.to_string(),
                detail: format!("{}%", format_signed_percentage(value)),
            });
        }
    }
    if let Some(add_percent) = &rewards.add_percent {
        for (key, title) in BREAKTHROUGH_ADD_PERCENT_REWARD_DEFS {
            let value = add_percent.get(key).copied().unwrap_or(0.0);
            if value == 0.0 {
                continue;
            }
            view.push(RealmRewardView {
                id: format!("add-percent-{key}"),
                title: title.to_string(),
                detail: format!("{}%", format_signed_percentage(value)),
            });
        }
    }
    Ok(view)
}

fn format_signed_number(value: f64) -> String {
    let rounded = value.round() as i64;
    if rounded > 0 {
        format!("+{rounded}")
    } else {
        rounded.to_string()
    }
}

fn format_signed_percentage(value: f64) -> String {
    let pct = (value * 100.0).to_string();
    if value > 0.0 {
        format!("+{pct}")
    } else {
        pct
    }
}

async fn consume_cost_items(
    transaction: &mut Transaction<'_, Postgres>,
    character_id: i64,
    items: &[BreakthroughItemCost],
) -> Result<(), BusinessError> {
    for item in items {
        let mut remaining = item.qty.max(0);
        if remaining <= 0 {
            continue;
        }
        let rows = sqlx::query(
            r#"
            SELECT id, qty
            FROM item_instance
            WHERE owner_character_id = $1
              AND location = 'bag'
              AND item_def_id = $2
            ORDER BY created_at ASC, id ASC
            FOR UPDATE
            "#,
        )
        .bind(character_id)
        .bind(&item.item_def_id)
        .fetch_all(&mut **transaction)
        .await
        .map_err(sqlx_business_error)?;
        for row in rows {
            if remaining <= 0 {
                break;
            }
            let instance_id = row.get::<i64, _>("id");
            let instance_qty = row.get::<i32, _>("qty").max(0);
            if instance_qty <= 0 {
                continue;
            }
            let consume_qty = remaining.min(instance_qty);
            if consume_qty == instance_qty {
                sqlx::query("DELETE FROM item_instance WHERE id = $1")
                    .bind(instance_id)
                    .execute(&mut **transaction)
                    .await
                    .map_err(sqlx_business_error)?;
            } else {
                sqlx::query(
                    r#"
                    UPDATE item_instance
                    SET qty = qty - $2,
                        updated_at = NOW()
                    WHERE id = $1
                    "#,
                )
                .bind(instance_id)
                .bind(consume_qty)
                .execute(&mut **transaction)
                .await
                .map_err(sqlx_business_error)?;
            }
            remaining -= consume_qty;
        }
        if remaining > 0 {
            return Err(BusinessError::new("材料不足"));
        }
    }
    Ok(())
}

fn build_requirement_failure_message(requirement: &RealmRequirementView) -> String {
    if requirement.source_type.as_deref() == Some("version_gate") {
        requirement.detail.clone()
    } else {
        format!("条件未满足：{}", requirement.title)
    }
}

fn build_dungeon_scope_text(
    catalog: &DungeonMetaCatalog,
    dungeon_id: Option<&str>,
    difficulty_id: Option<&str>,
) -> String {
    match (
        dungeon_id.filter(|value| !value.is_empty()),
        difficulty_id.filter(|value| !value.is_empty()),
    ) {
        (Some(dungeon_id), Some(difficulty_id)) => {
            let dungeon_name = catalog
                .dungeon_name_by_id
                .get(dungeon_id)
                .cloned()
                .unwrap_or_else(|| dungeon_id.to_string());
            let difficulty_name = catalog
                .difficulty_name_by_id
                .get(difficulty_id)
                .cloned()
                .unwrap_or_else(|| difficulty_id.to_string());
            format!("{dungeon_name}（{difficulty_name}）")
        }
        (Some(dungeon_id), None) => catalog
            .dungeon_name_by_id
            .get(dungeon_id)
            .cloned()
            .unwrap_or_else(|| dungeon_id.to_string()),
        (None, Some(difficulty_id)) => {
            let difficulty_name = catalog
                .difficulty_name_by_id
                .get(difficulty_id)
                .cloned()
                .unwrap_or_else(|| difficulty_id.to_string());
            format!("任意秘境（{difficulty_name}）")
        }
        (None, None) => "任意秘境".to_string(),
    }
}

fn build_dungeon_source_ref(dungeon_id: Option<&str>, difficulty_id: Option<&str>) -> String {
    match (
        dungeon_id.filter(|value| !value.is_empty()),
        difficulty_id.filter(|value| !value.is_empty()),
    ) {
        (Some(dungeon_id), Some(difficulty_id)) => {
            format!("dungeon:{dungeon_id}|difficulty:{difficulty_id}")
        }
        (Some(dungeon_id), None) => format!("dungeon:{dungeon_id}"),
        (None, Some(difficulty_id)) => format!("difficulty:{difficulty_id}"),
        (None, None) => "dungeon:*".to_string(),
    }
}

fn build_spent_item_views(
    items: &[BreakthroughItemCost],
) -> Result<Vec<RealmSpentItemView>, AppError> {
    let item_meta = load_item_meta_map()?;
    Ok(items
        .iter()
        .filter(|item| item.qty > 0)
        .map(|item| RealmSpentItemView {
            item_def_id: item.item_def_id.clone(),
            qty: item.qty,
            name: item_meta
                .get(&item.item_def_id)
                .map(|meta| meta.name.clone()),
            icon: item_meta
                .get(&item.item_def_id)
                .and_then(|meta| meta.icon.clone()),
        })
        .collect())
}

fn internal_business_error(error: AppError) -> BusinessError {
    if let AppError::Config(message) = error {
        return BusinessError::with_status(message, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    }
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

fn sqlx_business_error(error: sqlx::Error) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
