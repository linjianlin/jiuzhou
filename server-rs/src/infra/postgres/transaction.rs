use std::future::Future;

use sqlx::{PgPool, Postgres, Transaction};

use crate::shared::error::AppError;

pub async fn run_in_transaction<T, F, Fut>(pool: &PgPool, action: F) -> Result<T, AppError>
where
    F: for<'tx> FnOnce(&'tx mut Transaction<'_, Postgres>) -> Fut,
    Fut: Future<Output = Result<T, AppError>>,
{
    let mut transaction = pool.begin().await?;
    match action(&mut transaction).await {
        Ok(value) => {
            transaction.commit().await?;
            Ok(value)
        }
        Err(error) => {
            transaction.rollback().await?;
            Err(error)
        }
    }
}
