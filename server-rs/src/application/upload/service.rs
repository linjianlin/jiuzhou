use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use sqlx::Row;

use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::upload::{UploadRouteServices, UploadStoreRequest};

static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/**
 * upload 本地应用服务。
 *
 * 作用：
 * 1. 做什么：为 `avatar` / `avatar-asset` 提供本地落盘、本地 URL 确认、角色头像写库与删除能力，对齐 Node 当前头像链路。
 * 2. 不做什么：不接 COS、不扩展其它媒体分类，也不在这里触发 socket 推送。
 *
 * 输入 / 输出：
 * - 输入：已在路由层完成 MIME/大小校验后的 `UploadStoreRequest`、待确认的 `avatarUrl`、`userId`。
 * - 输出：本地公开 URL `/uploads/avatars/<file>`，以及角色头像更新/删除结果。
 *
 * 数据流 / 状态流：
 * - HTTP multipart -> 路由层做契约校验 -> 本服务写入本地目录 -> 角色头像接口继续写入 `characters.avatar`。
 * - HTTP confirm -> 路由层做必填校验 -> 本服务校验本地 URL 形状 -> 角色头像接口继续写入 `characters.avatar`。
 * - HTTP delete -> 本服务读取旧头像 -> 删除托管文件 -> 清空 `characters.avatar`。
 *
 * 复用设计说明：
 * - 本地落盘、旧头像清理、URL 规则与角色头像写库集中在一个服务里，避免 `upload`、`confirm`、`delete` 各自复制文件路径和 SQL。
 * - `avatar` 与 `avatar-asset` 共用同一份文件落盘规则；是否写角色资料由单独方法控制，避免资产上传链路误写角色表。
 *
 * 关键边界条件与坑点：
 * 1. 这里只接受 `/uploads/avatars/<文件名>` 这一种本地 URL，避免 confirm 接口偷偷放过任意路径。
 * 2. 本地写盘或删旧文件失败必须上翻为固定 `上传失败`，不能把底层 IO 细节暴露给外部协议。
 * 3. 角色头像写库沿用 Node 当前语义：即使账号暂时没有角色记录，也不额外报错或伪造其它业务失败。
 */
#[derive(Debug, Clone)]
pub struct RustUploadService {
    character_pool: Option<sqlx::PgPool>,
    local_storage_root: PathBuf,
}

