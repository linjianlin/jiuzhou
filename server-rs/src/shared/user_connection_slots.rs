use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use tokio::sync::oneshot;
use tokio::time::{Duration, timeout};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UserConnectionSlotChannel {
    HttpRequest,
    GameAuth,
}

#[derive(Debug)]
pub struct UserConnectionSlotLease {
    channel: UserConnectionSlotChannel,
    user_id: i64,
    slot_id: String,
    released: bool,
}

#[derive(Debug)]
struct PendingRequest {
    slot_id: String,
    limit: usize,
    sender: oneshot::Sender<UserConnectionSlotLease>,
}

#[derive(Debug, Default)]
struct UserConnectionSlotState {
    active_slots: HashSet<String>,
    pending_queue: VecDeque<PendingRequest>,
}

type ChannelSlots = HashMap<i64, UserConnectionSlotState>;
type SlotStore = HashMap<UserConnectionSlotChannel, ChannelSlots>;

static SLOT_STORE: OnceLock<Mutex<SlotStore>> = OnceLock::new();

fn slot_store() -> &'static Mutex<SlotStore> {
    SLOT_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl UserConnectionSlotLease {
    pub fn release(mut self) {
        if self.released {
            return;
        }
        self.released = true;
        release_slot(self.channel, self.user_id, &self.slot_id);
    }
}

fn assert_positive_i64(value: i64, field_name: &str) -> i64 {
    if value <= 0 {
        panic!("{field_name} must be a positive integer");
    }
    value
}

fn assert_positive_usize(value: usize, field_name: &str) -> usize {
    if value == 0 {
        panic!("{field_name} must be a positive integer");
    }
    value
}

fn cleanup_user_slots(channel: UserConnectionSlotChannel, user_id: i64) {
    let mut store = slot_store().lock().expect("slot store lock poisoned");
    let mut should_remove_channel = false;

    if let Some(channel_slots) = store.get_mut(&channel) {
        if let Some(user_slots) = channel_slots.get(&user_id) {
            if user_slots.active_slots.is_empty() && user_slots.pending_queue.is_empty() {
                channel_slots.remove(&user_id);
            }
        }
        should_remove_channel = channel_slots.is_empty();
    }

    if should_remove_channel {
        store.remove(&channel);
    }
}

fn promote_queued_slots(channel: UserConnectionSlotChannel, user_id: i64) {
    let mut pending_to_resume = Vec::new();

    {
        let mut store = slot_store().lock().expect("slot store lock poisoned");
        let Some(user_slots) = store.get_mut(&channel).and_then(|channel_slots| channel_slots.get_mut(&user_id)) else {
            return;
        };

        while let Some(next_pending) = user_slots.pending_queue.front() {
            if user_slots.active_slots.len() >= next_pending.limit {
                break;
            }
            let next_pending = user_slots.pending_queue.pop_front().expect("pending queue should contain item");
            user_slots.active_slots.insert(next_pending.slot_id.clone());
            pending_to_resume.push(next_pending);
        }
    }

    for pending in pending_to_resume {
        let _ = pending.sender.send(UserConnectionSlotLease {
            channel,
            user_id,
            slot_id: pending.slot_id,
            released: false,
        });
    }

    cleanup_user_slots(channel, user_id);
}

fn release_slot(channel: UserConnectionSlotChannel, user_id: i64, slot_id: &str) {
    {
        let mut store = slot_store().lock().expect("slot store lock poisoned");
        if let Some(user_slots) = store.get_mut(&channel).and_then(|channel_slots| channel_slots.get_mut(&user_id)) {
            user_slots.active_slots.remove(slot_id);
        }
    }

    promote_queued_slots(channel, user_id);
    cleanup_user_slots(channel, user_id);
}

pub fn get_active_user_connection_slot_count(
    channel: UserConnectionSlotChannel,
    user_id: i64,
) -> usize {
    let user_id = assert_positive_i64(user_id, "user_id");
    slot_store()
        .lock()
        .expect("slot store lock poisoned")
        .get(&channel)
        .and_then(|channel_slots| channel_slots.get(&user_id))
        .map(|user_slots| user_slots.active_slots.len())
        .unwrap_or(0)
}

pub fn acquire_user_connection_slot(
    channel: UserConnectionSlotChannel,
    user_id: i64,
    slot_id: impl Into<String>,
    limit: usize,
) -> Option<UserConnectionSlotLease> {
    let user_id = assert_positive_i64(user_id, "user_id");
    let limit = assert_positive_usize(limit, "limit");
    let slot_id = slot_id.into();
    assert!(!slot_id.trim().is_empty(), "slot_id cannot be empty");

    let mut store = slot_store().lock().expect("slot store lock poisoned");
    let channel_slots = store.entry(channel).or_default();
    let user_slots = channel_slots.entry(user_id).or_default();

    if !user_slots.active_slots.contains(&slot_id) && user_slots.active_slots.len() >= limit {
        return None;
    }

    user_slots.active_slots.insert(slot_id.clone());
    Some(UserConnectionSlotLease {
        channel,
        user_id,
        slot_id,
        released: false,
    })
}

