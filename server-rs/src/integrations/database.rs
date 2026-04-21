use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::migrate::Migrator;
use sqlx::postgres::{PgArguments, PgPoolOptions, PgQueryResult, PgRow};
use sqlx::query::Query;
use sqlx::{PgPool, Postgres, query, query_scalar};
use tokio::sync::Mutex;

use crate::config::DatabaseConfig;
use crate::shared::error::AppError;

tokio::task_local! {
    static TRANSACTION_CONTEXT: Arc<TransactionContext>;
}

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

type AfterCommitFuture = Pin<Box<dyn Future<Output = Result<(), AppError>> + Send>>;

struct TransactionContext {
    connection: Mutex<Option<sqlx::pool::PoolConnection<Postgres>>>,
    rollback_only: AtomicBool,
    rollback_cause: Mutex<Option<String>>,
    after_commit_callbacks: Mutex<Vec<AfterCommitFuture>>,
}

impl TransactionContext {
    fn new(connection: sqlx::pool::PoolConnection<Postgres>) -> Self {
        Self {
            connection: Mutex::new(Some(connection)),
            rollback_only: AtomicBool::new(false),
            rollback_cause: Mutex::new(None),
            after_commit_callbacks: Mutex::new(Vec::new()),
        }
    }

    #[cfg(test)]
    fn empty_for_test() -> Self {
        Self {
            connection: Mutex::new(None),
            rollback_only: AtomicBool::new(false),
            rollback_cause: Mutex::new(None),
            after_commit_callbacks: Mutex::new(Vec::new()),
        }
    }

    async fn mark_rollback_only(&self, cause: impl Into<String>) {
        self.rollback_only.store(true, Ordering::SeqCst);
        let mut rollback_cause = self.rollback_cause.lock().await;
        if rollback_cause.is_none() {
            *rollback_cause = Some(cause.into());
        }
    }

    async fn rollback_cause_message(&self) -> String {
        self.rollback_cause
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "未知错误".to_string())
    }
}

#[derive(Debug, Clone)]
pub struct DatabaseRuntime {
    pool: PgPool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationSummary {
    pub adopted_existing_schema_as_baseline: bool,
    pub previously_applied_migration_count: i64,
    pub total_applied_migration_count: i64,
    pub newly_applied_migration_count: i64,
}

impl DatabaseRuntime {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn apply_migrations(&self) -> Result<MigrationSummary, AppError> {
        let adopted_existing_schema_as_baseline = adopt_existing_schema_as_baseline(&self.pool).await?;
        let previously_applied_migration_count = count_applied_migrations(&self.pool).await?;
        MIGRATOR
            .run(&self.pool)
            .await
            .map_err(|error| AppError::config(format!("failed to run sqlx migrations: {error}")))?;
        let total_applied_migration_count = count_applied_migrations(&self.pool).await?;
        Ok(MigrationSummary {
            adopted_existing_schema_as_baseline,
            previously_applied_migration_count,
            total_applied_migration_count,
            newly_applied_migration_count: total_applied_migration_count
                .saturating_sub(previously_applied_migration_count),
        })
    }

    pub fn is_in_transaction(&self) -> bool {
        TRANSACTION_CONTEXT.try_with(|_| ()).is_ok()
    }

