use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sqlx::Row;
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep};

use crate::shared::error::AppError;
use crate::state::AppState;

const GAME_TIME_ROW_ID: i16 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct GameTimeSnapshot {
    pub era_name: String,
    pub base_year: i64,
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub shichen: String,
    pub weather: String,
    pub scale: i64,
    pub server_now_ms: i64,
    pub game_elapsed_ms: i64,
}

#[derive(Debug, Clone)]
struct GameTimeState {
    era_name: String,
    base_year: i64,
    weather: String,
    scale: i64,
    game_elapsed_ms: i64,
    last_real_ms: i64,
    last_sect_maintenance_day_serial: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GameTimeInitSummary {
    pub initialized: bool,
    pub loaded_from_db: bool,
    pub persisted_default_row: bool,
}

static GAME_TIME_STATE: OnceLock<Mutex<GameTimeState>> = OnceLock::new();
static GAME_TIME_TICK_HANDLE: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
static GAME_TIME_STOPPING: AtomicBool = AtomicBool::new(false);

fn game_time_state() -> Option<&'static Mutex<GameTimeState>> {
    GAME_TIME_STATE.get()
}

fn game_time_tick_handle() -> &'static Mutex<Option<JoinHandle<()>>> {
    GAME_TIME_TICK_HANDLE.get_or_init(|| Mutex::new(None))
}

pub async fn initialize_game_time_runtime(state: AppState) -> Result<GameTimeInitSummary, AppError> {
    if game_time_state().is_some() {
        return Ok(GameTimeInitSummary {
            initialized: true,
            loaded_from_db: true,
            persisted_default_row: false,
        });
    }

    let now = now_ms();
    let row = state
        .database
        .fetch_optional(
            "SELECT era_name, base_year, game_elapsed_ms, weather, scale, last_real_ms, last_sect_maintenance_day_serial FROM game_time WHERE id = $1 LIMIT 1",
            |q| q.bind(GAME_TIME_ROW_ID),
        )
        .await?;

    let (loaded_from_db, persisted_default_row, runtime_state) = if let Some(row) = row {
        (
            true,
            false,
            GameTimeState {
                era_name: row.try_get::<Option<String>, _>("era_name")?.unwrap_or_else(|| "末法纪元".to_string()),
                base_year: row.try_get::<Option<i32>, _>("base_year")?.unwrap_or(1000) as i64,
                weather: row.try_get::<Option<String>, _>("weather")?.unwrap_or_else(|| "晴".to_string()),
                scale: row.try_get::<Option<i32>, _>("scale")?.unwrap_or(read_game_time_scale() as i32) as i64,
                game_elapsed_ms: row.try_get::<Option<i64>, _>("game_elapsed_ms")?.unwrap_or(7 * 60 * 60 * 1000),
                last_real_ms: row.try_get::<Option<i64>, _>("last_real_ms")?.unwrap_or(now),
            last_sect_maintenance_day_serial: row.try_get::<Option<i32>, _>("last_sect_maintenance_day_serial")?.map(i64::from),
            },
        )
    } else {
        let initial = GameTimeState {
            era_name: "末法纪元".to_string(),
            base_year: 1000,
            weather: "晴".to_string(),
            scale: read_game_time_scale(),
            game_elapsed_ms: 7 * 60 * 60 * 1000,
            last_real_ms: now,
            last_sect_maintenance_day_serial: Some(build_shanghai_day_token(now)),
        };
        persist_game_time_state(&state, &initial).await?;
        (false, true, initial)
    };

    GAME_TIME_STATE
        .set(Mutex::new(runtime_state))
        .map_err(|_| AppError::config("游戏时间已初始化"))?;

    GAME_TIME_STOPPING.store(false, Ordering::SeqCst);
    let state_for_loop = state.clone();
    let handle = tokio::spawn(async move {
        loop {
            if GAME_TIME_STOPPING.load(Ordering::SeqCst) {
                break;
            }
            sleep(Duration::from_secs(1)).await;
            if GAME_TIME_STOPPING.load(Ordering::SeqCst) {
                break;
            }
            if let Err(error) = tick_and_persist(&state_for_loop).await {
                tracing::error!(error = %error, "game time tick failed");
            }
        }
    });
    *game_time_tick_handle().lock().expect("game time tick handle lock should acquire") = Some(handle);

    Ok(GameTimeInitSummary {
        initialized: true,
        loaded_from_db,
        persisted_default_row,
    })
}

pub async fn shutdown_game_time_runtime(state: &AppState) -> Result<(), AppError> {
    GAME_TIME_STOPPING.store(true, Ordering::SeqCst);
    if let Some(handle) = game_time_tick_handle()
        .lock()
        .expect("game time tick handle lock should acquire")
        .take()
    {
        let _ = handle.await;
    }
    if let Some(state_mutex) = game_time_state() {
        let runtime_state = state_mutex
            .lock()
            .map_err(|_| AppError::service_unavailable("游戏时间未初始化"))?
            .clone();
        persist_game_time_state(state, &runtime_state).await?;
    }
    Ok(())
}

