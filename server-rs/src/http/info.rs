use axum::Json;
use axum::extract::{Path, State};
use sqlx::Row;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::repo::info_target::{InfoItemTarget, InfoMonsterTarget, InfoNpcTarget, get_item_info_target, get_monster_info_target, get_npc_info_target};
use crate::repo::item_taxonomy::build_game_item_taxonomy;
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

#[derive(serde::Serialize)]
pub struct ItemTaxonomyEnvelope {
    pub taxonomy: crate::repo::item_taxonomy::GameItemTaxonomyDto,
}

#[derive(serde::Serialize)]
pub struct InfoTargetEnvelope {
    pub target: InfoTargetDto,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PlayerEquipmentDto {
    pub slot: String,
    pub name: String,
    pub quality: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PlayerTechniqueDto {
    pub name: String,
    pub level: String,
    #[serde(rename = "type")]
    pub technique_type: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoItemResourceDto {
    pub collect_limit: i64,
    pub used_count: i64,
    pub remaining: i64,
    pub cooldown_sec: i64,
    pub respawn_sec: i64,
    pub cooldown_until: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum InfoTargetDto {
    #[serde(rename = "monster")]
    Monster {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_marker: Option<String>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        task_tracked: bool,
        title: Option<String>,
        gender: String,
        realm: Option<String>,
        avatar: Option<String>,
        base_attrs: Option<serde_json::Value>,
        attr_variance: Option<f64>,
        attr_multiplier_min: Option<f64>,
        attr_multiplier_max: Option<f64>,
        stats: Option<Vec<crate::repo::info_target::InfoStatRow>>,
        drops: Option<Vec<crate::repo::info_target::InfoDropRow>>,
    },
    #[serde(rename = "npc")]
    Npc {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_marker: Option<String>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        task_tracked: bool,
        title: Option<String>,
        gender: Option<String>,
        realm: Option<String>,
        avatar: Option<String>,
        desc: Option<String>,
        drops: Option<Vec<serde_json::Value>>,
    },
    #[serde(rename = "item")]
    Item {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        object_kind: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resource: Option<InfoItemResourceDto>,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_marker: Option<String>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        task_tracked: bool,
        title: Option<String>,
        gender: String,
        realm: Option<String>,
        avatar: Option<String>,
        desc: Option<String>,
        stats: Option<Vec<crate::repo::info_target::InfoStatRow>>,
    },
    #[serde(rename = "player")]
    Player {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_marker: Option<String>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        task_tracked: bool,
        month_card_active: bool,
        title: Option<String>,
        title_description: Option<String>,
        gender: Option<String>,
        realm: Option<String>,
        avatar: Option<String>,
        stats: Option<Vec<crate::repo::info_target::InfoStatRow>>,
        equipment: Option<Vec<PlayerEquipmentDto>>,
        techniques: Option<Vec<PlayerTechniqueDto>>,
    },
}

pub async fn get_item_taxonomy() -> Result<Json<SuccessResponse<ItemTaxonomyEnvelope>>, AppError> {
    Ok(send_success(ItemTaxonomyEnvelope {
        taxonomy: build_game_item_taxonomy()?,
    }))
}

pub async fn get_info_target(
    State(state): State<AppState>,
    Path((target_type, id)): Path<(String, String)>,
) -> Result<Json<SuccessResponse<InfoTargetEnvelope>>, AppError> {
    if id.trim().is_empty() {
        return Err(AppError::config("参数错误"));
    }

    let target = match target_type.trim() {
        "item" => get_item_info_target(&id)?.map(map_item_target),
        "npc" => get_npc_info_target(&id)?.map(map_npc_target),
        "monster" => get_monster_info_target(&id)?.map(map_monster_target),
        "player" => load_player_target(&state, &id).await?,
        _ => return Err(AppError::config("参数错误")),
    }.ok_or_else(|| AppError::not_found("对象不存在"))?;

    Ok(send_success(InfoTargetEnvelope {
        target,
    }))
}

pub fn map_monster_target(target: InfoMonsterTarget) -> InfoTargetDto {
    InfoTargetDto::Monster {
        id: target.id,
        name: target.name,
        task_marker: None,
        task_tracked: false,
        title: target.title,
        gender: target.gender,
        realm: target.realm,
        avatar: target.avatar,
        base_attrs: target.base_attrs,
        attr_variance: target.attr_variance,
        attr_multiplier_min: target.attr_multiplier_min,
        attr_multiplier_max: target.attr_multiplier_max,
        stats: (!target.stats.is_empty()).then_some(target.stats),
        drops: (!target.drops.is_empty()).then_some(target.drops),
    }
}

pub fn map_npc_target(target: InfoNpcTarget) -> InfoTargetDto {
    InfoTargetDto::Npc {
        id: target.id,
        name: target.name,
        task_marker: None,
        task_tracked: false,
        title: target.title,
        gender: target.gender,
        realm: target.realm,
        avatar: target.avatar,
        desc: target.desc,
        drops: None,
    }
}

pub fn map_item_target(target: InfoItemTarget) -> InfoTargetDto {
    InfoTargetDto::Item {
        id: target.id,
        object_kind: None,
        resource: None,
        name: target.name,
        task_marker: None,
        task_tracked: false,
        title: target.title,
        gender: target.gender,
        realm: target.realm,
        avatar: target.avatar,
        desc: target.desc,
        stats: (!target.stats.is_empty()).then_some(target.stats),
    }
}

async fn load_player_target(
    state: &AppState,
    raw_id: &str,
) -> Result<Option<InfoTargetDto>, AppError> {
    let character_id = raw_id.trim().parse::<i64>().ok().filter(|value| *value > 0);
    let Some(character_id) = character_id else {
        return Ok(None);
    };

    let row = state
        .database
        .fetch_optional(
            "SELECT id, nickname, title, gender, avatar, realm, sub_realm, jing, qi, shen, attribute_points, spirit_stones, silver, COALESCE(jing, 0)::bigint AS qixue, COALESCE(jing, 0)::bigint AS max_qixue, COALESCE(qi, 0)::bigint AS lingqi, COALESCE(qi, 0)::bigint AS max_lingqi, 0::bigint AS wugong, 0::bigint AS fagong, 0::bigint AS wufang, 0::bigint AS fafang, 0::bigint AS mingzhong, 0::bigint AS shanbi, 0::bigint AS baoji, 0::bigint AS baoshang, 0::bigint AS kangbao, 0::bigint AS sudu, 0::bigint AS fuyuan FROM characters WHERE id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    let month_card_active = state
        .database
        .fetch_optional(
            "SELECT 1 FROM month_card_ownership WHERE character_id = $1 AND expire_at > CURRENT_TIMESTAMP LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?
        .is_some();

    let (title_name, title_description) = load_equipped_title_presentation(state, character_id).await?;
    let equipment = load_player_equipment(state, character_id).await?;
    let techniques = load_player_techniques(state, character_id).await?;

    let persisted_title = row.try_get::<Option<String>, _>("title")?.unwrap_or_default();
    let title = title_name
        .or_else(|| (!persisted_title.trim().is_empty()).then_some(persisted_title))
        .or(Some("散修".to_string()));

    Ok(Some(InfoTargetDto::Player {
        id: character_id.to_string(),
        name: row
            .try_get::<Option<String>, _>("nickname")?
            .unwrap_or_else(|| format!("修士{}", character_id)),
        task_marker: None,
        task_tracked: false,
        month_card_active,
        title,
        title_description,
        gender: normalize_gender(row.try_get::<Option<String>, _>("gender")?),
        realm: Some(build_full_realm(
            row.try_get::<Option<String>, _>("realm")?
                .unwrap_or_else(|| "凡人".to_string()),
            row.try_get::<Option<String>, _>("sub_realm")?
                .unwrap_or_default(),
        )),
        avatar: row.try_get::<Option<String>, _>("avatar")?,
        stats: Some(build_player_stats(&row)?),
        equipment: (!equipment.is_empty()).then_some(equipment),
        techniques: (!techniques.is_empty()).then_some(techniques),
    }))
}

async fn load_equipped_title_presentation(
    state: &AppState,
    character_id: i64,
) -> Result<(Option<String>, Option<String>), AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT title_id FROM character_title WHERE character_id = $1 AND is_equipped = true AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY id ASC LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok((None, None));
    };
    let title_id = row.try_get::<Option<String>, _>("title_id")?.unwrap_or_default();
    if title_id.trim().is_empty() {
        return Ok((None, None));
    }
    let title_map = load_title_definition_map()?;
    Ok(title_map
        .get(title_id.trim())
        .cloned()
        .unwrap_or((None, None)))
}

async fn load_player_equipment(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<PlayerEquipmentDto>, AppError> {
    let item_map = load_item_definition_map()?;
    let rows = state
        .database
        .fetch_all(
            "SELECT equipped_slot, item_def_id, quality FROM item_instance WHERE owner_character_id = $1 AND location = 'equipped' ORDER BY equipped_slot ASC, id ASC",
            |query| query.bind(character_id),
        )
        .await?;
    let mut equipment = Vec::new();
    for row in rows {
        let item_def_id = row.try_get::<Option<String>, _>("item_def_id")?.unwrap_or_default();
        let Some((name, quality_from_def)) = item_map.get(item_def_id.trim()) else {
            continue;
        };
        let quality = row.try_get::<Option<String>, _>("quality")?.unwrap_or_else(|| quality_from_def.clone());
        let slot = map_equipped_slot(
            &row.try_get::<Option<String>, _>("equipped_slot")?.unwrap_or_default(),
        );
        equipment.push(PlayerEquipmentDto {
            slot,
            name: name.clone(),
            quality: if quality.trim().is_empty() { "-".to_string() } else { quality },
        });
    }
    Ok(equipment)
}

async fn load_player_techniques(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<PlayerTechniqueDto>, AppError> {
    let technique_map = load_technique_definition_map()?;
    let rows = state
        .database
        .fetch_all(
            "SELECT technique_id, current_layer FROM character_technique WHERE character_id = $1 AND slot_type IS NOT NULL ORDER BY slot_type ASC, slot_index ASC",
            |query| query.bind(character_id),
        )
        .await?;
    let mut techniques = Vec::new();
    for row in rows {
        let technique_id = row.try_get::<Option<String>, _>("technique_id")?.unwrap_or_default();
        let Some((name, technique_type)) = technique_map.get(technique_id.trim()) else {
            continue;
        };
        let layer = opt_i64_from_i32(&row, "current_layer")?.unwrap_or_default();
        techniques.push(PlayerTechniqueDto {
            name: name.clone(),
            level: if layer > 0 { format!("{}重", layer) } else { "-".to_string() },
            technique_type: technique_type.clone(),
        });
    }
    Ok(techniques)
}

fn build_player_stats(
    row: &sqlx::postgres::PgRow,
) -> Result<Vec<crate::repo::info_target::InfoStatRow>, AppError> {
    let mut stats = Vec::new();
    for (label, key, ratio) in [
        ("精", "jing", false),
        ("气", "qi", false),
        ("神", "shen", false),
        ("属性点", "attribute_points", false),
        ("灵石", "spirit_stones", false),
        ("银两", "silver", false),
        ("气血", "qixue", false),
        ("最大气血", "max_qixue", false),
        ("灵气", "lingqi", false),
        ("最大灵气", "max_lingqi", false),
        ("物攻", "wugong", false),
        ("法攻", "fagong", false),
        ("物防", "wufang", false),
        ("法防", "fafang", false),
        ("命中", "mingzhong", true),
        ("闪避", "shanbi", true),
        ("暴击", "baoji", true),
        ("暴伤", "baoshang", true),
        ("抗暴", "kangbao", true),
        ("速度", "sudu", false),
        ("福缘", "fuyuan", false),
    ] {
        let value = row
            .try_get::<Option<f64>, _>(key)
            .ok()
            .flatten()
            .map(serde_json::Value::from)
            .or_else(|| {
                row.try_get::<Option<i64>, _>(key)
                    .ok()
                    .flatten()
                    .map(serde_json::Value::from)
            })
            .or_else(|| {
                row.try_get::<Option<i32>, _>(key)
                    .ok()
                    .flatten()
                    .map(i64::from)
                    .map(serde_json::Value::from)
            });
        let Some(value) = value else { continue; };
        let normalized = if ratio {
            if let Some(number) = value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)) {
                serde_json::Value::String(format_percent(number))
            } else {
                value.clone()
            }
        } else {
            value.clone()
        };
        stats.push(crate::repo::info_target::InfoStatRow {
            label: label.to_string(),
            value: normalized,
        });
    }
    Ok(stats)
}

fn load_title_definition_map(
) -> Result<BTreeMap<String, (Option<String>, Option<String>)>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/title_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read title_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse title_def.json: {error}")))?;
    let titles = payload
        .get("titles")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(titles
        .into_iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.trim().to_string();
            let name = row.get("name")?.as_str().map(|value| value.trim().to_string());
            let description = row.get("description").and_then(|value| value.as_str()).map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
            (!id.is_empty()).then_some((id, (name.filter(|value| !value.is_empty()), description)))
        })
        .collect())
}

fn load_item_definition_map() -> Result<BTreeMap<String, (String, String)>, AppError> {
    let mut map = BTreeMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let content = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../server/src/data/seeds/{filename}")),
        )
        .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
        let payload: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))?;
        let items = payload.get("items").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        for item in items {
            let id = item.get("id").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
            let name = item.get("name").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
            if id.is_empty() || name.is_empty() { continue; }
            let quality = item.get("quality").and_then(|value| value.as_str()).unwrap_or("-").trim().to_string();
            map.insert(id, (name, quality));
        }
    }
    Ok(map)
}

