use axum::Json;
use axum::extract::{Multipart, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::integrations::cos::{
    AvatarUploadStsPayload, cos_enabled, delete_avatar_object, extract_avatar_cos_key_from_url,
};
use crate::integrations::uploads::{
    accept_avatar_local_upload, is_valid_local_avatar_url, issue_avatar_sts_for_content,
};
use crate::realtime::public_socket::emit_game_character_to_user;
use crate::realtime::socket_protocol::{GameCharacterPayload, build_game_character_delta_payload};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

const LOCAL_AVATAR_UPLOAD_DISABLED_MESSAGE: &str = "COS 已启用，请使用预签名直传头像";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarUploadStsRequest {
    pub content_type: Option<String>,
    pub file_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarUploadConfirmRequest {
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarUploadStsData {
    pub cos_enabled: bool,
    pub max_file_size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expired_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<crate::integrations::cos::StsCredentials>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResultResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<UploadCharacterSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<GameCharacterPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadCharacterSnapshot {
    pub id: i64,
    pub avatar: Option<String>,
}

#[derive(Debug)]
struct UploadedAvatarPart {
    content_type: String,
    bytes: Vec<u8>,
}

pub async fn get_avatar_upload_sts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AvatarUploadStsRequest>,
) -> Result<Json<SuccessResponse<AvatarUploadStsData>>, AppError> {
    auth::require_auth(&state, &headers).await?;
    Ok(send_success(
        issue_avatar_upload_sts_response(&state, payload).await?,
    ))
}

pub async fn get_avatar_asset_upload_sts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AvatarUploadStsRequest>,
) -> Result<Json<SuccessResponse<AvatarUploadStsData>>, AppError> {
    auth::require_auth(&state, &headers).await?;
    Ok(send_success(
        issue_avatar_upload_sts_response(&state, payload).await?,
    ))
}

pub async fn confirm_avatar_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AvatarUploadConfirmRequest>,
) -> Result<Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let avatar_url = payload
        .avatar_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("缺少 avatarUrl"))?;
    let response = state
        .database
        .with_transaction(|| async { confirm_avatar_tx(&state, user.user_id, &avatar_url).await })
        .await?;
    emit_upload_character_realtime(&state, user.user_id, &response);
    Ok(send_upload_result(response))
}

pub async fn confirm_avatar_asset_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AvatarUploadConfirmRequest>,
) -> Result<Response, AppError> {
    auth::require_auth(&state, &headers).await?;
    let avatar_url = payload
        .avatar_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("缺少 avatarUrl"))?;
    Ok(send_upload_result(confirm_avatar_asset(
        &state,
        &avatar_url,
    )?))
}

pub async fn upload_avatar_local(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    ensure_local_avatar_upload_enabled(&state)?;
    let uploaded = read_avatar_part(multipart).await?;
    let avatar_url = accept_avatar_local_upload(
        &state.config.storage,
        &uploaded.content_type,
        &uploaded.bytes,
    )
    .await?;
    let response = state
        .database
        .with_transaction(|| async { update_avatar_tx(&state, user.user_id, &avatar_url).await })
        .await?;
    emit_upload_character_realtime(&state, user.user_id, &response);
    Ok(send_upload_result(response))
}

pub async fn upload_avatar_asset_local(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Response, AppError> {
    auth::require_auth(&state, &headers).await?;
    ensure_local_avatar_upload_enabled(&state)?;
    let uploaded = read_avatar_part(multipart).await?;
    let avatar_url = accept_avatar_local_upload(
        &state.config.storage,
        &uploaded.content_type,
        &uploaded.bytes,
    )
    .await?;
    Ok(send_upload_result(UploadResultResponse {
        success: true,
        message: "头像上传成功".to_string(),
        avatar_url: Some(avatar_url),
        character: None,
        debug_realtime: None,
    }))
}

pub async fn delete_avatar_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let response = state
        .database
        .with_transaction(|| async { delete_avatar_tx(&state, user.user_id).await })
        .await?;
    emit_upload_character_realtime(&state, user.user_id, &response);
    Ok(send_upload_result(response))
}

