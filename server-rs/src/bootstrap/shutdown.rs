use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownPhase {
    StopAccepting,
    DrainRuntime,
    ReleaseResources,
}

#[derive(Debug, Clone)]
pub struct ShutdownPlan {
    pub drain_timeout: Duration,
}

impl ShutdownPlan {
    pub fn new(drain_timeout: Duration) -> Self {
        Self { drain_timeout }
    }

    pub fn phases(&self) -> [ShutdownPhase; 3] {
        [
            ShutdownPhase::StopAccepting,
            ShutdownPhase::DrainRuntime,
            ShutdownPhase::ReleaseResources,
        ]
    }
}
