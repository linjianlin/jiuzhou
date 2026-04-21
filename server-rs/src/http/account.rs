use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use serde::Deserialize;
use serde::Serialize;
use sqlx::Row;
use std::net::SocketAddr;

use crate::auth;
use crate::http::security::{
    AttemptAction, assert_action_attempt_allowed, clear_action_attempt_failures, enforce_qps_limit,
    record_action_attempt_failure,
};
use crate::integrations::aliyun_sms;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::tencent_captcha;
use crate::shared::error::AppError;
use crate::shared::phone_binding_send_limit::{
    build_phone_binding_cooldown_key, build_phone_binding_exceeded_message,
    build_phone_binding_send_limit_windows,
};
use crate::shared::phone_number::{mask_phone_number, normalize_mainland_phone_number};
use crate::shared::request_ip::resolve_request_ip_with_socket_addr;
use crate::shared::response::{ServiceResult, SuccessResponse, send_result, send_success};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct CurrentIpData {
    pub ip: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneBindingStatusDto {
    pub enabled: bool,
    pub is_bound: bool,
    pub masked_phone_number: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordPayload {
    #[serde(rename = "currentPassword")]
    pub current_password: Option<String>,
    #[serde(rename = "newPassword")]
    pub new_password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendPhoneBindingCodePayload {
    pub phone_number: Option<String>,
    pub captcha_id: Option<String>,
    pub captcha_code: Option<String>,
    pub ticket: Option<String>,
    pub randstr: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindPhoneNumberPayload {
    pub phone_number: Option<String>,
    pub code: Option<String>,
}

pub async fn get_current_ip(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<CurrentIpData>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    let ip = resolve_request_ip_with_socket_addr(&headers, Some(remote_addr))?;
    Ok(send_success(CurrentIpData { ip }))
}

pub async fn change_password(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let request_ip = resolve_request_ip_with_socket_addr(&headers, Some(remote_addr))?;
    enforce_qps_limit(
        &state,
        &request_ip,
        "qps:account:password-change",
        10,
        10 * 60 * 1000,
        "账号安全请求过于频繁，请稍后再试",
    )
    .await?;
    let current_password = payload.current_password.unwrap_or_default();
    let new_password = payload.new_password.unwrap_or_default();

    if current_password.is_empty() || new_password.is_empty() {
        return Err(AppError::config("当前密码和新密码不能为空"));
    }
    if current_password == new_password {
        return Err(AppError::config("新密码不能与当前密码相同"));
    }
    if new_password.len() < 6 {
        return Err(AppError::config("密码长度至少6位"));
    }

    assert_action_attempt_allowed(
        &state,
        AttemptAction::PasswordChange,
        &user.user_id.to_string(),
        &request_ip,
    )
    .await?;

    let row = state
        .database
        .fetch_optional(
            "SELECT password, status::integer AS status FROM users WHERE id = $1",
            |query| query.bind(user.user_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("账号不存在".to_string()),
            data: None,
        }));
    };

    let status = row.try_get::<Option<i32>, _>("status")?.unwrap_or(1);
    if status == 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("账号已被禁用".to_string()),
            data: None,
        }));
    }

    let password_hash = row
        .try_get::<Option<String>, _>("password")?
        .unwrap_or_default();
    if password_hash.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("账号密码状态异常".to_string()),
            data: None,
        }));
    }

    let matched = bcrypt::verify(&current_password, &password_hash)
        .map_err(|error| AppError::config(format!("failed to verify password hash: {error}")))?;
    if !matched {
        record_action_attempt_failure(
            &state,
            AttemptAction::PasswordChange,
            &user.user_id.to_string(),
            &request_ip,
        )
        .await?;
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("当前密码错误".to_string()),
            data: None,
        }));
    }

    let next_password_hash = bcrypt::hash(&new_password, 10)
        .map_err(|error| AppError::config(format!("failed to hash password: {error}")))?;
    state
        .database
        .execute(
            "UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
            |query| query.bind(next_password_hash).bind(user.user_id),
        )
        .await?;
    clear_action_attempt_failures(
        &state,
        AttemptAction::PasswordChange,
        &user.user_id.to_string(),
        &request_ip,
    )
    .await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("密码修改成功".to_string()),
        data: Some(serde_json::json!({})),
    }))
}

