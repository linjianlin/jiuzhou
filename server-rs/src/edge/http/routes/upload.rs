use std::{future::Future, pin::Pin};

use axum::extract::{DefaultBodyLimit, Multipart, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

const MAX_IMAGE_SIZE_BYTES: usize = 2 * 1024 * 1024;
const INVALID_IMAGE_TYPE_MESSAGE: &str = "只支持 JPG、PNG、GIF、WEBP 格式的图片";
const IMAGE_TOO_LARGE_MESSAGE: &str = "图片大小不能超过2MB";
const MISSING_AVATAR_URL_MESSAGE: &str = "缺少 avatarUrl";
const MISSING_IMAGE_FILE_MESSAGE: &str = "请选择图片文件";
const ASSET_UPLOAD_SUCCESS_MESSAGE: &str = "头像上传成功";
const AVATAR_UPDATE_SUCCESS_MESSAGE: &str = "头像更新成功";

/**
 * upload 最小路由簇。
 *
 * 作用：
 * 1. 做什么：实现当前前端真实会走到的 `avatar/sts`、`avatar`、`avatar/confirm` 与 `avatar-asset` 组上传端点。
 * 2. 做什么：把冻结的图片类型/大小/缺字段文案和 Node 兼容响应 shape 固定在这一层，并让 `avatar`/`avatar-asset` 共用同一套校验与 multipart 解析。
 * 3. 不做什么：不扩展头像删除、不接 COS，也不在这里补额外的角色资料广播逻辑。
 *
 * 输入 / 输出：
 * - 输入：Bearer token、STS JSON、multipart `avatar` 文件、confirm JSON。
 * - 输出：STS 走 `{ success:true, data }`，本地 upload/confirm 走 `{ success, message, avatarUrl? }`。
 *
 * 数据流 / 状态流：
 * - STS / upload / confirm 请求 -> 统一鉴权 -> 统一图片校验 -> application upload 服务 -> 协议响应。
 *
 * 复用设计说明：
 * - 图片格式/大小校验集中在单一 helper，避免 `avatar` 与 `avatar-asset` 的 STS / multipart / confirm 各维护一份冻结契约。
 * - upload 成功响应 DTO 与处理函数统一复用，后续若补正式头像写库，只需在应用服务扩展，不必再复制四组 handler。
 *
 * 关键边界条件与坑点：
 * 1. multipart 默认 body limit 会提前抛 413，必须在路由层放宽限制后自己返回固定 `图片大小不能超过2MB`。
 * 2. confirm 缺字段与地址非法是两类不同错误：前者必须保留 `缺少 avatarUrl`，后者必须保留 `头像地址不合法`。
 */
#[derive(Debug, Clone)]
pub struct UploadStoreRequest {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct UploadStsRequest {
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    #[serde(rename = "fileSize")]
    file_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct UploadConfirmRequest {
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct UploadStsResponseData {
    cos_enabled: bool,
    max_file_size_bytes: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct UploadActionResponse {
    success: bool,
    message: String,
    #[serde(rename = "avatarUrl", skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
}

pub trait UploadRouteServices: Send + Sync {
    fn store_avatar_asset<'a>(
        &'a self,
        request: UploadStoreRequest,
    ) -> Pin<Box<dyn Future<Output = Result<String, BusinessError>> + Send + 'a>>;

    fn confirm_avatar_asset<'a>(
        &'a self,
        avatar_url: String,
    ) -> Pin<Box<dyn Future<Output = Result<String, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopUploadRouteServices;

impl UploadRouteServices for NoopUploadRouteServices {
    fn store_avatar_asset<'a>(
        &'a self,
        _request: UploadStoreRequest,
    ) -> Pin<Box<dyn Future<Output = Result<String, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "上传失败",
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }

    fn confirm_avatar_asset<'a>(
        &'a self,
        _avatar_url: String,
    ) -> Pin<Box<dyn Future<Output = Result<String, BusinessError>> + Send + 'a>> {
        Box::pin(async move { Err(BusinessError::new("头像地址不合法")) })
    }
}

pub fn build_upload_router() -> Router<AppState> {
    Router::new()
        .route("/avatar/sts", post(create_avatar_sts_handler))
        .route("/avatar", post(upload_avatar_handler))
        .route("/avatar/confirm", post(confirm_avatar_handler))
        .route("/avatar-asset/sts", post(create_avatar_asset_sts_handler))
        .route("/avatar-asset", post(upload_avatar_asset_handler))
        .route("/avatar-asset/confirm", post(confirm_avatar_asset_handler))
        .layer(DefaultBodyLimit::max(MAX_IMAGE_SIZE_BYTES * 2))
}

async fn create_avatar_sts_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UploadStsRequest>,
) -> Result<Response, BusinessError> {
    create_upload_sts_response(&state, &headers, payload).await
}

async fn create_avatar_asset_sts_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UploadStsRequest>,
) -> Result<Response, BusinessError> {
    create_upload_sts_response(&state, &headers, payload).await
}

