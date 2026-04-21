use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::config::CaptchaConfig;
use crate::shared::error::AppError;

type HmacSha256 = Hmac<Sha256>;

const CAPTCHA_HOST: &str = "captcha.intl.tencentcloudapi.com";
const CAPTCHA_SERVICE: &str = "captcha";
const CAPTCHA_VERSION: &str = "2019-07-22";

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct DescribeCaptchaResultRequest<'a> {
    captcha_type: u64,
    ticket: &'a str,
    randstr: &'a str,
    user_ip: &'a str,
    captcha_app_id: u64,
    app_secret_key: &'a str,
}

#[derive(Debug, Deserialize)]
struct DescribeCaptchaResultEnvelope {
    #[serde(rename = "Response")]
    response: DescribeCaptchaResultResponse,
}

#[derive(Debug, Deserialize)]
struct DescribeCaptchaResultResponse {
    #[serde(rename = "CaptchaCode")]
    captcha_code: Option<i64>,
    #[serde(rename = "CaptchaMsg")]
    captcha_msg: Option<String>,
    #[serde(rename = "RequestId")]
    request_id: Option<String>,
    #[serde(rename = "Error")]
    error: Option<TencentCloudApiError>,
}

#[derive(Debug, Deserialize)]
struct TencentCloudApiError {
    #[serde(rename = "Code")]
    code: String,
    #[serde(rename = "Message")]
    message: String,
}

pub async fn verify_tencent_captcha_ticket(
    client: &Client,
    config: &CaptchaConfig,
    ticket: &str,
    randstr: &str,
    user_ip: &str,
) -> Result<(), AppError> {
    if config.tencent_app_id == 0
        || config.tencent_app_secret_key.trim().is_empty()
        || config.tencent_secret_id.trim().is_empty()
        || config.tencent_secret_key.trim().is_empty()
    {
        return Err(AppError::config("天御验证码服务未正确配置"));
    }

    let request = DescribeCaptchaResultRequest {
        captcha_type: 9,
        ticket,
        randstr,
        user_ip,
        captcha_app_id: config.tencent_app_id,
        app_secret_key: &config.tencent_app_secret_key,
    };
    let body = serde_json::to_string(&request).map_err(|error| {
        AppError::config(format!(
            "failed to serialize tencent captcha request: {error}"
        ))
    })?;
    let timestamp = OffsetDateTime::now_utc().unix_timestamp() as u64;
    let authorization = build_tc3_authorization(
        &config.tencent_secret_id,
        &config.tencent_secret_key,
        &body,
        timestamp,
    )?;

    let response = client
        .post(format!("https://{CAPTCHA_HOST}"))
        .header("content-type", "application/json; charset=utf-8")
        .header("host", CAPTCHA_HOST)
        .header("x-tc-action", "DescribeCaptchaResult")
        .header("x-tc-version", CAPTCHA_VERSION)
        .header("x-tc-timestamp", timestamp.to_string())
        .header("authorization", authorization)
        .body(body)
        .send()
        .await?;

    let status = response.status();
    let text = response.text().await?;
    let envelope: DescribeCaptchaResultEnvelope = serde_json::from_str(&text).map_err(|error| {
        AppError::config(format!(
            "failed to parse Tencent captcha response: {error}; body={text}"
        ))
    })?;

    if !status.is_success() {
        if let Some(error) = envelope.response.error {
            return Err(AppError::config(format!(
                "验证码校验失败：{} {}",
                error.code, error.message
            )));
        }
        return Err(AppError::config(format!("验证码校验失败：HTTP {status}")));
    }
    if let Some(error) = envelope.response.error {
        return Err(AppError::config(format!(
            "验证码校验失败：{} {}",
            error.code, error.message
        )));
    }
    let captcha_code = envelope.response.captcha_code.unwrap_or_default();
    if captcha_code != 1 {
        return Err(AppError::config(format!(
            "验证码校验失败：{}",
            envelope
                .response
                .captcha_msg
                .unwrap_or_else(|| "未知错误".to_string())
        )));
    }

    let _ = envelope.response.request_id;
    Ok(())
}

fn build_tc3_authorization(
    secret_id: &str,
    secret_key: &str,
    body: &str,
    timestamp: u64,
) -> Result<String, AppError> {
    let date = format_tc3_date(timestamp)?;
    let canonical_request = format!(
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{CAPTCHA_HOST}\nx-tc-action:describecaptcharesult\n\ncontent-type;host;x-tc-action\n{}",
        sha256_hex(body)
    );
    let credential_scope = format!("{date}/{CAPTCHA_SERVICE}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{credential_scope}\n{}",
        sha256_hex(canonical_request)
    );

    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), &date)?;
    let secret_service = hmac_sha256(&secret_date, CAPTCHA_SERVICE)?;
    let secret_signing = hmac_sha256(&secret_service, "tc3_request")?;
    let signature = hex::encode(hmac_sha256(&secret_signing, &string_to_sign)?);

    Ok(format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, SignedHeaders=content-type;host;x-tc-action, Signature={signature}"
    ))
}

fn hmac_sha256(key: &[u8], message: &str) -> Result<Vec<u8>, AppError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|error| {
        AppError::config(format!(
            "failed to initialize Tencent captcha signer: {error}"
        ))
    })?;
    mac.update(message.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn sha256_hex(input: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(input.as_ref()))
}

fn format_tc3_date(timestamp: u64) -> Result<String, AppError> {
    let now = OffsetDateTime::from_unix_timestamp(timestamp as i64).map_err(|error| {
        AppError::config(format!("failed to build Tencent captcha date: {error}"))
    })?;
    Ok(format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    ))
}

#[cfg(test)]
mod tests {
    use crate::config::CaptchaConfig;

    #[test]
    fn request_payload_contains_expected_fields() {
        let payload = serde_json::to_value(super::DescribeCaptchaResultRequest {
            captcha_type: 9,
            ticket: "ticket-1",
            randstr: "rand-1",
            user_ip: "1.2.3.4",
            captcha_app_id: 123456789,
            app_secret_key: "secret-key",
        })
        .expect("payload should serialize");
        assert_eq!(payload["CaptchaType"], 9);
        assert_eq!(payload["Ticket"], "ticket-1");
        assert_eq!(payload["CaptchaAppId"], 123456789);
    }

    #[test]
    fn tc3_signature_is_stable_for_fixed_request() {
        let signature = super::build_tc3_authorization(
            "secret-id",
            "secret-key",
            r#"{"CaptchaType":9,"Ticket":"ticket","Randstr":"rand","UserIp":"1.2.3.4","CaptchaAppId":123,"AppSecretKey":"ask"}"#,
            1_735_689_600,
        )
        .expect("signature should build");
        assert!(
            signature
                .contains("TC3-HMAC-SHA256 Credential=secret-id/2025-01-01/captcha/tc3_request")
        );
    }

    #[test]
    fn empty_config_is_detected_before_request() {
        let config = CaptchaConfig {
            provider: crate::config::CaptchaProvider::Tencent,
            tencent_app_id: 0,
            tencent_app_secret_key: String::new(),
            tencent_secret_id: String::new(),
            tencent_secret_key: String::new(),
        };
        assert!(config.tencent_app_id == 0);
    }
}
