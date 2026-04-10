use std::{future::Future, pin::Pin};

use serde::Serialize;
use sqlx::Row;

use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::attribute::{
    AttributeBatchInput, AttributeMutationPayload, AttributeResetResponse, AttributeRouteServices,
};

const ATTRIBUTE_AMOUNT_MIN: i32 = 1;
const ATTRIBUTE_AMOUNT_MAX: i32 = 100;

/**
 * 属性加点应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `attributeService` 的单属性加点、减点、批量加点、重置四个入口，并保持 `sendResult` 的业务响应形状一致。
 * 2. 做什么：把“角色存在性 + 条件更新 + 返回最新剩余点数”收敛在单条 SQL / 单一服务入口里，避免路由层重复查询与写库分离。
 * 3. 不做什么：不负责登录鉴权、不主动推送角色刷新事件，也不扩展属性面板展示 DTO。
 *
 * 输入 / 输出：
 * - 输入：`user_id`、属性键、点数数量，或批量点数分配。
 * - 输出：`ServiceResultResponse<AttributeMutationPayload>` 与 `AttributeResetResponse`。
 *
 * 数据流 / 状态流：
 * - HTTP 路由完成鉴权与参数归一化 -> 本服务执行条件更新 SQL -> 返回 Node 兼容业务包体。
 *
 * 复用设计说明：
 * - 单属性加点与减点共享同一套 SQL 生成与结果归一化逻辑，避免两条热路径各自维护一份 `UPDATE characters`。
 * - 批量加点与重置虽然 SQL 不同，但统一复用同一组整数归一化和业务响应结构，后续若补 Socket 入口可直接复用本服务而不是复制规则。
 *
 * 关键边界条件与坑点：
 * 1. 可用属性点校验必须和更新写在同一条 SQL 里，否则并发请求会把“检查”和“扣点”拆开，导致双花。
 * 2. `batch` 返回的数据形状必须继续沿用 Node 当前 `{ attribute: "jing", newValue, remainingPoints }`，不能“顺手修正”为更直观的三属性对象。
 */
#[derive(Debug, Clone)]
pub struct RustAttributeRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttributeKey {
    Jing,
    Qi,
    Shen,
}

impl AttributeKey {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "jing" => Some(Self::Jing),
            "qi" => Some(Self::Qi),
            "shen" => Some(Self::Shen),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jing => "jing",
            Self::Qi => "qi",
            Self::Shen => "shen",
        }
    }
}

#[derive(Debug, Clone)]
struct SingleAttributeMutationRow {
    character_id: i64,
    character_exists: bool,
    updated: bool,
    new_value: i32,
    remaining_points: i32,
}

#[derive(Debug, Clone)]
struct BatchAttributeMutationRow {
    character_id: i64,
    character_exists: bool,
    updated: bool,
    jing: i32,
    remaining_points: i32,
}

#[derive(Debug, Clone)]
struct ResetAttributeMutationRow {
    character_exists: bool,
    updated: bool,
    refunded_points: i32,
}