async fn issue_avatar_upload_sts_response(
    state: &AppState,
    payload: AvatarUploadStsRequest,
) -> Result<AvatarUploadStsData, AppError> {
    let content_type = payload
        .content_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("只支持 JPG、PNG、GIF、WEBP 格式的图片"))?;
    let file_size = payload.file_size.unwrap_or_default();
    let payload = issue_avatar_sts_for_content(
        &state.outbound_http,
        &state.config.cos,
        &content_type,
        file_size,
    )
    .await?;
    Ok(map_avatar_sts_payload(payload))
}

fn map_avatar_sts_payload(payload: AvatarUploadStsPayload) -> AvatarUploadStsData {
    AvatarUploadStsData {
        cos_enabled: payload.cos_enabled,
        max_file_size_bytes: payload.max_file_size_bytes,
        bucket: payload.bucket,
        region: payload.region,
        key: payload.key,
        avatar_url: payload.avatar_url,
        start_time: payload.start_time,
        expired_time: payload.expired_time,
        credentials: payload.credentials,
    }
}

fn ensure_local_avatar_upload_enabled(state: &AppState) -> Result<(), AppError> {
    if cos_enabled(&state.config.cos) {
        return Err(AppError::config(LOCAL_AVATAR_UPLOAD_DISABLED_MESSAGE));
    }
    Ok(())
}

async fn read_avatar_part(mut multipart: Multipart) -> Result<UploadedAvatarPart, AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| upload_internal_error("上传失败"))?
    {
        if field.name() != Some("avatar") {
            continue;
        }
        let content_type = field
            .content_type()
            .map(|value| value.to_string())
            .unwrap_or_default();
        let bytes = field
            .bytes()
            .await
            .map_err(|_| upload_internal_error("上传失败"))?
            .to_vec();
        return Ok(UploadedAvatarPart {
            content_type,
            bytes,
        });
    }

    Err(AppError::config("请选择图片文件"))
}

async fn confirm_avatar_tx(
    state: &AppState,
    user_id: i64,
    avatar_url: &str,
) -> Result<UploadResultResponse, AppError> {
    if !is_valid_cos_avatar_url(state, avatar_url) {
        return Ok(UploadResultResponse {
            success: false,
            message: "头像地址不合法".to_string(),
            avatar_url: None,
            character: None,
            debug_realtime: None,
        });
    }

    let old_avatar = get_current_avatar(state, user_id).await?;
    state
        .database
        .execute(
            "UPDATE characters SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
            |q| q.bind(avatar_url).bind(user_id),
        )
        .await?;
    queue_old_avatar_cleanup(state, old_avatar, Some(avatar_url.to_string())).await?;
    let character = load_upload_character_snapshot(state, user_id).await?;

    Ok(UploadResultResponse {
        success: true,
        message: "头像更新成功".to_string(),
        avatar_url: Some(avatar_url.to_string()),
        debug_realtime: character.as_ref().map(|snapshot| {
            build_game_character_delta_payload(snapshot.id, snapshot.avatar.as_deref())
        }),
        character,
    })
}

fn confirm_avatar_asset(
    state: &AppState,
    avatar_url: &str,
) -> Result<UploadResultResponse, AppError> {
    if !is_valid_managed_avatar_url(state, avatar_url) {
        return Ok(UploadResultResponse {
            success: false,
            message: "头像地址不合法".to_string(),
            avatar_url: None,
            character: None,
            debug_realtime: None,
        });
    }

    Ok(UploadResultResponse {
        success: true,
        message: "头像上传成功".to_string(),
        avatar_url: Some(avatar_url.to_string()),
        debug_realtime: None,
        character: None,
    })
}

async fn update_avatar_tx(
    state: &AppState,
    user_id: i64,
    avatar_url: &str,
) -> Result<UploadResultResponse, AppError> {
    let old_avatar = get_current_avatar(state, user_id).await?;
    state
        .database
        .execute(
            "UPDATE characters SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
            |q| q.bind(avatar_url).bind(user_id),
        )
        .await?;
    queue_old_avatar_cleanup(state, old_avatar, Some(avatar_url.to_string())).await?;
    let character = load_upload_character_snapshot(state, user_id).await?;

    Ok(UploadResultResponse {
        success: true,
        message: "头像更新成功".to_string(),
        avatar_url: Some(avatar_url.to_string()),
        debug_realtime: character.as_ref().map(|snapshot| {
            build_game_character_delta_payload(snapshot.id, snapshot.avatar.as_deref())
        }),
        character,
    })
}

