//! The alarm planner: decides which OS notifications should exist, as a
//! pure function of the reminders table. Replaces the reconcile logic
//! that lived in mobile-scheduler.ts — the hash, body format, and
//! channel mapping here MUST stay bit/byte-identical to what the JS
//! produced, or upgrading double-schedules every armed alarm.

use std::collections::HashSet;

use serde::Serialize;

use crate::models::{Priority, Reminder, ReminderState};

/// How late an arriving reminder may be and still ring immediately.
/// Older than this stays silent (visible as overdue in-app) — a re-pair
/// or week-offline catch-up must not detonate a pile of stale alarms.
pub const GRACE_WINDOW_MS: i64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct PlannedNotification {
    pub id_hash: i32,
    pub reminder_id: String,
    pub title: String,
    pub body: String,
    pub channel_id: String,
    pub at_ms: i64,
    pub past_due: bool,
}

/// Bit-exact port of mobile-scheduler.ts `hashIdToInt32` (djb2-xor with
/// JS 32-bit semantics). A differing hash double-schedules every alarm
/// armed by the previous version — captured-vector tested.
pub fn hash_id_to_int32(id: &str) -> i32 {
    let mut h: i32 = 5381;
    // JS charCodeAt yields UTF-16 code units; ids are ASCII UUIDs, but
    // encode_utf16 keeps parity exact for any input.
    for c in id.encode_utf16() {
        h = (h.wrapping_shl(5).wrapping_add(h)) ^ (c as i32);
    }
    h.wrapping_abs()
}

fn fire_target_ms(r: &Reminder) -> Option<i64> {
    match r.state {
        // Fired is included deliberately: it means "rang on SOME device,
        // not yet acknowledged". A peer that rang flips pending→fired the
        // instant it rings, and that state syncs over — if Fired were
        // excluded, a phone that learns of the reminder late (cold sync)
        // would never ring at all. Grace + the armed log still bound it:
        // stale ones are skipped, and a device that already armed this
        // (reminder, fire-time) pair won't re-ring. Only user action
        // (dismiss / complete / re-snooze) silences peers.
        ReminderState::Pending | ReminderState::Snoozed | ReminderState::Fired => {
            Some(r.snooze_until.unwrap_or(r.due_at))
        }
        _ => None,
    }
}

fn channel_id_for(p: Priority) -> &'static str {
    match p {
        Priority::Low => "klaxon-low",
        Priority::Normal => "klaxon-normal",
        Priority::High => "klaxon-high",
    }
}

/// Port of formatDueLine — local time, same wording, same branches.
fn format_due_line(target_ms: i64, now_ms: i64) -> String {
    use chrono::{Datelike, Local, TimeZone, Timelike};
    let t = Local.timestamp_millis_opt(target_ms).unwrap();
    let now = Local.timestamp_millis_opt(now_ms).unwrap();
    let diff_days = (t.date_naive() - now.date_naive()).num_days();
    let hhmm = format!("{:02}:{:02}", t.hour(), t.minute());
    const MONTHS: [&str; 12] = [
        "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
        "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ];
    match diff_days {
        0 => format!("Due today {hhmm}"),
        1 => format!("Due tomorrow {hhmm}"),
        -1 => format!("Was due yesterday {hhmm}"),
        _ => format!("Due {} {:02} {hhmm}", MONTHS[t.month0() as usize], t.day()),
    }
}

fn priority_tag(p: Priority) -> &'static str {
    match p {
        Priority::Low => "LOW",
        Priority::Normal => "NORMAL",
        Priority::High => "HIGH",
    }
}

fn build_body(r: &Reminder, target_ms: i64, now_ms: i64) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(d) = &r.description {
        lines.push(d.clone());
    }
    lines.push(format!(
        "{} ({})",
        format_due_line(target_ms, now_ms),
        priority_tag(r.priority)
    ));
    lines.join("\n")
}

