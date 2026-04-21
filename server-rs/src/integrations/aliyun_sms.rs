use std::collections::BTreeMap;

use base64::Engine;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::Deserialize;
use sha1::Sha1;
use time::OffsetDateTime;

use crate::config::MarketPhoneBindingConfig;
use crate::shared::error::AppError;

type HmacSha1 = Hmac<Sha1>;

pub const ALIYUN_SMS_VERIFY_CODE_LENGTH: u64 = 6;
pub const ALIYUN_SMS_VERIFY_CODE_TYPE: u64 = 1;
pub const ALIYUN_SMS_COUNTRY_CODE: &str = "86";
pub const ALIYUN_SMS_VERIFY_CODE_PLACEHOLDER: &str = "##code##";
const DYPNSAPI_ENDPOINT: &str = "https://dypnsapi.aliyuncs.com/";
const API_VERSION: &str = "2017-05-25";

#[derive(Debug, Deserialize)]
struct AliyunSmsResponseEnvelope {
    #[serde(rename = "Code")]
    code: Option<String>,
    #[serde(rename = "Success")]
    success: Option<bool>,
    #[serde(rename = "Message")]
    message: Option<String>,
    #[serde(rename = "Model")]
    model: Option<AliyunSmsResponseModel>,
}

#[derive(Debug, Deserialize)]
struct AliyunSmsResponseModel {
    #[serde(rename = "VerifyResult")]
    verify_result: Option<String>,
}

pub fn build_aliyun_sms_verify_template_param(code_expire_seconds: u64) -> String {
    serde_json::json!({
        "code": ALIYUN_SMS_VERIFY_CODE_PLACEHOLDER,
        "min": code_expire_seconds.div_ceil(60).to_string(),
    })
    .to_string()
}

pub fn build_send_sms_verify_code_params(
    phone_number: &str,
    config: &MarketPhoneBindingConfig,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("PhoneNumber".to_string(), phone_number.to_string()),
        (
            "CountryCode".to_string(),
            ALIYUN_SMS_COUNTRY_CODE.to_string(),
        ),
        ("SignName".to_string(), config.sign_name.clone()),
        ("TemplateCode".to_string(), config.template_code.clone()),
        (
            "TemplateParam".to_string(),
            build_aliyun_sms_verify_template_param(config.code_expire_seconds),
        ),
        (
            "CodeLength".to_string(),
            ALIYUN_SMS_VERIFY_CODE_LENGTH.to_string(),
        ),
        (
            "CodeType".to_string(),
            ALIYUN_SMS_VERIFY_CODE_TYPE.to_string(),
        ),
        (
            "ValidTime".to_string(),
            config.code_expire_seconds.to_string(),
        ),
        (
            "Interval".to_string(),
            config.send_cooldown_seconds.to_string(),
        ),
    ])
}

pub async fn send_sms_verify_code(
    client: &Client,
    config: &MarketPhoneBindingConfig,
    phone_number: &str,
) -> Result<(), AppError> {
    let mut params = build_common_rpc_params(&config.aliyun_access_key_id, "SendSmsVerifyCode")?;
    params.extend(build_send_sms_verify_code_params(phone_number, config));
    let signature = sign_rpc_query(&config.aliyun_access_key_secret, &params)?;
    params.insert("Signature".to_string(), signature);

    let response = client.post(DYPNSAPI_ENDPOINT).form(&params).send().await?;
    let text = response.text().await?;
    let parsed: AliyunSmsResponseEnvelope = serde_json::from_str(&text).map_err(|error| {
        AppError::config(format!(
            "failed to parse Aliyun send response: {error}; body={text}"
        ))
    })?;
    assert_aliyun_success(
        parsed.code.as_deref(),
        parsed.success,
        parsed.message.as_deref(),
        "短信验证码发送",
    )?;
    Ok(())
}

pub async fn check_sms_verify_code(
    client: &Client,
    config: &MarketPhoneBindingConfig,
    phone_number: &str,
    verification_code: &str,
) -> Result<bool, AppError> {
    let mut params = build_common_rpc_params(&config.aliyun_access_key_id, "CheckSmsVerifyCode")?;
    params.extend(build_check_sms_verify_code_params(
        phone_number,
        verification_code,
    ));
    let signature = sign_rpc_query(&config.aliyun_access_key_secret, &params)?;
    params.insert("Signature".to_string(), signature);

    let response = client.post(DYPNSAPI_ENDPOINT).form(&params).send().await?;
    let text = response.text().await?;
    let parsed: AliyunSmsResponseEnvelope = serde_json::from_str(&text).map_err(|error| {
        AppError::config(format!(
            "failed to parse Aliyun verify response: {error}; body={text}"
        ))
    })?;
    if parsed.code.as_deref() == Some("isv.ValidateFail") {
        return Err(AppError::config("验证码错误或已失效，请重新获取"));
    }
    assert_aliyun_success(
        parsed.code.as_deref(),
        parsed.success,
        parsed.message.as_deref(),
        "短信验证码校验",
    )?;
    Ok(parsed
        .model
        .and_then(|model| model.verify_result)
        .as_deref()
        == Some("PASS"))
}