async fn delete_avatar_tx(
    state: &AppState,
    user_id: i64,
) -> Result<UploadResultResponse, AppError> {
    let old_avatar = get_current_avatar(state, user_id).await?;
    state.database.execute(
        "UPDATE characters SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1",
        |q| q.bind(user_id),
    ).await?;
    queue_old_avatar_cleanup(state, old_avatar, None).await?;
    let character = load_upload_character_snapshot(state, user_id).await?;

    Ok(UploadResultResponse {
        success: true,
        message: "头像删除成功".to_string(),
        avatar_url: None,
        debug_realtime: character.as_ref().map(|snapshot| {
            build_game_character_delta_payload(snapshot.id, snapshot.avatar.as_deref())
        }),
        character,
    })
}

async fn load_upload_character_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<Option<UploadCharacterSnapshot>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT id, avatar FROM characters WHERE user_id = $1 LIMIT 1",
            |q| q.bind(user_id),
        )
        .await?;
    row.map(|row| {
        Ok(UploadCharacterSnapshot {
            id: i64::from(row.try_get::<i32, _>("id")?),
            avatar: row.try_get::<Option<String>, _>("avatar")?,
        })
    })
    .transpose()
}

async fn get_current_avatar(state: &AppState, user_id: i64) -> Result<Option<String>, AppError> {
    let row = state
        .database
        .fetch_optional("SELECT avatar FROM characters WHERE user_id = $1", |q| {
            q.bind(user_id)
        })
        .await?;
    Ok(row
        .and_then(|row| row.try_get::<Option<String>, _>("avatar").ok())
        .flatten())
}

async fn queue_old_avatar_cleanup(
    state: &AppState,
    previous_avatar: Option<String>,
    next_avatar: Option<String>,
) -> Result<(), AppError> {
    let outbound_http = state.outbound_http.clone();
    let storage = state.config.storage.clone();
    let cos = state.config.cos.clone();
    state
        .database
        .after_transaction_commit(async move {
            delete_managed_avatar_if_replaced(
                &outbound_http,
                &storage.uploads_dir,
                &cos,
                previous_avatar.as_deref(),
                next_avatar.as_deref(),
            )
            .await
        })
        .await
}

