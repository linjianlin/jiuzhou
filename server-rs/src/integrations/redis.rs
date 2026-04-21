use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::Arc;
use std::time::{Duration, Instant};

use redis::AsyncCommands;
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::Mutex;

use crate::config::RedisConfig;
use crate::shared::error::AppError;

#[derive(Debug, Clone)]
pub struct RedisRuntime {
    client: redis::Client,
}

#[derive(Debug, Clone)]
pub struct RedisLockLease {
    runtime: RedisRuntime,
    key: String,
    token: String,
}

#[derive(Clone)]
pub struct RedisCacheLayer<K, T> {
    runtime: RedisRuntime,
    key_prefix: String,
    redis_ttl_sec: u64,
    memory_ttl_ms: u64,
    loader: Arc<
        dyn Fn(K) -> std::pin::Pin<Box<dyn Future<Output = Result<Option<T>, AppError>> + Send>>
            + Send
            + Sync,
    >,
    memory_cache: Arc<Mutex<HashMap<K, CacheEntry<T>>>>,
    inflight_loads: Arc<Mutex<HashMap<K, Arc<Mutex<()>>>>>,
}

#[derive(Debug, Clone)]
struct CacheEntry<T> {
    payload: T,
    expires_at: Instant,
}

impl RedisRuntime {
    pub fn new(client: redis::Client) -> Self {
        Self { client }
    }

    pub async fn get_string(&self, key: &str) -> Result<Option<String>, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: Option<String> = connection.get(key).await?;
        Ok(value)
    }

    pub async fn incr(&self, key: &str) -> Result<i64, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: i64 = connection.incr(key, 1).await?;
        Ok(value)
    }

    pub async fn pexpire(&self, key: &str, ttl_ms: i64) -> Result<bool, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: bool = redis::cmd("PEXPIRE")
            .arg(key)
            .arg(ttl_ms)
            .query_async(&mut connection)
            .await?;
        Ok(value)
    }

    pub async fn psetex(&self, key: &str, ttl_ms: i64, value: &str) -> Result<(), AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let _: () = redis::cmd("PSETEX")
            .arg(key)
            .arg(ttl_ms)
            .arg(value)
            .query_async(&mut connection)
            .await?;
        Ok(())
    }

    pub async fn mget(&self, keys: &[&str]) -> Result<Vec<Option<String>>, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let values: Vec<Option<String>> = redis::cmd("MGET")
            .arg(keys)
            .query_async(&mut connection)
            .await?;
        Ok(values)
    }

    pub async fn del_many(&self, keys: &[&str]) -> Result<(), AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let _: usize = redis::cmd("DEL")
            .arg(keys)
            .query_async(&mut connection)
            .await?;
        Ok(())
    }

    pub async fn set_string_ex(
        &self,
        key: &str,
        value: &str,
        ttl_sec: u64,
    ) -> Result<(), AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let _: () = connection.set_ex(key, value, ttl_sec).await?;
        Ok(())
    }

    pub async fn del(&self, key: &str) -> Result<(), AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let _: usize = connection.del(key).await?;
        Ok(())
    }

    pub async fn scan_match(&self, pattern: &str, count: usize) -> Result<Vec<String>, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let mut cursor = 0_u64;
        let mut out = Vec::new();
        loop {
            let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(count.max(1))
                .query_async(&mut connection)
                .await?;
            out.extend(keys);
            if next_cursor == 0 {
                break;
            }
            cursor = next_cursor;
        }
        Ok(out)
    }

    pub async fn expire(&self, key: &str, ttl_sec: i64) -> Result<bool, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let applied: bool = connection.expire(key, ttl_sec).await?;
        Ok(applied)
    }

    pub async fn ttl(&self, key: &str) -> Result<i64, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let ttl: i64 = connection.ttl(key).await?;
        Ok(ttl)
    }

    pub async fn hgetall(&self, key: &str) -> Result<HashMap<String, String>, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: HashMap<String, String> = connection.hgetall(key).await?;
        Ok(value)
    }

    pub async fn hincrby(&self, key: &str, field: &str, increment: i64) -> Result<i64, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: i64 = connection.hincr(key, field, increment).await?;
        Ok(value)
    }

    pub async fn sadd(&self, key: &str, member: &str) -> Result<usize, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: usize = connection.sadd(key, member).await?;
        Ok(value)
    }

    pub async fn zadd(&self, key: &str, score: i64, member: &str) -> Result<usize, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: usize = redis::cmd("ZADD")
            .arg(key)
            .arg(score)
            .arg(member)
            .query_async(&mut connection)
            .await?;
        Ok(value)
    }

    pub async fn zremrangebyscore(
        &self,
        key: &str,
        min_score: i64,
        max_score: i64,
    ) -> Result<i64, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: i64 = redis::cmd("ZREMRANGEBYSCORE")
            .arg(key)
            .arg(min_score)
            .arg(max_score)
            .query_async(&mut connection)
            .await?;
        Ok(value)
    }

    pub async fn zcount(&self, key: &str, min_score: i64, max_score: i64) -> Result<i64, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: i64 = redis::cmd("ZCOUNT")
            .arg(key)
            .arg(min_score)
            .arg(max_score)
            .query_async(&mut connection)
            .await?;
        Ok(value)
    }

    pub async fn zrange_withscores(
        &self,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<Vec<String>, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: Vec<String> = redis::cmd("ZRANGE")
            .arg(key)
            .arg(start)
            .arg(stop)
            .arg("WITHSCORES")
            .query_async(&mut connection)
            .await?;
        Ok(value)
    }

    pub async fn srandmember(&self, key: &str, count: usize) -> Result<Vec<String>, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let value: Vec<String> = redis::cmd("SRANDMEMBER")
            .arg(key)
            .arg(count)
            .query_async(&mut connection)
            .await?;
        Ok(value)
    }

    pub async fn eval_i64(
        &self,
        script: &str,
        keys: &[&str],
        args: &[&str],
    ) -> Result<i64, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let mut command = redis::cmd("EVAL");
        command.arg(script).arg(keys.len());
        for key in keys {
            command.arg(key);
        }
        for arg in args {
            command.arg(arg);
        }
        let result: i64 = command.query_async(&mut connection).await?;
        Ok(result)
    }

    pub async fn with_pipeline<F>(&self, build: F) -> Result<(), AppError>
    where
        F: FnOnce(&mut redis::Pipeline),
    {
        let mut pipeline = redis::pipe();
        build(&mut pipeline);
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let _: redis::Value = pipeline.query_async(&mut connection).await?;
        Ok(())
    }

    pub async fn acquire_lock(
        &self,
        key: &str,
        token: &str,
        ttl_sec: u64,
    ) -> Result<Option<RedisLockLease>, AppError> {
        let mut connection = self.client.get_multiplexed_tokio_connection().await?;
        let acquired: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(token)
            .arg("EX")
            .arg(ttl_sec)
            .arg("NX")
            .query_async(&mut connection)
            .await?;

        if acquired.is_some() {
            return Ok(Some(RedisLockLease {
                runtime: self.clone(),
                key: key.to_string(),
                token: token.to_string(),
            }));
        }

        Ok(None)
    }
}

