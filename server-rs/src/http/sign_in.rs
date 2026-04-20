use std::collections::{BTreeMap, HashSet};

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::realtime::sign_in::{SignInUpdatePayload, build_sign_in_update_payload};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

#[derive(Debug, Deserialize)]
pub struct SignInOverviewQuery {
    pub month: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInRecordDto {
    pub date: String,
    pub signed_at: String,
    pub reward: i64,
    pub is_holiday: bool,
    pub holiday_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInOverviewDto {
    pub today: String,
    pub signed_today: bool,
    pub month: String,
    pub month_signed_count: i64,
    pub streak_days: i64,
    pub records: BTreeMap<String, SignInRecordDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoSignInData {
    pub date: String,
    pub reward: i64,
    pub is_holiday: bool,
    pub holiday_name: Option<String>,
    pub spirit_stones: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<SignInUpdatePayload>,
}

pub async fn get_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SignInOverviewQuery>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let now = chrono_like_now();
    let month = query.month.unwrap_or_else(|| format!("{}-{:02}", now.year, now.month));
    let parsed = parse_month(&month).ok_or_else(|| AppError::config("月份参数错误"))?;
    let (month_start, next_month_start) = month_bounds(parsed.year, parsed.month);

    let month_rows = state
        .database
        .fetch_all(
            "SELECT sign_date, reward, is_holiday, holiday_name, created_at FROM sign_in_records WHERE user_id = $1 AND sign_date >= $2::date AND sign_date < $3::date ORDER BY sign_date ASC",
            |query| query.bind(user.user_id).bind(month_start.clone()).bind(next_month_start.clone()),
        )
        .await?;

    let mut records = BTreeMap::new();
    for row in month_rows {
        let date_key = normalize_date_key(row.try_get::<Option<String>, _>("sign_date")?);
        if date_key.is_empty() {
            continue;
        }
        let signed_at = row.try_get::<Option<String>, _>("created_at")?.unwrap_or_default();
        records.insert(
            date_key.clone(),
            SignInRecordDto {
                date: date_key,
                signed_at,
                reward: opt_i64_from_i32(&row, "reward")?.unwrap_or_default(),
                is_holiday: row.try_get::<Option<bool>, _>("is_holiday")?.unwrap_or(false),
                holiday_name: row.try_get::<Option<String>, _>("holiday_name")?,
            },
        );
    }

    let today = format!("{}-{:02}-{:02}", now.year, now.month, now.day);
    let signed_today = if records.contains_key(&today) {
        true
    } else {
        state
            .database
            .fetch_optional(
                "SELECT 1 FROM sign_in_records WHERE user_id = $1 AND sign_date = $2::date LIMIT 1",
                |query| query.bind(user.user_id).bind(today.clone()),
            )
            .await?
            .is_some()
    };

    let history_rows = state
        .database
        .fetch_all(
            "SELECT sign_date FROM sign_in_records WHERE user_id = $1 AND sign_date >= ($2::date - INTERVAL '366 days') ORDER BY sign_date DESC LIMIT 366",
            |query| query.bind(user.user_id).bind(today.clone()),
        )
        .await?;
    let signed_set = build_signed_date_set(
        history_rows
            .into_iter()
            .filter_map(|row| row.try_get::<Option<String>, _>("sign_date").ok().flatten())
            .collect(),
    );
    let streak_days = count_consecutive_signed_days(&signed_set, &today, 366);

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(SignInOverviewDto {
            today,
            signed_today,
            month,
            month_signed_count: records.len() as i64,
            streak_days,
            records,
        }),
    }))
}

