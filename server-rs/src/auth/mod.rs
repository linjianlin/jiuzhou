use axum::http::HeaderMap;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::shared::error::AppError;
use crate::state::AppState;

pub const AUTH_INVALID_MESSAGE: &str = "登录状态无效，请重新登录";
pub const HTTP_USER_QUEUE_TIMEOUT_MESSAGE: &str = "当前账号请求排队超时，请稍后再试";
pub const CHARACTER_NOT_FOUND_MESSAGE: &str = "角色不存在";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthClaims {
    pub id: i64,
    pub username: Option<String>,
    #[serde(rename = "sessionToken")]
    pub session_token: Option<String>,
    pub exp: usize,
}

#[derive(Debug, Clone)]
pub struct AuthTokenPayload<'a> {
    pub user_id: i64,
    pub username: &'a str,
    pub session_token: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedUser {
    pub user_id: i64,
    pub claims: AuthClaims,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedCharacter {
    pub user_id: i64,
    pub character_id: i64,
    pub claims: AuthClaims,
}

pub fn read_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let auth_header = headers.get(axum::http::header::AUTHORIZATION)?;
    let auth_header = auth_header.to_str().ok()?.trim();
    auth_header
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub fn verify_token(token: &str, jwt_secret: &str) -> Result<AuthClaims, AppError> {
    let token_data = decode::<AuthClaims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| AppError::unauthorized(AUTH_INVALID_MESSAGE))?;

    if token_data.claims.id <= 0 {
        return Err(AppError::unauthorized(AUTH_INVALID_MESSAGE));
    }

    Ok(token_data.claims)
}

pub fn sign_token(
    payload: AuthTokenPayload<'_>,
    jwt_secret: &str,
    jwt_expires_in: &str,
) -> Result<String, AppError> {
    let expires_at = calculate_expiration(jwt_expires_in)?;
    let claims = AuthClaims {
        id: payload.user_id,
        username: Some(payload.username.to_string()),
        session_token: payload.session_token.map(str::to_string),
        exp: expires_at,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret.as_bytes()),
    )
    .map_err(|error| AppError::config(format!("failed to sign JWT: {error}")))
}

fn calculate_expiration(raw: &str) -> Result<usize, AppError> {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Err(AppError::config("JWT_EXPIRES_IN cannot be empty"));
    }

    let (number_part, unit_multiplier) = match normalized.chars().last() {
        Some('s') => (&normalized[..normalized.len() - 1], 1_u64),
        Some('m') => (&normalized[..normalized.len() - 1], 60_u64),
        Some('h') => (&normalized[..normalized.len() - 1], 3_600_u64),
        Some('d') => (&normalized[..normalized.len() - 1], 86_400_u64),
        Some(last) if last.is_ascii_digit() => (normalized, 1_u64),
        _ => {
            return Err(AppError::config(
                "JWT_EXPIRES_IN must use s/m/h/d suffix or raw seconds",
            ));
        }
    };

    let amount = number_part
        .parse::<u64>()
        .map_err(|_| AppError::config("JWT_EXPIRES_IN must be a positive integer"))?;
    if amount == 0 {
        return Err(AppError::config("JWT_EXPIRES_IN must be greater than zero"));
    }

    let expires_in = amount
        .checked_mul(unit_multiplier)
        .ok_or_else(|| AppError::config("JWT_EXPIRES_IN is too large"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| AppError::config(format!("system clock error: {error}")))?
        .as_secs();

    usize::try_from(now + expires_in)
        .map_err(|_| AppError::config("calculated JWT expiration overflowed platform usize"))
}

