//! Per-`Ready`-client transport-closed poller.
//!
//! Each successful handshake spawns one [`TransportLivenessHandle`]
//! that polls the owning [`McpClient`]'s state machine on a small
//! interval (default 500 ms). On the **first observation of
//! `Ready` + `is_transport_closed() == true`** it emits a single
//! [`McpClientEvent::TransportClosed`] and exits.
//!
//! The poller is *one-shot*. The session-side dispatcher decides
//! what to do with the event — drop the dead client, surface
//! `unavailable` over ACP, and trigger a restart on a debounce.
//!
//! ## Watcher state machine
//!
//! Per-tick classification (single state-mutex acquisition via
//! [`McpClient::liveness_check`]):
//!
//! | State observed                | Action            | Emit?                  |
//! |-------------------------------|-------------------|------------------------|
//! | `Ready` + transport open      | continue polling  | no                     |
//! | `Ready` + transport closed    | clear slot, exit  | `TransportClosed`      |
//! | `Initializing` (re-handshake) | clear slot, exit  | no — silent withdrawal |
//! | `Pending`                     | clear slot, exit  | no — silent withdrawal |
//! | `Empty`                       | clear slot, exit  | no — silent withdrawal |
//!
//! This avoids the previous false-positive `TransportClosed` whenever
//! someone called `reset_transport()` or any other code path
//! moved the state away from `Ready`.
//!
//! ## Slot-clearing on exit
//!
//! Before exiting, the task clears
//! [`McpClient::liveness_handle`] so a subsequent
//! [`McpClient::arm_liveness_watcher`] call can install a fresh
//! handle. Without this, a dead-but-still-present
//! [`TransportLivenessHandle`] would silently block re-arming.
//!
//! ## Cancellation
//!
//! Dropping the [`TransportLivenessHandle`] cancels the spawned
//! task via [`tokio_util::sync::DropGuard`]. Both teardown paths
//! (slot-clear-from-inside, external drop) end with the same
//! handle-drop semantics.
//!
//! ## Why the task holds a `Weak`, never an `Arc`
//!
//! The client owns this task's kill switch: the
//! [`TransportLivenessHandle`] returned here is stored back into
//! [`McpClient::liveness_handle`]. A strong `Arc<McpClient>` inside
//! the task would therefore close a reference cycle —
//! task → `Arc<McpClient>` → handle → `DropGuard` → cancels the task —
//! and neither side could ever be released. For a healthy stdio
//! server [`McpClient::liveness_check`] returns
//! [`LivenessCheck::Healthy`] forever, so the cycle never breaks on
//! its own: the client is immortal, its `Arc<RunningService>` is
//! never dropped, rmcp never runs `transport.close()`, and the stdio
//! child process is leaked for the life of the host. That is exactly
//! the leak this `Weak` refuses. The task upgrades per tick and a
//! failed upgrade is a clean exit — the watcher must never resurrect
//! a client its owners have let go of.
//!
//! ## Why polling, not a `JoinHandle`-on-the-service-loop?
//!
//! rmcp 2.1's `RunningService` does not expose a future that
//! resolves on transport shutdown. The closest signal is
//! `Peer::is_transport_closed()` (a state inspection), which is the
//! same one [`McpClient::is_healthy`] reads. A `select!` on a
//! per-client `Notify` would require patching rmcp; polling avoids
//! that quarantine break and the overhead is negligible (one mutex
//! acquire + one atomic load per tick).

use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::servers::{LivenessCheck, McpClient, McpClientEvent, McpServerName};

/// Default poll interval. Picked to keep mean detection latency
/// under one second while polling is cheap (`Mutex::lock` +
/// `tokio::sync::mpsc::is_closed`). See module doc.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Shared liveness-handle slot type — same Arc lives on the
/// [`McpClient`] and is passed into the polling task so the task
/// can clear the slot before exiting. Kept private to the crate to
/// discourage external mutation.
pub(crate) type SharedLivenessSlot = Arc<parking_lot::Mutex<Option<TransportLivenessHandle>>>;

