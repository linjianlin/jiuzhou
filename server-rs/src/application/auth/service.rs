use std::{future::Future, pin::Pin};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use bcrypt::{hash, verify, DEFAULT_COST};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::Rng;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::application::character::service::{
    CheckCharacterResult, CreateCharacterResult, RenameCharacterWithCardResult,
    RustCharacterReadService, UpdateCharacterPositionResult, UpdateCharacterSettingResult,
};
use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::auth::{
    AuthActionResult, AuthResponseData, AuthResponseUser, AuthRouteServices, CaptchaChallenge,
    CaptchaProvider, CaptchaVerifyPayload, LoginInput, RegisterInput, VerifyTokenAndSessionResult,
};
use crate::edge::socket::game_socket::{
    auth_failed_failure, kicked_failure, server_error_failure, GameSocketAuthFailure,
    GameSocketAuthProfile, GameSocketAuthServices,
};

const AUTH_CAPTCHA_TTL_SECONDS: u64 = 300;
const LOGIN_QPS_LIMIT_MESSAGE: &str = "认证请求过于频繁，请稍后再试";
const LOGIN_BLOCKED_MESSAGE: &str = "登录尝试过于频繁，请15分钟后再试";
const CAPTCHA_CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Clone)]
pub struct RustAuthServices {
    pool: sqlx::PgPool,
    redis: redis::Client,
    jwt_secret: String,
    jwt_expires_in: String,
    captcha_provider: CaptchaProvider,
    character_read_service: RustCharacterReadService,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct JwtClaims {
    id: i64,
    username: String,
    exp: usize,
    #[serde(rename = "sessionToken", skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCaptchaRecord {
    answer: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
    scene: String,
}

impl RustAuthServices {
    pub fn new(
        pool: sqlx::PgPool,
        redis: redis::Client,
        jwt_secret: String,
        jwt_expires_in: String,
        captcha_provider: CaptchaProvider,
        runtime_services: crate::bootstrap::app::SharedRuntimeServices,
    ) -> Self {
        Self {
            character_read_service: RustCharacterReadService::new(pool.clone(), runtime_services),
            pool,
            redis,
            jwt_secret,
            jwt_expires_in,
            captcha_provider,
        }
    }

    async fn create_captcha_impl(&self) -> Result<CaptchaChallenge, BusinessError> {
        let captcha_id = generate_token_hex(16);
        let answer = generate_captcha_answer();
        let expires_at = current_timestamp_ms() + AUTH_CAPTCHA_TTL_SECONDS * 1_000;
        let record = StoredCaptchaRecord {
            answer: answer.clone(),
            expires_at,
            scene: "auth".to_string(),
        };
        let key = format!("auth:captcha:{captcha_id}");
        let payload = serde_json::to_string(&record).map_err(|_| {
            BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
        })?;

        let mut redis = self.redis_connection().await?;
        redis
            .set_ex::<_, _, ()>(key, payload, AUTH_CAPTCHA_TTL_SECONDS)
            .await
            .map_err(internal_business_error)?;

        Ok(CaptchaChallenge {
            captcha_id,
            image_data: render_captcha_data_uri(&answer),
            expires_at,
        })
    }

    async fn register_impl(&self, input: RegisterInput) -> Result<AuthActionResult, BusinessError> {
        self.enforce_qps(
            "qps:auth:register",
            6,
            10 * 60 * 1_000,
            &input.user_ip,
            LOGIN_QPS_LIMIT_MESSAGE,
        )
        .await?;
        self.verify_captcha(input.captcha).await?;

        let exists = sqlx::query("SELECT id FROM users WHERE username = $1")
            .bind(&input.username)
            .fetch_optional(&self.pool)
            .await
            .map_err(internal_business_error)?;
        if exists.is_some() {
            return Ok(AuthActionResult {
                success: false,
                message: "用户名已存在".to_string(),
                data: None,
            });
        }

        let password_hash = hash(input.password, DEFAULT_COST).map_err(internal_business_error)?;
        let user_row = sqlx::query(
            r#"
            INSERT INTO users (username, password, created_at, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING id, username, status, created_at::text AS created_at, updated_at::text AS updated_at
            "#,
        )
        .bind(&input.username)
        .bind(password_hash)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let token = self.encode_jwt(user_row.get::<i64, _>("id"), &input.username, None)?;

        Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: Some(AuthResponseData {
                user: AuthResponseUser {
                    id: user_row.get("id"),
                    username: user_row.get("username"),
                    status: user_row.get("status"),
                    created_at: user_row.try_get("created_at").ok(),
                    updated_at: user_row.try_get("updated_at").ok(),
                    last_login: None,
                },
                token,
                session_token: String::new(),
            }),
        })
    }