impl RustUploadService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self {
            character_pool: Some(pool),
            local_storage_root: default_storage_root(),
        }
    }

    pub fn with_local_storage_root(local_storage_root: PathBuf) -> Self {
        Self {
            character_pool: None,
            local_storage_root,
        }
    }

    pub fn with_local_storage_root_and_pool(
        local_storage_root: PathBuf,
        pool: sqlx::PgPool,
    ) -> Self {
        Self {
            character_pool: Some(pool),
            local_storage_root,
        }
    }

    fn ensure_storage_root(&self) -> Result<(), BusinessError> {
        std::fs::create_dir_all(&self.local_storage_root).map_err(|_| upload_failed_error())
    }

    fn next_file_name(&self, content_type: &str) -> String {
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        format!(
            "avatar-{timestamp_ms}-{sequence}.{}",
            extension_from_content_type(content_type)
        )
    }

    fn public_url(file_name: &str) -> String {
        format!("/uploads/avatars/{file_name}")
    }

    fn is_valid_local_avatar_url(avatar_url: &str) -> bool {
        let Some(file_name) = avatar_url.strip_prefix("/uploads/avatars/") else {
            return false;
        };
        if file_name.is_empty() || file_name.contains('/') {
            return false;
        }

        file_name
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '-'))
    }

    fn file_path(&self, file_name: &str) -> PathBuf {
        Path::new(&self.local_storage_root).join(file_name)
    }

    async fn assign_character_avatar_internal(
        &self,
        user_id: i64,
        avatar_url: &str,
    ) -> Result<String, BusinessError> {
        if !Self::is_valid_local_avatar_url(avatar_url) {
            return Err(BusinessError::new("头像地址不合法"));
        }
        let Some(pool) = &self.character_pool else {
            return Ok(avatar_url.to_string());
        };

        let previous_avatar =
            sqlx::query("SELECT avatar FROM characters WHERE user_id = $1 LIMIT 1")
                .bind(user_id)
                .fetch_optional(pool)
                .await
                .map_err(|_| upload_failed_error())?
                .and_then(|row| row.try_get::<Option<String>, _>("avatar").ok().flatten());

        sqlx::query(
            "UPDATE characters SET avatar = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
        )
        .bind(avatar_url)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|_| upload_failed_error())?;

        self.delete_managed_avatar_if_replaced(previous_avatar.as_deref(), Some(avatar_url))?;
        Ok(avatar_url.to_string())
    }

    async fn delete_character_avatar_internal(&self, user_id: i64) -> Result<(), BusinessError> {
        let Some(pool) = &self.character_pool else {
            return Ok(());
        };

        let current_avatar =
            sqlx::query("SELECT avatar FROM characters WHERE user_id = $1 LIMIT 1")
                .bind(user_id)
                .fetch_optional(pool)
                .await
                .map_err(|_| upload_failed_error())?
                .and_then(|row| row.try_get::<Option<String>, _>("avatar").ok().flatten());

        if let Some(avatar) = current_avatar.as_deref() {
            self.delete_managed_avatar(avatar)?;
        }

        sqlx::query(
            "UPDATE characters SET avatar = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1",
        )
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|_| upload_failed_error())?;

        Ok(())
    }

    fn delete_managed_avatar_if_replaced(
        &self,
        previous_avatar: Option<&str>,
        next_avatar: Option<&str>,
    ) -> Result<(), BusinessError> {
        let Some(previous_avatar) = normalize_managed_avatar_value(previous_avatar) else {
            return Ok(());
        };
        let normalized_next = normalize_managed_avatar_value(next_avatar);
        if normalized_next.as_deref() == Some(previous_avatar.as_str()) {
            return Ok(());
        }

        self.delete_managed_avatar(&previous_avatar)
    }

    fn delete_managed_avatar(&self, avatar_url: &str) -> Result<(), BusinessError> {
        if !Self::is_valid_local_avatar_url(avatar_url) {
            return Ok(());
        }

        let Some(file_name) = avatar_url.strip_prefix("/uploads/avatars/") else {
            return Ok(());
        };
        let file_path = self.file_path(file_name);
        match std::fs::remove_file(file_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(upload_failed_error()),
        }
    }
}

impl Default for RustUploadService {
    fn default() -> Self {
        Self::with_local_storage_root(default_storage_root())
    }
}

impl UploadRouteServices for RustUploadService {
    fn avatar_storage_root(&self) -> PathBuf {
        self.local_storage_root.clone()
    }

    fn store_avatar_asset<'a>(
        &'a self,
        request: UploadStoreRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.ensure_storage_root()?;
            let file_name = self.next_file_name(&request.content_type);
            let file_path = self.file_path(&file_name);
            std::fs::write(file_path, request.bytes).map_err(|_| upload_failed_error())?;
            Ok(Self::public_url(&file_name))
        })
    }

    fn confirm_avatar_asset<'a>(
        &'a self,
        avatar_url: String,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            if !Self::is_valid_local_avatar_url(&avatar_url) {
                return Err(BusinessError::new("头像地址不合法"));
            }
            Ok(avatar_url)
        })
    }

    fn assign_character_avatar<'a>(
        &'a self,
        user_id: i64,
        avatar_url: String,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.assign_character_avatar_internal(user_id, &avatar_url)
                .await
        })
    }

    fn delete_character_avatar<'a>(
        &'a self,
        user_id: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.delete_character_avatar_internal(user_id).await })
    }
}

fn default_storage_root() -> PathBuf {
    std::env::temp_dir()
        .join("jiuzhou-server-rs")
        .join("uploads")
        .join("avatars")
}

fn normalize_managed_avatar_value(value: Option<&str>) -> Option<String> {
    let normalized = value.unwrap_or_default().trim();
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.to_string())
}

fn extension_from_content_type(content_type: &str) -> &'static str {
    match content_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

fn upload_failed_error() -> BusinessError {
    BusinessError::with_status("上传失败", StatusCode::INTERNAL_SERVER_ERROR)
}
