use base64::Engine;
use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::net::SocketAddr;

use crate::auth::{self, AuthTokenPayload};
use crate::config::CaptchaProvider;
use crate::http::security::{AttemptAction, assert_action_attempt_allowed, clear_action_attempt_failures, enforce_qps_limit, record_action_attempt_failure};
use crate::integrations::redis::RedisRuntime;
use crate::integrations::tencent_captcha;
use crate::shared::error::AppError;
use crate::shared::request_ip::resolve_request_ip_with_socket_addr;
use crate::shared::response::{ServiceResult, send_result, send_success};
use crate::state::AppState;

const CAPTCHA_KEY_PREFIX: &str = "auth:captcha:";
const CAPTCHA_TTL_SECONDS: u64 = 300;
const CAPTCHA_LENGTH: usize = 4;
const CAPTCHA_CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Debug, Deserialize)]
pub struct AuthPayload {
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(rename = "captchaId")]
    pub captcha_id: Option<String>,
    #[serde(rename = "captchaCode")]
    pub captcha_code: Option<String>,
    pub ticket: Option<String>,
    pub randstr: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptchaChallenge {
    pub captcha_id: String,
    pub image_data: String,
    pub expires_at: u64,
}

#[derive(Debug, Serialize)]
pub struct AuthUserDto {
    pub id: i64,
    pub username: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSuccessData {
    pub user: AuthUserDto,
    pub token: String,
    pub session_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyData {
    pub user_id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapData {
    pub user_id: i64,
    pub has_character: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptchaConfigData {
    pub provider: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tencent_app_id: Option<u64>,
}

pub async fn get_captcha_config(
    State(state): State<AppState>,
) -> Json<crate::shared::response::SuccessResponse<CaptchaConfigData>> {
    let provider = if state.config.captcha.provider == CaptchaProvider::Tencent {
        "tencent"
    } else {
        "local"
    };
    send_success(CaptchaConfigData {
        provider,
        tencent_app_id: (state.config.captcha.provider == CaptchaProvider::Tencent
            && state.config.captcha.tencent_app_id > 0)
            .then_some(state.config.captcha.tencent_app_id),
    })
}

pub async fn get_captcha(State(state): State<AppState>) -> Result<Json<crate::shared::response::SuccessResponse<CaptchaChallenge>>, AppError> {
    if state.config.captcha.provider == CaptchaProvider::Tencent {
        return Err(AppError::config("当前验证码模式不支持此操作"));
    }
    let redis_client = state
        .redis
        .clone()
        .ok_or_else(|| AppError::service_unavailable("当前验证码服务不可用"))?;
    let redis = RedisRuntime::new(redis_client);
    let captcha_id = format!("captcha-{}", now_millis());
    let answer = generate_captcha_answer();
    let expires_at = now_secs() + CAPTCHA_TTL_SECONDS;
    let payload = serde_json::json!({
        "answer": answer,
        "expiresAt": expires_at,
    });
    redis
        .set_string_ex(
            &format!("{CAPTCHA_KEY_PREFIX}{captcha_id}"),
            &payload.to_string(),
            CAPTCHA_TTL_SECONDS,
        )
        .await?;

    Ok(send_success(CaptchaChallenge {
        captcha_id,
        image_data: build_captcha_image_data(&answer),
        expires_at,
    }))
}

pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> Result<axum::response::Response, AppError> {
    let request_ip = resolve_request_ip_with_socket_addr(&headers, Some(remote_addr))?;
    enforce_qps_limit(
        &state,
        &request_ip,
        "qps:auth:register",
        6,
        10 * 60 * 1000,
        "认证请求过于频繁，请稍后再试",
    )
    .await?;
    let username = payload.username.clone().unwrap_or_default().trim().to_string();
    let password = payload.password.clone().unwrap_or_default();
    validate_auth_input(&username, &password)?;
    verify_local_captcha_if_present(&state, &payload, &request_ip).await?;

    let existing = state
        .database
        .fetch_optional("SELECT id FROM users WHERE username = $1", |query| query.bind(&username))
        .await?;
    if existing.is_some() {
        return Ok(send_result(ServiceResult::<AuthSuccessData> {
            success: false,
            message: Some("用户名已存在".to_string()),
            data: None,
        }));
    }

    let password_hash = bcrypt::hash(&password, 10)
        .map_err(|error| AppError::config(format!("failed to hash password: {error}")))?;
    let inserted = state
        .database
        .fetch_one(
            "INSERT INTO users (username, password, created_at, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id::bigint AS id, username",
            |query| query.bind(&username).bind(password_hash),
        )
        .await?;
    let user_id: i64 = inserted.try_get("id")?;
    let username: String = inserted.try_get("username")?;
    let token = auth::sign_token(
        AuthTokenPayload {
            user_id,
            username: &username,
            session_token: None,
        },
        &state.config.service.jwt_secret,
        &state.config.service.jwt_expires_in,
    )?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("注册成功".to_string()),
        data: Some(AuthSuccessData {
            user: AuthUserDto { id: user_id, username },
            token,
            session_token: String::new(),
        }),
    }))
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> Result<axum::response::Response, AppError> {
    let request_ip = resolve_request_ip_with_socket_addr(&headers, Some(remote_addr))?;
    enforce_qps_limit(
        &state,
        &request_ip,
        "qps:auth:login",
        12,
        60 * 1000,
        "认证请求过于频繁，请稍后再试",
    )
    .await?;
    let username = payload.username.clone().unwrap_or_default().trim().to_string();
    let password = payload.password.clone().unwrap_or_default();
    validate_auth_input(&username, &password)?;
    assert_action_attempt_allowed(&state, AttemptAction::Login, &username, &request_ip).await?;
    verify_local_captcha_if_present(&state, &payload, &request_ip).await?;

    let row = state
        .database
        .fetch_optional(
            "SELECT id::bigint AS id, username, password, status::integer AS status FROM users WHERE username = $1",
            |query| query.bind(&username),
        )
        .await?;

    let Some(row) = row else {
        record_action_attempt_failure(&state, AttemptAction::Login, &username, &request_ip).await?;
        return Ok(send_result(ServiceResult::<AuthSuccessData> {
            success: false,
            message: Some("用户名或密码错误".to_string()),
            data: None,
        }));
    };

    let user_id: i64 = row.try_get("id")?;
    let username: String = row.try_get("username")?;
    let password_hash: String = row.try_get("password")?;
    let status: i32 = row.try_get("status")?;
    if status == 0 {
        record_action_attempt_failure(&state, AttemptAction::Login, &username, &request_ip).await?;
        return Ok(send_result(ServiceResult::<AuthSuccessData> {
            success: false,
            message: Some("账号已被禁用".to_string()),
            data: None,
        }));
    }

    let password_ok = bcrypt::verify(&password, &password_hash)
        .map_err(|error| AppError::config(format!("failed to verify password hash: {error}")))?;
    if !password_ok {
        record_action_attempt_failure(&state, AttemptAction::Login, &username, &request_ip).await?;
        return Ok(send_result(ServiceResult::<AuthSuccessData> {
            success: false,
            message: Some("用户名或密码错误".to_string()),
            data: None,
        }));
    }

    let session_token = format!("session-{}-{}", user_id, now_millis());
    state
        .database
        .execute(
            "UPDATE users SET last_login = CURRENT_TIMESTAMP, session_token = $1 WHERE id = $2",
            |query| query.bind(&session_token).bind(user_id as i32),
        )
        .await?;
    let token = auth::sign_token(
        AuthTokenPayload {
            user_id,
            username: &username,
            session_token: Some(&session_token),
        },
        &state.config.service.jwt_secret,
        &state.config.service.jwt_expires_in,
    )?;
    clear_action_attempt_failures(&state, AttemptAction::Login, &username, &request_ip).await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("登录成功".to_string()),
        data: Some(AuthSuccessData {
            user: AuthUserDto { id: user_id, username },
            token,
            session_token,
        }),
    }))
}

