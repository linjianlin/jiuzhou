use std::{future::Future, pin::Pin};

use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::time::{GameTimeSnapshotView, TimeRouteServices};
use axum::http::StatusCode;
use sqlx::Row;

const DEFAULT_ERA_NAME: &str = "末法纪元";
const DEFAULT_BASE_YEAR: i32 = 1000;
const DEFAULT_WEATHER: &str = "晴";
const DEFAULT_SCALE: u64 = 60;
const WEATHER_BUCKET_MS: u64 = 60 * 60 * 1000;

/**
 * time 只读应用服务。
 *
 * 作用：
 * 1. 做什么：直接读取 PostgreSQL `game_time` 单行状态，并按 Node `gameTimeService` 的同源公式换算 `/api/time` 需要的实时快照。
 * 2. 做什么：把时辰、年月日与天气推导集中到本模块，保证 HTTP 路由和未来 socket 时间同步复用同一份时间口径。
 * 3. 不做什么：不在这里启动定时器、不做 sect 日结算，也不写回 `game_time` 或维护后台运行态。
 *
 * 输入 / 输出：
 * - 输入：`sqlx::PgPool`，以及请求时刻的当前毫秒时间。
 * - 输出：`Option<GameTimeSnapshotView>`；当 `game_time` 尚未初始化时返回 `None`，交由路由层映射为 503。
 *
 * 数据流 / 状态流：
 * - HTTP time 路由 -> 本服务读取 `game_time` -> 规范化字段 -> 计算当前游戏经过时长 -> 推导日历/时辰/天气 -> 输出统一 DTO。
 *
 * 复用设计说明：
 * - Node 与 Rust 的时间协议都依赖同一套“经过毫秒数 -> 游戏日历”公式；把推导逻辑集中后，后续补 `game:time-sync` 时无需再复制一套映射。
 * - 天气权重与 hash 规则属于高频协议变化点，集中在这里能避免 HTTP、socket、后台任务各自维护不同版本。
 *
 * 关键边界条件与坑点：
 * 1. 当前实现是只读快照，不会像 Node runtime 一样推进并持久化 `game_time`；因此任何写回、副作用都不能偷偷加在这里。
 * 2. 天气必须按 Node 的 deterministic bucket 规则重算，不能直接信任库里的旧 `weather` 字段，否则服务重启后同一时刻会出现协议漂移。
 */
#[derive(Debug, Clone)]
pub struct RustTimeService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GameTimeState {
    era_name: String,
    base_year: i32,
    game_elapsed_ms: u64,
    scale: u64,
    last_real_ms: u64,
}

impl RustTimeService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_game_time_snapshot_impl(
        &self,
    ) -> Result<Option<GameTimeSnapshotView>, BusinessError> {
        let row = sqlx::query(
            r#"
            SELECT era_name, base_year, game_elapsed_ms, weather, scale, last_real_ms
            FROM game_time
            WHERE id = 1
            LIMIT 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(row) = row else {
            return Ok(None);
        };

        let server_now_ms = current_timestamp_ms();
        let state = normalize_game_time_state(&row, server_now_ms);
        let elapsed_ms = state.game_elapsed_ms.saturating_add(
            server_now_ms
                .saturating_sub(state.last_real_ms)
                .saturating_mul(state.scale),
        );

        Ok(Some(build_snapshot_from_elapsed(
            &state,
            server_now_ms,
            elapsed_ms,
        )))
    }
}

impl TimeRouteServices for RustTimeService {
    fn get_game_time_snapshot<'a>(
        &'a self,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<GameTimeSnapshotView>, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { self.get_game_time_snapshot_impl().await })
    }
}

fn normalize_game_time_state(row: &sqlx::postgres::PgRow, server_now_ms: u64) -> GameTimeState {
    let era_name = row
        .try_get::<String, _>("era_name")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ERA_NAME.to_string());
    let base_year = row
        .try_get::<i32, _>("base_year")
        .ok()
        .filter(|value| *value != 0)
        .unwrap_or(DEFAULT_BASE_YEAR);
    let game_elapsed_ms = row
        .try_get::<i64, _>("game_elapsed_ms")
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0);
    let last_real_ms = row
        .try_get::<i64, _>("last_real_ms")
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(server_now_ms);
    let scale = row
        .try_get::<i32, _>("scale")
        .ok()
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(resolve_env_scale);

    GameTimeState {
        era_name,
        base_year,
        game_elapsed_ms,
        scale,
        last_real_ms,
    }
}