impl RedisLockLease {
    pub async fn release(self) -> Result<bool, AppError> {
        const RELEASE_LOCK_LUA: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"#;
        Ok(self
            .runtime
            .eval_i64(RELEASE_LOCK_LUA, &[&self.key], &[&self.token])
            .await?
            == 1)
    }
}

impl<K, T> RedisCacheLayer<K, T>
where
    K: Clone + Eq + Hash + ToString + Send + 'static,
    T: Clone + Serialize + DeserializeOwned + Send + 'static,
{
    pub fn new<F, Fut>(
        runtime: RedisRuntime,
        key_prefix: impl Into<String>,
        redis_ttl_sec: u64,
        memory_ttl_ms: u64,
        loader: F,
    ) -> Self
    where
        F: Fn(K) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<T>, AppError>> + Send + 'static,
    {
        Self {
            runtime,
            key_prefix: key_prefix.into(),
            redis_ttl_sec,
            memory_ttl_ms,
            loader: Arc::new(move |key| Box::pin(loader(key))),
            memory_cache: Arc::new(Mutex::new(HashMap::new())),
            inflight_loads: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn get(&self, key: K) -> Result<Option<T>, AppError> {
        if let Some(entry) = self.memory_cache.lock().await.get(&key).cloned()
            && entry.expires_at > Instant::now()
        {
            return Ok(Some(entry.payload));
        }

        let redis_key = format!("{}{}", self.key_prefix, key.to_string());
        if let Ok(Some(raw)) = self.runtime.get_string(&redis_key).await {
            let value: T = serde_json::from_str(&raw).map_err(|error| {
                AppError::config(format!("failed to deserialize redis cache entry: {error}"))
            })?;
            self.memory_cache.lock().await.insert(
                key.clone(),
                CacheEntry {
                    payload: value.clone(),
                    expires_at: Instant::now() + Duration::from_millis(self.memory_ttl_ms.max(1)),
                },
            );
            return Ok(Some(value));
        }

        let inflight_lock = {
            let mut inflight = self.inflight_loads.lock().await;
            inflight
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };

        let _guard = inflight_lock.lock().await;

        if let Some(entry) = self.memory_cache.lock().await.get(&key).cloned()
            && entry.expires_at > Instant::now()
        {
            return Ok(Some(entry.payload));
        }

        let loaded = (self.loader)(key.clone()).await?;
        if let Some(value) = loaded.clone() {
            self.memory_cache.lock().await.insert(
                key.clone(),
                CacheEntry {
                    payload: value.clone(),
                    expires_at: Instant::now() + Duration::from_millis(self.memory_ttl_ms.max(1)),
                },
            );
            if let Ok(serialized) = serde_json::to_string(&value) {
                let _ = self
                    .runtime
                    .set_string_ex(&redis_key, &serialized, self.redis_ttl_sec.max(1))
                    .await;
            }
        }

        self.inflight_loads.lock().await.remove(&key);
        Ok(loaded)
    }

    pub async fn set(&self, key: K, value: T) -> Result<(), AppError> {
        let redis_key = format!("{}{}", self.key_prefix, key.to_string());
        let serialized = serde_json::to_string(&value).map_err(|error| {
            AppError::config(format!("failed to serialize redis cache entry: {error}"))
        })?;
        self.memory_cache.lock().await.insert(
            key.clone(),
            CacheEntry {
                payload: value,
                expires_at: Instant::now() + Duration::from_millis(self.memory_ttl_ms.max(1)),
            },
        );
        self.inflight_loads.lock().await.remove(&key);
        let _ = self
            .runtime
            .set_string_ex(&redis_key, &serialized, self.redis_ttl_sec.max(1))
            .await;
        Ok(())
    }

    pub async fn invalidate(&self, key: K) -> Result<(), AppError> {
        let redis_key = format!("{}{}", self.key_prefix, key.to_string());
        self.memory_cache.lock().await.remove(&key);
        self.inflight_loads.lock().await.remove(&key);
        let _ = self.runtime.del(&redis_key).await;
        Ok(())
    }

    pub async fn invalidate_all(&self) {
        self.memory_cache.lock().await.clear();
        self.inflight_loads.lock().await.clear();
    }
}

pub async fn connect(config: &RedisConfig) -> Result<(redis::Client, bool), AppError> {
    let client = redis::Client::open(config.url.clone())?;

    let available = match client.get_multiplexed_tokio_connection().await {
        Ok(mut connection) => {
            let pong: Result<String, redis::RedisError> =
                redis::cmd("PING").query_async(&mut connection).await;
            match pong {
                Ok(value) => value.eq_ignore_ascii_case("PONG"),
                Err(error) => {
                    tracing::warn!(error = %error, "Redis ping failed during startup");
                    false
                }
            }
        }
        Err(error) => {
            tracing::warn!(error = %error, "Redis connection failed during startup");
            false
        }
    };

    Ok((client, available))
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::RedisCacheLayer;
    use crate::shared::error::AppError;

    #[tokio::test]
    async fn cache_layer_singleflight_runs_loader_once() {
        let runtime = super::RedisRuntime::new(
            redis::Client::open("redis://127.0.0.1:6379").expect("redis client should build"),
        );
        let loader_calls = Arc::new(AtomicUsize::new(0));
        let loader_calls_for_cache = Arc::clone(&loader_calls);
        let cache = RedisCacheLayer::new(runtime, "test:", 60, 1_000, move |key: u64| {
            let loader_calls = Arc::clone(&loader_calls_for_cache);
            async move {
                loader_calls.fetch_add(1, Ordering::SeqCst);
                Ok::<Option<String>, AppError>(Some(format!("value-{key}")))
            }
        });

        let (left, right) = tokio::join!(cache.get(7), cache.get(7));
        assert_eq!(
            left.expect("left should succeed"),
            Some("value-7".to_string())
        );
        assert_eq!(
            right.expect("right should succeed"),
            Some("value-7".to_string())
        );
        assert_eq!(loader_calls.load(Ordering::SeqCst), 1);
    }
}