    async fn login_impl(&self, input: LoginInput) -> Result<AuthActionResult, BusinessError> {
        self.enforce_qps(
            "qps:auth:login",
            12,
            60 * 1_000,
            &input.user_ip,
            LOGIN_QPS_LIMIT_MESSAGE,
        )
        .await?;
        self.assert_login_attempt_allowed(&input.username, &input.user_ip)
            .await?;
        self.verify_captcha(input.captcha).await?;

        let user_row = sqlx::query(
            r#"
            SELECT
              id,
              username,
              password,
              status,
              created_at::text AS created_at,
              updated_at::text AS updated_at,
              last_login::text AS last_login
            FROM users
            WHERE username = $1
            LIMIT 1
            "#,
        )
        .bind(&input.username)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(user_row) = user_row else {
            self.record_login_attempt_failure(&input.username, &input.user_ip)
                .await?;
            return Ok(AuthActionResult {
                success: false,
                message: "用户名或密码错误".to_string(),
                data: None,
            });
        };

        let status = user_row.get::<i32, _>("status");
        if status == 0 {
            self.record_login_attempt_failure(&input.username, &input.user_ip)
                .await?;
            return Ok(AuthActionResult {
                success: false,
                message: "账号已被禁用".to_string(),
                data: None,
            });
        }

        let password_hash = user_row.get::<String, _>("password");
        let password_matches =
            verify(input.password, &password_hash).map_err(internal_business_error)?;
        if !password_matches {
            self.record_login_attempt_failure(&input.username, &input.user_ip)
                .await?;
            return Ok(AuthActionResult {
                success: false,
                message: "用户名或密码错误".to_string(),
                data: None,
            });
        }

        let session_token = generate_token_hex(32);
        sqlx::query(
            "UPDATE users SET last_login = CURRENT_TIMESTAMP, session_token = $1 WHERE id = $2",
        )
        .bind(&session_token)
        .bind(user_row.get::<i64, _>("id"))
        .execute(&self.pool)
        .await
        .map_err(internal_business_error)?;

        self.clear_login_attempt_failures(&input.username, &input.user_ip)
            .await?;
        let token = self.encode_jwt(
            user_row.get::<i64, _>("id"),
            &user_row.get::<String, _>("username"),
            Some(session_token.clone()),
        )?;

        Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: Some(AuthResponseData {
                user: AuthResponseUser {
                    id: user_row.get("id"),
                    username: user_row.get("username"),
                    status,
                    created_at: user_row.try_get("created_at").ok(),
                    updated_at: user_row.try_get("updated_at").ok(),
                    last_login: user_row.try_get("last_login").ok(),
                },
                token,
                session_token,
            }),
        })
    }

    async fn create_character_impl(
        &self,
        user_id: i64,
        nickname: String,
        gender: String,
    ) -> Result<CreateCharacterResult, BusinessError> {
        self.character_read_service
            .create_character(user_id, &nickname, &gender)
            .await
    }

    async fn verify_captcha(&self, payload: CaptchaVerifyPayload) -> Result<(), BusinessError> {
        match (self.captcha_provider, payload) {
            (
                CaptchaProvider::Local,
                CaptchaVerifyPayload::Local {
                    captcha_id,
                    captcha_code,
                },
            ) => {
                let key = format!("auth:captcha:{captcha_id}");
                let mut redis = self.redis_connection().await?;
                let raw = redis
                    .get::<_, Option<String>>(&key)
                    .await
                    .map_err(internal_business_error)?;
                let Some(raw) = raw else {
                    return Err(BusinessError::new("图片验证码已失效，请重新获取"));
                };
                let record: StoredCaptchaRecord =
                    serde_json::from_str(&raw).map_err(internal_business_error)?;
                if record.expires_at <= current_timestamp_ms() {
                    let _ = redis.del::<_, ()>(&key).await;
                    return Err(BusinessError::new("图片验证码已失效，请重新获取"));
                }
                let _ = redis.del::<_, ()>(&key).await;
                if captcha_code.trim().to_uppercase() != record.answer {
                    return Err(BusinessError::new("图片验证码错误，请重新获取"));
                }
                Ok(())
            }
            (CaptchaProvider::Tencent, CaptchaVerifyPayload::Tencent { ticket, randstr }) => {
                if ticket.trim().is_empty() || randstr.trim().is_empty() {
                    return Err(BusinessError::new("验证码票据不能为空"));
                }
                Ok(())
            }
            (CaptchaProvider::Local, CaptchaVerifyPayload::Tencent { .. }) => {
                Err(BusinessError::new("图片验证码不能为空"))
            }
            (CaptchaProvider::Tencent, CaptchaVerifyPayload::Local { .. }) => {
                Err(BusinessError::new("验证码票据不能为空"))
            }
        }
    }

    async fn enforce_qps(
        &self,
        key_prefix: &str,
        limit: u64,
        window_ms: u64,
        scope: &str,
        message: &str,
    ) -> Result<(), BusinessError> {
        let scope = normalize_scope(scope)?;
        let current_window = current_timestamp_ms() / window_ms;
        let redis_key = format!("{key_prefix}:{scope}:{current_window}");
        let mut redis = self.redis_connection().await?;
        let request_count = redis
            .incr::<_, _, i64>(&redis_key, 1)
            .await
            .map_err(internal_business_error)?;
        if request_count == 1 {
            let _: bool = redis
                .pexpire(&redis_key, (window_ms * 2) as i64)
                .await
                .map_err(internal_business_error)?;
        }
        if request_count as u64 > limit {
            return Err(BusinessError::with_status(
                message,
                axum::http::StatusCode::TOO_MANY_REQUESTS,
            ));
        }
        Ok(())
    }

    async fn assert_login_attempt_allowed(
        &self,
        username: &str,
        user_ip: &str,
    ) -> Result<(), BusinessError> {
        let keys = build_attempt_guard_keys("login", username, user_ip)?;
        let mut redis = self.redis_connection().await?;
        let values = redis
            .mget::<_, Vec<Option<String>>>(&[
                keys.subject_ip_block_key.as_str(),
                keys.subject_block_key.as_str(),
                keys.ip_block_key.as_str(),
            ])
            .await
            .map_err(internal_business_error)?;

        if values.iter().any(|value| value.as_deref() == Some("1")) {
            return Err(BusinessError::with_status(
                LOGIN_BLOCKED_MESSAGE,
                axum::http::StatusCode::TOO_MANY_REQUESTS,
            ));
        }
        Ok(())
    }

    async fn record_login_attempt_failure(
        &self,
        username: &str,
        user_ip: &str,
    ) -> Result<(), BusinessError> {
        let keys = build_attempt_guard_keys("login", username, user_ip)?;
        let mut redis = self.redis_connection().await?;
        let subject_ip =
            touch_failure_counter(&mut redis, &keys.subject_ip_failure_key, 15 * 60 * 1_000)
                .await?;
        let subject =
            touch_failure_counter(&mut redis, &keys.subject_failure_key, 15 * 60 * 1_000).await?;
        let ip = touch_failure_counter(&mut redis, &keys.ip_failure_key, 15 * 60 * 1_000).await?;

        if subject_ip >= 5 {
            write_block_key(&mut redis, &keys.subject_ip_block_key, 15 * 60 * 1_000).await?;
        }
        if subject >= 10 {
            write_block_key(&mut redis, &keys.subject_block_key, 15 * 60 * 1_000).await?;
        }
        if ip >= 20 {
            write_block_key(&mut redis, &keys.ip_block_key, 15 * 60 * 1_000).await?;
        }
        Ok(())
    }

    async fn clear_login_attempt_failures(
        &self,
        username: &str,
        user_ip: &str,
    ) -> Result<(), BusinessError> {
        let keys = build_attempt_guard_keys("login", username, user_ip)?;
        let mut redis = self.redis_connection().await?;
        let _: i64 = redis
            .del(&[
                keys.subject_ip_failure_key.as_str(),
                keys.subject_failure_key.as_str(),
                keys.subject_ip_block_key.as_str(),
                keys.subject_block_key.as_str(),
            ])
            .await
            .map_err(internal_business_error)?;
        Ok(())
    }

    async fn verify_impl(&self, token: &str) -> VerifyTokenAndSessionResult {
        let decoded = match self.decode_jwt_claims(token) {
            Some(claims) => claims,
            None => {
                return VerifyTokenAndSessionResult {
                    valid: false,
                    kicked: false,
                    user_id: None,
                };
            }
        };

        self.verify_claims(&decoded).await
    }

    async fn check_character_impl(
        &self,
        user_id: i64,
    ) -> Result<CheckCharacterResult, BusinessError> {
        self.character_read_service.check_character(user_id).await
    }

    async fn update_character_position_impl(
        &self,
        user_id: i64,
        current_map_id: String,
        current_room_id: String,
    ) -> Result<UpdateCharacterPositionResult, BusinessError> {
        self.character_read_service
            .update_character_position(user_id, &current_map_id, &current_room_id)
            .await
    }

    async fn rename_character_with_card_impl(
        &self,
        user_id: i64,
        item_instance_id: i64,
        nickname: String,
    ) -> Result<RenameCharacterWithCardResult, BusinessError> {
        self.character_read_service
            .rename_character_with_card(user_id, item_instance_id, &nickname)
            .await
    }

    async fn update_auto_cast_skills_impl(
        &self,
        user_id: i64,
        enabled: bool,
    ) -> Result<UpdateCharacterSettingResult, BusinessError> {
        self.character_read_service
            .update_auto_cast_skills(user_id, enabled)
            .await
    }

    async fn update_auto_disassemble_impl(
        &self,
        user_id: i64,
        enabled: bool,
        rules: Option<Vec<serde_json::Value>>,
    ) -> Result<UpdateCharacterSettingResult, BusinessError> {
        self.character_read_service
            .update_auto_disassemble_settings(user_id, enabled, rules)
            .await
    }

    async fn update_dungeon_no_stamina_cost_impl(
        &self,
        user_id: i64,
        enabled: bool,
    ) -> Result<UpdateCharacterSettingResult, BusinessError> {
        self.character_read_service
            .update_dungeon_no_stamina_cost(user_id, enabled)
            .await
    }

    async fn redis_connection(&self) -> Result<redis::aio::MultiplexedConnection, BusinessError> {
        self.redis
            .get_multiplexed_async_connection()
            .await
            .map_err(internal_business_error)
    }

    fn encode_jwt(
        &self,
        user_id: i64,
        username: &str,
        session_token: Option<String>,
    ) -> Result<String, BusinessError> {
        let claims = JwtClaims {
            id: user_id,
            username: username.to_string(),
            exp: (current_timestamp_ms() / 1_000
                + parse_expiration_seconds(&self.jwt_expires_in)? as u64) as usize,
            session_token,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(self.jwt_secret.as_bytes()),
        )
        .map_err(internal_business_error)
    }

    fn decode_jwt_claims(&self, token: &str) -> Option<JwtClaims> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = true;
        decode::<JwtClaims>(
            token,
            &DecodingKey::from_secret(self.jwt_secret.as_bytes()),
            &validation,
        )
        .ok()
        .map(|value| value.claims)
    }

    async fn verify_claims(&self, decoded: &JwtClaims) -> VerifyTokenAndSessionResult {
        let query_result = sqlx::query("SELECT session_token FROM users WHERE id = $1")
            .bind(decoded.id)
            .fetch_optional(&self.pool)
            .await;

        let row = match query_result {
            Ok(Some(row)) => row,
            Ok(None) | Err(_) => {
                return VerifyTokenAndSessionResult {
                    valid: false,
                    kicked: false,
                    user_id: None,
                };
            }
        };

        let db_session_token = row
            .try_get::<Option<String>, _>("session_token")
            .ok()
            .flatten();
        if let Some(db_session_token) = db_session_token {
            if decoded.session_token.as_deref() != Some(db_session_token.as_str()) {
                return VerifyTokenAndSessionResult {
                    valid: false,
                    kicked: true,
                    user_id: None,
                };
            }
        }

        VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(decoded.id),
        }
    }

    async fn resolve_game_socket_auth_impl(
        &self,
        token: &str,
    ) -> Result<GameSocketAuthProfile, GameSocketAuthFailure> {
        let decoded = self
            .decode_jwt_claims(token)
            .ok_or_else(auth_failed_failure)?;
        let verify_result = self.verify_claims(&decoded).await;
        if !verify_result.valid {
            return Err(if verify_result.kicked {
                kicked_failure()
            } else {
                auth_failed_failure()
            });
        }

        let character_id = sqlx::query("SELECT id FROM characters WHERE user_id = $1 LIMIT 1")
            .bind(decoded.id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|_| server_error_failure())?
            .and_then(|row| row.try_get::<i64, _>("id").ok());

        let team_id = match character_id {
            Some(character_id) => self.load_team_id(character_id).await,
            None => None,
        };
        let sect_id = match character_id {
            Some(character_id) => self.load_sect_id(character_id).await,
            None => None,
        };

        Ok(GameSocketAuthProfile {
            user_id: decoded.id,
            session_token: decoded.session_token.unwrap_or_default(),
            character_id,
            team_id,
            sect_id,
        })
    }

    async fn load_team_id(&self, character_id: i64) -> Option<String> {
        sqlx::query("SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1")
            .bind(character_id)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<String, _>("team_id").ok())
            .filter(|value| !value.trim().is_empty())
    }

    async fn load_sect_id(&self, character_id: i64) -> Option<String> {
        sqlx::query("SELECT sect_id FROM sect_member WHERE character_id = $1 LIMIT 1")
            .bind(character_id)
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<String, _>("sect_id").ok())
            .filter(|value| !value.trim().is_empty())
    }
}

