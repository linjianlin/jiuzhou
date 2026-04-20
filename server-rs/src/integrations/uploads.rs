use std::path::PathBuf;

use tokio::fs;

use crate::config::{CosConfig, StorageConfig};
use crate::integrations::cos::{AvatarUploadStsPayload, issue_avatar_upload_sts};
use crate::shared::error::AppError;

pub const AVATAR_UPLOAD_MAX_FILE_SIZE_BYTES: u64 = 2 * 1024 * 1024;
pub const ALLOWED_AVATAR_MIME_TYPES: [&str; 4] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
];

pub fn is_allowed_avatar_mime_type(content_type: &str) -> bool {
    ALLOWED_AVATAR_MIME_TYPES.contains(&content_type)
}

pub fn is_avatar_file_size_allowed(file_size: u64) -> bool {
    file_size > 0 && file_size <= AVATAR_UPLOAD_MAX_FILE_SIZE_BYTES
}

pub fn get_avatar_file_extension(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/jpeg" => Some(".jpg"),
        "image/png" => Some(".png"),
        "image/gif" => Some(".gif"),
        "image/webp" => Some(".webp"),
        _ => None,
    }
}

pub fn generate_avatar_filename(extension: &str) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("avatar-{timestamp}{extension}")
}

pub fn get_local_uploaded_avatar_url(filename: &str) -> String {
    format!("/uploads/avatars/{filename}")
}

pub fn is_valid_local_avatar_url(avatar_url: &str) -> bool {
    let bytes = avatar_url.as_bytes();
    avatar_url.starts_with("/uploads/avatars/")
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'/' | b'.' | b'_' | b'-'))
}

pub async fn accept_avatar_local_upload(
    storage: &StorageConfig,
    content_type: &str,
    bytes: &[u8],
) -> Result<String, AppError> {
    if !is_allowed_avatar_mime_type(content_type) {
        return Err(AppError::config("只支持 JPG、PNG、GIF、WEBP 格式的图片"));
    }
    if !is_avatar_file_size_allowed(bytes.len() as u64) {
        return Err(AppError::config("图片大小不能超过2MB"));
    }

    let extension = get_avatar_file_extension(content_type)
        .ok_or_else(|| AppError::config("不支持的头像图片格式"))?;
    let filename = generate_avatar_filename(extension);
    let avatar_dir: PathBuf = storage.uploads_dir.join("avatars");
    fs::create_dir_all(&avatar_dir).await?;
    fs::write(avatar_dir.join(&filename), bytes).await?;
    Ok(get_local_uploaded_avatar_url(&filename))
}

pub async fn issue_avatar_sts_for_content(
    client: &reqwest::Client,
    cos: &CosConfig,
    content_type: &str,
    file_size: u64,
) -> Result<AvatarUploadStsPayload, AppError> {
    if !is_allowed_avatar_mime_type(content_type) {
        return Err(AppError::config("只支持 JPG、PNG、GIF、WEBP 格式的图片"));
    }
    if !is_avatar_file_size_allowed(file_size) {
        return Err(AppError::config("图片大小不能超过2MB"));
    }

    issue_avatar_upload_sts(client, cos, content_type, AVATAR_UPLOAD_MAX_FILE_SIZE_BYTES).await
}

#[cfg(test)]
mod tests {
    use crate::config::{CosConfig, StorageConfig};

    #[tokio::test]
    async fn local_upload_writes_avatar_file_and_returns_public_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "server-rs-upload-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let storage = StorageConfig {
            uploads_dir: temp_dir.clone(),
        };

        let avatar_url = super::accept_avatar_local_upload(&storage, "image/png", b"fake-image")
            .await
            .expect("upload should succeed");

        assert!(avatar_url.starts_with("/uploads/avatars/avatar-"));
        let filename = avatar_url
            .strip_prefix("/uploads/avatars/")
            .expect("avatar path prefix should exist");
        assert!(temp_dir.join("avatars").join(filename).exists());
    }

    #[test]
    fn sts_payload_falls_back_to_local_when_cos_is_disabled() {
        let cos = CosConfig {
            secret_id: String::new(),
            secret_key: String::new(),
            bucket: String::new(),
            region: String::new(),
            avatar_prefix: "avatars/".to_string(),
            generated_image_prefix: "generated/".to_string(),
            domain: String::new(),
            sts_duration_seconds: 600,
        };

        let client = reqwest::Client::new();
        let payload = tokio::runtime::Runtime::new()
            .expect("runtime should build")
            .block_on(super::issue_avatar_sts_for_content(&client, &cos, "image/png", 1024))
            .expect("sts fallback should succeed");
        assert!(!payload.cos_enabled);
        assert_eq!(payload.max_file_size_bytes, super::AVATAR_UPLOAD_MAX_FILE_SIZE_BYTES);
    }
}
