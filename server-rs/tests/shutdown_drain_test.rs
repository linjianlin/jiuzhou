use std::time::Duration;

use jiuzhou_server_rs::bootstrap::shutdown::{ShutdownPhase, ShutdownPlan};

#[test]
fn shutdown_plan_preserves_stop_drain_release_order() {
    let plan = ShutdownPlan::new(Duration::from_secs(30));
    assert_eq!(plan.drain_timeout, Duration::from_secs(30));
    assert_eq!(
        plan.phases(),
        [
            ShutdownPhase::StopAccepting,
            ShutdownPhase::DrainRuntime,
            ShutdownPhase::ReleaseResources,
        ]
    );
}