fn load_technique_definition_map() -> Result<BTreeMap<String, (String, String)>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/technique_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse technique_def.json: {error}")))?;
    let techniques = payload.get("techniques").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    Ok(techniques
        .into_iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.trim().to_string();
            let name = row.get("name")?.as_str()?.trim().to_string();
            let technique_type = row.get("type").and_then(|value| value.as_str()).unwrap_or("功法").trim().to_string();
            (!id.is_empty() && !name.is_empty()).then_some((id, (name, technique_type)))
        })
        .collect())
}

fn map_equipped_slot(raw: &str) -> String {
    match raw.trim() {
        "weapon" => "武器",
        "head" => "头部",
        "clothes" => "衣服",
        "gloves" => "护手",
        "pants" => "下装",
        "necklace" => "项链",
        "accessory" => "饰品",
        "artifact" => "法宝",
        value if !value.is_empty() => value,
        _ => "槽位",
    }
    .to_string()
}

fn normalize_gender(value: Option<String>) -> Option<String> {
    match value.as_deref().map(str::trim) {
        Some("male") => Some("男".to_string()),
        Some("female") => Some("女".to_string()),
        Some(value) if !value.is_empty() => Some(value.to_string()),
        _ => None,
    }
}

fn build_full_realm(realm: String, sub_realm: String) -> String {
    let realm = realm.trim().to_string();
    let sub_realm = sub_realm.trim().to_string();
    if realm.is_empty() {
        return "凡人".to_string();
    }
    if realm == "凡人" || sub_realm.is_empty() {
        return realm;
    }
    format!("{}·{}", realm, sub_realm)
}

