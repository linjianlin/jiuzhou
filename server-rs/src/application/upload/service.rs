use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;

use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::upload::{UploadRouteServices, UploadStoreRequest};

static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/**
 * upload 最小本地应用服务。
 *
 * 作用：
 * 1. 做什么：为 `avatar-asset` 提供本地落盘与本地 URL 确认，保持当前客户端最小真实上传路径可用。
 * 2. 不做什么：不接 COS、不写角色资料、不扩展头像删除或其它媒体分类。
 *
 * 输入 / 输出：
 * - 输入：已在路由层完成 MIME/大小校验后的 `UploadStoreRequest`，以及待确认的 `avatarUrl`。
 * - 输出：本地公开 URL `/uploads/avatars/<file>`。
 *
 * 数据流 / 状态流：
 * - HTTP multipart -> 路由层做契约校验 -> 本服务写入本地目录 -> 返回公开 URL。
 * - HTTP confirm -> 路由层做必填校验 -> 本服务校验本地 URL 形状 -> 原样返回 URL。
 *
 * 复用设计说明：
 * - 本地落盘与 URL 规则集中在一个服务里，避免 `sts`、`upload`、`confirm` 各自复制文件名生成和路径拼装逻辑。
 * - 后续如果接 COS，只需要替换这里的存储/URL 规则，路由层冻结文案与响应 shape 可以继续复用。
 *
 * 关键边界条件与坑点：
 * 1. 这里只接受 `/uploads/avatars/<文件名>` 这一种本地 URL，避免 confirm 接口偷偷放过任意路径。
 * 2. 本地写盘失败必须上翻为固定 `上传失败`，不能把底层 IO 细节暴露给外部协议。
 */
#[derive(Debug, Clone)]
pub struct RustUploadService {
    local_storage_root: PathBuf,
}

impl RustUploadService {
    pub fn new() -> Self {
        Self {
            local_storage_root: std::env::temp_dir()
                .join("jiuzhou-server-rs")
                .join("uploads")
                .join("avatars"),
        }
    }

    pub fn with_local_storage_root(local_storage_root: PathBuf) -> Self {
        Self { local_storage_root }
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
}

impl Default for RustUploadService {
    fn default() -> Self {
        Self::new()
    }
}

impl UploadRouteServices for RustUploadService {
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
