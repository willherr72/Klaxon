//! One outgoing pass at a time, including Android's warm worker.

use std::{sync::OnceLock, time::Duration};
use tokio::sync::{watch, Mutex, MutexGuard};

static OUTGOING_PASS: Mutex<()> = Mutex::const_new(());
static FOREGROUND: OnceLock<watch::Sender<bool>> = OnceLock::new();

pub const FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT: u32 = 5;
pub const SELF_TEST_COOLDOWN: Duration = Duration::from_secs(1800);

/// Process-wide so a worker using its own runtime shares the same gate.
pub async fn acquire_pass() -> MutexGuard<'static, ()> {
    OUTGOING_PASS.lock().await
}

fn foreground_state() -> &'static watch::Sender<bool> {
    FOREGROUND.get_or_init(|| watch::channel(false).0)
}

/// Native lifecycle can run before Tauri setup. Keep the latest state even
/// when no app handle or scheduler exists yet.
#[cfg_attr(not(mobile), allow(dead_code))]
pub fn set_foreground(foreground: bool) {
    foreground_state().send_replace(foreground);
}

pub fn is_foreground() -> bool {
    *foreground_state().borrow()
}

/// Cancel a mobile health probe when the activity leaves the foreground.
pub async fn wait_until_background() {
    wait_for_background(foreground_state().subscribe()).await;
}

async fn wait_for_background(mut state: watch::Receiver<bool>) {
    let _ = state.wait_for(|foreground| !*foreground).await;
}

pub fn recovery_due(
    desktop: bool,
    foreground: bool,
    failed_passes: u32,
    since_last_test: Option<Duration>,
) -> bool {
    (desktop || foreground)
        && failed_passes >= FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT
        && since_last_test.map_or(true, |elapsed| elapsed >= SELF_TEST_COOLDOWN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn scheduled_manual_and_worker_passes_do_not_overlap() {
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut passes = Vec::new();
        for _ in 0..12 {
            let active = active.clone();
            let maximum = maximum.clone();
            passes.push(tokio::spawn(async move {
                let _pass = acquire_pass().await;
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(count, Ordering::SeqCst);
                for _ in 0..8 {
                    tokio::task::yield_now().await;
                }
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for pass in passes {
            pass.await.unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn canceling_a_waiting_worker_does_not_strand_the_gate() {
        let held = acquire_pass().await;
        let worker = tokio::spawn(async {
            let _pass = acquire_pass().await;
        });
        tokio::task::yield_now().await;
        assert!(
            !worker.is_finished(),
            "worker must wait for the active pass"
        );
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        drop(held);
        let _next = tokio::time::timeout(Duration::from_secs(1), acquire_pass())
            .await
            .expect("canceled worker must not block the next pass");
    }

    #[test]
    fn mobile_recovery_requires_foreground_repeated_failures_and_cooldown() {
        assert!(!recovery_due(false, false, 99, None));
        assert!(!recovery_due(false, true, 4, None));
        assert!(recovery_due(false, true, 5, None));
        assert!(!recovery_due(
            false,
            true,
            99,
            Some(Duration::from_secs(1799))
        ));
        assert!(recovery_due(
            false,
            true,
            99,
            Some(Duration::from_secs(1800))
        ));
    }

    #[test]
    fn desktop_watchdog_does_not_require_a_visible_window() {
        assert!(recovery_due(true, false, 5, None));
        assert!(!recovery_due(true, false, 4, None));
    }

    #[tokio::test]
    async fn lifecycle_before_setup_is_retained_and_pause_stops_probe() {
        let (state, receiver) = watch::channel(false);
        drop(receiver);
        // onResume can precede the first observer (Tauri setup).
        state.send_replace(true);
        assert!(*state.subscribe().borrow());
        let mut paused = Box::pin(wait_for_background(state.subscribe()));
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut paused)
            .await
            .is_err());
        state.send_replace(false);
        tokio::time::timeout(Duration::from_secs(1), paused)
            .await
            .unwrap();
    }
}