impl RustAttributeRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn add_attribute_point_impl(
        &self,
        user_id: i64,
        attribute: String,
        amount: i32,
    ) -> Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError> {
        let Some(attribute) = AttributeKey::parse(&attribute) else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("无效的属性类型".to_string()),
                None,
            ));
        };
        if !(ATTRIBUTE_AMOUNT_MIN..=ATTRIBUTE_AMOUNT_MAX).contains(&amount) {
            return Ok(ServiceResultResponse::new(
                false,
                Some("加点数量无效".to_string()),
                None,
            ));
        }

        let row =
            run_single_attribute_mutation(&self.pool, user_id, attribute, amount, true).await?;
        Ok(build_single_attribute_result(
            row,
            attribute,
            "加点成功",
            "属性点不足",
        ))
    }

    async fn remove_attribute_point_impl(
        &self,
        user_id: i64,
        attribute: String,
        amount: i32,
    ) -> Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError> {
        let Some(attribute) = AttributeKey::parse(&attribute) else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("无效的属性类型".to_string()),
                None,
            ));
        };
        if !(ATTRIBUTE_AMOUNT_MIN..=ATTRIBUTE_AMOUNT_MAX).contains(&amount) {
            return Ok(ServiceResultResponse::new(
                false,
                Some("减点数量无效".to_string()),
                None,
            ));
        }

        let row =
            run_single_attribute_mutation(&self.pool, user_id, attribute, amount, false).await?;
        Ok(build_single_attribute_result(
            row,
            attribute,
            "减点成功",
            "属性点不足以减少",
        ))
    }

    async fn batch_add_points_impl(
        &self,
        user_id: i64,
        input: AttributeBatchInput,
    ) -> Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError> {
        let jing = input.jing.max(0);
        let qi = input.qi.max(0);
        let shen = input.shen.max(0);
        let total_points = jing + qi + shen;
        if total_points <= 0 {
            return Ok(ServiceResultResponse::new(
                false,
                Some("请指定加点数量".to_string()),
                None,
            ));
        }

        let row = sqlx::query(
            r#"
            WITH target_character AS (
              SELECT id
              FROM characters
              WHERE user_id = $1
              LIMIT 1
            ),
            updated_character AS (
              UPDATE characters
              SET jing = jing + $2,
                  qi = qi + $3,
                  shen = shen + $4,
                  attribute_points = attribute_points - $5,
                  updated_at = CURRENT_TIMESTAMP
              FROM target_character
              WHERE characters.id = target_character.id
                AND characters.attribute_points >= $5
              RETURNING
                characters.id AS character_id,
                characters.jing AS jing,
                characters.attribute_points AS remaining_points
            )
            SELECT
              COALESCE((SELECT id FROM target_character), 0)::bigint AS character_id,
              EXISTS(SELECT 1 FROM target_character) AS character_exists,
              EXISTS(SELECT 1 FROM updated_character) AS updated,
              COALESCE((SELECT jing FROM updated_character), 0)::int AS jing,
              COALESCE((SELECT remaining_points FROM updated_character), 0)::int AS remaining_points
            "#,
        )
        .bind(user_id)
        .bind(jing)
        .bind(qi)
        .bind(shen)
        .bind(total_points)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let payload = BatchAttributeMutationRow {
            character_id: row.get("character_id"),
            character_exists: row.get("character_exists"),
            updated: row.get("updated"),
            jing: row.get("jing"),
            remaining_points: row.get("remaining_points"),
        };

        if !payload.character_exists {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ));
        }
        if !payload.updated {
            return Ok(ServiceResultResponse::new(
                false,
                Some("属性点不足".to_string()),
                None,
            ));
        }

        let _ = payload.character_id;
        Ok(ServiceResultResponse::new(
            true,
            Some("批量加点成功".to_string()),
            Some(AttributeMutationPayload {
                attribute: AttributeKey::Jing.as_str().to_string(),
                new_value: payload.jing,
                remaining_points: payload.remaining_points,
            }),
        ))
    }

    async fn reset_attribute_points_impl(
        &self,
        user_id: i64,
    ) -> Result<AttributeResetResponse, BusinessError> {
        let row = sqlx::query(
            r#"
            WITH target_character AS (
              SELECT id, jing, qi, shen
              FROM characters
              WHERE user_id = $1
              LIMIT 1
            ),
            updated_character AS (
              UPDATE characters
              SET jing = 0,
                  qi = 0,
                  shen = 0,
                  attribute_points = attribute_points + target_character.jing + target_character.qi + target_character.shen,
                  updated_at = CURRENT_TIMESTAMP
              FROM target_character
              WHERE characters.id = target_character.id
              RETURNING (target_character.jing + target_character.qi + target_character.shen)::int AS refunded_points
            )
            SELECT
              EXISTS(SELECT 1 FROM target_character) AS character_exists,
              EXISTS(SELECT 1 FROM updated_character) AS updated,
              COALESCE((SELECT refunded_points FROM updated_character), 0)::int AS refunded_points
            "#,
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let payload = ResetAttributeMutationRow {
            character_exists: row.get("character_exists"),
            updated: row.get("updated"),
            refunded_points: row.get("refunded_points"),
        };

        if !payload.character_exists {
            return Ok(AttributeResetResponse {
                success: false,
                message: "角色不存在".to_string(),
                total_points: None,
            });
        }
        if !payload.updated {
            return Ok(AttributeResetResponse {
                success: false,
                message: "重置失败".to_string(),
                total_points: None,
            });
        }

        Ok(AttributeResetResponse {
            success: true,
            message: "属性点已重置".to_string(),
            total_points: Some(payload.refunded_points),
        })
    }
}