async fn upload_avatar_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Response, BusinessError> {
    upload_multipart_avatar(&state, &headers, multipart, AVATAR_UPDATE_SUCCESS_MESSAGE).await
}

async fn upload_avatar_asset_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Response, BusinessError> {
    upload_multipart_avatar(&state, &headers, multipart, ASSET_UPLOAD_SUCCESS_MESSAGE).await
}

async fn confirm_avatar_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UploadConfirmRequest>,
) -> Result<Response, BusinessError> {
    confirm_avatar_upload(&state, &headers, payload, AVATAR_UPDATE_SUCCESS_MESSAGE).await
}

async fn confirm_avatar_asset_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UploadConfirmRequest>,
) -> Result<Response, BusinessError> {
    confirm_avatar_upload(&state, &headers, payload, ASSET_UPLOAD_SUCCESS_MESSAGE).await
}

async fn create_upload_sts_response(
    state: &AppState,
    headers: &HeaderMap,
    payload: UploadStsRequest,
) -> Result<Response, BusinessError> {
    ensure_authenticated(state, headers).await?;
    let content_type = payload.content_type.unwrap_or_default();
    validate_image_contract(
        &content_type,
        payload.file_size.unwrap_or_default() as usize,
    )?;

    Ok(success(UploadStsResponseData {
        cos_enabled: false,
        max_file_size_bytes: MAX_IMAGE_SIZE_BYTES,
    }))
}

async fn upload_multipart_avatar(
    state: &AppState,
    headers: &HeaderMap,
    multipart: Multipart,
    success_message: &'static str,
) -> Result<Response, BusinessError> {
    ensure_authenticated(state, headers).await?;
    let upload_request = read_avatar_upload_request(multipart).await?;
    let avatar_url = state
        .upload_services
        .store_avatar_asset(upload_request)
        .await?;
    Ok(upload_action_response(
        true,
        success_message,
        Some(avatar_url),
    ))
}

async fn confirm_avatar_upload(
    state: &AppState,
    headers: &HeaderMap,
    payload: UploadConfirmRequest,
    success_message: &'static str,
) -> Result<Response, BusinessError> {
    ensure_authenticated(state, headers).await?;
    let avatar_url = payload.avatar_url.unwrap_or_default().trim().to_string();
    if avatar_url.is_empty() {
        return Err(BusinessError::new(MISSING_AVATAR_URL_MESSAGE));
    }

    let avatar_url = state
        .upload_services
        .confirm_avatar_asset(avatar_url)
        .await?;
    Ok(upload_action_response(
        true,
        success_message,
        Some(avatar_url),
    ))
}

async fn read_avatar_upload_request(
    mut multipart: Multipart,
) -> Result<UploadStoreRequest, BusinessError> {
    while let Some(field) = multipart.next_field().await.map_err(|_| {
        BusinessError::with_status("上传失败", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
    })? {
        if field.name() != Some("avatar") {
            continue;
        }

        let content_type = field.content_type().map(str::to_string).unwrap_or_default();
        let bytes = field
            .bytes()
            .await
            .map_err(|_| {
                BusinessError::with_status(
                    "上传失败",
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                )
            })?
            .to_vec();
        validate_image_contract(&content_type, bytes.len())?;
        return Ok(UploadStoreRequest {
            content_type,
            bytes,
        });
    }

    Err(BusinessError::new(MISSING_IMAGE_FILE_MESSAGE))
}

async fn ensure_authenticated(state: &AppState, headers: &HeaderMap) -> Result<(), BusinessError> {
    let Some(token) = crate::edge::http::auth::read_bearer_token(headers) else {
        return Err(unauthorized_business_error());
    };

    let result = state.auth_services.verify_token_and_session(&token).await;
    if !result.valid {
        return if result.kicked {
            Err(BusinessError::with_status(
                "账号已在其他设备登录",
                axum::http::StatusCode::UNAUTHORIZED,
            ))
        } else {
            Err(unauthorized_business_error())
        };
    }

    let _ = result
        .user_id
        .ok_or_else(|| unauthorized_business_error())?;
    Ok(())
}

fn validate_image_contract(content_type: &str, file_size: usize) -> Result<(), BusinessError> {
    if !matches!(
        content_type,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    ) {
        return Err(BusinessError::new(INVALID_IMAGE_TYPE_MESSAGE));
    }
    if file_size == 0 || file_size > MAX_IMAGE_SIZE_BYTES {
        return Err(BusinessError::new(IMAGE_TOO_LARGE_MESSAGE));
    }
    Ok(())
}

fn upload_action_response(
    success_flag: bool,
    message: &str,
    avatar_url: Option<String>,
) -> Response {
    Json(UploadActionResponse {
        success: success_flag,
        message: message.to_string(),
        avatar_url,
    })
    .into_response()
}

fn unauthorized_business_error() -> BusinessError {
    BusinessError::with_status(
        "登录状态无效，请重新登录",
        axum::http::StatusCode::UNAUTHORIZED,
    )
}