pub fn get_game_time_snapshot() -> Result<GameTimeSnapshot, AppError> {
    let state = game_time_state()
        .ok_or_else(|| AppError::service_unavailable("游戏时间未初始化"))?
        .lock()
        .map_err(|_| AppError::service_unavailable("游戏时间未初始化"))?
        .clone();

    let server_now_ms = now_ms();
    let real_elapsed_ms = (server_now_ms - state.last_real_ms).max(0);
    let game_elapsed_ms = state.game_elapsed_ms + real_elapsed_ms * state.scale;

    Ok(build_snapshot(&state, server_now_ms, game_elapsed_ms))
}

async fn tick_and_persist(state: &AppState) -> Result<(), AppError> {
    let Some(state_mutex) = game_time_state() else {
        return Ok(());
    };
    let persisted_state = {
        let mut runtime_state = state_mutex
            .lock()
            .map_err(|_| AppError::service_unavailable("游戏时间未初始化"))?;
        let server_now_ms = now_ms();
        let real_elapsed_ms = (server_now_ms - runtime_state.last_real_ms).clamp(0, 60_000);
        let effective_real_elapsed_ms = if real_elapsed_ms == 0 { 1_000 } else { real_elapsed_ms };
        runtime_state.game_elapsed_ms += effective_real_elapsed_ms * runtime_state.scale;
        runtime_state.last_real_ms = server_now_ms;
        runtime_state.last_sect_maintenance_day_serial = Some(build_shanghai_day_token(server_now_ms));
        runtime_state.clone()
    };
    persist_game_time_state(state, &persisted_state).await
}

async fn persist_game_time_state(state: &AppState, runtime_state: &GameTimeState) -> Result<(), AppError> {
    state.database.execute(
        "INSERT INTO game_time (id, era_name, base_year, game_elapsed_ms, weather, scale, last_real_ms, last_sect_maintenance_day_serial, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) ON CONFLICT (id) DO UPDATE SET era_name = EXCLUDED.era_name, base_year = EXCLUDED.base_year, game_elapsed_ms = EXCLUDED.game_elapsed_ms, weather = EXCLUDED.weather, scale = EXCLUDED.scale, last_real_ms = EXCLUDED.last_real_ms, last_sect_maintenance_day_serial = EXCLUDED.last_sect_maintenance_day_serial, updated_at = NOW()",
        |q| q
            .bind(GAME_TIME_ROW_ID)
            .bind(&runtime_state.era_name)
            .bind(runtime_state.base_year as i32)
            .bind(runtime_state.game_elapsed_ms)
            .bind(&runtime_state.weather)
            .bind(runtime_state.scale as i32)
            .bind(runtime_state.last_real_ms)
            .bind(runtime_state.last_sect_maintenance_day_serial),
    ).await?;
    Ok(())
}

fn build_snapshot(
    state: &GameTimeState,
    server_now_ms: i64,
    game_elapsed_ms: i64,
) -> GameTimeSnapshot {
    let total_sec = game_elapsed_ms.div_euclid(1000);
    let second = total_sec.rem_euclid(60);
    let total_min = total_sec.div_euclid(60);
    let minute = total_min.rem_euclid(60);
    let total_hour = total_min.div_euclid(60);
    let hour = total_hour.rem_euclid(24);
    let total_day = total_hour.div_euclid(24);
    let day = total_day.rem_euclid(30) + 1;
    let total_month = total_day.div_euclid(30);
    let month = total_month.rem_euclid(12) + 1;
    let year = state.base_year + total_month.div_euclid(12);

    GameTimeSnapshot {
        era_name: state.era_name.clone(),
        base_year: state.base_year,
        year,
        month,
        day,
        hour,
        minute,
        second,
        shichen: calc_shichen(hour),
        weather: state.weather.clone(),
        scale: state.scale,
        server_now_ms,
        game_elapsed_ms,
    }
}

fn calc_shichen(hour: i64) -> String {
    match hour {
        23 | 0 => "子时",
        1..=2 => "丑时",
        3..=4 => "寅时",
        5..=6 => "卯时",
        7..=8 => "辰时",
        9..=10 => "巳时",
        11..=12 => "午时",
        13..=14 => "未时",
        15..=16 => "申时",
        17..=18 => "酉时",
        19..=20 => "戌时",
        _ => "亥时",
    }
    .to_string()
}

fn read_game_time_scale() -> i64 {
    std::env::var("GAME_TIME_SCALE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(60)
}

fn build_shanghai_day_token(server_now_ms: i64) -> i64 {
    (server_now_ms + 8 * 60 * 60 * 1000).div_euclid(24 * 60 * 60 * 1000)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{GameTimeInitSummary, build_shanghai_day_token, calc_shichen};

    #[test]
    fn snapshot_contains_expected_default_fields() {
        assert_eq!(calc_shichen(0), "子时");
        assert_eq!(calc_shichen(12), "午时");
        assert_eq!(build_shanghai_day_token(0), 0);
    }

    #[test]
    fn game_time_init_summary_defaults_to_false() {
        let summary = GameTimeInitSummary::default();
        assert!(!summary.initialized);
        assert!(!summary.loaded_from_db);
        assert!(!summary.persisted_default_row);
    }
}