impl AttributeRouteServices for RustAttributeRouteService {
    fn add_attribute_point<'a>(
        &'a self,
        user_id: i64,
        attribute: String,
        amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.add_attribute_point_impl(user_id, attribute, amount)
                .await
        })
    }

    fn remove_attribute_point<'a>(
        &'a self,
        user_id: i64,
        attribute: String,
        amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.remove_attribute_point_impl(user_id, attribute, amount)
                .await
        })
    }

    fn batch_add_points<'a>(
        &'a self,
        user_id: i64,
        input: AttributeBatchInput,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.batch_add_points_impl(user_id, input).await })
    }

    fn reset_attribute_points<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<AttributeResetResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.reset_attribute_points_impl(user_id).await })
    }
}

fn build_single_attribute_result(
    row: SingleAttributeMutationRow,
    attribute: AttributeKey,
    success_message: &str,
    insufficient_message: &str,
) -> ServiceResultResponse<AttributeMutationPayload> {
    if !row.character_exists {
        return ServiceResultResponse::new(false, Some("角色不存在".to_string()), None);
    }
    if !row.updated {
        return ServiceResultResponse::new(false, Some(insufficient_message.to_string()), None);
    }

    let _ = row.character_id;
    ServiceResultResponse::new(
        true,
        Some(success_message.to_string()),
        Some(AttributeMutationPayload {
            attribute: attribute.as_str().to_string(),
            new_value: row.new_value,
            remaining_points: row.remaining_points,
        }),
    )
}

async fn run_single_attribute_mutation(
    pool: &sqlx::PgPool,
    user_id: i64,
    attribute: AttributeKey,
    amount: i32,
    is_add: bool,
) -> Result<SingleAttributeMutationRow, BusinessError> {
    let attribute_name = attribute.as_str();
    let attribute_guard_sql = if is_add {
        "characters.attribute_points >= $2".to_string()
    } else {
        format!("characters.{attribute_name} >= $2")
    };
    let attribute_mutation_sql = if is_add {
        format!("{attribute_name} = {attribute_name} + $2")
    } else {
        format!("{attribute_name} = {attribute_name} - $2")
    };
    let attribute_point_mutation_sql = if is_add {
        "attribute_points = attribute_points - $2".to_string()
    } else {
        "attribute_points = attribute_points + $2".to_string()
    };
    let sql = format!(
        r#"
        WITH target_character AS (
          SELECT id
          FROM characters
          WHERE user_id = $1
          LIMIT 1
        ),
        updated_character AS (
          UPDATE characters
          SET {attribute_mutation_sql},
              {attribute_point_mutation_sql},
              updated_at = CURRENT_TIMESTAMP
          FROM target_character
          WHERE characters.id = target_character.id
            AND {attribute_guard_sql}
          RETURNING
            characters.id AS character_id,
            characters.{attribute_name} AS new_value,
            characters.attribute_points AS remaining_points
        )
        SELECT
          COALESCE((SELECT id FROM target_character), 0)::bigint AS character_id,
          EXISTS(SELECT 1 FROM target_character) AS character_exists,
          EXISTS(SELECT 1 FROM updated_character) AS updated,
          COALESCE((SELECT new_value FROM updated_character), 0)::int AS new_value,
          COALESCE((SELECT remaining_points FROM updated_character), 0)::int AS remaining_points
        "#
    );

    let row = sqlx::query(&sql)
        .bind(user_id)
        .bind(amount)
        .fetch_one(pool)
        .await
        .map_err(internal_business_error)?;

    Ok(SingleAttributeMutationRow {
        character_id: row.get("character_id"),
        character_exists: row.get("character_exists"),
        updated: row.get("updated"),
        new_value: row.get("new_value"),
        remaining_points: row.get("remaining_points"),
    })
}

fn internal_business_error(error: sqlx::Error) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