pub async fn verify(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::shared::response::SuccessResponse<VerifyData>>, AppError> {
    let verified = auth::verify_token_and_session(&state, &headers).await?;
    Ok(send_success(VerifyData {
        user_id: verified.user_id,
    }))
}

pub async fn bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::shared::response::SuccessResponse<BootstrapData>>, AppError> {
    let verified = auth::verify_token_and_session(&state, &headers).await?;
    let has_character = state
        .database
        .fetch_optional(
            "SELECT id FROM characters WHERE user_id = $1 LIMIT 1",
            |query| query.bind(verified.user_id),
        )
        .await?
        .is_some();
    Ok(send_success(BootstrapData {
        user_id: verified.user_id,
        has_character,
    }))
}

fn validate_auth_input(username: &str, password: &str) -> Result<(), AppError> {
    if username.is_empty() || password.is_empty() {
        return Err(AppError::config("用户名和密码不能为空"));
    }
    if username.chars().count() < 2 || username.chars().count() > 20 {
        return Err(AppError::config("用户名长度需在2-20个字符之间"));
    }
    if password.chars().count() < 6 {
        return Err(AppError::config("密码长度至少6位"));
    }
    Ok(())
}

async fn verify_local_captcha_if_present(
    state: &AppState,
    payload: &AuthPayload,
    user_ip: &str,
) -> Result<(), AppError> {
    match state.config.captcha.provider {
        CaptchaProvider::Tencent => {
            let ticket = payload.ticket.as_deref().map(str::trim).unwrap_or_default();
            let randstr = payload.randstr.as_deref().map(str::trim).unwrap_or_default();
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
        CaptchaProvider::Local => {}
    }

    let Some(captcha_id) = payload.captcha_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(AppError::config("图片验证码不能为空"));
    };
    let captcha_code = payload
        .captcha_code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("图片验证码不能为空"))?;
    let redis_client = state
        .redis
        .clone()
        .ok_or_else(|| AppError::service_unavailable("当前验证码服务不可用"))?;
    let redis = RedisRuntime::new(redis_client);
    let key = format!("{CAPTCHA_KEY_PREFIX}{captcha_id}");
    let raw = redis
        .get_string(&key)
        .await?
        .ok_or_else(|| AppError::config("验证码不存在或已失效"))?;
    redis.del(&key).await?;
    let stored: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| AppError::config(format!("failed to decode captcha payload: {error}")))?;
    let answer = stored["answer"].as_str().unwrap_or_default().to_ascii_uppercase();
    let expires_at = stored["expiresAt"].as_u64().unwrap_or_default();
    if expires_at < now_secs() {
        return Err(AppError::config("图片验证码已失效，请重新获取"));
    }
    if answer != captcha_code.trim().to_ascii_uppercase() {
        return Err(AppError::config("图片验证码错误，请重新获取"));
    }
    Ok(())
}

fn generate_captcha_answer() -> String {
    (0..CAPTCHA_LENGTH)
        .map(|index| {
            let seed = (now_millis() as usize).wrapping_add(index * 17);
            let idx = seed % CAPTCHA_CHARSET.len();
            CAPTCHA_CHARSET[idx] as char
        })
        .collect()
}

fn build_captcha_image_data(answer: &str) -> String {
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="132" height="56"><rect width="132" height="56" rx="10" fill="#f8fafc"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-size="24" font-family="Arial, sans-serif" fill="#0f172a">{answer}</text></svg>"##
    );
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
    )
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn captcha_config_payload_matches_frontend_contract_shape() {
        let payload = serde_json::to_value(super::CaptchaConfigData {
            provider: "tencent",
            tencent_app_id: Some(123456789),
        })
        .expect("payload should serialize");

        assert_eq!(payload["provider"], "tencent");
        assert_eq!(payload["tencentAppId"], 123456789);
        println!("CAPTCHA_CONFIG_RESPONSE={}", payload);
    }
}
