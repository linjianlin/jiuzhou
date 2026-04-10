use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct ReadinessGate {
    ready: Arc<AtomicBool>,
}

impl ReadinessGate {
    pub fn new() -> Self {
        Self {
            ready: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn mark_unready(&self) {
        self.ready.store(false, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
}

impl Default for ReadinessGate {
    fn default() -> Self {
        Self::new()
    }
}