pub async fn do_sign_in(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let today = format_today();
    let holiday = get_today_holiday_info();

    let result = state
        .database
        .with_transaction(|| async {
            let character_row = state
                .database
                .fetch_optional(
                    "SELECT id, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE",
                    |query| query.bind(user.user_id),
                )
                .await?;
            let Some(character_row) = character_row else {
                return Ok(failure_result::<DoSignInData>("角色不存在，无法签到"));
            };
            let character_id = i64::from(character_row.try_get::<i32, _>("id")?);
            let current_spirit_stones: i64 = character_row.try_get::<Option<i64>, _>("spirit_stones")?.unwrap_or_default();

            let already_signed = state
                .database
                .fetch_optional(
                    "SELECT 1 FROM sign_in_records WHERE user_id = $1 AND sign_date = $2::date LIMIT 1 FOR UPDATE",
                    |query| query.bind(user.user_id).bind(today.clone()),
                )
                .await?;
            if already_signed.is_some() {
                return Ok(failure_result::<DoSignInData>("今日已签到"));
            }

            let history_rows = state
                .database
                .fetch_all(
                    "SELECT sign_date FROM sign_in_records WHERE user_id = $1 AND sign_date >= ($2::date - INTERVAL '366 days') AND sign_date < $2::date ORDER BY sign_date DESC LIMIT 366",
                    |query| query.bind(user.user_id).bind(today.clone()),
                )
                .await?;
            let signed_set = build_signed_date_set(
                history_rows
                    .into_iter()
                    .filter_map(|row| row.try_get::<Option<String>, _>("sign_date").ok().flatten())
                    .collect(),
            );
            let previous_streak = count_consecutive_signed_days(&signed_set, &prev_day(parse_date_key(&today).expect("today should parse")).to_string(), 366);
            let reward = calculate_sign_in_reward(previous_streak + 1);

            state
                .database
                .execute(
                    "INSERT INTO sign_in_records (user_id, sign_date, reward, is_holiday, holiday_name) VALUES ($1, $2::date, $3, $4, $5)",
                    |query| {
                        query
                            .bind(user.user_id)
                            .bind(today.clone())
                            .bind(reward)
                            .bind(holiday.is_holiday)
                            .bind(holiday.holiday_name.clone())
                    },
                )
                .await?;

            let new_spirit_stones = current_spirit_stones + reward;
            state
                .database
                .execute(
                    "UPDATE characters SET spirit_stones = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
                    |query| query.bind(new_spirit_stones).bind(character_id),
                )
                .await?;

            let debug_day = today.clone();
            Ok(success_result(
                "签到成功",
                DoSignInData {
                    date: today,
                    reward,
                    is_holiday: holiday.is_holiday,
                    holiday_name: holiday.holiday_name,
                    spirit_stones: new_spirit_stones,
                    debug_realtime: Some(build_sign_in_update_payload(&debug_day, reward, new_spirit_stones)),
                },
            ))
        })
        .await?;

    Ok(send_result(result))
}

fn parse_month(raw: &str) -> Option<ParsedMonth> {
    let captures = raw.trim().split('-').collect::<Vec<_>>();
    if captures.len() != 2 {
        return None;
    }
    let year = captures[0].parse::<i32>().ok()?;
    let month = captures[1].parse::<u32>().ok()?;
    (1..=12).contains(&month).then_some(ParsedMonth { year, month })
}

#[derive(Debug, Clone, Copy)]
struct ParsedMonth {
    year: i32,
    month: u32,
}

fn month_bounds(year: i32, month: u32) -> (String, String) {
    let start = format!("{year}-{:02}-01", month);
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let next = format!("{next_year}-{:02}-01", next_month);
    (start, next)
}

fn calculate_sign_in_reward(streak_days_after_sign_in: i64) -> i64 {
    let effective = streak_days_after_sign_in.clamp(1, 30);
    1500 + (effective - 1) * 100
}

fn normalize_date_key(raw: Option<String>) -> String {
    raw.unwrap_or_default().chars().take(10).collect()
}

fn build_signed_date_set(values: Vec<String>) -> HashSet<String> {
    values
        .into_iter()
        .map(|value| value.chars().take(10).collect::<String>())
        .filter(|value| !value.is_empty())
        .collect()
}

fn count_consecutive_signed_days(signed_set: &HashSet<String>, start_date: &str, max_days: usize) -> i64 {
    let Some(mut cursor) = parse_date_key(start_date) else {
        return 0;
    };
    let mut streak = 0_i64;
    while streak < max_days as i64 {
        let key = format!("{}-{:02}-{:02}", cursor.year, cursor.month, cursor.day);
        if !signed_set.contains(&key) {
            break;
        }
        streak += 1;
        cursor = prev_day(cursor);
    }
    streak
}

#[derive(Debug, Clone, Copy)]
struct SimpleDate {
    year: i32,
    month: u32,
    day: u32,
}

fn parse_date_key(raw: &str) -> Option<SimpleDate> {
    let parts = raw.split('-').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    Some(SimpleDate {
        year: parts[0].parse().ok()?,
        month: parts[1].parse().ok()?,
        day: parts[2].parse().ok()?,
    })
}

