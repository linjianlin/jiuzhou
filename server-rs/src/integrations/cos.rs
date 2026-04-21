use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::config::CosConfig;
use crate::shared::error::AppError;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

const TENCENT_STS_HOST: &str = "sts.tencentcloudapi.com";
const TENCENT_STS_SERVICE: &str = "sts";
const TENCENT_STS_VERSION: &str = "2018-08-13";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarUploadStsPayload {
    pub cos_enabled: bool,
    pub max_file_size_bytes: u64,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub key: Option<String>,
    pub avatar_url: Option<String>,
    pub start_time: Option<u64>,
    pub expired_time: Option<u64>,
    pub credentials: Option<StsCredentials>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StsCredentials {
    #[serde(rename = "tmpSecretId")]
    pub tmp_secret_id: String,
    #[serde(rename = "tmpSecretKey")]
    pub tmp_secret_key: String,
    #[serde(rename = "sessionToken")]
    pub session_token: String,
}

#[derive(Debug, Serialize)]
struct FederationTokenRequest<'a> {
    #[serde(rename = "Name")]
    name: &'a str,
    #[serde(rename = "Policy")]
    policy: String,
    #[serde(rename = "DurationSeconds")]
    duration_seconds: u64,
}

#[derive(Debug, Deserialize)]
struct FederationTokenEnvelope {
    #[serde(rename = "Response")]
    response: FederationTokenResponse,
}

#[derive(Debug, Deserialize)]
struct FederationTokenResponse {
    #[serde(rename = "Credentials")]
    credentials: Option<FederationTokenCredentials>,
    #[serde(rename = "ExpiredTime")]
    expired_time: Option<u64>,
    #[serde(rename = "Error")]
    error: Option<TencentCloudApiError>,
}

#[derive(Debug, Deserialize)]
struct FederationTokenCredentials {
    #[serde(rename = "TmpSecretId")]
    tmp_secret_id: String,
    #[serde(rename = "TmpSecretKey")]
    tmp_secret_key: String,
    #[serde(rename = "Token")]
    token: String,
}

#[derive(Debug, Deserialize)]
struct TencentCloudApiError {
    #[serde(rename = "Code")]
    code: String,
    #[serde(rename = "Message")]
    message: String,
}

pub fn cos_enabled(config: &CosConfig) -> bool {
    !config.secret_id.trim().is_empty()
        && !config.secret_key.trim().is_empty()
        && !config.bucket.trim().is_empty()
        && !config.region.trim().is_empty()
}

pub fn build_cos_public_url(config: &CosConfig, key: &str) -> String {
    let normalized_key = key.trim_start_matches('/');
    if !config.domain.trim().is_empty() {
        return format!("https://{}/{normalized_key}", config.domain);
    }

    format!(
        "https://{}.cos.{}.myqcloud.com/{normalized_key}",
        config.bucket, config.region
    )
}