    pub async fn execute<'q, F>(&self, sql: &'q str, bind: F) -> Result<PgQueryResult, AppError>
    where
        F: FnOnce(Query<'q, Postgres, PgArguments>) -> Query<'q, Postgres, PgArguments>,
    {
        if !self.is_in_transaction() && is_write_sql(sql) {
            return self
                .with_transaction(|| async move { self.execute_in_current_context(sql, bind).await })
                .await;
        }

        self.execute_in_current_context(sql, bind).await
    }

    pub async fn fetch_optional<'q, F>(&self, sql: &'q str, bind: F) -> Result<Option<PgRow>, AppError>
    where
        F: FnOnce(Query<'q, Postgres, PgArguments>) -> Query<'q, Postgres, PgArguments>,
    {
        self.fetch_optional_in_current_context(sql, bind).await
    }

    pub async fn fetch_one<'q, F>(&self, sql: &'q str, bind: F) -> Result<PgRow, AppError>
    where
        F: FnOnce(Query<'q, Postgres, PgArguments>) -> Query<'q, Postgres, PgArguments>,
    {
        if let Ok(context) = TRANSACTION_CONTEXT.try_with(Arc::clone) {
            let mut connection = context.connection.lock().await;
            let connection = connection
                .as_mut()
                .expect("transaction-scoped query requires an active connection");
            return Ok(bind(sqlx::query(sql)).fetch_one(&mut **connection).await?);
        }

        Ok(bind(sqlx::query(sql)).fetch_one(&self.pool).await?)
    }

    pub async fn fetch_all<'q, F>(&self, sql: &'q str, bind: F) -> Result<Vec<PgRow>, AppError>
    where
        F: FnOnce(Query<'q, Postgres, PgArguments>) -> Query<'q, Postgres, PgArguments>,
    {
        if let Ok(context) = TRANSACTION_CONTEXT.try_with(Arc::clone) {
            let mut connection = context.connection.lock().await;
            let connection = connection
                .as_mut()
                .expect("transaction-scoped query requires an active connection");
            return Ok(bind(sqlx::query(sql)).fetch_all(&mut **connection).await?);
        }

        Ok(bind(sqlx::query(sql)).fetch_all(&self.pool).await?)
    }

    pub async fn with_transaction<T, F, Fut>(&self, callback: F) -> Result<T, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, AppError>>,
    {
        if let Ok(context) = TRANSACTION_CONTEXT.try_with(Arc::clone) {
            let result = callback().await;
            if let Err(error) = &result {
                context.mark_rollback_only(error.to_string()).await;
            }
            return result;
        }

        let mut connection = self.pool.acquire().await?;
        sqlx::query("BEGIN").execute(&mut *connection).await?;

        let context = Arc::new(TransactionContext::new(connection));
        let result = TRANSACTION_CONTEXT.scope(Arc::clone(&context), callback()).await;
        let rollback_only = context.rollback_only.load(Ordering::SeqCst);

        if result.is_ok() && rollback_only {
            let cause_message = context.rollback_cause_message().await;
            let mut connection = context.connection.lock().await;
            let connection = connection
                .as_mut()
                .expect("root transaction context should own a database connection");
            sqlx::query("ROLLBACK").execute(&mut **connection).await?;
            return Err(AppError::TransactionRollbackOnly(format!(
                "事务已标记为回滚：调用链中存在失败操作（{cause_message}）"
            )));
        }

        match result {
            Ok(value) => {
                {
                    let mut connection = context.connection.lock().await;
                    let connection = connection
                        .as_mut()
                        .expect("root transaction context should own a database connection");
                    sqlx::query("COMMIT").execute(&mut **connection).await?;
                }

                let callbacks = {
                    let mut callbacks = context.after_commit_callbacks.lock().await;
                    std::mem::take(&mut *callbacks)
                };
                for callback in callbacks {
                    callback.await?;
                }

                Ok(value)
            }
            Err(error) => {
                let mut connection = context.connection.lock().await;
                let connection = connection
                    .as_mut()
                    .expect("root transaction context should own a database connection");
                sqlx::query("ROLLBACK").execute(&mut **connection).await?;
                Err(error)
            }
        }
    }

    pub async fn after_transaction_commit<Fut>(&self, callback: Fut) -> Result<(), AppError>
    where
        Fut: Future<Output = Result<(), AppError>> + Send + 'static,
    {
        if let Ok(context) = TRANSACTION_CONTEXT.try_with(Arc::clone) {
            context.after_commit_callbacks.lock().await.push(Box::pin(callback));
            return Ok(());
        }

        callback.await
    }

    async fn execute_in_current_context<'q, F>(
        &self,
        sql: &'q str,
        bind: F,
    ) -> Result<PgQueryResult, AppError>
    where
        F: FnOnce(Query<'q, Postgres, PgArguments>) -> Query<'q, Postgres, PgArguments>,
    {
        if let Ok(context) = TRANSACTION_CONTEXT.try_with(Arc::clone) {
            let mut connection = context.connection.lock().await;
            let connection = connection
                .as_mut()
                .expect("transaction-scoped query requires an active connection");
            return Ok(bind(sqlx::query(sql)).execute(&mut **connection).await?);
        }

        Ok(bind(sqlx::query(sql)).execute(&self.pool).await?)
    }

    async fn fetch_optional_in_current_context<'q, F>(
        &self,
        sql: &'q str,
        bind: F,
    ) -> Result<Option<PgRow>, AppError>
    where
        F: FnOnce(Query<'q, Postgres, PgArguments>) -> Query<'q, Postgres, PgArguments>,
    {
        if let Ok(context) = TRANSACTION_CONTEXT.try_with(Arc::clone) {
            let mut connection = context.connection.lock().await;
            let connection = connection
                .as_mut()
                .expect("transaction-scoped query requires an active connection");
            return Ok(bind(sqlx::query(sql)).fetch_optional(&mut **connection).await?);
        }

        Ok(bind(sqlx::query(sql)).fetch_optional(&self.pool).await?)
    }
}

fn is_write_sql(sql: &str) -> bool {
    let normalized = sql.trim_start().to_uppercase();
    normalized.starts_with("INSERT")
        || normalized.starts_with("UPDATE")
        || normalized.starts_with("DELETE")
        || normalized.starts_with("MERGE")
        || normalized.starts_with("REPLACE")
        || normalized.starts_with("TRUNCATE")
        || (normalized.starts_with("SELECT") && normalized.contains("FOR UPDATE"))
        || (normalized.starts_with("WITH")
            && ["INSERT", "UPDATE", "DELETE", "MERGE"]
                .iter()
                .any(|keyword| normalized.contains(keyword)))
}

async fn count_applied_migrations(pool: &PgPool) -> Result<i64, AppError> {
    let migration_table_exists = query_scalar::<_, bool>(
        "SELECT to_regclass('public._sqlx_migrations') IS NOT NULL",
    )
    .fetch_one(pool)
    .await?;
    if !migration_table_exists {
        return Ok(0);
    }

    Ok(query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM _sqlx_migrations")
        .fetch_one(pool)
        .await?)
}

async fn adopt_existing_schema_as_baseline(pool: &PgPool) -> Result<bool, AppError> {
    let migration_table_exists = query_scalar::<_, bool>(
        "SELECT to_regclass('public._sqlx_migrations') IS NOT NULL",
    )
    .fetch_one(pool)
    .await?;
    if migration_table_exists {
        return Ok(false);
    }

    let public_table_count = query_scalar::<_, i64>(
        "SELECT COUNT(*)::bigint FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await?;
    if public_table_count <= 0 {
        return Ok(false);
    }

    let Some(baseline_migration) = MIGRATOR.iter().next() else {
        return Ok(false);
    };

    query(
        r#"
CREATE TABLE IF NOT EXISTS _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
    success BOOLEAN NOT NULL,
    checksum BYTEA NOT NULL,
    execution_time BIGINT NOT NULL
)
        "#,
    )
    .execute(pool)
    .await?;

    query(
        r#"
INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
VALUES ($1, $2, TRUE, $3, 0)
ON CONFLICT (version) DO NOTHING
        "#,
    )
    .bind(baseline_migration.version)
    .bind(baseline_migration.description.as_ref())
    .bind(baseline_migration.checksum.as_ref())
    .execute(pool)
    .await?;

    Ok(true)
}

pub async fn connect(config: &DatabaseConfig) -> Result<DatabaseRuntime, AppError> {
    let pool = PgPoolOptions::new()
        .max_connections(250)
        .connect(&config.url)
        .await?;

    query("SELECT 1").execute(&pool).await?;

    Ok(DatabaseRuntime::new(pool))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use sqlx::PgPool;
    use tokio::sync::Mutex;

    use super::{DatabaseRuntime, TRANSACTION_CONTEXT, TransactionContext};
    use crate::shared::error::AppError;

    #[tokio::test]
    async fn after_commit_runs_immediately_outside_transaction() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://postgres:postgres@localhost:5432/jiuzhou")
            .expect("lazy pool should build");
        let runtime = DatabaseRuntime::new(pool);
        let marker = Arc::new(Mutex::new(false));
        let marker_for_callback = Arc::clone(&marker);

        runtime
            .after_transaction_commit(async move {
                *marker_for_callback.lock().await = true;
                Ok(())
            })
            .await
            .expect("callback should run");

        assert!(*marker.lock().await);
    }

    #[test]
    fn write_sql_detection_matches_expected_commands() {
        assert!(super::is_write_sql("INSERT INTO users(id) VALUES (1)"));
        assert!(super::is_write_sql("SELECT * FROM users FOR UPDATE"));
        assert!(!super::is_write_sql("SELECT * FROM users"));
    }

    #[tokio::test]
    async fn nested_transaction_marks_root_as_rollback_only() {
        let pool = PgPool::connect_lazy("postgresql://postgres:postgres@localhost:5432/jiuzhou")
            .expect("lazy pool should build");
        let runtime = DatabaseRuntime::new(pool);
        let context = Arc::new(TransactionContext::empty_for_test());

        let result = TRANSACTION_CONTEXT
            .scope(Arc::clone(&context), async {
                let nested = runtime
                    .with_transaction(|| async { Err::<(), AppError>(AppError::config("nested failure")) })
                    .await;
                assert!(nested.is_err());
                Ok::<(), AppError>(())
            })
            .await;

        assert!(result.is_ok());
        assert!(context.rollback_only.load(Ordering::SeqCst));
        assert_eq!(context.rollback_cause_message().await, "configuration error: nested failure");
    }
}