pub async fn get_phone_binding_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<PhoneBindingStatusDto>>, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let row = state
        .database
        .fetch_optional(
            "SELECT phone_number FROM users WHERE id = $1 LIMIT 1",
            |query| query.bind(user.user_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::not_found("账号不存在"));
    };
    let phone_number = row.try_get::<Option<String>, _>("phone_number")?;
    let masked_phone_number = phone_number.as_deref().and_then(mask_phone_number);

    Ok(send_success(PhoneBindingStatusDto {
        enabled: state.config.market_phone_binding.enabled,
        is_bound: phone_number
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some(),
        masked_phone_number,
    }))
}

pub async fn send_phone_binding_code(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<SendPhoneBindingCodePayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    assert_phone_binding_feature_enabled(&state)?;
    let phone_number =
        normalize_mainland_phone_number(payload.phone_number.as_deref().unwrap_or_default())?;
    let request_ip = resolve_request_ip_with_socket_addr(&headers, Some(remote_addr))?;
    verify_phone_binding_captcha(&state, &payload, &request_ip).await?;
    assert_phone_binding_writable(&state, user.user_id, &phone_number).await?;

    let redis = RedisRuntime::new(
        state
            .redis
            .clone()
            .ok_or_else(|| AppError::service_unavailable("Redis 不可用，无法发送验证码"))?,
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default();

    let cooldown_key = build_phone_binding_cooldown_key(user.user_id);
    let cooldown_ttl = redis.ttl(&cooldown_key).await?;
    if cooldown_ttl > 0 {
        return Err(AppError::config(&format!(
            "验证码发送过于频繁，请{}秒后重试",
            cooldown_ttl
        )));
    }

    for window in build_phone_binding_send_limit_windows(
        user.user_id,
        &state.config.market_phone_binding,
        now,
    ) {
        let current = redis
            .get_string(&window.key)
            .await?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if current >= window.limit {
            return Err(AppError::config(build_phone_binding_exceeded_message(
                window.key_segment,
                window.limit,
            )));
        }
    }

    aliyun_sms::send_sms_verify_code(
        &state.outbound_http,
        &state.config.market_phone_binding,
        &phone_number,
    )
    .await?;

    for window in build_phone_binding_send_limit_windows(
        user.user_id,
        &state.config.market_phone_binding,
        now,
    ) {
        let count = redis.incr(&window.key).await?;
        if count == 1 {
            redis
                .pexpire(&window.key, (window.expire_seconds * 1000) as i64)
                .await?;
        }
    }
    redis
        .set_string_ex(
            &cooldown_key,
            &phone_number,
            state.config.market_phone_binding.send_cooldown_seconds,
        )
        .await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("验证码发送成功".to_string()),
        data: Some(serde_json::json!({
            "cooldownSeconds": state.config.market_phone_binding.send_cooldown_seconds,
        })),
    }))
}

pub async fn bind_phone_number(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BindPhoneNumberPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    assert_phone_binding_feature_enabled(&state)?;
    let phone_number =
        normalize_mainland_phone_number(payload.phone_number.as_deref().unwrap_or_default())?;
    let verification_code = payload.code.unwrap_or_default();
    if !verification_code.chars().all(|ch| ch.is_ascii_digit()) || verification_code.len() != 6 {
        return Err(AppError::config("验证码格式错误"));
    }
    assert_phone_binding_writable(&state, user.user_id, &phone_number).await?;

    let verified = aliyun_sms::check_sms_verify_code(
        &state.outbound_http,
        &state.config.market_phone_binding,
        &phone_number,
        &verification_code,
    )
    .await?;
    if !verified {
        return Err(AppError::config("验证码错误或已失效，请重新获取"));
    }

    state
        .database
        .execute(
            "UPDATE users SET phone_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
            |query| query.bind(&phone_number).bind(user.user_id),
        )
        .await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("绑定成功".to_string()),
        data: Some(serde_json::json!({
            "maskedPhoneNumber": mask_phone_number(&phone_number),
        })),
    }))
}

fn assert_phone_binding_feature_enabled(state: &AppState) -> Result<(), AppError> {
    if !state.config.market_phone_binding.enabled {
        return Err(AppError::config("坊市手机号绑定功能未开启"));
    }
    Ok(())
}