pub fn extract_avatar_cos_key_from_url(config: &CosConfig, url: &str) -> Option<String> {
    if !url.starts_with("https://") {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    let default_host = format!("{}.cos.{}.myqcloud.com", config.bucket, config.region);
    let allowed_hosts = if config.domain.trim().is_empty() {
        vec![default_host]
    } else {
        vec![default_host, config.domain.trim().to_string()]
    };
    if !allowed_hosts
        .iter()
        .any(|host| host == parsed.host_str().unwrap_or_default())
    {
        return None;
    }
    let key = parsed.path().trim_start_matches('/').trim().to_string();
    if key.is_empty() || !key.starts_with(config.avatar_prefix.trim()) {
        return None;
    }
    Some(key)
}

pub async fn delete_avatar_object(
    client: &reqwest::Client,
    config: &CosConfig,
    key: &str,
) -> Result<(), AppError> {
    if !cos_enabled(config) {
        return Ok(());
    }
    let normalized_key = key.trim_start_matches('/').trim();
    if normalized_key.is_empty() || !normalized_key.starts_with(config.avatar_prefix.trim()) {
        return Err(AppError::config("COS 头像对象 key 不合法"));
    }

    let host = format!("{}.cos.{}.myqcloud.com", config.bucket, config.region);
    let date = build_cos_http_date()?;
    let authorization = build_cos_delete_authorization(config, &host, normalized_key, &date)?;
    let encoded_key = urlencoding::encode(normalized_key).replace("%2F", "/");
    let response = client
        .delete(format!("https://{host}/{encoded_key}"))
        .header("host", &host)
        .header("date", &date)
        .header("authorization", authorization)
        .send()
        .await?;

    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(());
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(AppError::config(format!(
        "COS 删除对象失败: status={status}, body={body}"
    )))
}

pub fn issue_avatar_upload_sts_fallback(
    config: &CosConfig,
    max_file_size_bytes: u64,
) -> AvatarUploadStsPayload {
    if !cos_enabled(config) {
        return AvatarUploadStsPayload {
            cos_enabled: false,
            max_file_size_bytes,
            bucket: None,
            region: None,
            key: None,
            avatar_url: None,
            start_time: None,
            expired_time: None,
            credentials: None,
        };
    }

    let key = format!("{}avatar-upload-fallback.png", config.avatar_prefix);
    AvatarUploadStsPayload {
        cos_enabled: true,
        max_file_size_bytes,
        bucket: Some(config.bucket.clone()),
        region: Some(config.region.clone()),
        key: Some(key.clone()),
        avatar_url: Some(build_cos_public_url(config, &key)),
        start_time: None,
        expired_time: None,
        credentials: None,
    }
}

pub fn build_avatar_upload_resource(
    bucket: &str,
    region: &str,
    key: &str,
) -> Result<String, AppError> {
    let last_dash_index = bucket
        .rfind('-')
        .ok_or_else(|| AppError::config("COS_BUCKET 格式不合法，需为 BucketName-APPID"))?;
    if last_dash_index == 0 || last_dash_index == bucket.len() - 1 {
        return Err(AppError::config(
            "COS_BUCKET 格式不合法，需为 BucketName-APPID",
        ));
    }

    let app_id = &bucket[last_dash_index + 1..];
    let short_bucket_name = &bucket[..last_dash_index];
    Ok(format!(
        "qcs::cos:{region}:uid/{app_id}:prefix//{app_id}/{short_bucket_name}/{key}"
    ))
}

pub fn build_avatar_upload_policy(
    bucket: &str,
    region: &str,
    key: &str,
    content_type: &str,
    max_file_size_bytes: u64,
) -> Result<serde_json::Value, AppError> {
    Ok(serde_json::json!({
        "version": "2.0",
        "statement": [{
            "action": ["name/cos:PutObject"],
            "effect": "allow",
            "principal": {"qcs": ["*"]},
            "resource": [build_avatar_upload_resource(bucket, region, key)?],
            "condition": {
                "string_equal": {"cos:content-type": content_type},
                "numeric_less_than_equal": {"cos:content-length": max_file_size_bytes}
            }
        }]
    }))
}

pub async fn issue_avatar_upload_sts(
    client: &reqwest::Client,
    config: &CosConfig,
    content_type: &str,
    max_file_size_bytes: u64,
) -> Result<AvatarUploadStsPayload, AppError> {
    if !cos_enabled(config) {
        return Ok(issue_avatar_upload_sts_fallback(
            config,
            max_file_size_bytes,
        ));
    }

    let extension = avatar_extension_from_content_type(content_type)
        .ok_or_else(|| AppError::config("只支持 JPG、PNG、GIF、WEBP 格式的图片"))?;
    let key = format!(
        "{}{}",
        config.avatar_prefix,
        generate_cos_avatar_filename(extension)
    );
    let policy = build_avatar_upload_policy(
        &config.bucket,
        &config.region,
        &key,
        content_type,
        max_file_size_bytes,
    )?;
    let policy = serde_json::to_string(&policy)
        .map_err(|error| AppError::config(format!("failed to serialize COS policy: {error}")))?;

    let start_time = unix_timestamp_now();
    let request_payload = FederationTokenRequest {
        name: "avatar-upload",
        policy,
        duration_seconds: config.sts_duration_seconds,
    };
    let body = serde_json::to_string(&request_payload).map_err(|error| {
        AppError::config(format!("failed to serialize STS request body: {error}"))
    })?;

    let authorization = build_tc3_authorization(config, &body, start_time)?;
    let response = client
        .post(format!("https://{TENCENT_STS_HOST}"))
        .header("content-type", "application/json; charset=utf-8")
        .header("host", TENCENT_STS_HOST)
        .header("x-tc-action", "GetFederationToken")
        .header("x-tc-version", TENCENT_STS_VERSION)
        .header("x-tc-timestamp", start_time.to_string())
        .header("x-tc-region", &config.region)
        .header("authorization", authorization)
        .body(body)
        .send()
        .await?;

    let status = response.status();
    let text = response.text().await?;
    let envelope: FederationTokenEnvelope = serde_json::from_str(&text).map_err(|error| {
        AppError::config(format!(
            "failed to parse Tencent STS response: {error}; body={text}"
        ))
    })?;

    if !status.is_success() {
        if let Some(error) = envelope.response.error {
            return Err(AppError::config(format!(
                "Tencent STS request failed: {} {}",
                error.code, error.message
            )));
        }
        return Err(AppError::config(format!(
            "Tencent STS request failed with status {status}"
        )));
    }

    if let Some(error) = envelope.response.error {
        return Err(AppError::config(format!(
            "Tencent STS request failed: {} {}",
            error.code, error.message
        )));
    }

    let credentials = envelope
        .response
        .credentials
        .ok_or_else(|| AppError::config("Tencent STS response missing credentials"))?;
    let expired_time = envelope
        .response
        .expired_time
        .ok_or_else(|| AppError::config("Tencent STS response missing expiredTime"))?;

    Ok(AvatarUploadStsPayload {
        cos_enabled: true,
        max_file_size_bytes,
        bucket: Some(config.bucket.clone()),
        region: Some(config.region.clone()),
        key: Some(key.clone()),
        avatar_url: Some(build_cos_public_url(config, &key)),
        start_time: Some(start_time),
        expired_time: Some(expired_time),
        credentials: Some(StsCredentials {
            tmp_secret_id: credentials.tmp_secret_id,
            tmp_secret_key: credentials.tmp_secret_key,
            session_token: credentials.token,
        }),
    })
}

fn avatar_extension_from_content_type(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/jpeg" => Some(".jpg"),
        "image/png" => Some(".png"),
        "image/gif" => Some(".gif"),
        "image/webp" => Some(".webp"),
        _ => None,
    }
}

