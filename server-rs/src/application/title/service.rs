use std::collections::HashMap;
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use serde::Deserialize;
use serde_json::Value;
use sqlx::Row;

use crate::application::static_data::seed::read_seed_json;
use axum::http::StatusCode;

use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::title::{TitleInfoView, TitleListView, TitleRouteServices};

static STATIC_TITLE_MAP: OnceLock<Result<HashMap<String, StaticTitleDefinition>, String>> =
    OnceLock::new();

/**
 * 称号应用服务。
 *
 * 作用：
 * 1. 做什么：复用 Node 现有 `title_def.json + generated_title_def` 双源读取规则，提供 `/api/title/list` 与 `/api/title/equip` 所需的单一服务入口。
 * 2. 做什么：把静态称号索引前置缓存到模块级，避免每次请求重复解析种子文件；动态称号只针对命中的 titleId 做一次批量补查。
 * 3. 不做什么：不处理称号发放，不负责推送通知，也不在这里扩展成完整成就系统。
 *
 * 输入 / 输出：
 * - 输入：`character_id`，以及装备接口额外接收 `title_id`。
 * - 输出：列表返回 Node 兼容的 `TitleListView`；装备返回 `{ success, message }` 业务结果。
 *
 * 数据流 / 状态流：
 * - HTTP 路由确认角色上下文 -> 本服务读取 `character_title`
 * - 静态定义先走模块级缓存，动态定义再查 `generated_title_def`
 * - 列表直接序列化返回；装备则锁定当前称号记录、切换 `is_equipped`、同步 `characters.title`。
 *
 * 复用设计说明：
 * - 标题定义读取和 effects 规范化集中在这里，后续若迁移成就奖励、云游正式称号或首页角色面板，不需要再各自复制一套 `titleId -> definition` 逻辑。
 * - 静态索引缓存与动态定义补查拆成两层，可以同时服务高频列表读取和低频装备 mutation，避免每个调用点各自建 Map。
 *
 * 关键边界条件与坑点：
 * 1. 静态定义优先级必须高于动态定义，同 ID 时不能被数据库记录覆盖，否则会破坏现有正式称号定义口径。
 * 2. 装备接口对“未拥有该称号”的判断必须同时校验定义存在和角色归属记录存在，不能只看 `title_def.json` 是否有该 ID。
 */
#[derive(Debug, Clone)]
pub struct RustTitleRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleEquipResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone)]
struct StaticTitleDefinition {
    id: String,
    name: String,
    description: String,
    color: Option<String>,
    icon: Option<String>,
    effects: HashMap<String, i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct StaticTitleSeedFile {
    titles: Vec<StaticTitleSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct StaticTitleSeed {
    id: String,
    name: String,
    description: String,
    color: Option<String>,
    icon: Option<String>,
    effects: Option<Value>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone)]
struct DynamicTitleDefinition {
    id: String,
    name: String,
    description: String,
    color: Option<String>,
    icon: Option<String>,
    effects: HashMap<String, i64>,
}

impl RustTitleRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn list_titles_impl(&self, character_id: i64) -> Result<TitleListView, BusinessError> {
        let rows = sqlx::query(
            r#"
            SELECT
              title_id,
              is_equipped,
              to_char(obtained_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS obtained_at,
              CASE
                WHEN expires_at IS NULL THEN NULL
                ELSE to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              END AS expires_at
            FROM character_title
            WHERE character_id = $1
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY is_equipped DESC, obtained_at ASC, id ASC
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let mut title_ids = Vec::with_capacity(rows.len());
        for row in &rows {
            let title_id = row.get::<String, _>("title_id");
            if !title_id.trim().is_empty() {
                title_ids.push(title_id);
            }
        }
        let definitions = self.load_title_definitions(&title_ids).await?;

        let mut titles = Vec::with_capacity(rows.len());
        let mut equipped = String::new();
        for row in rows {
            let title_id = row.get::<String, _>("title_id");
            let Some(definition) = definitions.get(title_id.as_str()) else {
                continue;
            };
            let is_equipped = row.get::<bool, _>("is_equipped");
            if is_equipped {
                equipped = title_id.clone();
            }
            let obtained_at = row
                .try_get::<Option<String>, _>("obtained_at")
                .ok()
                .flatten()
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string());
            let expires_at = row
                .try_get::<Option<String>, _>("expires_at")
                .ok()
                .flatten();

            titles.push(TitleInfoView {
                id: definition.id.clone(),
                name: definition.name.clone(),
                description: definition.description.clone(),
                color: definition.color.clone(),
                icon: definition.icon.clone(),
                effects: definition.effects.clone(),
                is_equipped,
                obtained_at,
                expires_at,
            });
        }

        Ok(TitleListView { titles, equipped })
    }

