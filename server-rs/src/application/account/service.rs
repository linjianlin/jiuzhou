use sqlx::Row;

use crate::edge::http::error::BusinessError;

/**
 * 账号级手机号绑定状态读取服务。
 *
 * 作用：
 * 1. 做什么：为 `/api/account/phone-binding/status` 提供唯一的账号级真值读取入口，统一从 `users.phone_number` 组装状态 DTO。
 * 2. 做什么：集中解析手机号绑定开关与脱敏规则，避免 account/game/market 各自重复读取环境变量或重复截断手机号。
 * 3. 不做什么：不发送短信、不校验验证码、不处理换绑流程，也不承担 HTTP 鉴权。
 *
 * 输入 / 输出：
 * - 输入：`user_id`。
 * - 输出：`PhoneBindingStatusDto`，字段与 Node 当前前端消费协议保持一致。
 *
 * 数据流 / 状态流：
 * - account 路由鉴权成功 -> 本服务查询 `users.phone_number` -> 脱敏并返回状态 DTO。
 *
 * 复用设计说明：
 * - 账号页状态接口与未来首页聚合都会消费同一份手机号绑定真值；把读取和脱敏统一收敛在这里后，后续无需再复制一套 `phone_number -> maskedPhoneNumber` 规则。
 * - 开关解析也放在这里，避免路由层、业务层各自读取环境变量导致“状态展示”和“守卫开关”口径漂移。
 *
 * 关键边界条件与坑点：
 * 1. 账号不存在必须维持 `404 账号不存在`，不能返回伪造的未绑定状态。
 * 2. 脱敏只针对标准 11 位手机号执行；若线上已有脏数据，至少不能因为切片越界把服务打崩。
 */
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PhoneBindingStatusDto {
    pub enabled: bool,
    #[serde(rename = "isBound")]
    pub is_bound: bool,
    #[serde(rename = "maskedPhoneNumber")]
    pub masked_phone_number: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SendPhoneBindingCodeResult {
    #[serde(rename = "cooldownSeconds")]
    pub cooldown_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BindPhoneNumberResult {
    #[serde(rename = "maskedPhoneNumber")]
    pub masked_phone_number: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangePasswordResult {
    pub success: bool,
    pub message: String,
}

#[derive(Clone)]
pub struct RustAccountService {
    pool: sqlx::PgPool,
    phone_binding_enabled: bool,
}

impl RustAccountService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self {
            pool,
            phone_binding_enabled: read_market_phone_binding_enabled(),
        }
    }

    pub async fn get_phone_binding_status(
        &self,
        user_id: i64,
    ) -> Result<PhoneBindingStatusDto, BusinessError> {
        let row = sqlx::query("SELECT phone_number FROM users WHERE id = $1 LIMIT 1")
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal_business_error)?;

        let Some(row) = row else {
            return Err(BusinessError::with_status(
                "账号不存在",
                axum::http::StatusCode::NOT_FOUND,
            ));
        };

        let phone_number = row
            .try_get::<Option<String>, _>("phone_number")
            .map_err(internal_business_error)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        Ok(PhoneBindingStatusDto {
            enabled: self.phone_binding_enabled,
            is_bound: phone_number.is_some(),
            masked_phone_number: phone_number.as_deref().map(mask_phone_number),
        })
    }
}

fn read_market_phone_binding_enabled() -> bool {
    std::env::var("MARKET_PHONE_BINDING_ENABLED")
        .ok()
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        .unwrap_or(false)
}

fn mask_phone_number(phone_number: &str) -> String {
    if phone_number.len() < 11 {
        return phone_number.to_string();
    }

    format!("{}****{}", &phone_number[..3], &phone_number[7..])
}

fn internal_business_error(error: impl std::fmt::Display) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
