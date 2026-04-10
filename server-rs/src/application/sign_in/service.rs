use std::collections::{HashMap, HashSet};

use chrono::{Datelike, Duration, Local, NaiveDate};
use lunar_rust::solar::{self, SolarRefHelper};
use serde::Serialize;
use sqlx::Row;

use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;

const SIGN_IN_HISTORY_LOOKBACK_DAYS: i64 = 366;
const SIGN_IN_REWARD_BASE: i64 = 1_500;
const SIGN_IN_REWARD_STREAK_CAP: i64 = 30;
const SIGN_IN_REWARD_STEP: i64 = 100;

/**
 * 签到应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `signInService` 的签到总览与执行签到逻辑，集中维护月份校验、连签计算、节假日判定与奖励落库。
 * 2. 做什么：把签到记录读取、角色存在性校验、插入幂等与灵石发放收敛到单一事务入口，避免路由层或其它聚合模块重复拼接规则。
 * 3. 不做什么：不处理登录鉴权、不做首页 DTO 聚合，也不复用 battle/idle 等其它资源结算链路。
 *
 * 输入 / 输出：
 * - 输入：`user_id`，以及总览接口额外接收 `YYYY-MM` 月份字符串。
 * - 输出：`ServiceResultResponse<SignInOverviewData>` 与 `ServiceResultResponse<DoSignInData>`，保持 Node `sendResult` 协议。
 *
 * 数据流 / 状态流：
 * - 总览：HTTP -> 本服务 -> `sign_in_records` 月份读取 + 历史回看 -> 单次构建 records/hash set -> 返回总览 DTO。
 * - 执行签到：HTTP -> 本服务 -> 角色查询 -> 连签计算 -> 事务插入签到记录并增加角色灵石 -> 返回最新结果。
 *
 * 复用设计说明：
 * - 月份解析、日期键格式化、历史签到集合与奖励计算都集中在这里，后续首页聚合与签到页面复用同一份业务规则，不必在多个模块重复维护。
 * - 节假日判定封装成独立 helper，避免未来战令/活动日历再次各自接第三方日历库。
 *
 * 关键边界条件与坑点：
 * 1. 今日重复签到必须继续依赖数据库唯一约束幂等返回“今日已签到”，不能只靠内存判断，否则并发下会漂移。
 * 2. 连签奖励必须以“今天签到后的天数”计算且 30 天封顶，不能把查询历史与奖励公式拆到不同层分别维护。
 */
#[derive(Debug, Clone)]
pub struct RustSignInService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SignInRecordDto {
    pub date: String,
    #[serde(rename = "signedAt")]
    pub signed_at: String,
    pub reward: i64,
    #[serde(rename = "isHoliday")]
    pub is_holiday: bool,
    #[serde(rename = "holidayName")]
    pub holiday_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SignInOverviewData {
    pub today: String,
    #[serde(rename = "signedToday")]
    pub signed_today: bool,
    pub month: String,
    #[serde(rename = "monthSignedCount")]
    pub month_signed_count: usize,
    #[serde(rename = "streakDays")]
    pub streak_days: i64,
    pub records: HashMap<String, SignInRecordDto>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DoSignInData {
    pub date: String,
    pub reward: i64,
    #[serde(rename = "isHoliday")]
    pub is_holiday: bool,
    #[serde(rename = "holidayName")]
    pub holiday_name: Option<String>,
    #[serde(rename = "spiritStones")]
    pub spirit_stones: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HolidayInfo {
    is_holiday: bool,
    holiday_name: Option<String>,
}

impl RustSignInService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    pub async fn get_overview(
        &self,
        user_id: i64,
        month: &str,
    ) -> Result<ServiceResultResponse<SignInOverviewData>, BusinessError> {
        let Some(parsed_month) = parse_month(month) else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("月份参数错误".to_string()),
                None,
            ));
        };

        let month_start = format!("{}-01", parsed_month);
        let next_month = next_month_key(parsed_month)?;
        let today = Local::now().date_naive();
        let today_key = format_date_key(today);

        let month_rows = sqlx::query(
            r#"
            SELECT
              to_char(sign_date, 'YYYY-MM-DD') AS sign_date,
              COALESCE(reward, 0)::bigint AS reward,
              COALESCE(is_holiday, FALSE) AS is_holiday,
              holiday_name,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS signed_at
            FROM sign_in_records
            WHERE user_id = $1
              AND sign_date >= $2::date
              AND sign_date < $3::date
            ORDER BY sign_date ASC
            "#,
        )
        .bind(user_id)
        .bind(&month_start)
        .bind(&next_month)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let mut records = HashMap::with_capacity(month_rows.len());
        for row in month_rows {
            let date = row.get::<String, _>("sign_date");
            records.insert(
                date.clone(),
                SignInRecordDto {
                    date,
                    signed_at: row
                        .try_get::<Option<String>, _>("signed_at")
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                    reward: row.get::<i64, _>("reward"),
                    is_holiday: row.get::<bool, _>("is_holiday"),
                    holiday_name: row.try_get("holiday_name").ok().flatten(),
                },
            );
        }