/// Release the client's liveness slot, dropping any handle it held.
///
/// Both watcher-exit arms (transport closed, transient state drift)
/// clear the slot so a later [`McpClient::arm_liveness_watcher`] can
/// install a fresh handle. The taken handle is dropped outside the
/// critical section — the lock is held for nanoseconds.
fn clear_liveness_slot(slot: &SharedLivenessSlot) {
    let stale_handle = slot.lock().take();
    drop(stale_handle);
}

/// RAII handle for the per-client liveness task.
///
/// Drop semantics: drop → `DropGuard` cancels the `CancellationToken`
/// → the polling task wakes from `select!` on the next tick and
/// exits cleanly without emitting. There is no public `abort()` /
/// `stop()` — the contract is "tie the handle to the client".
pub struct TransportLivenessHandle {
    /// Name of the server this handle is watching. Exposed for
    /// diagnostics / log lines.
    pub server_name: McpServerName,
    /// On drop, cancels the spawned task. Field is held purely for
    /// its `Drop`; never read.
    _cancel: DropGuard,
}

impl std::fmt::Debug for TransportLivenessHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportLivenessHandle")
            .field("server_name", &self.server_name)
            .finish()
    }
}

impl TransportLivenessHandle {
    pub fn server_name(&self) -> &str {
        &self.server_name
    }
}

