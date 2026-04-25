use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use tokio::fs;

use crate::config::StorageConfig;
use crate::integrations::image_model_client::ImageModelCallResult;
use crate::shared::error::AppError;
use crate::state::AppState;

const GENERATED_UPLOAD_DIR: &str = "generated";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedGeneratedImage {
    pub bytes: Vec<u8>,
    pub extension: &'static str,
    pub content_type: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadedGeneratedImage {
    pub bytes: Vec<u8>,
    pub extension: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeneratedImageStorageSource {
    Base64(String),
    Url(String),
}

pub fn image_extension_from_content_type(content_type: &str) -> Option<&'static str> {
    match content_type.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn content_type_from_extension(extension: &str) -> Option<&'static str> {
    match extension.trim().trim_start_matches('.') {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn split_data_url(raw: &str) -> Option<(&str, &str)> {
    let (prefix, payload) = raw.trim().split_once(',')?;
    let prefix_lower = prefix.to_ascii_lowercase();
    if !prefix_lower.starts_with("data:image/") || !prefix_lower.ends_with(";base64") {
        return None;
    }
    Some((prefix, payload))
}

pub fn decode_base64_image(raw: &str) -> Result<DecodedGeneratedImage, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::config("图片 base64 数据为空"));
    }

    let (content_type, payload) = if let Some((prefix, payload)) = split_data_url(trimmed) {
        let content_type = prefix
            .trim_start_matches("data:")
            .trim_end_matches(";base64")
            .trim();
        let extension = image_extension_from_content_type(content_type)
            .ok_or_else(|| AppError::config("不支持的生成图片 MIME 类型"))?;
        (
            content_type_from_extension(extension)
                .ok_or_else(|| AppError::config("不支持的生成图片 MIME 类型"))?,
            payload.trim(),
        )
    } else {
        return Err(AppError::config(
            "生成图片 base64 必须包含 data:image/*;base64 前缀",
        ));
    };

    let bytes = STANDARD
        .decode(payload)
        .map_err(|error| AppError::config(format!("生成图片 base64 解码失败: {error}")))?;
    if bytes.is_empty() {
        return Err(AppError::config("生成图片数据为空"));
    }
    let extension = image_extension_from_content_type(content_type)
        .ok_or_else(|| AppError::config("不支持的生成图片 MIME 类型"))?;

    Ok(DecodedGeneratedImage {
        bytes,
        extension,
        content_type,
    })
}

fn generated_image_filename(extension: &str) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!(
        "generated-{timestamp}.{}",
        extension.trim().trim_start_matches('.')
    )
}

fn generated_image_public_url(filename: &str) -> String {
    format!("/uploads/{GENERATED_UPLOAD_DIR}/{filename}")
}

pub async fn persist_generated_image_bytes(
    storage: &StorageConfig,
    bytes: &[u8],
    extension: &str,
) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::config("生成图片数据为空"));
    }
    let normalized_extension = extension.trim().trim_start_matches('.');
    let _content_type = content_type_from_extension(normalized_extension)
        .ok_or_else(|| AppError::config("不支持的生成图片格式"))?;
    let filename = generated_image_filename(normalized_extension);
    let generated_dir: PathBuf = storage.uploads_dir.join(GENERATED_UPLOAD_DIR);
    fs::create_dir_all(&generated_dir).await?;
    fs::write(generated_dir.join(&filename), bytes).await?;
    Ok(generated_image_public_url(&filename))
}

pub async fn download_generated_image(
    client: &reqwest::Client,
    url: &str,
) -> Result<DownloadedGeneratedImage, AppError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AppError::config("生成图片 URL 为空"));
    }
    let response = client.get(trimmed).send().await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_string();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "下载生成图片失败：HTTP {} {}",
            status.as_u16(),
            String::from_utf8_lossy(&bytes)
        )));
    }
    if bytes.is_empty() {
        return Err(AppError::config("下载生成图片失败：返回空图片"));
    }
    let extension = image_extension_from_content_type(&content_type)
        .ok_or_else(|| AppError::config("下载生成图片响应 MIME 类型不支持"))?;
    Ok(DownloadedGeneratedImage {
        bytes: bytes.to_vec(),
        extension,
    })
}

pub async fn persist_generated_image_source(
    state: &AppState,
    source: GeneratedImageStorageSource,
) -> Result<String, AppError> {
    match source {
        GeneratedImageStorageSource::Base64(raw) => {
            let decoded = decode_base64_image(&raw)?;
            persist_generated_image_bytes(&state.config.storage, &decoded.bytes, decoded.extension)
                .await
        }
        GeneratedImageStorageSource::Url(url) => {
            let downloaded = download_generated_image(&state.outbound_http, &url).await?;
            persist_generated_image_bytes(
                &state.config.storage,
                &downloaded.bytes,
                downloaded.extension,
            )
            .await
        }
    }
}

pub async fn persist_generated_image_result(
    state: &AppState,
    result: &ImageModelCallResult,
) -> Result<String, AppError> {
    if !result.b64.trim().is_empty() {
        return persist_generated_image_source(
            state,
            GeneratedImageStorageSource::Base64(result.b64.clone()),
        )
        .await;
    }
    if !result.url.trim().is_empty() {
        return persist_generated_image_source(
            state,
            GeneratedImageStorageSource::Url(result.url.clone()),
        )
        .await;
    }
    Err(AppError::config("图像模型未返回可用图片数据"))
}

#[cfg(test)]
mod tests {
    use super::{decode_base64_image, image_extension_from_content_type};

    #[test]
    fn generated_image_storage_detects_data_url_extension() {
        let decoded =
            decode_base64_image("data:image/png;base64,aGVsbG8=").expect("png should decode");

        assert_eq!(decoded.bytes, b"hello");
        assert_eq!(decoded.extension, "png");
        assert_eq!(decoded.content_type, "image/png");
    }

    #[test]
    fn generated_image_storage_detects_webp_mime_extension() {
        assert_eq!(
            image_extension_from_content_type("image/webp"),
            Some("webp")
        );
        assert_eq!(image_extension_from_content_type("image/jpeg"), Some("jpg"));
    }

    #[test]
    fn generated_image_storage_rejects_bare_base64() {
        let error = decode_base64_image("aGVsbG8=").expect_err("bare base64 should fail");

        assert!(error.to_string().contains("必须包含"));
    }

    #[test]
    fn generated_image_storage_rejects_invalid_base64() {
        let error = decode_base64_image("data:image/png;base64,not base64")
            .expect_err("invalid base64 should fail");

        assert!(error.to_string().contains("base64 解码失败"));
    }

    #[test]
    fn generated_image_storage_rejects_unsupported_mime() {
        let error = decode_base64_image("data:image/svg+xml;base64,PHN2Zz4=")
            .expect_err("unsupported mime should fail");

        assert!(error.to_string().contains("不支持"));
    }
}