pub fn build_check_sms_verify_code_params(
    phone_number: &str,
    verification_code: &str,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("PhoneNumber".to_string(), phone_number.to_string()),
        ("VerifyCode".to_string(), verification_code.to_string()),
        (
            "CountryCode".to_string(),
            ALIYUN_SMS_COUNTRY_CODE.to_string(),
        ),
    ])
}

pub fn sign_rpc_query(
    access_key_secret: &str,
    params: &BTreeMap<String, String>,
) -> Result<String, AppError> {
    let canonicalized = params
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let string_to_sign = format!("POST&%2F&{}", percent_encode(&canonicalized));
    let mut mac =
        HmacSha1::new_from_slice(format!("{access_key_secret}&").as_bytes()).map_err(|error| {
            AppError::config(format!("failed to initialize Aliyun SMS signer: {error}"))
        })?;
    mac.update(string_to_sign.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

fn build_common_rpc_params(
    access_key_id: &str,
    action: &str,
) -> Result<BTreeMap<String, String>, AppError> {
    Ok(BTreeMap::from([
        ("AccessKeyId".to_string(), access_key_id.to_string()),
        ("Action".to_string(), action.to_string()),
        ("Format".to_string(), "JSON".to_string()),
        ("SignatureMethod".to_string(), "HMAC-SHA1".to_string()),
        ("SignatureNonce".to_string(), build_signature_nonce()),
        ("SignatureVersion".to_string(), "1.0".to_string()),
        ("Timestamp".to_string(), build_timestamp()?),
        ("Version".to_string(), API_VERSION.to_string()),
    ]))
}

fn build_signature_nonce() -> String {
    format!("nonce-{}", OffsetDateTime::now_utc().unix_timestamp_nanos())
}

fn build_timestamp() -> Result<String, AppError> {
    let now = OffsetDateTime::now_utc();
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    ))
}

fn assert_aliyun_success(
    code: Option<&str>,
    success: Option<bool>,
    message: Option<&str>,
    action_label: &str,
) -> Result<(), AppError> {
    if success == Some(true) && code == Some("OK") {
        return Ok(());
    }
    Err(AppError::config(
        message
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(action_label)
            .to_string(),
    ))
}

fn percent_encode(raw: &str) -> String {
    let encoded = urlencoding::encode(raw).into_owned();
    encoded
        .replace('+', "%20")
        .replace('*', "%2A")
        .replace("%7E", "~")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::config::MarketPhoneBindingConfig;

    #[test]
    fn send_sms_params_match_existing_node_request_shape() {
        let config = MarketPhoneBindingConfig {
            enabled: true,
            aliyun_access_key_id: "ak".to_string(),
            aliyun_access_key_secret: "sk".to_string(),
            sign_name: "九州修仙录".to_string(),
            template_code: "SMS_123456".to_string(),
            code_expire_seconds: 300,
            send_cooldown_seconds: 60,
            send_hourly_limit: 5,
            send_daily_limit: 10,
        };
        let params = super::build_send_sms_verify_code_params("13812340000", &config);
        assert_eq!(
            params.get("PhoneNumber").map(String::as_str),
            Some("13812340000")
        );
        assert_eq!(params.get("CountryCode").map(String::as_str), Some("86"));
        assert_eq!(params.get("CodeLength").map(String::as_str), Some("6"));
        assert_eq!(params.get("Interval").map(String::as_str), Some("60"));
        assert!(
            params
                .get("TemplateParam")
                .map(|value| value.contains("##code##"))
                .unwrap_or(false)
        );
    }

    #[test]
    fn rpc_signature_is_stable_for_fixed_params() {
        let params = BTreeMap::from([
            ("AccessKeyId".to_string(), "ak".to_string()),
            ("Action".to_string(), "SendSmsVerifyCode".to_string()),
            ("Format".to_string(), "JSON".to_string()),
            ("PhoneNumber".to_string(), "13812340000".to_string()),
            ("Version".to_string(), "2017-05-25".to_string()),
        ]);
        let signature = super::sign_rpc_query("sk", &params).expect("signature should build");
        assert!(!signature.is_empty());
    }
}