        let signed_today = if records.contains_key(&today_key) {
            true
        } else {
            sqlx::query("SELECT 1 FROM sign_in_records WHERE user_id = $1 AND sign_date = $2::date LIMIT 1")
                .bind(user_id)
                .bind(&today_key)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_business_error)?
                .is_some()
        };

        let history_rows = sqlx::query(
            r#"
            SELECT to_char(sign_date, 'YYYY-MM-DD') AS sign_date
            FROM sign_in_records
            WHERE user_id = $1
              AND sign_date >= ($2::date - INTERVAL '366 days')
            ORDER BY sign_date DESC
            LIMIT 366
            "#,
        )
        .bind(user_id)
        .bind(&today_key)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let signed_dates = build_signed_date_set(history_rows);
        let streak_days = count_consecutive_signed_days(&signed_dates, today, SIGN_IN_HISTORY_LOOKBACK_DAYS);

        Ok(ServiceResultResponse::new(
            true,
            Some("获取成功".to_string()),
            Some(SignInOverviewData {
                today: today_key,
                signed_today,
                month: parsed_month.to_string(),
                month_signed_count: records.len(),
                streak_days,
                records,
            }),
        ))
    }

    pub async fn do_sign_in(
        &self,
        user_id: i64,
    ) -> Result<ServiceResultResponse<DoSignInData>, BusinessError> {
        let today = Local::now().date_naive();
        let today_key = format_date_key(today);
        let holiday_info = get_holiday_info(today);

        let Some(character_id) = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM characters WHERE user_id = $1 LIMIT 1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)? else {
            return Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在，无法签到".to_string()),
                None,
            ));
        };

        let history_rows = sqlx::query(
            r#"
            SELECT to_char(sign_date, 'YYYY-MM-DD') AS sign_date
            FROM sign_in_records
            WHERE user_id = $1
              AND sign_date >= ($2::date - INTERVAL '366 days')
              AND sign_date < $2::date
            ORDER BY sign_date DESC
            LIMIT 366
            "#,
        )
        .bind(user_id)
        .bind(&today_key)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let signed_dates = build_signed_date_set(history_rows);
        let previous_streak_days = count_consecutive_signed_days(
            &signed_dates,
            today - Duration::days(1),
            SIGN_IN_HISTORY_LOOKBACK_DAYS,
        );
        let reward = calculate_sign_in_reward(previous_streak_days + 1);

        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let inserted = sqlx::query_scalar::<_, i64>(
            r#"
            INSERT INTO sign_in_records (user_id, sign_date, reward, is_holiday, holiday_name)
            VALUES ($1, $2::date, $3, $4, $5)
            ON CONFLICT (user_id, sign_date) DO NOTHING
            RETURNING id
            "#,
        )
        .bind(user_id)
        .bind(&today_key)
        .bind(reward)
        .bind(holiday_info.is_holiday)
        .bind(&holiday_info.holiday_name)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        if inserted.is_none() {
            return Ok(ServiceResultResponse::new(
                false,
                Some("今日已签到".to_string()),
                None,
            ));
        }

        let updated_spirit_stones = sqlx::query_scalar::<_, i64>(
            r#"
            UPDATE characters
            SET spirit_stones = COALESCE(spirit_stones, 0) + $2
            WHERE id = $1
            RETURNING spirit_stones
            "#,
        )
        .bind(character_id)
        .bind(reward)
        .fetch_one(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction
            .commit()
            .await
            .map_err(internal_business_error)?;

        Ok(ServiceResultResponse::new(
            true,
            Some("签到成功".to_string()),
            Some(DoSignInData {
                date: today_key,
                reward,
                is_holiday: holiday_info.is_holiday,
                holiday_name: holiday_info.holiday_name,
                spirit_stones: updated_spirit_stones,
            }),
        ))
    }
}

fn parse_month(month: &str) -> Option<&str> {
    let bytes = month.as_bytes();
    if bytes.len() != 7 || bytes[4] != b'-' {
        return None;
    }

    let year = month[0..4].parse::<i32>().ok()?;
    let month_value = month[5..7].parse::<u32>().ok()?;
    if year <= 0 || !(1..=12).contains(&month_value) {
        return None;
    }

    Some(month)
}

fn next_month_key(month: &str) -> Result<String, BusinessError> {
    let year = month[0..4]
        .parse::<i32>()
        .map_err(internal_business_error)?;
    let month_value = month[5..7]
        .parse::<u32>()
        .map_err(internal_business_error)?;
    let next = if month_value == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month_value + 1, 1)
    }
    .ok_or_else(|| {
        BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
    })?;
    Ok(format!("{:04}-{:02}-01", next.year(), next.month()))
}

fn build_signed_date_set(rows: Vec<sqlx::postgres::PgRow>) -> HashSet<String> {
    let mut signed_dates = HashSet::with_capacity(rows.len());
    for row in rows {
        let date = row.get::<String, _>("sign_date");
        if !date.is_empty() {
            signed_dates.insert(date);
        }
    }
    signed_dates
}

fn count_consecutive_signed_days(
    signed_dates: &HashSet<String>,
    start_date: NaiveDate,
    max_days: i64,
) -> i64 {
    let mut streak_days = 0;
    let mut cursor = start_date;
    while streak_days < max_days {
        if !signed_dates.contains(&format_date_key(cursor)) {
            break;
        }
        streak_days += 1;
        cursor -= Duration::days(1);
    }
    streak_days
}

fn calculate_sign_in_reward(streak_days_after_sign_in: i64) -> i64 {
    let effective_days = streak_days_after_sign_in.clamp(1, SIGN_IN_REWARD_STREAK_CAP);
    SIGN_IN_REWARD_BASE + (effective_days - 1) * SIGN_IN_REWARD_STEP
}

fn get_holiday_info(date: NaiveDate) -> HolidayInfo {
    let festivals = solar::from_ymd(date.year() as i64, date.month() as i64, date.day() as i64)
        .get_festivals();
    let Some(first_holiday) = festivals.into_iter().next() else {
        return HolidayInfo {
            is_holiday: false,
            holiday_name: None,
        };
    };
    HolidayInfo {
        is_holiday: true,
        holiday_name: Some(first_holiday),
    }
}

fn format_date_key(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    tracing::error!("sign in service internal error: {error}");
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
