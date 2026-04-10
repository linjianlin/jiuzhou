use crate::bootstrap::app::SharedRuntimeServices;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::arena::{ArenaOpponentView, ArenaRecordView, ArenaStatusView};
use crate::runtime::projection::service::{
    ArenaProjectionRedis, ArenaRecordProjectionRedis, OnlineBattleCharacterSnapshotRedis,
};
use serde_json::Value;

const DEFAULT_ARENA_DAILY_LIMIT: i64 = 20;

/**
 * arena 只读应用服务。
 *
 * 作用：
 * 1. 做什么：复用 startup 已恢复的 online projection registry，对齐 Node `/api/arena/status|opponents|records` 三条只读接口。
 * 2. 做什么：把竞技场积分、今日次数、对手筛选、战报裁剪与战力口径集中在一个模块，避免路由层重复扫描 projection 或重复解析 computed JSON。
 * 3. 不做什么：不发起竞技场匹配、不创建 PVP battle session，也不回写 Redis/数据库。
 *
 * 输入 / 输出：
 * - 输入：共享 `SharedRuntimeServices`、角色 ID，以及可选的 limit。
 * - 输出：Node 兼容的 `ServiceResultResponse<ArenaStatusView | Vec<ArenaOpponentView> | Vec<ArenaRecordView>>`。
 *
 * 数据流 / 状态流：
 * - startup recovery -> `online_projection_registry` 恢复 character/arena projection -> 本服务读取并组装只读 DTO -> HTTP 路由透传。
 *
 * 复用设计说明：
 * - 竞技场状态、匹配候选与战报都依赖同一份 arena projection；集中在这里后，后续补 `/challenge`、`/match` 时仍可复用同一口径的只读基础。
 * - 战力优先读取 projection 里已算好的 `power`，缺失时再按共享权重公式从 `computed` 聚合，避免不同接口各自解释同一份角色面板。
 *
 * 关键边界条件与坑点：
 * 1. projection 缺失时必须保持 Node 当前 `success:false + 竞技场投影不存在` 的响应语义，不能擅自回退空数组或 404。
 * 2. 对手排序要按与自身积分差值升序，而不是按总积分降序；否则会破坏 Node 当前“就近匹配”展示口径。
 */
pub async fn get_arena_status(
    runtime_services: &SharedRuntimeServices,
    character_id: i64,
) -> Result<ServiceResultResponse<ArenaStatusView>, BusinessError> {
    let runtime = runtime_services.read().await;
    let Some(projection) = runtime.online_projection_registry.get_arena(character_id) else {
        return Ok(ServiceResultResponse::new(
            false,
            Some("竞技场投影不存在".to_string()),
            None,
        ));
    };

    Ok(ServiceResultResponse::new(
        true,
        Some("ok".to_string()),
        Some(ArenaStatusView {
            score: projection.score,
            win_count: projection.win_count,
            lose_count: projection.lose_count,
            today_used: projection.today_used,
            today_limit: normalize_today_limit(projection.today_limit),
            today_remaining: projection.today_remaining.max(0),
        }),
    ))
}

pub async fn get_arena_opponents(
    runtime_services: &SharedRuntimeServices,
    character_id: i64,
    limit: Option<i64>,
) -> Result<ServiceResultResponse<Vec<ArenaOpponentView>>, BusinessError> {
    let normalized_limit = clamp_limit(limit, 10, 1, 50);
    let runtime = runtime_services.read().await;
    let Some(self_projection) = runtime.online_projection_registry.get_arena(character_id) else {
        return Ok(ServiceResultResponse::new(
            false,
            Some("竞技场投影不存在".to_string()),
            None,
        ));
    };

    let mut candidates = runtime
        .online_projection_registry
        .list_arenas()
        .into_iter()
        .filter(|projection| projection.character_id != character_id)
        .filter_map(|projection| {
            let snapshot = runtime
                .online_projection_registry
                .get_character(projection.character_id)?;
            Some((projection, snapshot.clone()))
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        let left_gap = (left.0.score - self_projection.score).abs();
        let right_gap = (right.0.score - self_projection.score).abs();
        left_gap
            .cmp(&right_gap)
            .then_with(|| left.0.character_id.cmp(&right.0.character_id))
    });

    let mut result = Vec::with_capacity(normalized_limit as usize);
    for (projection, snapshot) in candidates.into_iter().take(normalized_limit as usize) {
        result.push(build_arena_opponent_view(&projection, &snapshot));
    }

    Ok(ServiceResultResponse::new(
        true,
        Some("ok".to_string()),
        Some(result),
    ))
}

pub async fn get_arena_records(
    runtime_services: &SharedRuntimeServices,
    character_id: i64,
    limit: Option<i64>,
) -> Result<ServiceResultResponse<Vec<ArenaRecordView>>, BusinessError> {
    let normalized_limit = clamp_limit(limit, 50, 1, 200);
    let runtime = runtime_services.read().await;
    let Some(projection) = runtime.online_projection_registry.get_arena(character_id) else {
        return Ok(ServiceResultResponse::new(
            false,
            Some("竞技场投影不存在".to_string()),
            None,
        ));
    };

    let result = projection
        .records
        .iter()
        .take(normalized_limit as usize)
        .map(build_arena_record_view)
        .collect::<Vec<_>>();

    Ok(ServiceResultResponse::new(
        true,
        Some("ok".to_string()),
        Some(result),
    ))
}