    async fn equip_title_impl(
        &self,
        character_id: i64,
        title_id: String,
    ) -> Result<TitleEquipResult, BusinessError> {
        if character_id <= 0 {
            return Ok(TitleEquipResult {
                success: false,
                message: "角色不存在".to_string(),
            });
        }
        let normalized_title_id = title_id.trim().to_string();
        if normalized_title_id.is_empty() {
            return Ok(TitleEquipResult {
                success: false,
                message: "称号ID不能为空".to_string(),
            });
        }

        let definitions = self
            .load_title_definitions(&[normalized_title_id.clone()])
            .await?;
        let Some(target_definition) = definitions.get(normalized_title_id.as_str()) else {
            return Ok(TitleEquipResult {
                success: false,
                message: "未拥有该称号".to_string(),
            });
        };

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let target_row = sqlx::query(
            r#"
            SELECT title_id
            FROM character_title
            WHERE character_id = $1
              AND title_id = $2
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(character_id)
        .bind(&normalized_title_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        if target_row.is_none() {
            return Ok(TitleEquipResult {
                success: false,
                message: "未拥有该称号".to_string(),
            });
        }

        let current_row = sqlx::query(
            r#"
            SELECT title_id
            FROM character_title
            WHERE character_id = $1
              AND is_equipped = true
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(character_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        let current_title_id = current_row.map(|row| row.get::<String, _>("title_id"));
        if current_title_id.as_deref() == Some(normalized_title_id.as_str()) {
            transaction
                .commit()
                .await
                .map_err(internal_business_error)?;
            return Ok(TitleEquipResult {
                success: true,
                message: "ok".to_string(),
            });
        }

        sqlx::query(
            r#"
            UPDATE character_title
            SET is_equipped = false,
                updated_at = NOW()
            WHERE character_id = $1
              AND is_equipped = true
            "#,
        )
        .bind(character_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        sqlx::query(
            r#"
            UPDATE character_title
            SET is_equipped = true,
                updated_at = NOW()
            WHERE character_id = $1
              AND title_id = $2
            "#,
        )
        .bind(character_id)
        .bind(&normalized_title_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        sqlx::query(
            r#"
            UPDATE characters
            SET title = $2,
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(character_id)
        .bind(&target_definition.name)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction
            .commit()
            .await
            .map_err(internal_business_error)?;

        Ok(TitleEquipResult {
            success: true,
            message: "ok".to_string(),
        })
    }

    async fn load_title_definitions(
        &self,
        title_ids: &[String],
    ) -> Result<HashMap<String, StaticTitleDefinition>, BusinessError> {
        let static_titles = load_static_titles().map_err(internal_string_business_error)?;
        let mut merged = HashMap::with_capacity(title_ids.len());
        let mut dynamic_ids = Vec::new();

        for title_id in title_ids {
            let normalized_id = title_id.trim();
            if normalized_id.is_empty() || merged.contains_key(normalized_id) {
                continue;
            }
            if let Some(definition) = static_titles.get(normalized_id) {
                merged.insert(normalized_id.to_string(), definition.clone());
            } else {
                dynamic_ids.push(normalized_id.to_string());
            }
        }

        if dynamic_ids.is_empty() {
            return Ok(merged);
        }

        let rows = sqlx::query(
            r#"
            SELECT id, name, description, color, icon, effects
            FROM generated_title_def
            WHERE enabled = true
              AND id = ANY($1::varchar[])
            "#,
        )
        .bind(&dynamic_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        for row in rows {
            let dynamic = DynamicTitleDefinition {
                id: row.get("id"),
                name: row.get("name"),
                description: row.get("description"),
                color: row.try_get::<Option<String>, _>("color").ok().flatten(),
                icon: row.try_get::<Option<String>, _>("icon").ok().flatten(),
                effects: normalize_title_effects(row.try_get::<Value, _>("effects").ok()),
            };
            merged.insert(
                dynamic.id.clone(),
                StaticTitleDefinition {
                    id: dynamic.id,
                    name: dynamic.name,
                    description: dynamic.description,
                    color: dynamic.color,
                    icon: dynamic.icon,
                    effects: dynamic.effects,
                },
            );
        }

        Ok(merged)
    }
}

impl TitleRouteServices for RustTitleRouteService {
    fn list_titles<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TitleListView, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.list_titles_impl(character_id).await })
    }

    fn equip_title<'a>(
        &'a self,
        character_id: i64,
        title_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<TitleEquipResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.equip_title_impl(character_id, title_id).await })
    }
}

fn load_static_titles() -> Result<&'static HashMap<String, StaticTitleDefinition>, String> {
    let result = STATIC_TITLE_MAP.get_or_init(|| {
        let seed: StaticTitleSeedFile =
            read_seed_json("title_def.json").map_err(|error| error.to_string())?;
        let mut definitions = HashMap::with_capacity(seed.titles.len());
        for title in seed.titles {
            if title.enabled == Some(false) || title.id.trim().is_empty() {
                continue;
            }
            definitions.insert(
                title.id.clone(),
                StaticTitleDefinition {
                    id: title.id,
                    name: title.name,
                    description: title.description,
                    color: title.color,
                    icon: title.icon,
                    effects: normalize_title_effects(title.effects),
                },
            );
        }
        Ok(definitions)
    });
    result.as_ref().map_err(Clone::clone)
}

fn normalize_title_effects(raw: Option<Value>) -> HashMap<String, i64> {
    let Some(Value::Object(entries)) = raw else {
        return HashMap::new();
    };
    let mut normalized = HashMap::with_capacity(entries.len());
    for (key, value) in entries {
        if let Some(number) = value.as_i64() {
            normalized.insert(key, number);
            continue;
        }
        if let Some(number) = value.as_u64() {
            normalized.insert(key, number as i64);
        }
    }
    normalized
}

fn internal_business_error(error: sqlx::Error) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}

fn internal_string_business_error(error: String) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}
