use crate::infra::config::settings::Settings;
use crate::shared::error::AppError;
use redis::AsyncCommands;

#[derive(Clone)]
pub struct AppRedis {
    pub client: redis::Client,
}

pub async fn build_redis(settings: &Settings) -> Result<AppRedis, AppError> {
    let client = redis::Client::open(settings.redis.url.clone())?;
    Ok(AppRedis { client })
}

impl AppRedis {
    pub async fn get_string(&self, key: &str) -> Result<Option<String>, AppError> {
        let mut connection = self.client.get_multiplexed_async_connection().await?;
        connection.get(key).await.map_err(Into::into)
    }

    pub async fn smembers(&self, key: &str) -> Result<Vec<String>, AppError> {
        let mut connection = self.client.get_multiplexed_async_connection().await?;
        connection.smembers(key).await.map_err(Into::into)
    }

    pub async fn keys(&self, pattern: &str) -> Result<Vec<String>, AppError> {
        let mut connection = self.client.get_multiplexed_async_connection().await?;
        redis::cmd("KEYS")
            .arg(pattern)
            .query_async(&mut connection)
            .await
            .map_err(Into::into)
    }
}
