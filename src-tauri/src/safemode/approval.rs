use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::time::Duration;

static APPROVAL_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestedEvent {
    pub id: String,
    pub port: String,
    pub hex: String,
    pub ascii: String,
    pub reason: String,
    pub tool_use_id: String,
    pub expires_at: u64,
}

#[derive(Debug)]
struct PendingApproval {
    responder: SyncSender<bool>,
}

#[derive(Debug, Default)]
pub struct ApprovalStore {
    pending: HashMap<String, PendingApproval>,
}

impl ApprovalStore {
    pub fn register(
        &mut self,
        port: String,
        hex: String,
        ascii: String,
        reason: String,
        tool_use_id: String,
        expires_at_ms: u64,
    ) -> (ApprovalRequestedEvent, mpsc::Receiver<bool>) {
        let id = format!("apr-{}", APPROVAL_SEQ.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending
            .insert(id.clone(), PendingApproval { responder: tx });
        let event = ApprovalRequestedEvent {
            id,
            port,
            hex,
            ascii,
            reason,
            tool_use_id,
            expires_at: expires_at_ms,
        };
        (event, rx)
    }

    /// Remove and return the responder for `id` without sending (caller sends outside any outer lock).
    pub fn take(&mut self, id: &str) -> Option<SyncSender<bool>> {
        self.pending.remove(id).map(|p| p.responder)
    }

    pub fn cancel(&mut self, id: &str) {
        self.pending.remove(id);
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Approved,
    Denied,
    Timeout,
}

pub async fn wait_for_approval(
    rx: mpsc::Receiver<bool>,
    timeout_ms: u64,
) -> Result<ApprovalOutcome, String> {
    let duration = Duration::from_millis(timeout_ms.max(1));
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(duration))
        .await
        .map_err(|e| e.to_string())?;

    match result {
        Ok(true) => Ok(ApprovalOutcome::Approved),
        Ok(false) => Ok(ApprovalOutcome::Denied),
        Err(RecvTimeoutError::Timeout) => Ok(ApprovalOutcome::Timeout),
        Err(RecvTimeoutError::Disconnected) => Ok(ApprovalOutcome::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration as StdDuration;

    #[test]
    fn approve_delivers_true_once() {
        let mut store = ApprovalStore::default();
        let (event, rx) = store.register(
            "p".into(),
            "01".into(),
            ".".into(),
            "r".into(),
            "tu1".into(),
            0,
        );
        let tx = store.take(&event.id).expect("pending");
        tx.send(true).unwrap();
        assert_eq!(rx.recv_timeout(StdDuration::from_millis(50)), Ok(true));
        assert!(store.take(&event.id).is_none());
    }

    #[test]
    fn deny_delivers_false() {
        let mut store = ApprovalStore::default();
        let (event, rx) = store.register(
            "p".into(),
            "01".into(),
            ".".into(),
            "r".into(),
            "tu1".into(),
            0,
        );
        store.take(&event.id).unwrap().send(false).unwrap();
        assert_eq!(rx.recv_timeout(StdDuration::from_millis(50)), Ok(false));
    }

    #[test]
    fn timeout_when_unanswered() {
        let mut store = ApprovalStore::default();
        let (_event, rx) = store.register(
            "p".into(),
            "01".into(),
            ".".into(),
            "r".into(),
            "tu1".into(),
            0,
        );
        assert_eq!(
            rx.recv_timeout(StdDuration::from_millis(30)),
            Err(RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn double_resolve_only_one_result() {
        let mut store = ApprovalStore::default();
        let (event, rx) = store.register(
            "p".into(),
            "01".into(),
            ".".into(),
            "r".into(),
            "tu1".into(),
            0,
        );
        store.take(&event.id).unwrap().send(true).unwrap();
        assert!(store.take(&event.id).is_none());
        assert_eq!(rx.recv_timeout(StdDuration::from_millis(50)), Ok(true));
    }

    #[test]
    fn late_resolve_after_cancel_is_ignored() {
        let mut store = ApprovalStore::default();
        let (event, rx) = store.register(
            "p".into(),
            "01".into(),
            ".".into(),
            "r".into(),
            "tu1".into(),
            0,
        );
        store.cancel(&event.id);
        assert!(store.take(&event.id).is_none());
        assert_eq!(
            rx.recv_timeout(StdDuration::from_millis(20)),
            Err(RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn wait_for_approval_async_reads_channel() {
        tauri::async_runtime::block_on(async {
            let (tx, rx) = mpsc::sync_channel(1);
            tx.send(true).unwrap();
            let outcome = wait_for_approval(rx, 1_000).await.unwrap();
            assert_eq!(outcome, ApprovalOutcome::Approved);
        });
    }
}