fn resolve_env_scale() -> u64 {
    std::env::var("GAME_TIME_SCALE")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SCALE)
}

fn build_snapshot_from_elapsed(
    state: &GameTimeState,
    server_now_ms: u64,
    game_elapsed_ms: u64,
) -> GameTimeSnapshotView {
    let total_sec = game_elapsed_ms / 1000;
    let second = (total_sec % 60) as i32;
    let total_min = total_sec / 60;
    let minute = (total_min % 60) as i32;
    let total_hour = total_min / 60;
    let hour = (total_hour % 24) as i32;
    let total_day = total_hour / 24;
    let day = (total_day % 30) as i32 + 1;
    let total_month = total_day / 30;
    let month = (total_month % 12) as i32 + 1;
    let year_add = (total_month / 12) as i32;
    let year = state.base_year.saturating_add(year_add);

    GameTimeSnapshotView {
        era_name: state.era_name.clone(),
        base_year: state.base_year,
        year,
        month,
        day,
        hour,
        minute,
        second,
        shichen: calc_shichen(hour),
        weather: resolve_weather(state.base_year, game_elapsed_ms),
        scale: i32::try_from(state.scale).unwrap_or(i32::MAX),
        server_now_ms,
        game_elapsed_ms,
    }
}

fn calc_shichen(hour: i32) -> String {
    match hour {
        23 | 0 => "子时",
        1 | 2 => "丑时",
        3 | 4 => "寅时",
        5 | 6 => "卯时",
        7 | 8 => "辰时",
        9 | 10 => "巳时",
        11 | 12 => "午时",
        13 | 14 => "未时",
        15 | 16 => "申时",
        17 | 18 => "酉时",
        19 | 20 => "戌时",
        _ => "亥时",
    }
    .to_string()
}

fn resolve_weather(base_year: i32, game_elapsed_ms: u64) -> String {
    let bucket = (game_elapsed_ms / WEATHER_BUCKET_MS) as u32;
    let calendar = get_calendar_from_elapsed(base_year, game_elapsed_ms);
    let seed = hash_u32(
        bucket
            ^ (((calendar.year as u32) & 0xffff) << 16)
            ^ ((calendar.month as u32) & 0xff)
            ^ (((calendar.day as u32) & 0x3f) << 8),
    );
    let r01 = f64::from(seed) / 4_294_967_296_f64;
    pick_weighted(r01, get_weather_weights_by_month(calendar.month)).to_string()
}

