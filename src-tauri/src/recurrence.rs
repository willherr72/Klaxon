//! Recurrence rule evaluation. Pure logic, no I/O — fully unit-testable.

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc, Weekday};

use crate::models::RepeatRule;

/// Compute the next `due_at` (millis since epoch) strictly after `now_ms`,
/// given the previous occurrence at `last_due_at` and the recurrence `rule`.
pub fn next_after(rule: &RepeatRule, last_due_at_ms: i64, now_ms: i64) -> Option<i64> {
    let last = Utc.timestamp_millis_opt(last_due_at_ms).single()?;
    let now = Utc.timestamp_millis_opt(now_ms).single()?;

    match rule {
        RepeatRule::Daily => {
            let mut next = last + Duration::days(1);
            while next <= now {
                next = next + Duration::days(1);
            }
            Some(next.timestamp_millis())
        }
        RepeatRule::Weekly { weekdays } => {
            if weekdays.is_empty() {
                return None;
            }
            let mut candidate = last + Duration::days(1);
            for _ in 0..14 {
                let w = candidate.weekday().num_days_from_monday() as u8;
                if weekdays.contains(&w) && candidate > now {
                    return Some(candidate.timestamp_millis());
                }
                candidate = candidate + Duration::days(1);
            }
            None
        }
        RepeatRule::Interval { every_seconds } => {
            if *every_seconds <= 0 {
                return None;
            }
            let mut next = last + Duration::seconds(*every_seconds);
            while next <= now {
                next = next + Duration::seconds(*every_seconds);
            }
            Some(next.timestamp_millis())
        }
        RepeatRule::Monthly { day } => next_monthly(last, now, *day),
    }
}

fn next_monthly(last: DateTime<Utc>, now: DateTime<Utc>, day: u8) -> Option<i64> {
    let day = day.clamp(1, 28) as u32;
    let mut year = last.year();
    let mut month = last.month();
    for _ in 0..36 {
        month += 1;
        if month > 12 {
            month = 1;
            year += 1;
        }
        if let Some(candidate) = Utc
            .with_ymd_and_hms(year, month, day, last.hour(), last.minute(), last.second())
            .single()
        {
            if candidate > now {
                return Some(candidate.timestamp_millis());
            }
        }
    }
    None
}

#[allow(dead_code)]
fn weekday_to_num(w: Weekday) -> u8 {
    w.num_days_from_monday() as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn daily_next_day() {
        let last = ts(2026, 5, 6, 9, 0);
        let now = ts(2026, 5, 6, 12, 0);
        let next = next_after(&RepeatRule::Daily, last, now).unwrap();
        assert_eq!(next, ts(2026, 5, 7, 9, 0));
    }

    #[test]
    fn daily_skips_past_missed() {
        let last = ts(2026, 5, 1, 9, 0);
        let now = ts(2026, 5, 5, 12, 0);
        let next = next_after(&RepeatRule::Daily, last, now).unwrap();
        assert_eq!(next, ts(2026, 5, 6, 9, 0));
    }

    #[test]
    fn weekly_picks_next_listed_day() {
        // last fired Monday 2026-05-04, rule = Mon/Wed/Fri (0,2,4)
        let last = ts(2026, 5, 4, 9, 0);
        let now = ts(2026, 5, 4, 10, 0);
        let next = next_after(
            &RepeatRule::Weekly {
                weekdays: vec![0, 2, 4],
            },
            last,
            now,
        )
        .unwrap();
        // next should be Wednesday 2026-05-06
        assert_eq!(next, ts(2026, 5, 6, 9, 0));
    }

    #[test]
    fn weekly_wraps_to_next_week() {
        // last fired Friday 2026-05-08, rule = Mon only
        let last = ts(2026, 5, 8, 9, 0);
        let now = ts(2026, 5, 8, 10, 0);
        let next = next_after(
            &RepeatRule::Weekly { weekdays: vec![0] },
            last,
            now,
        )
        .unwrap();
        // next Monday is 2026-05-11
        assert_eq!(next, ts(2026, 5, 11, 9, 0));
    }

    #[test]
    fn weekly_empty_returns_none() {
        let last = ts(2026, 5, 4, 9, 0);
        let now = ts(2026, 5, 4, 10, 0);
        let next = next_after(
            &RepeatRule::Weekly { weekdays: vec![] },
            last,
            now,
        );
        assert!(next.is_none());
    }

    #[test]
    fn interval_advances_to_first_future() {
        let last = ts(2026, 5, 6, 9, 0);
        let now = ts(2026, 5, 6, 10, 30);
        let next = next_after(
            &RepeatRule::Interval {
                every_seconds: 3600,
            },
            last,
            now,
        )
        .unwrap();
        assert_eq!(next, ts(2026, 5, 6, 11, 0));
    }

    #[test]
    fn interval_zero_returns_none() {
        let last = ts(2026, 5, 6, 9, 0);
        let now = ts(2026, 5, 6, 10, 0);
        let next = next_after(
            &RepeatRule::Interval { every_seconds: 0 },
            last,
            now,
        );
        assert!(next.is_none());
    }

    #[test]
    fn monthly_next_month_same_day() {
        let last = ts(2026, 5, 15, 9, 0);
        let now = ts(2026, 5, 15, 10, 0);
        let next = next_after(&RepeatRule::Monthly { day: 15 }, last, now).unwrap();
        assert_eq!(next, ts(2026, 6, 15, 9, 0));
    }

    #[test]
    fn monthly_clamps_day_to_28() {
        let last = ts(2026, 1, 31, 9, 0);
        let now = ts(2026, 1, 31, 10, 0);
        // day=31 clamps to 28, lands on Feb 28 not Feb 31
        let next = next_after(&RepeatRule::Monthly { day: 31 }, last, now).unwrap();
        assert_eq!(next, ts(2026, 2, 28, 9, 0));
    }
}