pub async fn wait_for_user_connection_slot(
    channel: UserConnectionSlotChannel,
    user_id: i64,
    slot_id: impl Into<String>,
    limit: usize,
    wait_ms: u64,
) -> Option<UserConnectionSlotLease> {
    let user_id = assert_positive_i64(user_id, "user_id");
    let limit = assert_positive_usize(limit, "limit");
    let slot_id = slot_id.into();
    assert!(!slot_id.trim().is_empty(), "slot_id cannot be empty");

    if let Some(lease) = acquire_user_connection_slot(channel, user_id, slot_id.clone(), limit) {
        return Some(lease);
    }

    let (sender, receiver) = oneshot::channel();
    {
        let mut store = slot_store().lock().expect("slot store lock poisoned");
        let channel_slots = store.entry(channel).or_default();
        let user_slots = channel_slots.entry(user_id).or_default();
        user_slots.pending_queue.push_back(PendingRequest {
            slot_id: slot_id.clone(),
            limit,
            sender,
        });
    }

    tracing::info!(
        channel = ?channel,
        user_id,
        limit,
        wait_ms,
        slot_id,
        "user connection slot queued"
    );

    match timeout(Duration::from_millis(wait_ms), receiver).await {
        Ok(Ok(lease)) => Some(lease),
        _ => {
            let mut store = slot_store().lock().expect("slot store lock poisoned");
            if let Some(user_slots) = store.get_mut(&channel).and_then(|channel_slots| channel_slots.get_mut(&user_id)) {
                user_slots.pending_queue.retain(|pending| pending.slot_id != slot_id);
            }
            drop(store);
            cleanup_user_slots(channel, user_id);
            None
        }
    }
}

pub fn reset_user_connection_slots_for_test() {
    slot_store().lock().expect("slot store lock poisoned").clear();
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    use tokio::time::{Duration, sleep};

    use super::{
        UserConnectionSlotChannel, acquire_user_connection_slot,
        get_active_user_connection_slot_count, reset_user_connection_slots_for_test,
        wait_for_user_connection_slot,
    };

    fn test_lock() -> &'static Mutex<()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn acquire_rejects_when_limit_is_exceeded() {
        let _guard = test_lock().lock().expect("test lock poisoned");
        reset_user_connection_slots_for_test();

        let first = acquire_user_connection_slot(UserConnectionSlotChannel::HttpRequest, 1001, "req-1", 2);
        let second = acquire_user_connection_slot(UserConnectionSlotChannel::HttpRequest, 1001, "req-2", 2);
        let rejected = acquire_user_connection_slot(UserConnectionSlotChannel::HttpRequest, 1001, "req-3", 2);

        assert!(first.is_some());
        assert!(second.is_some());
        assert!(rejected.is_none());
        assert_eq!(get_active_user_connection_slot_count(UserConnectionSlotChannel::HttpRequest, 1001), 2);
    }

    #[test]
    fn acquire_is_idempotent_for_same_slot_id() {
        let _guard = test_lock().lock().expect("test lock poisoned");
        reset_user_connection_slots_for_test();

        let first = acquire_user_connection_slot(UserConnectionSlotChannel::GameAuth, 2002, "socket-1", 1);
        let repeated = acquire_user_connection_slot(UserConnectionSlotChannel::GameAuth, 2002, "socket-1", 1);

        assert!(first.is_some());
        assert!(repeated.is_some());
        assert_eq!(get_active_user_connection_slot_count(UserConnectionSlotChannel::GameAuth, 2002), 1);
    }

    #[tokio::test]
    async fn wait_promotes_fifo_after_release() {
        let _guard = test_lock().lock().expect("test lock poisoned");
        reset_user_connection_slots_for_test();

        let first = acquire_user_connection_slot(UserConnectionSlotChannel::HttpRequest, 5005, "req-1", 1)
            .expect("first lease should be acquired");

        let waiting = tokio::spawn(async move {
            let lease = wait_for_user_connection_slot(
                UserConnectionSlotChannel::HttpRequest,
                5005,
                "req-2",
                1,
                100,
            )
            .await;
            assert!(lease.is_some());
            lease.expect("lease should exist").release();
        });

        tokio::task::yield_now().await;
        sleep(Duration::from_millis(20)).await;
        first.release();
        waiting.await.expect("task should finish");
        assert_eq!(get_active_user_connection_slot_count(UserConnectionSlotChannel::HttpRequest, 5005), 0);
    }

    #[tokio::test]
    async fn wait_returns_none_after_timeout() {
        let _guard = test_lock().lock().expect("test lock poisoned");
        reset_user_connection_slots_for_test();

        let first = acquire_user_connection_slot(UserConnectionSlotChannel::GameAuth, 6006, "socket-1", 1)
            .expect("first lease should be acquired");

        let waited = wait_for_user_connection_slot(
            UserConnectionSlotChannel::GameAuth,
            6006,
            "socket-2",
            1,
            20,
        )
        .await;

        assert!(waited.is_none());
        first.release();
    }
}