impl AuthRouteServices for RustAuthServices {
    fn captcha_provider(&self) -> CaptchaProvider {
        self.captcha_provider
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.create_captcha_impl().await })
    }

    fn register<'a>(
        &'a self,
        input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.register_impl(input).await })
    }

    fn login<'a>(
        &'a self,
        input: LoginInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.login_impl(input).await })
    }

    fn verify_token_and_session<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<Box<dyn Future<Output = VerifyTokenAndSessionResult> + Send + 'a>> {
        Box::pin(async move { self.verify_impl(token).await })
    }

    fn check_character<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<CheckCharacterResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.check_character_impl(user_id).await })
    }

    fn create_character<'a>(
        &'a self,
        user_id: i64,
        nickname: String,
        gender: String,
    ) -> Pin<Box<dyn Future<Output = Result<CreateCharacterResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.create_character_impl(user_id, nickname, gender).await })
    }

    fn update_character_position<'a>(
        &'a self,
        user_id: i64,
        current_map_id: String,
        current_room_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.update_character_position_impl(user_id, current_map_id, current_room_id)
                .await
        })
    }

    fn rename_character_with_card<'a>(
        &'a self,
        user_id: i64,
        item_instance_id: i64,
        nickname: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<RenameCharacterWithCardResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.rename_character_with_card_impl(user_id, item_instance_id, nickname)
                .await
        })
    }

    fn update_auto_cast_skills<'a>(
        &'a self,
        user_id: i64,
        enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { self.update_auto_cast_skills_impl(user_id, enabled).await })
    }

    fn update_auto_disassemble<'a>(
        &'a self,
        user_id: i64,
        enabled: bool,
        rules: Option<Vec<serde_json::Value>>,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.update_auto_disassemble_impl(user_id, enabled, rules)
                .await
        })
    }

    fn update_dungeon_no_stamina_cost<'a>(
        &'a self,
        user_id: i64,
        enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.update_dungeon_no_stamina_cost_impl(user_id, enabled)
                .await
        })
    }
}