fn build_arena_opponent_view(
    projection: &ArenaProjectionRedis,
    snapshot: &OnlineBattleCharacterSnapshotRedis,
) -> ArenaOpponentView {
    ArenaOpponentView {
        id: snapshot.character_id,
        name: read_computed_string(&snapshot.computed, "nickname")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("修士{}", snapshot.character_id)),
        realm: read_computed_string(&snapshot.computed, "realm")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "凡人".to_string()),
        power: resolve_rank_power(&snapshot.computed),
        score: projection.score.max(0),
    }
}

fn build_arena_record_view(record: &ArenaRecordProjectionRedis) -> ArenaRecordView {
    ArenaRecordView {
        id: record.id.clone(),
        ts: record.ts,
        opponent_name: record.opponent_name.clone(),
        opponent_realm: record.opponent_realm.clone(),
        opponent_power: record.opponent_power.max(0),
        result: record.result.clone(),
        delta_score: record.delta_score,
        score_after: record.score_after.max(0),
    }
}

fn clamp_limit(limit: Option<i64>, fallback: i64, min: i64, max: i64) -> i64 {
    limit.unwrap_or(fallback).clamp(min, max)
}

fn normalize_today_limit(today_limit: i64) -> i64 {
    if today_limit > 0 {
        today_limit
    } else {
        DEFAULT_ARENA_DAILY_LIMIT
    }
}

fn read_computed_string(computed: &Value, key: &str) -> Option<String> {
    computed
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn read_computed_i64(computed: &Value, key: &str) -> i64 {
    computed
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|item| i64::try_from(item).ok()))
                .or_else(|| value.as_f64().map(|item| item.floor() as i64))
        })
        .unwrap_or(0)
        .max(0)
}

fn read_computed_f64(computed: &Value, key: &str) -> f64 {
    computed
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|item| item as f64))
        })
        .unwrap_or(0.0)
        .max(0.0)
}

fn resolve_rank_power(computed: &Value) -> i64 {
    let direct_power = read_computed_i64(computed, "power");
    if direct_power > 0 {
        return direct_power;
    }

    let attack_score = compute_pair_score(
        read_computed_i64(computed, "wugong"),
        read_computed_i64(computed, "fagong"),
        2.15,
        0.95,
    );
    let defense_score = compute_pair_score(
        read_computed_i64(computed, "wufang"),
        read_computed_i64(computed, "fafang"),
        1.55,
        0.85,
    );
    let flat_score = compute_flat_score(computed);
    let ratio_score = compute_ratio_score(computed);

    (attack_score + defense_score + flat_score + ratio_score)
        .round()
        .max(0.0) as i64
}

fn compute_pair_score(left: i64, right: i64, primary_weight: f64, secondary_weight: f64) -> f64 {
    let primary = left.max(right) as f64;
    let secondary = left.min(right) as f64;
    primary * primary_weight + secondary * secondary_weight
}

fn compute_flat_score(computed: &Value) -> f64 {
    [
        ("max_qixue", 0.24_f64),
        ("max_lingqi", 0.30_f64),
        ("sudu", 18.0_f64),
        ("qixue_huifu", 26.0_f64),
        ("lingqi_huifu", 32.0_f64),
    ]
    .into_iter()
    .map(|(key, weight)| read_computed_i64(computed, key) as f64 * weight)
    .sum()
}

fn compute_ratio_score(computed: &Value) -> f64 {
    [
        ("mingzhong", 160.0_f64, 0.9_f64),
        ("shanbi", 200.0_f64, 0.05_f64),
        ("zhaojia", 220.0_f64, 0.05_f64),
        ("baoji", 280.0_f64, 0.1_f64),
        ("baoshang", 140.0_f64, 1.5_f64),
        ("jianbaoshang", 200.0_f64, 0.0_f64),
        ("jianfantan", 110.0_f64, 0.0_f64),
        ("kangbao", 210.0_f64, 0.0_f64),
        ("zengshang", 360.0_f64, 0.0_f64),
        ("zhiliao", 300.0_f64, 0.0_f64),
        ("jianliao", 240.0_f64, 0.0_f64),
        ("xixue", 250.0_f64, 0.0_f64),
        ("lengque", 420.0_f64, 0.0_f64),
        ("kongzhi_kangxing", 220.0_f64, 0.0_f64),
        ("jin_kangxing", 90.0_f64, 0.0_f64),
        ("mu_kangxing", 90.0_f64, 0.0_f64),
        ("shui_kangxing", 90.0_f64, 0.0_f64),
        ("huo_kangxing", 90.0_f64, 0.0_f64),
        ("tu_kangxing", 90.0_f64, 0.0_f64),
    ]
    .into_iter()
    .map(|(key, weight, baseline)| {
        let effective = (read_computed_f64(computed, key) - baseline).max(0.0);
        effective * weight
    })
    .sum()
}