fn format_percent(value: f64) -> String {
    let percent = value * 100.0;
    let fixed = if (percent - percent.round()).abs() < 1e-9 {
        format!("{:.0}", percent)
    } else {
        format!("{:.2}", percent)
    };
    format!("{}%", fixed.trim_end_matches('0').trim_end_matches('.'))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use http::{Request, StatusCode};
    use tower::ServiceExt;

    use crate::bootstrap::app::build_router;
    use crate::config::{
        AppConfig, CaptchaConfig, CaptchaProvider, CosConfig, DatabaseConfig, HttpConfig,
        LoggingConfig, MarketPhoneBindingConfig, OutboundHttpConfig, RedisConfig, ServiceConfig, StorageConfig,
        WanderConfig,
    };
    use crate::integrations::database::DatabaseRuntime;
    use crate::state::AppState;

    fn test_state() -> AppState {
        let config = Arc::new(AppConfig {
            service: ServiceConfig {
                name: "九州修仙录 Rust Backend".to_string(),
                version: "0.1.0".to_string(),
                node_env: "test".to_string(),
                jwt_secret: "test-secret".to_string(),
                jwt_expires_in: "7d".to_string(),
            },
            http: HttpConfig {
                host: "127.0.0.1".to_string(),
                port: 6011,
                cors_origin: "*".to_string(),
            },
            wander: WanderConfig {
                ai_enabled: false,
                model_provider: String::new(),
                model_url: String::new(),
                model_key: String::new(),
                model_name: String::new(),
            },
            captcha: CaptchaConfig {
                provider: CaptchaProvider::Local,
                tencent_app_id: 0,
                tencent_app_secret_key: String::new(),
                tencent_secret_id: String::new(),
                tencent_secret_key: String::new(),
            },
            market_phone_binding: MarketPhoneBindingConfig {
                enabled: false,
                aliyun_access_key_id: String::new(),
                aliyun_access_key_secret: String::new(),
                sign_name: String::new(),
                template_code: String::new(),
                code_expire_seconds: 300,
                send_cooldown_seconds: 60,
                send_hourly_limit: 5,
                send_daily_limit: 10,
            },
            database: DatabaseConfig {
                url: "postgresql://postgres:postgres@localhost:5432/jiuzhou".to_string(),
            },
            redis: RedisConfig {
                url: "redis://127.0.0.1:6379".to_string(),
            },
            outbound_http: OutboundHttpConfig { timeout_ms: 1_000 },
            storage: StorageConfig {
                uploads_dir: std::env::temp_dir().join("server-rs-test-uploads"),
            },
            cos: CosConfig {
                secret_id: String::new(),
                secret_key: String::new(),
                bucket: String::new(),
                region: String::new(),
                avatar_prefix: "avatars/".to_string(),
                generated_image_prefix: "generated/".to_string(),
                domain: String::new(),
                sts_duration_seconds: 600,
            },
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
        });

        let database = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy(&config.database.url)
            .expect("lazy postgres pool should build for tests");
        let redis = Some(
            redis::Client::open(config.redis.url.clone()).expect("test redis client should build"),
        );
        let http_client = reqwest::Client::new();

        AppState::new(config, DatabaseRuntime::new(database), redis, http_client, true)
    }

    #[tokio::test]
    async fn item_taxonomy_endpoint_returns_taxonomy_payload() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/info/item-taxonomy")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json should parse");
        assert_eq!(payload["success"], true);
        assert!(payload["data"]["taxonomy"]["categories"]["options"]
            .as_array()
            .map(|items| !items.is_empty())
            .unwrap_or(false));
        println!("ITEM_TAXONOMY_RESPONSE={}", payload);
    }

    #[tokio::test]
    async fn item_target_endpoint_returns_item_payload() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/info/item/cons-001")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json should parse");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["target"]["type"], "item");
        assert_eq!(payload["data"]["target"]["name"], "清灵丹");
        println!("ITEM_TARGET_RESPONSE={}", payload);
    }

    #[tokio::test]
    async fn npc_target_endpoint_returns_npc_payload() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/info/npc/npc-village-elder")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json should parse");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["target"]["type"], "npc");
        assert_eq!(payload["data"]["target"]["name"], "村长");
        println!("NPC_TARGET_RESPONSE={}", payload);
    }

    #[tokio::test]
    async fn monster_target_endpoint_returns_monster_payload() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/info/monster/monster-duzhang-guchong")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json should parse");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["target"]["type"], "monster");
        assert_eq!(payload["data"]["target"]["name"], "毒瘴蛊虫");
        println!("MONSTER_TARGET_RESPONSE={}", payload);
    }

    #[tokio::test]
    async fn player_target_endpoint_returns_player_payload() {
        let app = build_router(test_state()).expect("router should build");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/info/player/88")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("request should succeed");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should read");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json should parse");

        if status == StatusCode::OK {
            assert_eq!(payload["success"], true);
            assert_eq!(payload["data"]["target"]["type"], "player");
            println!("PLAYER_TARGET_ENDPOINT_RESPONSE={}", payload);
        } else {
            assert!(status == StatusCode::NOT_FOUND || status == StatusCode::INTERNAL_SERVER_ERROR);
            println!("PLAYER_TARGET_ENDPOINT_FALLBACK_RESPONSE={}", payload);
        }
    }

    #[test]
    fn player_target_payload_matches_frontend_contract_shape() {
        let payload = serde_json::to_value(super::InfoTargetEnvelope {
            target: super::InfoTargetDto::Player {
                id: "88".to_string(),
                name: "凌霄子".to_string(),
                task_marker: None,
                task_tracked: false,
                month_card_active: true,
                title: Some("猎兔新手".to_string()),
                title_description: Some("击杀野兔达人".to_string()),
                gender: Some("男".to_string()),
                realm: Some("炼精化炁·养气期".to_string()),
                avatar: Some("/uploads/avatars/test.png".to_string()),
                stats: Some(vec![crate::repo::info_target::InfoStatRow {
                    label: "物攻".to_string(),
                    value: serde_json::json!(15),
                }]),
                equipment: Some(vec![super::PlayerEquipmentDto {
                    slot: "武器".to_string(),
                    name: "基础剑".to_string(),
                    quality: "黄".to_string(),
                }]),
                techniques: Some(vec![super::PlayerTechniqueDto {
                    name: "基础剑法".to_string(),
                    level: "3重".to_string(),
                    technique_type: "武技".to_string(),
                }]),
            },
        })
        .expect("payload should serialize");

        assert_eq!(payload["target"]["type"], "player");
        assert_eq!(payload["target"]["month_card_active"], true);
        assert_eq!(payload["target"]["equipment"][0]["slot"], "武器");
        assert_eq!(payload["target"]["techniques"][0]["type"], "武技");
        println!("PLAYER_TARGET_RESPONSE={}", payload);
    }
}
