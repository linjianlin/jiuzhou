use crate::integrations::redis::RedisRuntime;
use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Copy)]
pub enum AttemptAction {
    Login,
    PasswordChange,
    RedeemCode,
}

struct AttemptPolicy {
    failure_window_ms: i64,
    block_window_ms: i64,
    subject_ip_failure_limit: i64,
    subject_failure_limit: i64,
    ip_failure_limit: i64,
    blocked_message: &'static str,
}

fn attempt_policy(action: AttemptAction) -> AttemptPolicy {
    match action {
        AttemptAction::Login => AttemptPolicy {
            failure_window_ms: 15 * 60 * 1000,
            block_window_ms: 15 * 60 * 1000,
            subject_ip_failure_limit: 5,
            subject_failure_limit: 10,
            ip_failure_limit: 20,
            blocked_message: "登录尝试过于频繁，请15分钟后再试",
        },
        AttemptAction::PasswordChange => AttemptPolicy {
            failure_window_ms: 10 * 60 * 1000,
            block_window_ms: 10 * 60 * 1000,
            subject_ip_failure_limit: 5,
            subject_failure_limit: 8,
            ip_failure_limit: 16,
            blocked_message: "密码验证失败次数过多，请10分钟后再试",
        },
        AttemptAction::RedeemCode => AttemptPolicy {
            failure_window_ms: 15 * 60 * 1000,
            block_window_ms: 15 * 60 * 1000,
            subject_ip_failure_limit: 5,
            subject_failure_limit: 10,
            ip_failure_limit: 20,
            blocked_message: "兑换码尝试过于频繁，请15分钟后再试",
        },
    }
}

fn action_key(action: AttemptAction) -> &'static str {
    match action {
        AttemptAction::Login => "login",
        AttemptAction::PasswordChange => "password-change",
        AttemptAction::RedeemCode => "redeem-code",
    }
}

fn normalize_part(value: &str) -> Result<String, AppError> {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return Err(AppError::config("attempt guard key part cannot be empty"));
    }
    Ok(urlencoding::encode(&normalized).to_string())
}

fn build_attempt_keys(action: AttemptAction, subject: &str, ip: &str) -> Result<[String; 6], AppError> {
    let action = normalize_part(action_key(action))?;
    let subject = normalize_part(subject)?;
    let ip = normalize_part(ip)?;
    let base = format!("attempt-guard:{action}");
    Ok([
        format!("{base}:failure:subject-ip:{subject}:{ip}"),
        format!("{base}:failure:subject:{subject}"),
        format!("{base}:failure:ip:{ip}"),
        format!("{base}:block:subject-ip:{subject}:{ip}"),
        format!("{base}:block:subject:{subject}"),
        format!("{base}:block:ip:{ip}"),
    ])
}

fn redis_runtime(state: &AppState) -> Result<RedisRuntime, AppError> {
    Ok(RedisRuntime::new(
        state
            .redis
            .clone()
            .ok_or_else(|| AppError::service_unavailable("Redis 不可用，无法执行安全校验"))?,
    ))
}

pub async fn assert_action_attempt_allowed(
    state: &AppState,
    action: AttemptAction,
    subject: &str,
    ip: &str,
) -> Result<(), AppError> {
    let redis = redis_runtime(state)?;
    let policy = attempt_policy(action);
    let keys = build_attempt_keys(action, subject, ip)?;
    let refs = [&keys[3][..], &keys[4][..], &keys[5][..]];
    let values = redis.mget(&refs).await?;
    if values.into_iter().any(|value| value.as_deref() == Some("1")) {
        return Err(AppError::too_many_requests(policy.blocked_message));
    }
    Ok(())
}

pub async fn record_action_attempt_failure(
    state: &AppState,
    action: AttemptAction,
    subject: &str,
    ip: &str,
) -> Result<(), AppError> {
    let redis = redis_runtime(state)?;
    let policy = attempt_policy(action);
    let keys = build_attempt_keys(action, subject, ip)?;
    let subject_ip = redis.incr(&keys[0]).await?;
    if subject_ip == 1 {
        redis.pexpire(&keys[0], policy.failure_window_ms).await?;
    }
    let subject_count = redis.incr(&keys[1]).await?;
    if subject_count == 1 {
        redis.pexpire(&keys[1], policy.failure_window_ms).await?;
    }
    let ip_count = redis.incr(&keys[2]).await?;
    if ip_count == 1 {
        redis.pexpire(&keys[2], policy.failure_window_ms).await?;
    }
    if subject_ip >= policy.subject_ip_failure_limit {
        redis.psetex(&keys[3], policy.block_window_ms, "1").await?;
    }
    if subject_count >= policy.subject_failure_limit {
        redis.psetex(&keys[4], policy.block_window_ms, "1").await?;
    }
    if ip_count >= policy.ip_failure_limit {
        redis.psetex(&keys[5], policy.block_window_ms, "1").await?;
    }
    Ok(())
}

pub async fn clear_action_attempt_failures(
    state: &AppState,
    action: AttemptAction,
    subject: &str,
    ip: &str,
) -> Result<(), AppError> {
    let redis = redis_runtime(state)?;
    let keys = build_attempt_keys(action, subject, ip)?;
    let refs = [&keys[0][..], &keys[1][..], &keys[3][..], &keys[4][..]];
    redis.del_many(&refs).await
}

pub async fn enforce_qps_limit(
    state: &AppState,
    scope_key: &str,
    key_prefix: &str,
    limit: i64,
    window_ms: i64,
    message: &str,
) -> Result<(), AppError> {
    let redis = redis_runtime(state)?;
    let current_window = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default())
        / window_ms;
    let redis_key = format!("{key_prefix}:{}:{current_window}", normalize_part(scope_key)?);
    let count = redis.incr(&redis_key).await?;
    if count == 1 {
        redis.pexpire(&redis_key, window_ms * 2).await?;
    }
    if count > limit {
        return Err(AppError::too_many_requests(message));
    }
    Ok(())
}
