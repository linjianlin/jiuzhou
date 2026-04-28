#[cfg(unix)]
use tokio::signal::unix::{SignalKind, signal};

use crate::jobs::{JobRuntime, flush_pending_runtime_deltas};
use crate::realtime::RealtimeRuntime;
use crate::shared::game_time::shutdown_game_time_runtime;
use crate::state::AppState;

pub async fn wait_for_shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut stream) = signal(SignalKind::terminate()) {
            let _ = stream.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("received ctrl-c signal");
        }
        _ = terminate => {
            tracing::info!("received terminate signal");
        }
    }
}

pub async fn shutdown_application(
    state: AppState,
    realtime_runtime: RealtimeRuntime,
    job_runtime: JobRuntime,
) {
    tracing::info!("starting graceful shutdown sequence");
    tracing::info!("→ shutting down realtime runtime");
    realtime_runtime.shutdown().await;
    tracing::info!("✓ realtime runtime stopped");

    tracing::info!("→ flushing game time runtime");
    if let Err(error) = shutdown_game_time_runtime(&state).await {
        tracing::error!(error = %error, "game time runtime flush failed during shutdown");
    } else {
        tracing::info!("✓ game time runtime flushed");
    }

    tracing::info!("→ shutting down job runtime");
    job_runtime.shutdown().await;
    tracing::info!("✓ job runtime stopped");

    tracing::info!("→ draining outstanding tasks");
    tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
    tracing::info!("✓ drain window elapsed");

    tracing::info!("→ flushing pending runtime deltas");
    match flush_pending_runtime_deltas(&state).await {
        Ok(summary) => {
            tracing::info!(
                progress_character_count = summary.progress_character_count,
                item_grant_character_count = summary.item_grant_character_count,
                item_instance_mutation_character_count =
                    summary.item_instance_mutation_character_count,
                resource_character_count = summary.resource_character_count,
                "✓ pending runtime deltas flushed"
            );
        }
        Err(error) => {
            tracing::error!(error = %error, "pending runtime delta flush failed during shutdown");
        }
    }

    tracing::info!("→ closing database runtime");
    state.database.close().await;
    tracing::info!("✓ database runtime closed");

    if state.redis_available {
        tracing::info!("✓ redis client dropped with application state");
    } else {
        tracing::info!("✓ redis was unavailable; no redis shutdown required");
    }
}

#[cfg(test)]
mod tests {
    fn assert_source_order(source: &str, earlier: &str, later: &str) {
        let earlier_index = source
            .find(earlier)
            .unwrap_or_else(|| panic!("shutdown source missing earlier marker: {earlier}"));
        let later_index = source
            .find(later)
            .unwrap_or_else(|| panic!("shutdown source missing later marker: {later}"));
        assert!(
            earlier_index < later_index,
            "expected `{earlier}` to appear before `{later}`"
        );
    }

    #[test]
    fn shutdown_source_orders_game_time_before_job_runtime() {
        let source = include_str!("shutdown.rs");
        let implementation_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("shutdown source should include implementation before tests");

        assert_source_order(
            implementation_source,
            "shutdown_game_time_runtime(&state)",
            "job_runtime.shutdown().await",
        );
    }

    #[test]
    fn shutdown_source_uses_node_drain_window() {
        let source = include_str!("shutdown.rs");
        let implementation_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("shutdown source should include implementation before tests");

        assert_source_order(
            implementation_source,
            "job_runtime.shutdown().await",
            "std::time::Duration::from_millis(2_000)",
        );
        assert_source_order(
            implementation_source,
            "std::time::Duration::from_millis(2_000)",
            "flush_pending_runtime_deltas(&state)",
        );
        assert_source_order(
            implementation_source,
            "flush_pending_runtime_deltas(&state)",
            "state.database.close().await",
        );
    }
}