async fn delete_managed_avatar_if_replaced(
    client: &reqwest::Client,
    uploads_dir: &std::path::Path,
    cos: &crate::config::CosConfig,
    previous_avatar: Option<&str>,
    next_avatar: Option<&str>,
) -> Result<(), AppError> {
    let normalized_previous = normalize_managed_avatar_value(previous_avatar);
    let normalized_next = normalize_managed_avatar_value(next_avatar);
    if normalized_previous.is_none() || normalized_previous == normalized_next {
        return Ok(());
    }
    let Some(previous_avatar) = normalized_previous else {
        return Ok(());
    };
    if let Some(key) = extract_avatar_cos_key_from_url(cos, &previous_avatar) {
        if let Err(error) = delete_avatar_object(client, cos, &key).await {
            tracing::warn!(avatar = %previous_avatar, key = %key, error = %error, "failed to delete old COS avatar object");
        }
        return Ok(());
    }
    if !is_valid_local_avatar_url(&previous_avatar) {
        return Ok(());
    }
    let relative_path = previous_avatar.trim_start_matches("/uploads/");
    let path = uploads_dir.join(relative_path);
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn normalize_managed_avatar_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_valid_managed_avatar_url(state: &AppState, avatar_url: &str) -> bool {
    is_valid_local_avatar_url(avatar_url) || is_valid_cos_avatar_url(state, avatar_url)
}

fn is_valid_cos_avatar_url(state: &AppState, avatar_url: &str) -> bool {
    if !avatar_url.starts_with("https://") {
        return false;
    }
    let Ok(parsed) = reqwest::Url::parse(avatar_url) else {
        return false;
    };
    let default_host = format!(
        "{}.cos.{}.myqcloud.com",
        state.config.cos.bucket, state.config.cos.region
    );
    let allowed_hosts = if state.config.cos.domain.trim().is_empty() {
        vec![default_host]
    } else {
        vec![default_host, state.config.cos.domain.trim().to_string()]
    };
    if !allowed_hosts
        .iter()
        .any(|host| host == parsed.host_str().unwrap_or_default())
    {
        return false;
    }
    parsed
        .path()
        .trim_start_matches('/')
        .starts_with(state.config.cos.avatar_prefix.trim())
}

fn emit_upload_character_realtime(state: &AppState, user_id: i64, result: &UploadResultResponse) {
    if !result.success {
        return;
    }
    let Some(payload) = result.debug_realtime.as_ref() else {
        return;
    };
    emit_game_character_to_user(state, user_id, payload);
}

fn send_upload_result(result: UploadResultResponse) -> Response {
    let status = if result.success {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };
    (status, Json(result)).into_response()
}

fn upload_internal_error(message: &str) -> AppError {
    AppError::Business {
        message: message.to_string(),
        status: StatusCode::INTERNAL_SERVER_ERROR,
        extra: serde_json::Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AvatarUploadStsData, LOCAL_AVATAR_UPLOAD_DISABLED_MESSAGE, UploadCharacterSnapshot,
        UploadResultResponse, normalize_managed_avatar_value,
    };
    use crate::realtime::socket_protocol::build_game_character_delta_payload;

    #[test]
    fn avatar_upload_sts_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": AvatarUploadStsData {
                cos_enabled: false,
                max_file_size_bytes: crate::integrations::uploads::AVATAR_UPLOAD_MAX_FILE_SIZE_BYTES,
                bucket: None,
                region: None,
                key: None,
                avatar_url: None,
                start_time: None,
                expired_time: None,
                credentials: None,
            }
        });
        assert_eq!(payload["data"]["cosEnabled"], false);
        println!("UPLOAD_STS_RESPONSE={}", payload);
    }

    #[test]
    fn avatar_confirm_response_matches_contract() {
        let payload = serde_json::to_value(UploadResultResponse {
            success: true,
            message: "头像更新成功".to_string(),
            avatar_url: Some("/uploads/avatars/avatar-1.png".to_string()),
            character: Some(UploadCharacterSnapshot {
                id: 1,
                avatar: Some("/uploads/avatars/avatar-1.png".to_string()),
            }),
            debug_realtime: Some(build_game_character_delta_payload(
                1,
                Some("/uploads/avatars/avatar-1.png"),
            )),
        })
        .expect("payload should serialize");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["avatarUrl"], "/uploads/avatars/avatar-1.png");
        assert_eq!(payload["character"]["id"], 1);
        assert_eq!(payload["debugRealtime"]["kind"], "game:character");
        println!("UPLOAD_CONFIRM_RESPONSE={}", payload);
    }

    #[test]
    fn avatar_delete_response_matches_contract() {
        let payload = serde_json::to_value(UploadResultResponse {
            success: true,
            message: "头像删除成功".to_string(),
            avatar_url: None,
            character: Some(UploadCharacterSnapshot {
                id: 1,
                avatar: None,
            }),
            debug_realtime: Some(build_game_character_delta_payload(1, None)),
        })
        .expect("payload should serialize");
        assert_eq!(payload["message"], "头像删除成功");
        assert_eq!(payload["character"]["avatar"], serde_json::Value::Null);
        assert_eq!(payload["debugRealtime"]["delta"]["id"], 1);
        println!("UPLOAD_DELETE_RESPONSE={}", payload);
    }

    #[test]
    fn local_avatar_upload_disabled_message_matches_contract() {
        assert_eq!(
            LOCAL_AVATAR_UPLOAD_DISABLED_MESSAGE,
            "COS 已启用，请使用预签名直传头像"
        );
    }

    #[test]
    fn normalize_managed_avatar_value_trims_empty_values() {
        assert_eq!(
            normalize_managed_avatar_value(Some("  /uploads/avatars/a.png  ")),
            Some("/uploads/avatars/a.png".to_string())
        );
        assert_eq!(normalize_managed_avatar_value(Some("   ")), None);
    }
}