/// Spawn a one-shot transport-liveness poller for a `Ready` client.
///
/// # Parameters
///
/// - `server_name`: bound to emitted events.
/// - `client`: **`Weak<McpClient>`** whose `liveness_check` we poll.
///   Weak on purpose — see the module doc's "Why the task holds a
///   `Weak`". Upgraded per tick and dropped again before the next
///   `.await` on the tick, so the watcher never extends the client's
///   life past its owners'.
/// - `poll_interval`: tick period.
/// - `on_event`: sink for `TransportClosed` if observed.
/// - `liveness_slot`: shared Arc to the owning `McpClient`'s
///   `liveness_handle` field. Cleared from inside the task before
///   exit.
///
/// # Contract
///
/// - Caller MUST have already observed the client transition to
///   [`crate::servers::ClientStateKind::Ready`]
///   ([`McpClient::arm_liveness_watcher`] enforces this).
/// - The poller exits silently on transient non-`Ready` states; only
///   `Ready` + closed transport produces an event.
/// - The poller exits silently — and WITHOUT clearing the slot —
///   when the `Weak` fails to upgrade. The slot lives inside the
///   client that just died, so there is nothing left to clear and
///   nothing left to watch.
/// - The send may fail if the dispatcher has dropped its receiver
///   (subagent teardown, session shutdown). That's logged at debug
///   and the task exits — there's no retry.
///
/// # Why `tokio::time::interval` and not `sleep_until`
///
/// `interval` ticks immediately on first poll, which gives us
/// instant detection of "the transport was already closed when the
/// handle was spawned" — a real failure mode if a handshake races a
/// shutdown event from the server (e.g. Ctrl+C against an stdio
/// server that died between `Ready` write and the spawn). The
/// `MissedTickBehavior::Skip` default is fine: the worst case under
/// a runtime stall is "we don't poll for a while", which only
/// delays detection.
pub fn spawn_transport_liveness(
    server_name: McpServerName,
    client: Weak<McpClient>,
    poll_interval: Duration,
    on_event: UnboundedSender<McpClientEvent>,
    liveness_slot: SharedLivenessSlot,
) -> TransportLivenessHandle {
    let token = CancellationToken::new();
    let drop_guard = token.clone().drop_guard();

    let server_name_for_task = server_name.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(poll_interval);
        // Skip missed ticks under runtime stall — see fn doc.
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    // Cancelled by the handle's `DropGuard`. The
                    // caller dropped the handle (e.g. McpClient
                    // teardown), so the slot has already been
                    // mutated externally — do not race the dropper
                    // by clearing the slot here.
                    tracing::trace!(
                        server = %server_name_for_task,
                        "transport liveness watcher cancelled by handle drop",
                    );
                    return;
                }
                _ = tick.tick() => {
                    // Upgrade per tick, never hold the strong ref
                    // across the loop: this task's kill switch lives
                    // INSIDE the client, so a retained `Arc` here is a
                    // cycle that makes a healthy client — and its stdio
                    // child — immortal. See the module doc.
                    //
                    // `None` means the last owner (`owned_clients`,
                    // `shared_clients`, an in-flight caller) let go
                    // while we were sleeping. Exit; do NOT clear the
                    // slot — it died with the client, and there is
                    // nothing to re-arm.
                    let Some(client) = client.upgrade() else {
                        tracing::trace!(
                            server = %server_name_for_task,
                            "transport liveness watcher: client dropped, exiting",
                        );
                        return;
                    };
                    match client.liveness_check().await {
                        LivenessCheck::Healthy => continue,
                        LivenessCheck::TransportClosed => {
                            tracing::info!(
                                server = %server_name_for_task,
                                "transport liveness watcher detected closed transport",
                            );
                            // Clear our own slot before exiting so a
                            // subsequent `arm_liveness_watcher` can
                            // install a fresh handle.
                            //
                            // Self-cancel-by-drop: clearing the slot
                            // drops the taken `TransportLivenessHandle`,
                            // whose `DropGuard` cancels the very
                            // `CancellationToken` this task is
                            // `select!`ing on. Benign because we
                            // `return` immediately — but DO NOT add any
                            // post-`return` work that re-enters the
                            // `select!`; it would race this self-cancel.
                            clear_liveness_slot(&liveness_slot);

                            if on_event
                                .send(McpClientEvent::TransportClosed {
                                    server: server_name_for_task.clone(),
                                    // Bind the event to THIS client
                                    // instance so the dispatcher can
                                    // skip evicting a replacement
                                    // registered under the same name.
                                    client_id: client.client_id(),
                                })
                                .is_err()
                            {
                                tracing::debug!(
                                    server = %server_name_for_task,
                                    "dispatcher receiver dropped; liveness watcher exiting silently",
                                );
                            }
                            return;
                        }
                        LivenessCheck::Transient => {
                            // State moved out of `Ready` (re-handshake
                            // started, or the transport was reset
                            // externally). The watcher detects
                            // *transport closure*, not state changes,
                            // so exit silently; the caller re-arms a
                            // fresh watcher when the new handshake
                            // completes.
                            tracing::debug!(
                                server = %server_name_for_task,
                                "transport liveness watcher: state drifted out of Ready, exiting silently",
                            );
                            clear_liveness_slot(&liveness_slot);
                            return;
                        }
                    }
                }
            }
        }
    });

    TransportLivenessHandle {
        server_name,
        _cancel: drop_guard,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::McpClient;
    use tokio::sync::mpsc::unbounded_channel;

    /// Stub client whose `liveness_check()` returns
    /// `LivenessCheck::Transient`: `McpClient::stub` lands in
    /// `ClientState::Empty`, which the liveness classifier treats as a
    /// silent-withdrawal state (NOT `TransportClosed`).
    fn make_stub_client() -> Arc<McpClient> {
        Arc::new(McpClient::stub("test-server"))
    }

    /// Contract: a watcher whose owning client never reaches
    /// `Ready+closed` (here the stub is `Empty`) exits **silently**
    /// — no `TransportClosed` event, and the slot is cleared.
    /// The watcher must not false-positive on non-`Ready` states.
    #[tokio::test(start_paused = true)]
    async fn poller_silent_exit_on_non_ready_state() {
        let (tx, mut rx) = unbounded_channel::<McpClientEvent>();
        let slot: SharedLivenessSlot = Arc::new(parking_lot::Mutex::new(None));
        let client = make_stub_client();
        let handle = spawn_transport_liveness(
            "test-server".to_string(),
            Arc::downgrade(&client),
            Duration::from_millis(500),
            tx,
            Arc::clone(&slot),
        );
        // Pre-populate the slot so we can assert the watcher
        // clears it on exit.
        *slot.lock() = Some(handle);

        // First `interval.tick()` fires immediately under paused
        // time. The watcher classifies `Empty` as `Transient` and
        // exits silently.
        tokio::time::advance(Duration::from_millis(10)).await;
        tokio::task::yield_now().await;

        // No event emitted: the watcher exited silently.
        assert!(
            rx.try_recv().is_err(),
            "non-Ready states must not produce TransportClosed",
        );

        // Slot is cleared so re-arming wouldn't be blocked.
        assert!(
            slot.lock().is_none(),
            "watcher must clear its own slot on exit",
        );
    }

    /// Contract: when the watcher emits `TransportClosed` it both
    /// (a) sends the event and (b) clears the shared liveness
    /// slot so the next `arm_liveness_watcher` succeeds.
    ///
    /// We exercise this by constructing a client that *would*
    /// classify as `Ready + closed` — but `McpClient::stub` is
    /// `Empty`, which classifies as `Transient`, so this test
    /// instead asserts the silent-exit path. The Ready+closed
    /// path is covered by the integration test in `servers.rs`.
    #[tokio::test(start_paused = true)]
    async fn poller_clears_slot_on_exit() {
        let (tx, mut rx) = unbounded_channel::<McpClientEvent>();
        let slot: SharedLivenessSlot = Arc::new(parking_lot::Mutex::new(None));
        let client = make_stub_client();
        let handle = spawn_transport_liveness(
            "test-server".to_string(),
            Arc::downgrade(&client),
            Duration::from_millis(500),
            tx,
            Arc::clone(&slot),
        );
        *slot.lock() = Some(handle);

        tokio::time::advance(Duration::from_millis(10)).await;
        tokio::task::yield_now().await;

        // Advancing several intervals confirms the watcher exited
        // (not just stuck in a loop without progress).
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
        assert!(
            slot.lock().is_none(),
            "slot must be cleared even on the silent-exit path",
        );
    }

    /// Contract: dropping the handle stops the task without
    /// emitting. Drops happen via the external `DropGuard` path,
    /// distinct from the in-task slot-clear path tested above.
    #[tokio::test(start_paused = true)]
    async fn drop_cancels_task_before_first_tick() {
        let (tx, mut rx) = unbounded_channel::<McpClientEvent>();
        let slot: SharedLivenessSlot = Arc::new(parking_lot::Mutex::new(None));
        let client = make_stub_client();
        let handle = spawn_transport_liveness(
            "test-server".to_string(),
            Arc::downgrade(&client),
            Duration::from_secs(60), // Long interval so the first tick is far away.
            tx,
            Arc::clone(&slot),
        );
        // Drop before the tick can fire — the `DropGuard` arm
        // wins the `select!`.
        drop(handle);
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
    }

    /// Contract (the leak's structural falsifier, process-free): the
    /// spawned watcher holds NO strong reference to the client it
    /// watches. If this ever regresses to `Arc::clone`, every healthy
    /// MCP client becomes immortal and its stdio child is leaked —
    /// see the module doc.
    #[tokio::test(start_paused = true)]
    async fn spawned_watcher_holds_no_strong_ref_to_client() {
        let (tx, _rx) = unbounded_channel::<McpClientEvent>();
        let slot: SharedLivenessSlot = Arc::new(parking_lot::Mutex::new(None));
        let client = make_stub_client();
        let handle = spawn_transport_liveness(
            "test-server".to_string(),
            Arc::downgrade(&client),
            Duration::from_secs(60), // Never ticks during the test.
            tx,
            Arc::clone(&slot),
        );
        assert_eq!(
            Arc::strong_count(&client),
            1,
            "the liveness task must not own an Arc<McpClient>: the client owns \
             this task's kill switch, so a strong ref is a reference cycle",
        );
        drop(handle);
    }

    /// Contract: a watcher whose client has already been dropped
    /// exits on its next tick instead of resurrecting anything.
    #[tokio::test(start_paused = true)]
    async fn watcher_exits_when_client_is_dropped() {
        let (tx, mut rx) = unbounded_channel::<McpClientEvent>();
        let slot: SharedLivenessSlot = Arc::new(parking_lot::Mutex::new(None));
        let client = make_stub_client();
        let weak = Arc::downgrade(&client);
        let handle = spawn_transport_liveness(
            "test-server".to_string(),
            weak.clone(),
            Duration::from_millis(500),
            tx,
            Arc::clone(&slot),
        );
        // Keep the handle out of the slot so the DropGuard is not the
        // thing that stops the task — the failed upgrade must be.
        drop(client);
        assert!(weak.upgrade().is_none(), "client must be fully dropped");

        tokio::time::advance(Duration::from_millis(600)).await;
        tokio::task::yield_now().await;

        assert!(
            rx.try_recv().is_err(),
            "a vanished client must not produce a TransportClosed event",
        );
        drop(handle);
    }
}
