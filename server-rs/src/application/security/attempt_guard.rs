use redis::AsyncCommands;

use crate::edge::http::error::BusinessError;

/**
 * 敏感操作尝试防护。
 *
 * 作用：
 * 1. 做什么：统一维护登录、兑换码等敏感操作的失败计数与临时锁定规则，避免各业务模块重复拼 Redis key 与阈值判断。
 * 2. 做什么：把主体 + IP、主体、IP 三层维度的失败窗口与锁定窗口收敛到同一实现，保证 Rust 与 Node 的 key 结构保持一致。
 * 3. 不做什么：不负责真实业务校验，不决定请求是否成功，也不处理验证码或 QPS 规则。
 *
 * 输入 / 输出：
 * - 输入：Redis 客户端、操作名、主体标识、请求 IP、阈值策略。
 * - 输出：允许继续尝试时返回 `Ok(())`；达到锁定阈值时返回固定业务错误；业务失败/成功后负责更新或清理 Redis 计数。
 *
 * 数据流 / 状态流：
 * - 路由或应用服务构造作用域 -> `assert_allowed` 读取 block key
 * - 业务失败 -> `record_failure` 增量更新 failure key 并按阈值写入 block key
 * - 业务成功 -> `clear_failures` 清理主体相关失败与锁定状态。
 *
 * 复用设计说明：
 * - 登录与兑换码都共享同一套键构造与窗口算法；抽到这里后，后续密码修改、短信验证等入口可直接复用，不会在各服务里再长出第二套规则。
 * - key 规范化、TTL 写入和 block 判定统一收口，后续只需补策略常量，不需要复制底层 Redis 操作。
 *
 * 关键边界条件与坑点：
 * 1. 成功后只清理 `subject-ip / subject` 维度，不能误清理纯 IP 维度，否则会把同出口 IP 的异常流量一起放开。
 * 2. action、subject、ip 任一为空都视为服务端配置错误，必须走 500，不能静默拼出错误 key。
 */
#[derive(Debug, Clone)]
pub struct AttemptGuardService {
    redis: redis::Client,
}

#[derive(Debug, Clone, Copy)]
pub struct AttemptGuardPolicy {
    pub failure_window_ms: u64,
    pub block_window_ms: u64,
    pub subject_ip_failure_limit: i64,
    pub subject_failure_limit: i64,
    pub ip_failure_limit: i64,
    pub blocked_message: &'static str,
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

impl AttemptGuardService {
    pub fn new(redis: redis::Client) -> Self {
        Self { redis }
    }

    pub async fn assert_allowed(
        &self,
        action: &str,
        subject: &str,
        ip: &str,
        policy: AttemptGuardPolicy,
    ) -> Result<(), BusinessError> {
        let keys = build_attempt_guard_keys(action, subject, ip)?;
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
                policy.blocked_message,
                axum::http::StatusCode::TOO_MANY_REQUESTS,
            ));
        }

        Ok(())
    }

    pub async fn record_failure(
        &self,
        action: &str,
        subject: &str,
        ip: &str,
        policy: AttemptGuardPolicy,
    ) -> Result<(), BusinessError> {
        let keys = build_attempt_guard_keys(action, subject, ip)?;
        let mut redis = self.redis_connection().await?;
        let subject_ip = touch_failure_counter(
            &mut redis,
            &keys.subject_ip_failure_key,
            policy.failure_window_ms,
        )
        .await?;
        let subject = touch_failure_counter(
            &mut redis,
            &keys.subject_failure_key,
            policy.failure_window_ms,
        )
        .await?;
        let ip = touch_failure_counter(&mut redis, &keys.ip_failure_key, policy.failure_window_ms)
            .await?;

        if subject_ip >= policy.subject_ip_failure_limit {
            write_block_key(
                &mut redis,
                &keys.subject_ip_block_key,
                policy.block_window_ms,
            )
            .await?;
        }
        if subject >= policy.subject_failure_limit {
            write_block_key(&mut redis, &keys.subject_block_key, policy.block_window_ms).await?;
        }
        if ip >= policy.ip_failure_limit {
            write_block_key(&mut redis, &keys.ip_block_key, policy.block_window_ms).await?;
        }

        Ok(())
    }

    pub async fn clear_failures(
        &self,
        action: &str,
        subject: &str,
        ip: &str,
    ) -> Result<(), BusinessError> {
        let keys = build_attempt_guard_keys(action, subject, ip)?;
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

    async fn redis_connection(&self) -> Result<redis::aio::MultiplexedConnection, BusinessError> {
        self.redis
            .get_multiplexed_async_connection()
            .await
            .map_err(internal_business_error)
    }
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

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
