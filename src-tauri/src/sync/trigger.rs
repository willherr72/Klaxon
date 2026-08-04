//! Event-driven sync triggers.
//!
//! The sync loop used to be purely clock-driven (every 20s), which meant a
//! write could sit locally for up to 20s before its first attempt to leave
//! the device — long enough to lose the race against a lid-close. Local
//! mutations, app launch, and Windows resume now nudge the loop through a
//! channel; nudges within [`DEBOUNCE`] coalesce so bulk edits cost one
//! dial, and a failed nudge-triggered pass retries on a bounded backoff
//! before going quiet until the next trigger.

use std::time::Duration;

/// Why the sync loop is being poked. `Retry(n)` carries the attempt count
/// so the backoff schedule stays bounded without extra state in the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nudge {
    Write,
    Launch,
    Resume,
    Retry(u8),
    /// v0.7.2 (issue #3): the OS reported an interface/connectivity
    /// change. The loop tells iroh to re-evaluate sockets and paths
    /// before dialing — without this, an endpoint that outlives a
    /// network migration stays bound to the dead network forever.
    NetworkChange,
}

/// Coalescing window: nudges arriving within this of the first are folded
/// into a single pass, so pasting five reminders dials once, not five times.
pub const DEBOUNCE: Duration = Duration::from_millis(1500);

/// Bounded backoff after a failed triggered pass. Three retries, then
/// silence until the next real trigger — no dial storms against a peer
/// that's asleep.
pub fn next_retry_delay(attempt: u8) -> Option<Duration> {
    match attempt {
        0 => Some(Duration::from_secs(5)),
        1 => Some(Duration::from_secs(15)),
        2 => Some(Duration::from_secs(45)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_bounded_and_increasing() {
        let d0 = next_retry_delay(0).unwrap();
        let d1 = next_retry_delay(1).unwrap();
        let d2 = next_retry_delay(2).unwrap();
        assert!(d0 < d1 && d1 < d2, "backoff must increase");
        assert_eq!(next_retry_delay(3), None, "must give up after 3 attempts");
        assert_eq!(next_retry_delay(200), None);
    }
}