fn generate_cos_avatar_filename(extension: &str) -> String {
    format!("avatar-{}{}", unix_timestamp_now(), extension)
}

fn unix_timestamp_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn sha256_hex(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn sha1_hex(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha1::digest(input.as_ref()))
}

fn hmac_sha256(key: &[u8], message: &str) -> Result<Vec<u8>, AppError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|error| AppError::config(format!("failed to initialize HMAC: {error}")))?;
    mac.update(message.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn hmac_sha1(key: &[u8], message: &str) -> Result<Vec<u8>, AppError> {
    let mut mac = HmacSha1::new_from_slice(key)
        .map_err(|error| AppError::config(format!("failed to initialize HMAC-SHA1: {error}")))?;
    mac.update(message.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn build_cos_http_date() -> Result<String, AppError> {
    const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let now = OffsetDateTime::now_utc();
    let weekday = WEEKDAYS[now.weekday().number_days_from_monday() as usize];
    let month = MONTHS[now.month() as usize - 1];
    Ok(format!(
        "{weekday}, {:02} {month} {:04} {:02}:{:02}:{:02} GMT",
        now.day(),
        now.year(),
        now.hour(),
        now.minute(),
        now.second()
    ))
}

fn build_cos_delete_authorization(
    config: &CosConfig,
    host: &str,
    key: &str,
    date: &str,
) -> Result<String, AppError> {
    let now = unix_timestamp_now();
    let sign_time = format!("{};{}", now.saturating_sub(60), now.saturating_add(600));
    let sign_key = hex::encode(hmac_sha1(config.secret_key.as_bytes(), &sign_time)?);
    let header_list = "date;host";
    let http_headers = format!(
        "date={}&host={}",
        urlencoding::encode(date),
        urlencoding::encode(host)
    );
    let http_string = format!("delete\n/{}\n\n{}\n", key, http_headers);
    let string_to_sign = format!("sha1\n{}\n{}\n", sign_time, sha1_hex(http_string));
    let signature = hex::encode(hmac_sha1(sign_key.as_bytes(), &string_to_sign)?);
    Ok(format!(
        "q-sign-algorithm=sha1&q-ak={}&q-sign-time={}&q-key-time={}&q-header-list={}&q-url-param-list=&q-signature={}",
        config.secret_id, sign_time, sign_time, header_list, signature
    ))
}

fn build_tc3_authorization(
    config: &CosConfig,
    body: &str,
    timestamp: u64,
) -> Result<String, AppError> {
    let date = build_tc3_date(timestamp)?;
    let hashed_payload = sha256_hex(body);
    let canonical_request = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{TENCENT_STS_HOST}\nx-tc-action:getfederationtoken\n\ncontent-type;host;x-tc-action\n{hashed_payload}"
    );
    let credential_scope = format!("{date}/{TENCENT_STS_SERVICE}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}",
        sha256_hex(canonical_request)
    );

    let secret_date = hmac_sha256(format!("TC3{}", config.secret_key).as_bytes(), &date)?;
    let secret_service = hmac_sha256(&secret_date, TENCENT_STS_SERVICE)?;
    let secret_signing = hmac_sha256(&secret_service, "tc3_request")?;
    let signature = hex::encode(hmac_sha256(&secret_signing, &string_to_sign)?);

    Ok(format!(
        "TC3-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders=content-type;host;x-tc-action, Signature={signature}",
        config.secret_id
    ))
}

fn build_tc3_date(timestamp: u64) -> Result<String, AppError> {
    let datetime = OffsetDateTime::from_unix_timestamp(timestamp as i64).map_err(|error| {
        AppError::config(format!("failed to build TC3 date from timestamp: {error}"))
    })?;
    Ok(format!(
        "{:04}-{:02}-{:02}",
        datetime.year(),
        u8::from(datetime.month()),
        datetime.day()
    ))
}

#[cfg(test)]
mod tests {
    use crate::config::CosConfig;

    #[test]
    fn custom_domain_overrides_default_cos_host() {
        let config = CosConfig {
            secret_id: "id".to_string(),
            secret_key: "key".to_string(),
            bucket: "bucket-12345".to_string(),
            region: "ap-shanghai".to_string(),
            avatar_prefix: "avatars/".to_string(),
            generated_image_prefix: "generated/".to_string(),
            domain: "oss.example.com".to_string(),
            sts_duration_seconds: 600,
        };

        assert_eq!(
            super::build_cos_public_url(&config, "avatars/example.png"),
            "https://oss.example.com/avatars/example.png"
        );
    }

    #[test]
    fn upload_resource_matches_node_contract() {
        let resource = super::build_avatar_upload_resource(
            "idle-1254084933",
            "ap-guangzhou",
            "jiuzhou/avatars/avatar-1.png",
        )
        .expect("resource should build");

        assert_eq!(
            resource,
            "qcs::cos:ap-guangzhou:uid/1254084933:prefix//1254084933/idle/jiuzhou/avatars/avatar-1.png"
        );
    }

    #[test]
    fn upload_policy_matches_node_contract_shape() {
        let policy = super::build_avatar_upload_policy(
            "idle-1254084933",
            "ap-guangzhou",
            "jiuzhou/avatars/avatar-1.png",
            "image/png",
            2 * 1024 * 1024,
        )
        .expect("policy should build");

        assert_eq!(policy["statement"][0]["action"][0], "name/cos:PutObject");
        assert_eq!(
            policy["statement"][0]["condition"]["string_equal"]["cos:content-type"],
            "image/png"
        );
        assert_eq!(
            policy["statement"][0]["condition"]["numeric_less_than_equal"]["cos:content-length"],
            2 * 1024 * 1024
        );
    }

    #[test]
    fn extract_avatar_cos_key_accepts_default_host() {
        let config = CosConfig {
            secret_id: "id".to_string(),
            secret_key: "key".to_string(),
            bucket: "bucket-12345".to_string(),
            region: "ap-shanghai".to_string(),
            avatar_prefix: "avatars/".to_string(),
            generated_image_prefix: "generated/".to_string(),
            domain: String::new(),
            sts_duration_seconds: 600,
        };

        assert_eq!(
            super::extract_avatar_cos_key_from_url(
                &config,
                "https://bucket-12345.cos.ap-shanghai.myqcloud.com/avatars/example.png"
            ),
            Some("avatars/example.png".to_string())
        );
    }

    #[test]
    fn extract_avatar_cos_key_accepts_custom_domain() {
        let config = CosConfig {
            secret_id: "id".to_string(),
            secret_key: "key".to_string(),
            bucket: "bucket-12345".to_string(),
            region: "ap-shanghai".to_string(),
            avatar_prefix: "avatars/".to_string(),
            generated_image_prefix: "generated/".to_string(),
            domain: "oss.example.com".to_string(),
            sts_duration_seconds: 600,
        };

        assert_eq!(
            super::extract_avatar_cos_key_from_url(
                &config,
                "https://oss.example.com/avatars/example.png"
            ),
            Some("avatars/example.png".to_string())
        );
    }

    #[test]
    fn cos_delete_authorization_uses_q_sign_sha1_shape() {
        let config = CosConfig {
            secret_id: "id".to_string(),
            secret_key: "key".to_string(),
            bucket: "bucket-12345".to_string(),
            region: "ap-shanghai".to_string(),
            avatar_prefix: "avatars/".to_string(),
            generated_image_prefix: "generated/".to_string(),
            domain: String::new(),
            sts_duration_seconds: 600,
        };
        let authorization = super::build_cos_delete_authorization(
            &config,
            "bucket-12345.cos.ap-shanghai.myqcloud.com",
            "avatars/example.png",
            "Wed, 14 Aug 2019 11:59:40 GMT",
        )
        .expect("authorization should build");
        assert!(authorization.starts_with("q-sign-algorithm=sha1&q-ak=id&"));
        assert!(authorization.contains("q-header-list=date;host"));
    }
}