pub async fn verify_session(
    state: &AppState,
    user_id: i64,
    session_token: Option<&str>,
) -> Result<(), AppError> {
    println!("VERIFY_SESSION_TRACE: entered user_id={user_id}");
    let Some(session_token) = session_token.filter(|value| !value.trim().is_empty()) else {
        println!("VERIFY_SESSION_TRACE: missing_token");
        return Err(AppError::unauthorized(AUTH_INVALID_MESSAGE));
    };

    let row = state
        .database
        .fetch_optional("SELECT session_token FROM users WHERE id = $1", |query| {
            query.bind(user_id)
        })
        .await?;
    println!(
        "VERIFY_SESSION_TRACE: fetch_optional_done row_present={}",
        row.is_some()
    );

    let Some(row) = row else {
        println!("VERIFY_SESSION_TRACE: row_missing");
        return Err(AppError::unauthorized(AUTH_INVALID_MESSAGE));
    };

    let current_session_token: Option<String> = row.try_get("session_token")?;
    println!(
        "VERIFY_SESSION_TRACE: token_loaded matches={}",
        current_session_token.as_deref() == Some(session_token)
    );
    if current_session_token.as_deref() != Some(session_token) {
        return Err(AppError::unauthorized("账号已在其他设备登录").with_extra("kicked", true));
    }

    Ok(())
}

pub async fn verify_token_and_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedUser, AppError> {
    let token =
        read_bearer_token(headers).ok_or_else(|| AppError::unauthorized(AUTH_INVALID_MESSAGE))?;
    let claims = verify_token(token, &state.config.service.jwt_secret)?;
    verify_session(state, claims.id, claims.session_token.as_deref()).await?;

    Ok(AuthenticatedUser {
        user_id: claims.id,
        claims,
    })
}

pub async fn get_character_id_by_user_id(
    state: &AppState,
    user_id: i64,
) -> Result<Option<i64>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT id::bigint AS id FROM characters WHERE user_id = $1 LIMIT 1",
            |query| query.bind(user_id),
        )
        .await?;

    let character_id = row
        .map(|record| record.try_get::<i64, _>("id"))
        .transpose()?;

    Ok(character_id.filter(|value| *value > 0))
}

pub async fn require_auth(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedUser, AppError> {
    let token =
        read_bearer_token(headers).ok_or_else(|| AppError::unauthorized(AUTH_INVALID_MESSAGE))?;
    let claims = verify_token(token, &state.config.service.jwt_secret)?;

    Ok(AuthenticatedUser {
        user_id: claims.id,
        claims,
    })
}

pub async fn require_character(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedCharacter, AppError> {
    let user = require_auth(state, headers).await?;
    let character_id = get_character_id_by_user_id(state, user.user_id)
        .await?
        .ok_or_else(|| AppError::not_found(CHARACTER_NOT_FOUND_MESSAGE))?;

    Ok(AuthenticatedCharacter {
        user_id: user.user_id,
        character_id,
        claims: user.claims,
    })
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, header::AUTHORIZATION};
    use jsonwebtoken::{EncodingKey, Header, encode};

    use super::{
        AUTH_INVALID_MESSAGE, AuthClaims, AuthTokenPayload, read_bearer_token, sign_token,
        verify_token,
    };

    #[test]
    fn bearer_token_is_read_from_header() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer token-123"));

        assert_eq!(read_bearer_token(&headers), Some("token-123"));
    }

    #[test]
    fn verify_token_accepts_valid_claims() {
        let claims = AuthClaims {
            id: 1,
            username: Some("tester".to_string()),
            session_token: Some("session-1".to_string()),
            exp: 4_102_444_800,
        };
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(b"secret"),
        )
        .expect("jwt should encode");

        let decoded = verify_token(&token, "secret").expect("jwt should decode");
        assert_eq!(decoded.id, 1);
        assert_eq!(decoded.session_token.as_deref(), Some("session-1"));
    }

    #[test]
    fn verify_token_rejects_invalid_token() {
        let error = verify_token("invalid-token", "secret").expect_err("token should fail");
        assert_eq!(error.client_message(), AUTH_INVALID_MESSAGE);
    }

    #[test]
    fn sign_token_includes_session_token_when_present() {
        let token = sign_token(
            AuthTokenPayload {
                user_id: 7,
                username: "tester",
                session_token: Some("session-7"),
            },
            "secret",
            "7d",
        )
        .expect("token should sign");

        let decoded = verify_token(&token, "secret").expect("token should decode");
        assert_eq!(decoded.id, 7);
        assert_eq!(decoded.username.as_deref(), Some("tester"));
        assert_eq!(decoded.session_token.as_deref(), Some("session-7"));
    }
}
