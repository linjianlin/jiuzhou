use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;

use crate::bootstrap::app::SharedRuntimeServices;
use crate::edge::http::error::BusinessError;

/**
 * 角色最小读写聚合服务。
 *
 * 作用：
 * 1. 做什么：为 `/api/auth/bootstrap`、`/api/character/check`、`/api/character/info`、`/api/character/create`、`/api/character/updatePosition`、`/api/character/renameWithCard` 与三个 character settings mutation 提供统一的角色最小读写入口。
 * 2. 做什么：优先复用启动期恢复好的 online projection 内存索引做高频读取，未命中再回落 PostgreSQL；创角、位置更新、最小改名校验与设置更新只写入当前合同真正需要的主表字段。
 * 3. 不做什么：不处理成就初始化、缓存失效、完整 gameplay 副作用链，也不伪造 Redis/运行态中当前并不存在的库存实例消费能力。
 *
 * 输入 / 输出：
 * - 输入：`userId`，以及创角时的 `nickname/gender`、位置更新时的 `currentMapId/currentRoomId`、改名时的 `itemInstanceId/nickname`、设置更新时的 `enabled/rules`。
 * - 输出：读取场景返回 `CheckCharacterResult`；创角场景返回 `CreateCharacterResult`；位置、改名与设置 mutation 返回统一轻量结果。
 *
 * 数据流 / 状态流：
 * - HTTP/Auth 入口 -> 本服务
 * - -> online projection `userId -> characterId -> computed snapshot` 快速路径
 * - -> 未命中时回落 PostgreSQL `characters` 基础字段查询
 * - -> 创角时先做重复角色/道号校验 -> 单事务写入 `characters + inventory`
 * - -> 位置更新时统一做参数归一化 -> 更新 `characters.current_map_id/current_room_id` -> 按当前运行态真实能力同步内存 online projection。
 * - -> 改名时先检查角色存在、再复用统一道号规则校验；若 Rust 端缺少真实易名符实例消费链，则明确返回业务失败，不伪造成功。
 * - -> 设置更新时统一做布尔/规则归一化 -> 更新 `characters` 对应字段 -> 仅同步当前内存里真实存在的 projection 快照。
 * - -> 路由层再包装为 Node 兼容 envelope。
 *
 * 复用设计说明：
 * - bootstrap、character 读取路由、create 成功回包、position mutation、renameWithCard 与 settings mutation 都复用同一聚合服务，避免路由层重复拼 SQL、重复维护道号校验与写库文案。
 * - 运行态 projection 是高频读路径，DB 查询只保留为真实缺失时的兜底入口；位置/设置同步也集中在这里，改名校验也复用同一套昵称规则，避免后续其它调用方再各写一份重复逻辑。
 *
 * 关键边界条件与坑点：
 * 1. online projection 只覆盖当前恢复到内存的角色，不能把未命中直接当成“角色不存在”；必须继续查 PostgreSQL。
 * 2. create 成功后暂不具备 Node 侧完整副作用链，因此这里只返回数据库里可真实读取的基础快照；位置与设置更新也只同步当前已恢复到内存的 online projection，不能伪装成已经持久化回 Redis。
 * 3. renameWithCard 若没有真实库存实例读取与扣除能力，必须明确返回业务失败，不能跳过扣卡直接改名。
 */
#[derive(Clone)]
pub struct RustCharacterReadService {
    pool: sqlx::PgPool,
    runtime_services: SharedRuntimeServices,
}