/// The plan: which OS notifications should exist right now.
///
/// - Future fire time → include (same-id re-schedule is idempotent).
/// - Past fire time → include only within [`GRACE_WINDOW_MS`] AND when
///   the (reminder, fire time) pair isn't in the armed log — ring once.
/// - Silent tasks and terminal states never ring.
pub fn desired_notifications(
    reminders: &[Reminder],
    armed: &HashSet<(String, i64)>,
    now_ms: i64,
) -> Vec<PlannedNotification> {
    let mut out = Vec::new();
    for r in reminders {
        if r.silent {
            continue;
        }
        let Some(t) = fire_target_ms(r) else { continue };
        let past_due = t <= now_ms;
        if past_due {
            let age = now_ms - t;
            if age > GRACE_WINDOW_MS {
                continue;
            }
            if armed.contains(&(r.id.clone(), t)) {
                continue;
            }
        }
        out.push(PlannedNotification {
            id_hash: hash_id_to_int32(&r.id),
            reminder_id: r.id.clone(),
            title: r.title.clone(),
            body: build_body(r, t, now_ms),
            channel_id: channel_id_for(r.priority).to_string(),
            at_ms: t,
            past_due,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Priority, Reminder, ReminderState};

    fn reminder(id: &str, state: ReminderState, due: i64, snooze: Option<i64>) -> Reminder {
        Reminder {
            id: id.into(),
            title: "Test".into(),
            description: None,
            due_at: due,
            priority: Priority::Normal,
            sound_path: None,
            repeat_rule: None,
            state,
            snooze_until: snooze,
            created_at: 0,
            updated_at: 0,
            source: "local".into(),
            external_id: None,
            last_synced_at: None,
            silent: false,
            tags: vec![],
            task_lane_id: None,
            task_sort_key: None,
        }
    }

    /// Captured from the running JS implementation — bit-exact or bust.
    #[test]
    fn hash_matches_js_bit_for_bit() {
        assert_eq!(hash_id_to_int32("00000000-0000-4000-8000-000000000001"), 1887187000);
        assert_eq!(hash_id_to_int32("a3f8c2d1-9b4e-4c7a-8d2f-1e5b6a9c0d3e"), 1885464322);
        assert_eq!(hash_id_to_int32("ee5a9ef7-79cb-494a-9739-721cd03f6b22"), 2117013459);
        assert_eq!(hash_id_to_int32(""), 5381);
        assert_eq!(hash_id_to_int32("z"), 177631);
    }

    #[test]
    fn unacknowledged_states_are_armed_terminal_states_are_not() {
        let now = 1_000_000;
        let rs = vec![
            reminder("a", ReminderState::Pending, now + 60_000, None),
            reminder("b", ReminderState::Snoozed, now + 60_000, Some(now + 120_000)),
            reminder("c", ReminderState::Completed, now + 60_000, None),
            reminder("d", ReminderState::Dismissed, now + 60_000, None),
            reminder("e", ReminderState::Fired, now + 60_000, None),
        ];
        let plan = desired_notifications(&rs, &Default::default(), now);
        let ids: Vec<&str> = plan.iter().map(|p| p.reminder_id.as_str()).collect();
        // Fired counts as unacknowledged — only dismiss/complete silence
        // a reminder across devices.
        assert_eq!(ids, vec!["a", "b", "e"]);
        // Snooze wins over due_at as the fire time.
        assert_eq!(plan[1].at_ms, now + 120_000);
    }

    #[test]
    fn fired_on_another_device_rings_here_within_grace_once() {
        // The late-arrival scenario that motivated v0.6: desktop rang at
        // due (state pending→fired), the fired state cold-syncs to the
        // phone minutes later — the phone must still ring it.
        let now = 100_000_000;
        let due = now - 10 * 60_000;
        let rs = vec![reminder("f", ReminderState::Fired, due, None)];
        let plan = desired_notifications(&rs, &Default::default(), now);
        assert_eq!(plan.len(), 1, "unacknowledged fired reminder rings late");
        assert!(plan[0].past_due);

        // Once armed here, later passes stay silent while state is Fired.
        let mut armed = std::collections::HashSet::new();
        armed.insert(("f".to_string(), due));
        assert!(desired_notifications(&rs, &armed, now).is_empty());

        // Beyond grace it is stale — never rings, same as pending.
        let stale = vec![reminder("g", ReminderState::Fired, now - 31 * 60_000, None)];
        assert!(desired_notifications(&stale, &Default::default(), now).is_empty());
    }

    #[test]
    fn grace_window_edges() {
        let now = 100_000_000;
        let rs = vec![
            reminder("young", ReminderState::Pending, now - 29 * 60_000, None),
            reminder("stale", ReminderState::Pending, now - 31 * 60_000, None),
        ];
        let plan = desired_notifications(&rs, &Default::default(), now);
        assert_eq!(plan.len(), 1, "29min late rings, 31min late doesn't");
        assert_eq!(plan[0].reminder_id, "young");
        assert!(plan[0].past_due);
    }

    #[test]
    fn ring_once_via_armed_log() {
        let now = 100_000_000;
        let due = now - 60_000;
        let rs = vec![reminder("x", ReminderState::Pending, due, None)];

        let first = desired_notifications(&rs, &Default::default(), now);
        assert_eq!(first.len(), 1, "first sight of a late reminder rings");

        let mut armed = std::collections::HashSet::new();
        armed.insert(("x".to_string(), due));
        let second = desired_notifications(&rs, &armed, now);
        assert!(second.is_empty(), "already-armed pair must not re-ring");
    }

    #[test]
    fn snooze_moves_fire_time_and_rings_again() {
        let now = 100_000_000;
        let due = now - 60_000;
        let mut armed = std::collections::HashSet::new();
        armed.insert(("x".to_string(), due));
        // Snoozed to a new (past) fire time — a new pair, within grace.
        let rs = vec![reminder("x", ReminderState::Snoozed, due, Some(now - 10_000))];
        let plan = desired_notifications(&rs, &armed, now);
        assert_eq!(plan.len(), 1, "new fire time = new ring");
        assert_eq!(plan[0].at_ms, now - 10_000);
    }

    #[test]
    fn future_arming_is_not_blocked_by_armed_log() {
        // The log exists to stop past-due re-rings; a future-due reminder
        // must keep re-scheduling idempotently even when logged.
        let now = 1_000_000;
        let due = now + 60_000;
        let mut armed = std::collections::HashSet::new();
        armed.insert(("x".to_string(), due));
        let rs = vec![reminder("x", ReminderState::Pending, due, None)];
        assert_eq!(desired_notifications(&rs, &armed, now).len(), 1);
    }

    #[test]
    fn silent_tasks_never_ring() {
        let now = 1_000_000;
        let mut r = reminder("t", ReminderState::Pending, now + 60_000, None);
        r.silent = true;
        assert!(desired_notifications(&[r], &Default::default(), now).is_empty());
    }

    #[test]
    fn body_carries_description_due_line_and_priority() {
        let now = 1_000_000;
        let mut r = reminder("a", ReminderState::Pending, now + 60_000, None);
        r.description = Some("bring the charger".into());
        let plan = desired_notifications(&[r], &Default::default(), now);
        let body = &plan[0].body;
        assert!(body.starts_with("bring the charger\n"));
        assert!(body.contains("(NORMAL)"));
        assert!(body.contains("Due "), "due line present: {body}");
    }
}
