use std::collections::HashMap;

use crate::application::month_card::service::default_month_card_id;
use crate::edge::http::error::BusinessError;

/**
 * 月卡权益共享读取工具。
 *
 * 作用：
 * 1. 做什么：提供 `character_ids -> 月卡激活态` 的批量查询入口，供首页、排行、组队等需要展示月卡标记的只读链路复用。
 * 2. 做什么：统一处理角色 ID 去重、默认值补齐与有效期过滤，避免各服务各写一份相同 SQL。
 * 3. 不做什么：不负责月卡激活、续期、领奖，也不缓存除本次查询外的额外状态。
 *
 * 输入 / 输出：
 * - 输入：`PgPool` 与待查询的角色 ID 列表。
 * - 输出：包含全部合法角色 ID 的 `HashMap<i64, bool>`，未命中的角色默认 `false`。
 *
 * 数据流 / 状态流：
 * - 调用方收集角色 ID -> 本模块去重并查 `month_card_ownership` -> 返回激活态映射 -> 调用方拼装 DTO。
 *
 * 复用设计说明：
 * - 首页组队块、排行榜和新补的 team 读链路都需要同一份“角色是否有激活月卡”真值，把查询收口后可以避免后续再复制 `ANY($1)` 与默认 false 初始化逻辑。
 * - 该模块只暴露批量纯读接口，方便后续更多展示模块直接复用，而不把月卡业务主流程耦合进来。
 *
 * 关键边界条件与坑点：
 * 1. 只认 `expire_at > CURRENT_TIMESTAMP` 的 ownership 为激活，不能把过期但未清理的数据当成激活态。
 * 2. 返回值必须覆盖所有合法输入角色 ID，调用方才能稳定用 `unwrap_or(false)` 之外的直接查表逻辑。
 */
pub async fn load_month_card_active_map(
    pool: &sqlx::PgPool,
    character_ids: &[i64],
) -> Result<HashMap<i64, bool>, BusinessError> {
    let normalized_ids = normalize_character_ids(character_ids);
    let mut result = HashMap::with_capacity(normalized_ids.len());
    for character_id in &normalized_ids {
        result.insert(*character_id, false);
    }

    if normalized_ids.is_empty() {
        return Ok(result);
    }

    let rows = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT character_id
        FROM month_card_ownership
        WHERE character_id = ANY($1::bigint[])
          AND month_card_id = $2
          AND expire_at > CURRENT_TIMESTAMP
        "#,
    )
    .bind(&normalized_ids)
    .bind(default_month_card_id())
    .fetch_all(pool)
    .await
    .map_err(internal_business_error)?;

    for character_id in rows {
        result.insert(character_id, true);
    }

    Ok(result)
}

fn normalize_character_ids(character_ids: &[i64]) -> Vec<i64> {
    let mut normalized_ids = character_ids
        .iter()
        .copied()
        .filter(|character_id| *character_id > 0)
        .collect::<Vec<_>>();
    normalized_ids.sort_unstable();
    normalized_ids.dedup();
    normalized_ids
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