const CHARACTER_NICKNAME_MIN_LENGTH: usize = 2;
const CHARACTER_NICKNAME_MAX_LENGTH: usize = 12;
const CHARACTER_NICKNAME_REQUIRED_MESSAGE: &str = "道号不能为空";
const CHARACTER_NICKNAME_LENGTH_MESSAGE: &str = "道号需2-12个字符";
const CHARACTER_NICKNAME_DUPLICATE_MESSAGE: &str = "该道号已被使用";
const CHARACTER_ALREADY_EXISTS_MESSAGE: &str = "已存在角色，无法重复创建";
const CHARACTER_CREATE_SUCCESS_MESSAGE: &str = "角色创建成功";
const CHARACTER_CREATE_READBACK_FAILED_MESSAGE: &str = "角色创建成功，但读取角色数据失败";
const CHARACTER_POSITION_REQUIRED_MESSAGE: &str = "位置参数不能为空";
const CHARACTER_POSITION_TOO_LONG_MESSAGE: &str = "位置参数过长";
const CHARACTER_NOT_FOUND_MESSAGE: &str = "角色不存在";
const CHARACTER_POSITION_UPDATED_MESSAGE: &str = "位置更新成功";
const CHARACTER_SETTING_UPDATED_MESSAGE: &str = "设置已保存";
const CHARACTER_RENAME_CARD_UNSUPPORTED_MESSAGE: &str = "当前暂不支持使用易名符改名";
const AUTO_DISASSEMBLE_DEFAULT_CATEGORY: &str = "equipment";
const AUTO_DISASSEMBLE_DEFAULT_MAX_QUALITY_RANK: i32 = 1;
const AUTO_DISASSEMBLE_MAX_RULE_COUNT: usize = 20;
const AUTO_DISASSEMBLE_MAX_LIST_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutoDisassembleRuleDto {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    #[serde(rename = "subCategories", skip_serializing_if = "Option::is_none")]
    pub sub_categories: Option<Vec<String>>,
    #[serde(
        rename = "excludedSubCategories",
        skip_serializing_if = "Option::is_none"
    )]
    pub excluded_sub_categories: Option<Vec<String>>,
    #[serde(
        rename = "includeNameKeywords",
        skip_serializing_if = "Option::is_none"
    )]
    pub include_name_keywords: Option<Vec<String>>,
    #[serde(
        rename = "excludeNameKeywords",
        skip_serializing_if = "Option::is_none"
    )]
    pub exclude_name_keywords: Option<Vec<String>>,
    #[serde(rename = "maxQualityRank")]
    pub max_quality_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CharacterBasicInfo {
    pub id: i64,
    pub nickname: String,
    pub gender: String,
    pub title: String,
    pub realm: String,
    pub sub_realm: Option<String>,
    pub auto_cast_skills: bool,
    pub auto_disassemble_enabled: bool,
    pub auto_disassemble_rules: Option<Vec<AutoDisassembleRuleDto>>,
    pub dungeon_no_stamina_cost: bool,
    pub spirit_stones: i64,
    pub silver: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckCharacterResult {
    pub has_character: bool,
    pub character: Option<CharacterBasicInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CharacterRouteData {
    pub character: Option<CharacterBasicInfo>,
    #[serde(rename = "hasCharacter")]
    pub has_character: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateCharacterResult {
    pub success: bool,
    pub message: String,
    pub data: Option<CharacterRouteData>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCharacterPositionResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCharacterSettingResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameCharacterWithCardResult {
    pub success: bool,
    pub message: String,
}

enum NormalizedCharacterPositionResult {
    Valid { map_id: String, room_id: String },
    Invalid { message: &'static str },
}

impl RustCharacterReadService {
    pub fn new(pool: sqlx::PgPool, runtime_services: SharedRuntimeServices) -> Self {
        Self {
            pool,
            runtime_services,
        }
    }

    pub async fn check_character(
        &self,
        user_id: i64,
    ) -> Result<CheckCharacterResult, BusinessError> {
        let character = self.load_character_snapshot(user_id).await?;
        Ok(CheckCharacterResult {
            has_character: character.is_some(),
            character,
        })
    }

    pub async fn create_character(
        &self,
        user_id: i64,
        nickname: &str,
        gender: &str,
    ) -> Result<CreateCharacterResult, BusinessError> {
        let existing_character =
            sqlx::query("SELECT id FROM characters WHERE user_id = $1 LIMIT 1")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_business_error)?;
        if existing_character.is_some() {
            return Ok(CreateCharacterResult {
                success: false,
                message: CHARACTER_ALREADY_EXISTS_MESSAGE.to_string(),
                data: None,
            });
        }

        let normalized_nickname = normalize_character_nickname_input(nickname);
        if normalized_nickname.is_empty() {
            return Ok(CreateCharacterResult {
                success: false,
                message: CHARACTER_NICKNAME_REQUIRED_MESSAGE.to_string(),
                data: None,
            });
        }

        let nickname_length = normalized_nickname.chars().count();
        if !(CHARACTER_NICKNAME_MIN_LENGTH..=CHARACTER_NICKNAME_MAX_LENGTH)
            .contains(&nickname_length)
        {
            return Ok(CreateCharacterResult {
                success: false,
                message: CHARACTER_NICKNAME_LENGTH_MESSAGE.to_string(),
                data: None,
            });
        }

        let duplicate_nickname =
            sqlx::query("SELECT id FROM characters WHERE nickname = $1 LIMIT 1")
                .bind(&normalized_nickname)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_business_error)?;
        if duplicate_nickname.is_some() {
            return Ok(CreateCharacterResult {
                success: false,
                message: CHARACTER_NICKNAME_DUPLICATE_MESSAGE.to_string(),
                data: None,
            });
        }

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let character_id = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO characters (
              user_id,
              nickname,
              gender,
              title,
              spirit_stones,
              silver,
              realm,
              exp,
              attribute_points,
              jing,
              qi,
              shen,
              attribute_type,
              attribute_element,
              current_map_id,
              current_room_id
            ) VALUES (
              $1,
              $2,
              $3,
              '散修',
              0,
              0,
              '凡人',
              0,
              0,
              0,
              0,
              0,
              'physical',
              'none',
              'map-qingyun-village',
              'room-village-center'
            )
            RETURNING id
            "#,
        )
        .bind(user_id)
        .bind(&normalized_nickname)
        .bind(gender)
        .fetch_one(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        sqlx::query(
            r#"
            INSERT INTO inventory (character_id, bag_capacity, warehouse_capacity)
            VALUES ($1, 100, 1000)
            ON CONFLICT (character_id) DO NOTHING
            "#,
        )
        .bind(character_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction
            .commit()
            .await
            .map_err(internal_business_error)?;

        let character = self.load_character_from_db(user_id).await?;
        let Some(character) = character else {
            return Ok(CreateCharacterResult {
                success: false,
                message: CHARACTER_CREATE_READBACK_FAILED_MESSAGE.to_string(),
                data: None,
            });
        };

        Ok(CreateCharacterResult {
            success: true,
            message: CHARACTER_CREATE_SUCCESS_MESSAGE.to_string(),
            data: Some(CharacterRouteData {
                character: Some(character),
                has_character: true,
            }),
        })
    }

    pub async fn update_character_position(
        &self,
        user_id: i64,
        current_map_id: &str,
        current_room_id: &str,
    ) -> Result<UpdateCharacterPositionResult, BusinessError> {
        let normalized = normalize_character_position_input(current_map_id, current_room_id);
        let (map_id, room_id) = match normalized {
            NormalizedCharacterPositionResult::Valid { map_id, room_id } => (map_id, room_id),
            NormalizedCharacterPositionResult::Invalid { message } => {
                return Ok(UpdateCharacterPositionResult {
                    success: false,
                    message: message.to_string(),
                });
            }
        };

        let updated_character_id = sqlx::query_scalar::<_, i64>(
            r#"
            UPDATE characters
            SET current_map_id = $1,
                current_room_id = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $3
            RETURNING id
            "#,
        )
        .bind(&map_id)
        .bind(&room_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(character_id) = updated_character_id else {
            return Ok(UpdateCharacterPositionResult {
                success: false,
                message: CHARACTER_NOT_FOUND_MESSAGE.to_string(),
            });
        };

        self.sync_runtime_position(character_id, &map_id, &room_id)
            .await;

        Ok(UpdateCharacterPositionResult {
            success: true,
            message: CHARACTER_POSITION_UPDATED_MESSAGE.to_string(),
        })
    }

    pub async fn rename_character_with_card(
        &self,
        user_id: i64,
        _item_instance_id: i64,
        nickname: &str,
    ) -> Result<RenameCharacterWithCardResult, BusinessError> {
        let character_row = sqlx::query(
            r#"
            SELECT id, nickname
            FROM characters
            WHERE user_id = $1
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(character_row) = character_row else {
            return Ok(RenameCharacterWithCardResult {
                success: false,
                message: CHARACTER_NOT_FOUND_MESSAGE.to_string(),
            });
        };

        let character_id = character_row
            .try_get::<i64, _>("id")
            .map_err(internal_business_error)?;
        let normalized_nickname = normalize_character_nickname_input(nickname);
        if normalized_nickname.is_empty() {
            return Ok(RenameCharacterWithCardResult {
                success: false,
                message: CHARACTER_NICKNAME_REQUIRED_MESSAGE.to_string(),
            });
        }

        let nickname_length = normalized_nickname.chars().count();
        if !(CHARACTER_NICKNAME_MIN_LENGTH..=CHARACTER_NICKNAME_MAX_LENGTH)
            .contains(&nickname_length)
        {
            return Ok(RenameCharacterWithCardResult {
                success: false,
                message: CHARACTER_NICKNAME_LENGTH_MESSAGE.to_string(),
            });
        }

        let duplicate_nickname =
            sqlx::query("SELECT id FROM characters WHERE nickname = $1 AND id <> $2 LIMIT 1")
                .bind(&normalized_nickname)
                .bind(character_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_business_error)?;
        if duplicate_nickname.is_some() {
            return Ok(RenameCharacterWithCardResult {
                success: false,
                message: CHARACTER_NICKNAME_DUPLICATE_MESSAGE.to_string(),
            });
        }

        Ok(RenameCharacterWithCardResult {
            success: false,
            message: CHARACTER_RENAME_CARD_UNSUPPORTED_MESSAGE.to_string(),
        })
    }

    pub async fn update_auto_cast_skills(
        &self,
        user_id: i64,
        enabled: bool,
    ) -> Result<UpdateCharacterSettingResult, BusinessError> {
        let updated_character_id = sqlx::query_scalar::<_, i64>(
            r#"
            UPDATE characters
            SET auto_cast_skills = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2
            RETURNING id
            "#,
        )
        .bind(enabled)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(character_id) = updated_character_id else {
            return Ok(UpdateCharacterSettingResult {
                success: false,
                message: CHARACTER_NOT_FOUND_MESSAGE.to_string(),
            });
        };

        self.sync_runtime_auto_cast_skills(character_id, enabled)
            .await;

        Ok(UpdateCharacterSettingResult {
            success: true,
            message: CHARACTER_SETTING_UPDATED_MESSAGE.to_string(),
        })
    }

    pub async fn update_auto_disassemble_settings(
        &self,
        user_id: i64,
        enabled: bool,
        rules: Option<Vec<Value>>,
    ) -> Result<UpdateCharacterSettingResult, BusinessError> {
        let normalized_rules = rules
            .as_ref()
            .map(|items| normalize_auto_disassemble_rule_set_list(items));
        let rules_json = normalized_rules
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(internal_business_error)?;

        let updated_row = sqlx::query(
            r#"
            UPDATE characters
            SET auto_disassemble_enabled = $1,
                auto_disassemble_rules = COALESCE($2::jsonb, auto_disassemble_rules, '[]'::jsonb),
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $3
            RETURNING id, auto_disassemble_enabled, auto_disassemble_rules
            "#,
        )
        .bind(enabled)
        .bind(rules_json)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(row) = updated_row else {
            return Ok(UpdateCharacterSettingResult {
                success: false,
                message: CHARACTER_NOT_FOUND_MESSAGE.to_string(),
            });
        };

        let character_id = row.try_get("id").map_err(internal_business_error)?;
        let persisted_enabled = row
            .try_get("auto_disassemble_enabled")
            .map_err(internal_business_error)?;
        let persisted_rules = parse_auto_disassemble_rules(
            row.try_get::<Option<Value>, _>("auto_disassemble_rules")
                .map_err(internal_business_error)?,
        )?
        .unwrap_or_default();

        self.sync_runtime_auto_disassemble(character_id, persisted_enabled, &persisted_rules)
            .await;

        Ok(UpdateCharacterSettingResult {
            success: true,
            message: CHARACTER_SETTING_UPDATED_MESSAGE.to_string(),
        })
    }

    pub async fn update_dungeon_no_stamina_cost(
        &self,
        user_id: i64,
        enabled: bool,
    ) -> Result<UpdateCharacterSettingResult, BusinessError> {
        let updated_character_id = sqlx::query_scalar::<_, i64>(
            r#"
            UPDATE characters
            SET dungeon_no_stamina_cost = $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2
            RETURNING id
            "#,
        )
        .bind(enabled)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(character_id) = updated_character_id else {
            return Ok(UpdateCharacterSettingResult {
                success: false,
                message: CHARACTER_NOT_FOUND_MESSAGE.to_string(),
            });
        };

        self.sync_runtime_dungeon_no_stamina_cost(character_id, enabled)
            .await;

        Ok(UpdateCharacterSettingResult {
            success: true,
            message: CHARACTER_SETTING_UPDATED_MESSAGE.to_string(),
        })
    }

    async fn load_character_snapshot(
        &self,
        user_id: i64,
    ) -> Result<Option<CharacterBasicInfo>, BusinessError> {
        if let Some(character) = self.load_projection_snapshot(user_id).await {
            return Ok(Some(character));
        }

        self.load_character_from_db(user_id).await
    }

    async fn load_projection_snapshot(&self, user_id: i64) -> Option<CharacterBasicInfo> {
        let registry = self.runtime_services.read().await;
        let registry = &registry.online_projection_registry;
        let character_id = registry.find_character_id_by_user_id(user_id)?;
        let snapshot = registry.get_character(character_id)?;
        serde_json::from_value::<CharacterBasicInfo>(snapshot.computed.clone()).ok()
    }

    async fn load_character_from_db(
        &self,
        user_id: i64,
    ) -> Result<Option<CharacterBasicInfo>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT
              id,
              nickname,
              gender,
              title,
              realm,
              sub_realm,
              auto_cast_skills,
              auto_disassemble_enabled,
              auto_disassemble_rules,
              dungeon_no_stamina_cost,
              spirit_stones,
              silver
            FROM characters
            WHERE user_id = $1
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(row) = row else {
            return Ok(None);
        };

        let auto_disassemble_rules = parse_auto_disassemble_rules(
            row.try_get::<Option<serde_json::Value>, _>("auto_disassemble_rules")
                .map_err(internal_business_error)?,
        )?;

        Ok(Some(CharacterBasicInfo {
            id: row.try_get("id").map_err(internal_business_error)?,
            nickname: row.try_get("nickname").map_err(internal_business_error)?,
            gender: row.try_get("gender").map_err(internal_business_error)?,
            title: row.try_get("title").map_err(internal_business_error)?,
            realm: row.try_get("realm").map_err(internal_business_error)?,
            sub_realm: row.try_get("sub_realm").map_err(internal_business_error)?,
            auto_cast_skills: row
                .try_get("auto_cast_skills")
                .map_err(internal_business_error)?,
            auto_disassemble_enabled: row
                .try_get("auto_disassemble_enabled")
                .map_err(internal_business_error)?,
            auto_disassemble_rules,
            dungeon_no_stamina_cost: row
                .try_get("dungeon_no_stamina_cost")
                .map_err(internal_business_error)?,
            spirit_stones: row
                .try_get("spirit_stones")
                .map_err(internal_business_error)?,
            silver: row.try_get("silver").map_err(internal_business_error)?,
        }))
    }

    async fn sync_runtime_position(&self, character_id: i64, map_id: &str, room_id: &str) {
        let mut runtime_services = self.runtime_services.write().await;
        let _ = runtime_services
            .online_projection_registry
            .update_character_position(character_id, map_id, room_id);
    }

    async fn sync_runtime_auto_cast_skills(&self, character_id: i64, enabled: bool) {
        let mut runtime_services = self.runtime_services.write().await;
        let _ = runtime_services
            .online_projection_registry
            .update_character_auto_cast_skills(character_id, enabled);
    }

    async fn sync_runtime_auto_disassemble(
        &self,
        character_id: i64,
        enabled: bool,
        rules: &[AutoDisassembleRuleDto],
    ) {
        let mut runtime_services = self.runtime_services.write().await;
        let _ = runtime_services
            .online_projection_registry
            .update_character_auto_disassemble(character_id, enabled, rules);
    }

    async fn sync_runtime_dungeon_no_stamina_cost(&self, character_id: i64, enabled: bool) {
        let mut runtime_services = self.runtime_services.write().await;
        let _ = runtime_services
            .online_projection_registry
            .update_character_dungeon_no_stamina_cost(character_id, enabled);
    }
}

fn normalize_character_nickname_input(nickname: &str) -> String {
    nickname.trim().to_string()
}

fn normalize_character_position_input(
    current_map_id: &str,
    current_room_id: &str,
) -> NormalizedCharacterPositionResult {
    let map_id = current_map_id.trim();
    let room_id = current_room_id.trim();

    if map_id.is_empty() || room_id.is_empty() {
        return NormalizedCharacterPositionResult::Invalid {
            message: CHARACTER_POSITION_REQUIRED_MESSAGE,
        };
    }

    if map_id.chars().count() > 64 || room_id.chars().count() > 64 {
        return NormalizedCharacterPositionResult::Invalid {
            message: CHARACTER_POSITION_TOO_LONG_MESSAGE,
        };
    }

    NormalizedCharacterPositionResult::Valid {
        map_id: map_id.to_string(),
        room_id: room_id.to_string(),
    }
}

fn parse_auto_disassemble_rules(
    value: Option<serde_json::Value>,
) -> Result<Option<Vec<AutoDisassembleRuleDto>>, BusinessError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    serde_json::from_value::<Vec<AutoDisassembleRuleDto>>(value)
        .map(Some)
        .map_err(internal_business_error)
}

fn normalize_auto_disassemble_rule_set_list(items: &[Value]) -> Vec<AutoDisassembleRuleDto> {
    let mut normalized = Vec::with_capacity(items.len().min(AUTO_DISASSEMBLE_MAX_RULE_COUNT));
    for item in items.iter().take(AUTO_DISASSEMBLE_MAX_RULE_COUNT) {
        normalized.push(normalize_auto_disassemble_rule_set(item));
    }

    if normalized.is_empty() {
        return vec![default_auto_disassemble_rule_set()];
    }

    normalized
}

fn normalize_auto_disassemble_rule_set(raw: &Value) -> AutoDisassembleRuleDto {
    let empty = serde_json::Map::new();
    let record = raw.as_object().unwrap_or(&empty);
    let categories = normalize_auto_disassemble_token_list(record.get("categories"));
    let sub_categories = normalize_auto_disassemble_token_list(record.get("subCategories"));
    let excluded_sub_categories =
        normalize_auto_disassemble_token_list(record.get("excludedSubCategories"));
    let include_name_keywords =
        normalize_auto_disassemble_token_list(record.get("includeNameKeywords"));
    let exclude_name_keywords =
        normalize_auto_disassemble_token_list(record.get("excludeNameKeywords"));

    AutoDisassembleRuleDto {
        categories: Some(if categories.is_empty() {
            vec![AUTO_DISASSEMBLE_DEFAULT_CATEGORY.to_string()]
        } else {
            categories
        }),
        sub_categories: Some(sub_categories),
        excluded_sub_categories: Some(excluded_sub_categories),
        include_name_keywords: Some(include_name_keywords),
        exclude_name_keywords: Some(exclude_name_keywords),
        max_quality_rank: clamp_quality_rank(record.get("maxQualityRank")),
    }
}

fn normalize_auto_disassemble_token_list(raw: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };

    let mut normalized = Vec::with_capacity(items.len().min(AUTO_DISASSEMBLE_MAX_LIST_SIZE));
    let mut seen = std::collections::BTreeSet::new();
    for item in items.iter().take(AUTO_DISASSEMBLE_MAX_LIST_SIZE) {
        let token = item
            .as_str()
            .map(str::trim)
            .unwrap_or_default()
            .to_lowercase();
        if token.is_empty() || !seen.insert(token.clone()) {
            continue;
        }
        normalized.push(token);
    }
    normalized
}

fn clamp_quality_rank(raw: Option<&Value>) -> i32 {
    let Some(value) = raw else {
        return AUTO_DISASSEMBLE_DEFAULT_MAX_QUALITY_RANK;
    };
    let Some(number) = value.as_i64() else {
        return AUTO_DISASSEMBLE_DEFAULT_MAX_QUALITY_RANK;
    };

    number.clamp(1, 4) as i32
}

fn default_auto_disassemble_rule_set() -> AutoDisassembleRuleDto {
    AutoDisassembleRuleDto {
        categories: Some(vec![AUTO_DISASSEMBLE_DEFAULT_CATEGORY.to_string()]),
        sub_categories: Some(Vec::new()),
        excluded_sub_categories: Some(Vec::new()),
        include_name_keywords: Some(Vec::new()),
        exclude_name_keywords: Some(Vec::new()),
        max_quality_rank: AUTO_DISASSEMBLE_DEFAULT_MAX_QUALITY_RANK,
    }
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