fn prev_day(date: SimpleDate) -> SimpleDate {
    if date.day > 1 {
        return SimpleDate { day: date.day - 1, ..date };
    }
    if date.month > 1 {
        let month = date.month - 1;
        return SimpleDate {
            year: date.year,
            month,
            day: days_in_month(date.year, month),
        };
    }
    SimpleDate {
        year: date.year - 1,
        month: 12,
        day: 31,
    }
}

impl std::fmt::Display for SimpleDate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(year) { 29 } else { 28 },
        _ => 30,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[derive(Debug, Clone, Copy)]
struct SimpleNow {
    year: i32,
    month: u32,
    day: u32,
}

fn chrono_like_now() -> SimpleNow {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let days = now / 86_400;
    civil_from_days(days as i64)
}

fn format_today() -> String {
    let now = chrono_like_now();
    format!("{}-{:02}-{:02}", now.year, now.month, now.day)
}

#[derive(Debug, Clone)]
struct HolidayInfo {
    is_holiday: bool,
    holiday_name: Option<String>,
}

fn get_today_holiday_info() -> HolidayInfo {
    get_holiday_info_for_date(&format_today())
}

fn get_holiday_info_for_date(date: &str) -> HolidayInfo {
    match holiday_cn::is_offday(date) {
        Ok((is_holiday, holiday_name)) => HolidayInfo {
            is_holiday,
            holiday_name: if is_holiday {
                holiday_name.map(|value| value.to_string())
            } else {
                None
            },
        },
        Err(_) => HolidayInfo {
            is_holiday: false,
            holiday_name: None,
        },
    }
}

fn failure_result<T>(message: &str) -> ServiceResult<T> {
    ServiceResult {
        success: false,
        message: Some(message.to_string()),
        data: None,
    }
}

fn success_result<T: Serialize>(message: &str, data: T) -> ServiceResult<T> {
    ServiceResult {
        success: true,
        message: Some(message.to_string()),
        data: Some(data),
    }
}

fn civil_from_days(days_since_epoch: i64) -> SimpleNow {
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    SimpleNow {
        year: year as i32,
        month: m as u32,
        day: d as u32,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::realtime::sign_in::build_sign_in_update_payload;

    #[test]
    fn parse_month_accepts_valid_values() {
        let parsed = super::parse_month("2026-04").expect("month should parse");
        assert_eq!(parsed.year, 2026);
        assert_eq!(parsed.month, 4);
    }

    #[test]
    fn parse_month_rejects_invalid_values() {
        assert!(super::parse_month("2026-13").is_none());
        assert!(super::parse_month("202604").is_none());
    }

    #[test]
    fn overview_payload_matches_frontend_contract_shape() {
        let payload = serde_json::to_value(super::SignInOverviewDto {
            today: "2026-04-11".to_string(),
            signed_today: false,
            month: "2026-04".to_string(),
            month_signed_count: 3,
            streak_days: 2,
            records: BTreeMap::from([(
                "2026-04-10".to_string(),
                super::SignInRecordDto {
                    date: "2026-04-10".to_string(),
                    signed_at: "2026-04-10T10:00:00.000Z".to_string(),
                    reward: 1600,
                    is_holiday: false,
                    holiday_name: None,
                },
            )]),
        })
        .expect("payload should serialize");

        assert_eq!(payload["today"], "2026-04-11");
        assert_eq!(payload["signedToday"], false);
        assert_eq!(payload["monthSignedCount"], 3);
        assert_eq!(payload["streakDays"], 2);
        println!("SIGNIN_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn do_sign_in_success_payload_matches_frontend_contract_shape() {
        let payload = serde_json::to_value(super::DoSignInData {
            date: "2026-04-11".to_string(),
            reward: 1600,
            is_holiday: false,
            holiday_name: None,
            spirit_stones: 2600,
            debug_realtime: Some(build_sign_in_update_payload("2026-04-11", 1600, 2600)),
        })
        .expect("payload should serialize");

        assert_eq!(payload["date"], "2026-04-11");
        assert_eq!(payload["reward"], 1600);
        assert_eq!(payload["spiritStones"], 2600);
        assert_eq!(payload["debugRealtime"]["kind"], "sign-in:update");
        println!("SIGNIN_DO_RESPONSE={}", payload);
    }

    #[test]
    fn holiday_helper_returns_expected_shape_for_known_date() {
        let info = super::get_holiday_info_for_date("2025-01-01");
        assert!(info.is_holiday);
        assert_eq!(info.holiday_name.as_deref(), Some("元旦"));
    }
}