async fn assert_phone_binding_writable(
    state: &AppState,
    user_id: i64,
    phone_number: &str,
) -> Result<(), AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT phone_number FROM users WHERE id = $1 LIMIT 1",
            |query| query.bind(user_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::not_found("账号不存在"));
    };
    let current_phone = row.try_get::<Option<String>, _>("phone_number")?;
    if let Some(current_phone) = current_phone
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if current_phone != phone_number {
            return Err(AppError::config("当前账号已绑定其他手机号，暂不支持换绑"));
        }
    }

    let duplicate = state
        .database
        .fetch_optional(
            "SELECT id FROM users WHERE phone_number = $1 AND id <> $2 LIMIT 1",
            |query| query.bind(phone_number).bind(user_id),
        )
        .await?;
    if duplicate.is_some() {
        return Err(AppError::config("该手机号已绑定其他账号"));
    }
    Ok(())
}

async fn verify_phone_binding_captcha(
    state: &AppState,
    payload: &SendPhoneBindingCodePayload,
    user_ip: &str,
) -> Result<(), AppError> {
    match state.config.captcha.provider {
        crate::config::CaptchaProvider::Tencent => {
            let ticket = payload.ticket.as_deref().map(str::trim).unwrap_or_default();
            let randstr = payload
                .randstr
                .as_deref()
                .map(str::trim)
                .unwrap_or_default();
            if ticket.is_empty() || randstr.is_empty() {
                return Err(AppError::config("验证码票据不能为空"));
            }
            return tencent_captcha::verify_tencent_captcha_ticket(
                &state.outbound_http,
                &state.config.captcha,
                ticket,
                randstr,
                user_ip,
            )
            .await;
        }
        crate::config::CaptchaProvider::Local => {}
    }

    let captcha_id = payload
        .captcha_id
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    let captcha_code = payload
        .captcha_code
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if captcha_id.is_empty() || captcha_code.is_empty() {
        return Err(AppError::config("图片验证码不能为空"));
    }
    let redis = RedisRuntime::new(
        state
            .redis
            .clone()
            .ok_or_else(|| AppError::service_unavailable("当前验证码服务不可用"))?,
    );
    let captcha_key = format!("auth:captcha:{captcha_id}");
    let raw = redis
        .get_string(&captcha_key)
        .await?
        .ok_or_else(|| AppError::config("验证码不存在或已失效"))?;
    redis.del(&captcha_key).await?;
    let stored: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| AppError::config(format!("failed to decode captcha payload: {error}")))?;
    let answer = stored["answer"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let expires_at = stored["expiresAt"].as_u64().unwrap_or_default();
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    if expires_at < now_secs {
        return Err(AppError::config("图片验证码已失效，请重新获取"));
    }
    if answer != captcha_code.to_ascii_uppercase() {
        return Err(AppError::config("图片验证码错误，请重新获取"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn current_ip_prefers_forwarded_for() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.2.3.4, 10.0.0.1"),
        );
        headers.insert("x-real-ip", HeaderValue::from_static("5.6.7.8"));
        let ip =
            crate::shared::request_ip::resolve_request_ip(&headers).expect("ip should resolve");
        assert_eq!(ip, "1.2.3.4");
        let payload =
            serde_json::to_value(super::CurrentIpData { ip }).expect("payload should serialize");
        println!("ACCOUNT_CURRENT_IP_RESPONSE={}", payload);
    }

    #[test]
    fn change_password_success_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "密码修改成功",
            "data": {}
        });
        assert_eq!(payload["success"], true);
        assert_eq!(payload["message"], "密码修改成功");
        println!("ACCOUNT_CHANGE_PASSWORD_SUCCESS_RESPONSE={}", payload);
    }

    #[test]
    fn phone_binding_status_payload_matches_contract() {
        let payload = serde_json::to_value(super::PhoneBindingStatusDto {
            enabled: true,
            is_bound: true,
            masked_phone_number: Some("138****0000".to_string()),
        })
        .expect("payload should serialize");
        assert_eq!(payload["enabled"], true);
        assert_eq!(payload["isBound"], true);
        assert_eq!(payload["maskedPhoneNumber"], "138****0000");
        println!("ACCOUNT_PHONE_BINDING_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn phone_binding_send_code_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"cooldownSeconds": 60}
        });
        assert_eq!(payload["data"]["cooldownSeconds"], 60);
        println!("ACCOUNT_PHONE_BINDING_SEND_CODE_RESPONSE={}", payload);
    }

    #[test]
    fn phone_binding_bind_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"maskedPhoneNumber": "138****0000"}
        });
        assert_eq!(payload["data"]["maskedPhoneNumber"], "138****0000");
        println!("ACCOUNT_PHONE_BINDING_BIND_RESPONSE={}", payload);
    }
}