impl GameSocketAuthServices for RustAuthServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a>,
    > {
        Box::pin(async move { self.resolve_game_socket_auth_impl(token).await })
    }
}

#[derive(Debug, Clone)]
struct AttemptGuardKeys {
    subject_ip_failure_key: String,
    subject_failure_key: String,
    ip_failure_key: String,
    subject_ip_block_key: String,
    subject_block_key: String,
    ip_block_key: String,
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

fn parse_expiration_seconds(raw: &str) -> Result<u64, BusinessError> {
    let value = raw.trim();
    if value.is_empty() {
        return Ok(7 * 24 * 60 * 60);
    }

    if let Ok(seconds) = value.parse::<u64>() {
        return Ok(seconds);
    }

    let (number, unit) = value.split_at(value.len().saturating_sub(1));
    let amount = number.parse::<u64>().map_err(|_| {
        BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
    })?;
    let seconds = match unit {
        "s" => amount,
        "m" => amount * 60,
        "h" => amount * 60 * 60,
        "d" => amount * 24 * 60 * 60,
        _ => {
            return Err(BusinessError::with_status(
                "服务器错误",
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    };
    Ok(seconds)
}

fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_token_hex(byte_len: usize) -> String {
    let mut bytes = vec![0_u8; byte_len];
    rand::thread_rng().fill(bytes.as_mut_slice());
    hex::encode(bytes)
}

fn generate_captcha_answer() -> String {
    let mut rng = rand::thread_rng();
    (0..4)
        .map(|_| {
            let index = rng.gen_range(0..CAPTCHA_CHARSET.len());
            CAPTCHA_CHARSET[index] as char
        })
        .collect()
}

fn render_captcha_data_uri(answer: &str) -> String {
    let mut rng = rand::thread_rng();
    let rotations = [
        rng.gen_range(-18..18),
        rng.gen_range(-18..18),
        rng.gen_range(-18..18),
        rng.gen_range(-18..18),
    ];
    let svg = format!(
        r#"<svg xmlns='http://www.w3.org/2000/svg' width='132' height='56' viewBox='0 0 132 56'>
<rect width='132' height='56' rx='12' fill='#f8fafc'/>
<path d='M8 16 C 28 38, 52 6, 76 28 S 112 50, 124 20' stroke='#94a3b8' stroke-width='1.5' fill='none'/>
<path d='M10 42 C 32 18, 58 48, 84 22 S 114 14, 124 38' stroke='#cbd5e1' stroke-width='1.2' fill='none'/>
<g fill='#0f172a' font-family='Verdana, sans-serif' font-size='28' font-weight='700'>
  <text x='16' y='36' transform='rotate({r0} 16 36)'>{c0}</text>
  <text x='42' y='34' transform='rotate({r1} 42 34)'>{c1}</text>
  <text x='70' y='38' transform='rotate({r2} 70 38)'>{c2}</text>
  <text x='96' y='35' transform='rotate({r3} 96 35)'>{c3}</text>
</g>
</svg>"#,
        r0 = rotations[0],
        r1 = rotations[1],
        r2 = rotations[2],
        r3 = rotations[3],
        c0 = &answer[0..1],
        c1 = &answer[1..2],
        c2 = &answer[2..3],
        c3 = &answer[3..4],
    );
    format!(
        "data:image/svg+xml;base64,{}",
        BASE64.encode(svg.as_bytes())
    )
}

fn normalize_scope(scope: &str) -> Result<String, BusinessError> {
    let scope = scope.trim();
    if scope.is_empty() {
        return Err(BusinessError::new("QPS 限流作用域不能为空字符串"));
    }
    Ok(scope.to_string())
}

fn build_attempt_guard_keys(
    action: &str,
    subject: &str,
    ip: &str,
) -> Result<AttemptGuardKeys, BusinessError> {
    let action = normalize_attempt_key_part(action, "action")?;
    let subject = normalize_attempt_key_part(subject, "subject")?;
    let ip = normalize_attempt_key_part(ip, "ip")?;
    let base = format!("attempt-guard:{action}");
    Ok(AttemptGuardKeys {
        subject_ip_failure_key: format!("{base}:failure:subject-ip:{subject}:{ip}"),
        subject_failure_key: format!("{base}:failure:subject:{subject}"),
        ip_failure_key: format!("{base}:failure:ip:{ip}"),
        subject_ip_block_key: format!("{base}:block:subject-ip:{subject}:{ip}"),
        subject_block_key: format!("{base}:block:subject:{subject}"),
        ip_block_key: format!("{base}:block:ip:{ip}"),
    })
}

fn normalize_attempt_key_part(value: &str, field_name: &str) -> Result<String, BusinessError> {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return Err(BusinessError::with_status(
            format!("{field_name} 不能为空"),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }
    Ok(urlencoding::encode(&normalized).into_owned())
}

async fn touch_failure_counter(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    window_ms: u64,
) -> Result<i64, BusinessError> {
    let count = redis
        .incr::<_, _, i64>(key, 1)
        .await
        .map_err(internal_business_error)?;
    if count == 1 {
        let _: bool = redis
            .pexpire(key, window_ms as i64)
            .await
            .map_err(internal_business_error)?;
    }
    Ok(count)
}

async fn write_block_key(
    redis: &mut redis::aio::MultiplexedConnection,
    key: &str,
    window_ms: u64,
) -> Result<(), BusinessError> {
    redis
        .set::<_, _, ()>(key, "1")
        .await
        .map_err(internal_business_error)?;
    let _: bool = redis
        .pexpire(key, window_ms as i64)
        .await
        .map_err(internal_business_error)?;
    Ok(())
}
