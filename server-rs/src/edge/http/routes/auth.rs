use std::{future::Future, pin::Pin};

use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::application::character::service::{
    CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{invalid_session_response, read_bearer_token};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptchaProvider {
    Local,
    Tencent,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CaptchaChallenge {
    #[serde(rename = "captchaId")]
    pub captcha_id: String,
    #[serde(rename = "imageData")]
    pub image_data: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthResponseUser {
    pub id: i64,
    pub username: String,
    pub status: i32,
    #[serde(rename = "created_at", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(rename = "updated_at", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(rename = "last_login", skip_serializing_if = "Option::is_none")]
    pub last_login: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthResponseData {
    pub user: AuthResponseUser,
    pub token: String,
    #[serde(rename = "sessionToken")]
    pub session_token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthActionResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<AuthResponseData>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyTokenAndSessionResult {
    pub valid: bool,
    pub kicked: bool,
    pub user_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptchaVerifyPayload {
    Local {
        captcha_id: String,
        captcha_code: String,
    },
    Tencent {
        ticket: String,
        randstr: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterInput {
    pub username: String,
    pub password: String,
    pub user_ip: String,
    pub captcha: CaptchaVerifyPayload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginInput {
    pub username: String,
    pub password: String,
    pub user_ip: String,
    pub captcha: CaptchaVerifyPayload,
}

#[derive(Debug, Deserialize)]
struct AuthPayload {
    username: Option<String>,
    password: Option<String>,
    #[serde(rename = "captchaId")]
    captcha_id: Option<String>,
    #[serde(rename = "captchaCode")]
    captcha_code: Option<String>,
    ticket: Option<String>,
    randstr: Option<String>,
}

pub trait AuthRouteServices: Send + Sync {
    fn captcha_provider(&self) -> CaptchaProvider;

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>>;

    fn register<'a>(
        &'a self,
        input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>>;

    fn login<'a>(
        &'a self,
        input: LoginInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>>;

    fn verify_token_and_session<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<Box<dyn Future<Output = VerifyTokenAndSessionResult> + Send + 'a>>;

    fn check_character<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<CheckCharacterResult, BusinessError>> + Send + 'a>>;

    fn create_character<'a>(
        &'a self,
        user_id: i64,
        nickname: String,
        gender: String,
    ) -> Pin<Box<dyn Future<Output = Result<CreateCharacterResult, BusinessError>> + Send + 'a>>;

    fn update_character_position<'a>(
        &'a self,
        user_id: i64,
        current_map_id: String,
        current_room_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>,
    >;
}

pub fn build_auth_router() -> Router<AppState> {
    Router::new()
        .route("/captcha", get(captcha_handler))
        .route("/register", post(register_handler))
        .route("/login", post(login_handler))
        .route("/verify", get(verify_handler))
        .route("/bootstrap", get(bootstrap_handler))
}

async fn captcha_handler(State(state): State<AppState>) -> Result<Response, BusinessError> {
    if matches!(
        state.auth_services.captcha_provider(),
        CaptchaProvider::Tencent
    ) {
        return Err(BusinessError::new("当前验证码模式不支持此操作"));
    }

    let challenge = state.auth_services.create_captcha().await?;
    Ok(success(challenge))
}

async fn register_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> Result<Response, BusinessError> {
    let username = normalize_required(payload.username.clone(), "用户名和密码不能为空")?;
    let password = payload.password.clone().unwrap_or_default();
    if password.is_empty() {
        return Err(BusinessError::new("用户名和密码不能为空"));
    }
    if username.chars().count() < 2 || username.chars().count() > 20 {
        return Err(BusinessError::new("用户名长度需在2-20个字符之间"));
    }
    if password.chars().count() < 6 {
        return Err(BusinessError::new("密码长度至少6位"));
    }

    let captcha = parse_captcha_payload(state.auth_services.captcha_provider(), &payload)?;
    let result = state
        .auth_services
        .register(RegisterInput {
            username,
            password,
            user_ip: resolve_request_ip(&headers),
            captcha,
        })
        .await?;

    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}

async fn login_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AuthPayload>,
) -> Result<Response, BusinessError> {
    let username = normalize_required(payload.username.clone(), "用户名和密码不能为空")?;
    let password = payload.password.clone().unwrap_or_default();
    if password.is_empty() {
        return Err(BusinessError::new("用户名和密码不能为空"));
    }

    let captcha = parse_captcha_payload(state.auth_services.captcha_provider(), &payload)?;
    let result = state
        .auth_services
        .login(LoginInput {
            username,
            password,
            user_ip: resolve_request_ip(&headers),
            captcha,
        })
        .await?;

    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}

async fn verify_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let token = require_bearer_token(&headers)?;
    let result = state.auth_services.verify_token_and_session(&token).await;
    if !result.valid {
        return invalid_session_response(result.kicked);
    }

    Ok(success(serde_json::json!({
        "userId": result.user_id,
    })))
}

async fn bootstrap_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let token = require_bearer_token(&headers)?;
    let result = state.auth_services.verify_token_and_session(&token).await;
    if !result.valid {
        return invalid_session_response(result.kicked);
    }

    let user_id = result.user_id.unwrap_or_default();
    let character = state.auth_services.check_character(user_id).await?;
    Ok(success(serde_json::json!({
        "userId": user_id,
        "hasCharacter": character.has_character,
    })))
}

fn normalize_required(value: Option<String>, message: &str) -> Result<String, BusinessError> {
    let value = value.unwrap_or_default().trim().to_string();
    if value.is_empty() {
        Err(BusinessError::new(message))
    } else {
        Ok(value)
    }
}

fn parse_captcha_payload(
    provider: CaptchaProvider,
    payload: &AuthPayload,
) -> Result<CaptchaVerifyPayload, BusinessError> {
    match provider {
        CaptchaProvider::Local => {
            let captcha_id = payload
                .captcha_id
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string();
            let captcha_code = payload
                .captcha_code
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string();
            if captcha_id.is_empty() || captcha_code.is_empty() {
                return Err(BusinessError::new("图片验证码不能为空"));
            }
            Ok(CaptchaVerifyPayload::Local {
                captcha_id,
                captcha_code,
            })
        }
        CaptchaProvider::Tencent => {
            let ticket = payload
                .ticket
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string();
            let randstr = payload
                .randstr
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string();
            if ticket.is_empty() || randstr.is_empty() {
                return Err(BusinessError::new("验证码票据不能为空"));
            }
            Ok(CaptchaVerifyPayload::Tencent { ticket, randstr })
        }
    }
}

fn resolve_request_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|value| value.to_str().ok())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn require_bearer_token(headers: &HeaderMap) -> Result<String, BusinessError> {
    read_bearer_token(headers).ok_or_else(|| {
        BusinessError::with_status("登录状态无效，请重新登录", StatusCode::UNAUTHORIZED)
    })
}
