use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};

pub use crate::application::account::service::PhoneBindingStatusDto;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{require_authenticated_user_id, resolve_request_ip};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

/**
 * account 账号级只读路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node 当前账号页已公开的 `/current-ip`、`/phone-binding/send-code|bind|status`、`/password/change` 协议层。
 * 2. 做什么：复用现有 Bearer + session 鉴权链，把手机号绑定状态、发码、绑卡和改密都收口到统一服务接口，避免路由层散落同类校验。
 * 3. 不做什么：不直接实现短信发送、外部验证码验证或密码哈希写库，这些仍由下层服务负责。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；手机号发码/绑定与改密额外读取 JSON body。
 * - 输出：读取接口继续返回 `success(data)`；改密返回 `sendResult` 形状；字段名与 Node 当前协议保持一致。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> 统一 session 校验 -> 路由层做参数归一化 -> `AuthRouteServices` 账号相关能力 -> Node 兼容响应 envelope。
 *
 * 复用设计说明：
 * - 认证结果与手机号绑定状态后续会被首页聚合、坊市守卫等能力复用；这里先固定账号级只读协议，后续其它模块直接复用同一服务即可，不必再复制 `user_id -> phone_number` 查询。
 * - 请求 IP 解析复用共享 helper，避免 auth/account/审计链路各自长一套 `x-forwarded-for` 取值规则。
 *
 * 关键边界条件与坑点：
 * 1. 发码接口在 local captcha 模式下必须继续复用 `图片验证码不能为空` 这组固定文案，不能偷偷改成通用参数错误。
 * 2. 改密接口的前置校验顺序要和 Node 一致：先判空，再判“新旧密码相同”，再判密码长度策略。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct CurrentIpPayload {
    ip: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhoneBindingSendCodePayload {
    phone_number: Option<String>,
    captcha_id: Option<String>,
    captcha_code: Option<String>,
    ticket: Option<String>,
    randstr: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindPhoneNumberPayload {
    phone_number: Option<String>,
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordPayload {
    current_password: Option<String>,
    new_password: Option<String>,
}

pub fn build_account_router() -> Router<AppState> {
    Router::new()
        .route("/current-ip", get(current_ip_handler))
        .route(
            "/phone-binding/send-code",
            post(phone_binding_send_code_handler),
        )
        .route("/phone-binding/bind", post(bind_phone_number_handler))
        .route("/phone-binding/status", get(phone_binding_status_handler))
        .route("/password/change", post(change_password_handler))
}

async fn current_ip_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(success(CurrentIpPayload {
        ip: resolve_request_ip(&headers),
    }))
}

async fn phone_binding_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let status = state
        .auth_services
        .get_phone_binding_status(user_id)
        .await?;
    Ok(success(status))
}

async fn phone_binding_send_code_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PhoneBindingSendCodePayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let phone_number = payload
        .phone_number
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if phone_number.is_empty() {
        return Err(BusinessError::new("手机号不能为空"));
    }

    let captcha = parse_captcha_verify_payload(state.auth_services.captcha_provider(), &payload)?;
    let result = state
        .auth_services
        .send_phone_binding_code(user_id, phone_number, resolve_request_ip(&headers), captcha)
        .await?;
    Ok(success(result))
}

async fn bind_phone_number_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BindPhoneNumberPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let phone_number = payload.phone_number.unwrap_or_default().trim().to_string();
    if phone_number.is_empty() {
        return Err(BusinessError::new("手机号不能为空"));
    }

    let code = payload.code.unwrap_or_default().trim().to_string();
    if code.is_empty() {
        return Err(BusinessError::new("验证码不能为空"));
    }

    let result = state
        .auth_services
        .bind_phone_number(user_id, phone_number, code)
        .await?;
    Ok(success(result))
}

async fn change_password_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ChangePasswordPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let current_password = payload.current_password.unwrap_or_default();
    let new_password = payload.new_password.unwrap_or_default();

    if current_password.is_empty() || new_password.is_empty() {
        return Err(BusinessError::new("当前密码和新密码不能为空"));
    }
    if current_password == new_password {
        return Err(BusinessError::new("新密码不能与当前密码相同"));
    }
    if let Some(message) = get_password_policy_error(&new_password) {
        return Err(BusinessError::new(message));
    }

    let result = state
        .auth_services
        .change_password(
            user_id,
            current_password,
            new_password,
            resolve_request_ip(&headers),
        )
        .await?;
    Ok(service_result(
        ServiceResultResponse::<serde_json::Value>::new(result.success, Some(result.message), None),
    ))
}

fn parse_captcha_verify_payload(
    provider: crate::edge::http::routes::auth::CaptchaProvider,
    payload: &PhoneBindingSendCodePayload,
) -> Result<crate::edge::http::routes::auth::CaptchaVerifyPayload, BusinessError> {
    match provider {
        crate::edge::http::routes::auth::CaptchaProvider::Local => {
            let captcha_id = payload.captcha_id.clone().unwrap_or_default();
            let captcha_code = payload.captcha_code.clone().unwrap_or_default();
            if captcha_id.trim().is_empty() || captcha_code.trim().is_empty() {
                return Err(BusinessError::new("图片验证码不能为空"));
            }
            Ok(
                crate::edge::http::routes::auth::CaptchaVerifyPayload::Local {
                    captcha_id,
                    captcha_code,
                },
            )
        }
        crate::edge::http::routes::auth::CaptchaProvider::Tencent => {
            let ticket = payload.ticket.clone().unwrap_or_default();
            let randstr = payload.randstr.clone().unwrap_or_default();
            if ticket.trim().is_empty() || randstr.trim().is_empty() {
                return Err(BusinessError::new("验证码票据不能为空"));
            }
            Ok(crate::edge::http::routes::auth::CaptchaVerifyPayload::Tencent { ticket, randstr })
        }
    }
}

fn get_password_policy_error(password: &str) -> Option<&'static str> {
    if password.chars().count() < 6 {
        Some("密码长度至少6位")
    } else {
        None
    }
}