fn get_calendar_from_elapsed(base_year: i32, game_elapsed_ms: u64) -> CalendarSnapshot {
    let total_sec = game_elapsed_ms / 1000;
    let total_min = total_sec / 60;
    let total_hour = total_min / 60;
    let hour = (total_hour % 24) as i32;
    let total_day = total_hour / 24;
    let day = (total_day % 30) as i32 + 1;
    let total_month = total_day / 30;
    let month = (total_month % 12) as i32 + 1;
    let year_add = (total_month / 12) as i32;

    CalendarSnapshot {
        year: base_year.saturating_add(year_add),
        month,
        day,
        hour,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CalendarSnapshot {
    year: i32,
    month: i32,
    day: i32,
    hour: i32,
}

#[derive(Debug, Clone, Copy)]
struct WeightedWeather<'a> {
    weather: &'a str,
    weight: f64,
}

fn hash_u32(seed: u32) -> u32 {
    let mut hashed = seed ^ 0x811c9dc5;
    hashed = (hashed ^ (hashed >> 16)).wrapping_mul(0x7feb352d);
    hashed = (hashed ^ (hashed >> 15)).wrapping_mul(0x846ca68b);
    hashed ^ (hashed >> 16)
}

fn pick_weighted(r01: f64, items: &[WeightedWeather<'static>]) -> &'static str {
    let total_weight = items
        .iter()
        .filter(|item| item.weight.is_finite() && item.weight > 0.0)
        .map(|item| item.weight)
        .sum::<f64>();
    if total_weight <= 0.0 {
        return DEFAULT_WEATHER;
    }

    let target = r01.clamp(0.0, 0.999_999_999) * total_weight;
    let mut acc = 0.0;
    for item in items {
        if !item.weight.is_finite() || item.weight <= 0.0 {
            continue;
        }
        acc += item.weight;
        if target <= acc {
            return item.weather;
        }
    }

    items.last().map(|item| item.weather).unwrap_or(DEFAULT_WEATHER)
}

fn get_weather_weights_by_month(month: i32) -> &'static [WeightedWeather<'static>] {
    match month {
        12 | 1 | 2 => &[
            WeightedWeather {
                weather: "雪",
                weight: 0.35,
            },
            WeightedWeather {
                weather: "阴",
                weight: 0.25,
            },
            WeightedWeather {
                weather: "晴",
                weight: 0.25,
            },
            WeightedWeather {
                weather: "雾",
                weight: 0.10,
            },
            WeightedWeather {
                weather: "雨",
                weight: 0.05,
            },
        ],
        3..=5 => &[
            WeightedWeather {
                weather: "晴",
                weight: 0.30,
            },
            WeightedWeather {
                weather: "雨",
                weight: 0.30,
            },
            WeightedWeather {
                weather: "阴",
                weight: 0.25,
            },
            WeightedWeather {
                weather: "雾",
                weight: 0.10,
            },
            WeightedWeather {
                weather: "雷",
                weight: 0.05,
            },
        ],
        6..=8 => &[
            WeightedWeather {
                weather: "晴",
                weight: 0.35,
            },
            WeightedWeather {
                weather: "雨",
                weight: 0.25,
            },
            WeightedWeather {
                weather: "雷",
                weight: 0.20,
            },
            WeightedWeather {
                weather: "阴",
                weight: 0.15,
            },
            WeightedWeather {
                weather: "雾",
                weight: 0.05,
            },
        ],
        _ => &[
            WeightedWeather {
                weather: "晴",
                weight: 0.35,
            },
            WeightedWeather {
                weather: "阴",
                weight: 0.30,
            },
            WeightedWeather {
                weather: "雨",
                weight: 0.20,
            },
            WeightedWeather {
                weather: "雾",
                weight: 0.10,
            },
            WeightedWeather {
                weather: "雷",
                weight: 0.05,
            },
        ],
    }
}

fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::{
        build_snapshot_from_elapsed, calc_shichen, get_calendar_from_elapsed, resolve_weather,
        GameTimeState,
    };

    #[test]
    fn calc_shichen_matches_node_boundaries() {
        assert_eq!(calc_shichen(0), "子时");
        assert_eq!(calc_shichen(2), "丑时");
        assert_eq!(calc_shichen(8), "辰时");
        assert_eq!(calc_shichen(15), "申时");
        assert_eq!(calc_shichen(22), "亥时");
        assert_eq!(calc_shichen(23), "子时");
    }

    #[test]
    fn snapshot_calendar_derivation_matches_node_formula() {
        let state = GameTimeState {
            era_name: "末法纪元".to_string(),
            base_year: 1000,
            game_elapsed_ms: 0,
            scale: 60,
            last_real_ms: 0,
        };
        let snapshot = build_snapshot_from_elapsed(
            &state,
            1_712_707_200_000,
            (((365_u64 * 24) + 8) * 60 + 30) * 60 * 1000 + 15_000,
        );

        assert_eq!(snapshot.year, 1001);
        assert_eq!(snapshot.month, 1);
        assert_eq!(snapshot.day, 6);
        assert_eq!(snapshot.hour, 8);
        assert_eq!(snapshot.minute, 30);
        assert_eq!(snapshot.second, 15);
        assert_eq!(snapshot.shichen, "辰时");
    }

    #[test]
    fn weather_resolution_is_deterministic_for_same_bucket() {
        let first = resolve_weather(1000, 5 * 60 * 60 * 1000);
        let second = resolve_weather(1000, 5 * 60 * 60 * 1000 + 30 * 60 * 1000);
        let later_bucket = resolve_weather(1000, 6 * 60 * 60 * 1000);

        assert_eq!(first, second);
        assert!(!later_bucket.is_empty());
    }

    #[test]
    fn calendar_projection_tracks_month_rollover() {
        let calendar = get_calendar_from_elapsed(1000, 30_u64 * 24 * 60 * 60 * 1000);

        assert_eq!(calendar.year, 1000);
        assert_eq!(calendar.month, 2);
        assert_eq!(calendar.day, 1);
        assert_eq!(calendar.hour, 0);
    }
}
