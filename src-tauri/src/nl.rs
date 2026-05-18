//! Natural-language quick-add parser.
//!
//! Pulls a date and time out of phrases like "tomorrow 3pm gym" or
//! "in 30 min call back" and returns the leftover words as the reminder
//! title. Pure logic — fully unit-testable.
//!
//! Supports:
//!   - "today", "tomorrow", "tonight" (tonight defaults to 8pm)
//!   - Weekday names (mon..sun, monday..sunday, tue/tues, thurs)
//!   - "next <weekday>" (same-day-of-week always means a week from now)
//!   - "next week" (+7 days)
//!   - "in N <unit>" — second(s)/minute(s)/hour(s)/day(s)/week(s) + short forms
//!   - Single-token times: "3pm", "3:30pm", "15:00", "noon", "midnight"
//!   - Two-token times: "3 pm" / "3:30 am"
//!
//! Filler words like "remind", "me", "to", "do" are stripped from the
//! title's leading edge. Anything else stays.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Timelike, Weekday};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Parsed {
    pub due_at_ms: i64,
    pub title: String,
    pub matched_date: Option<String>,
    pub matched_time: Option<String>,
    /// Inline `#tag` tokens pulled out of the input, normalized to lowercase
    /// and deduplicated. The `#` is stripped.
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParseError {
    pub message: String,
}

pub fn parse(input: &str, now: DateTime<Local>) -> Result<Parsed, ParseError> {
    let lower = input.to_lowercase();
    let raw: Vec<String> = lower.split_whitespace().map(|s| s.to_string()).collect();
    if raw.is_empty() {
        return Err(ParseError {
            message: "type something".into(),
        });
    }

    // Treat each token slot as Some(word) until it's consumed by a match.
    let mut tokens: Vec<Option<String>> = raw.into_iter().map(Some).collect();

    // --- Inline #tags ------------------------------------------------------
    // Pull these out first so they don't trip up the date/time scanners and
    // don't end up in the title body.
    let mut tags: Vec<String> = Vec::new();
    let mut seen_tags = std::collections::HashSet::new();
    for slot in tokens.iter_mut() {
        let Some(tok) = slot.as_ref() else { continue };
        if !tok.starts_with('#') || tok.len() <= 1 {
            continue;
        }
        let cleaned = tok[1..]
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
            .collect::<String>()
            .to_lowercase();
        if cleaned.is_empty() {
            continue;
        }
        if seen_tags.insert(cleaned.clone()) {
            tags.push(cleaned);
        }
        *slot = None;
    }

    let mut hour: Option<u32> = None;
    let mut minute: u32 = 0;
    let mut time_phrase: Option<String> = None;

    // --- Time parse pass --------------------------------------------------
    for i in 0..tokens.len() {
        let Some(tok) = tokens[i].as_ref() else { continue };
        if let Some((h, m)) = parse_time_token(tok) {
            hour = Some(h);
            minute = m;
            time_phrase = Some(tok.clone());
            tokens[i] = None;
            break;
        }
        // "3 pm" / "3:30 am"
        if i + 1 < tokens.len() {
            if let Some(next) = tokens[i + 1].as_ref() {
                let combined = format!("{tok}{next}");
                if let Some((h, m)) = parse_time_token(&combined) {
                    hour = Some(h);
                    minute = m;
                    time_phrase = Some(format!("{tok} {next}"));
                    tokens[i] = None;
                    tokens[i + 1] = None;
                    break;
                }
            }
        }
        if tok == "noon" {
            hour = Some(12);
            time_phrase = Some(tok.clone());
            tokens[i] = None;
            break;
        }
        if tok == "midnight" {
            hour = Some(0);
            time_phrase = Some(tok.clone());
            tokens[i] = None;
            break;
        }
    }

    // --- Date parse pass --------------------------------------------------
    let mut target_date: Option<NaiveDate> = None;
    let mut date_phrase: Option<String> = None;

    'date_loop: for i in 0..tokens.len() {
        let Some(tok) = tokens[i].clone() else { continue };

        match tok.as_str() {
            "today" => {
                target_date = Some(now.date_naive());
                date_phrase = Some(tok.clone());
                tokens[i] = None;
                break 'date_loop;
            }
            "tonight" => {
                target_date = Some(now.date_naive());
                date_phrase = Some(tok.clone());
                tokens[i] = None;
                if hour.is_none() {
                    hour = Some(20);
                }
                break 'date_loop;
            }
            "tomorrow" | "tmrw" | "tmw" => {
                target_date = Some(now.date_naive() + Duration::days(1));
                date_phrase = Some(tok.clone());
                tokens[i] = None;
                break 'date_loop;
            }
            _ => {}
        }

        if let Some(wd) = parse_weekday(&tok) {
            let days = days_until(now.weekday(), wd, false);
            target_date = Some(now.date_naive() + Duration::days(days));
            date_phrase = Some(tok.clone());
            tokens[i] = None;
            break 'date_loop;
        }

        // "next monday" / "next week"
        if tok == "next" && i + 1 < tokens.len() {
            if let Some(next_tok) = tokens[i + 1].as_ref() {
                if let Some(wd) = parse_weekday(next_tok) {
                    let days = days_until(now.weekday(), wd, true);
                    target_date = Some(now.date_naive() + Duration::days(days));
                    date_phrase = Some(format!("next {next_tok}"));
                    tokens[i] = None;
                    tokens[i + 1] = None;
                    break 'date_loop;
                }
                if next_tok == "week" {
                    target_date = Some(now.date_naive() + Duration::days(7));
                    date_phrase = Some("next week".to_string());
                    tokens[i] = None;
                    tokens[i + 1] = None;
                    break 'date_loop;
                }
            }
        }
    }

    // "in N <unit>"
    if target_date.is_none() {
        for i in 0..tokens.len().saturating_sub(2) {
            if tokens[i].as_deref() != Some("in") {
                continue;
            }
            let (Some(num_tok), Some(unit_tok)) =
                (tokens[i + 1].clone(), tokens[i + 2].clone())
            else {
                continue;
            };
            let Ok(n) = num_tok.parse::<i64>() else {
                continue;
            };
            let added = match unit_tok.as_str() {
                "second" | "seconds" | "sec" | "secs" => Some(Duration::seconds(n)),
                "minute" | "minutes" | "min" | "mins" => Some(Duration::minutes(n)),
                "hour" | "hours" | "hr" | "hrs" => Some(Duration::hours(n)),
                "day" | "days" => Some(Duration::days(n)),
                "week" | "weeks" => Some(Duration::days(n * 7)),
                _ => None,
            };
            if let Some(dur) = added {
                let target = now + dur;
                target_date = Some(target.date_naive());
                if hour.is_none() {
                    hour = Some(target.hour());
                    minute = target.minute();
                }
                date_phrase = Some(format!("in {num_tok} {unit_tok}"));
                tokens[i] = None;
                tokens[i + 1] = None;
                tokens[i + 2] = None;
                break;
            }
        }
    }

    let date = target_date.unwrap_or_else(|| now.date_naive());
    let hour = hour.unwrap_or(9);
    let naive = date.and_hms_opt(hour, minute, 0).ok_or(ParseError {
        message: "invalid time".into(),
    })?;
    let mut dt = match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => t,
        chrono::LocalResult::Ambiguous(a, _) => a,
        chrono::LocalResult::None => {
            return Err(ParseError {
                message: "ambiguous time (DST jump?)".into(),
            })
        }
    };

    // If the user didn't anchor a date and the resolved time is already in
    // the past today, push to tomorrow — they obviously didn't mean a past
    // alarm.
    if target_date.is_none() && dt < now {
        dt = dt + Duration::days(1);
    }

    let title_tokens: Vec<String> = tokens.into_iter().flatten().collect();
    let title = clean_title(&title_tokens);

    if title.is_empty() {
        return Err(ParseError {
            message: "no title — try 'tomorrow 9am gym'".into(),
        });
    }

    Ok(Parsed {
        due_at_ms: dt.timestamp_millis(),
        title,
        matched_date: date_phrase,
        matched_time: time_phrase,
        tags,
    })
}

fn parse_time_token(tok: &str) -> Option<(u32, u32)> {
    let lower = tok.to_lowercase();
    let (digits, am_pm) = if let Some(rest) = lower.strip_suffix("am") {
        (rest, Some(false))
    } else if let Some(rest) = lower.strip_suffix("pm") {
        (rest, Some(true))
    } else if let Some(rest) = lower.strip_suffix('a') {
        // Avoid matching words ending in 'a' like "tea"/"pizza".
        if !rest.chars().all(|c| c.is_ascii_digit() || c == ':') {
            return None;
        }
        (rest, Some(false))
    } else if let Some(rest) = lower.strip_suffix('p') {
        if !rest.chars().all(|c| c.is_ascii_digit() || c == ':') {
            return None;
        }
        (rest, Some(true))
    } else {
        // No am/pm suffix → require a colon. A bare number like "2" or "30"
        // is too ambiguous (and "2" was being grabbed as 02:00, eating the
        // "2" from phrases like "in 2 hours"). 24-hour times always have a
        // colon, so this is the right discriminator.
        if !lower.contains(':') {
            return None;
        }
        (lower.as_str(), None)
    };

    let (h_str, m_str) = if let Some(idx) = digits.find(':') {
        (&digits[..idx], &digits[idx + 1..])
    } else {
        (digits, "0")
    };

    let h: u32 = h_str.parse().ok()?;
    let m: u32 = m_str.parse().ok()?;
    if m >= 60 {
        return None;
    }

    let h = match am_pm {
        Some(false) if h == 12 => 0,
        Some(false) if h > 12 => return None,
        Some(false) => h,
        Some(true) if h == 12 => 12,
        Some(true) if h > 12 => return None,
        Some(true) => h + 12,
        None => h,
    };
    if h >= 24 {
        return None;
    }
    Some((h, m))
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    match s {
        "monday" | "mon" => Some(Weekday::Mon),
        "tuesday" | "tue" | "tues" => Some(Weekday::Tue),
        "wednesday" | "wed" | "weds" => Some(Weekday::Wed),
        "thursday" | "thu" | "thurs" => Some(Weekday::Thu),
        "friday" | "fri" => Some(Weekday::Fri),
        "saturday" | "sat" => Some(Weekday::Sat),
        "sunday" | "sun" => Some(Weekday::Sun),
        _ => None,
    }
}

fn days_until(today: Weekday, target: Weekday, force_next_week: bool) -> i64 {
    let today_n = today.num_days_from_monday() as i64;
    let target_n = target.num_days_from_monday() as i64;
    let diff = (target_n - today_n).rem_euclid(7);
    if force_next_week && diff == 0 {
        7
    } else {
        diff
    }
}

fn clean_title(tokens: &[String]) -> String {
    // Strip filler phrases like "remind me to" from the leading edge.
    // Don't strip from the middle — "remind boss to call" should keep
    // "remind" if it's actually part of the user's title (uncommon, but).
    let fillers: &[&str] = &[
        "remind", "me", "to", "do", "the", "a", "an", "that", "of", "please",
    ];
    let mut start = 0usize;
    while start < tokens.len() && fillers.contains(&tokens[start].as_str()) {
        start += 1;
    }
    let body = tokens[start..].join(" ");
    capitalize_first(body.trim())
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
    }

    fn dt_from_ms(ms: i64) -> DateTime<Local> {
        Local.timestamp_millis_opt(ms).single().unwrap()
    }

    #[test]
    fn tomorrow_with_time() {
        // Tue 2026-05-19 14:00
        let now = local(2026, 5, 19, 14, 0);
        let p = parse("tomorrow 3pm meeting", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Meeting");
        assert_eq!(dt.year(), 2026);
        assert_eq!(dt.month(), 5);
        assert_eq!(dt.day(), 20);
        assert_eq!(dt.hour(), 15);
        assert_eq!(dt.minute(), 0);
    }

    #[test]
    fn weekday_picks_this_week() {
        // Mon 2026-05-18
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("wed 9am stand up", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Stand up");
        assert_eq!(dt.day(), 20); // Wed
        assert_eq!(dt.hour(), 9);
    }

    #[test]
    fn next_weekday_jumps_a_week_when_same_day() {
        // Mon 2026-05-18
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("next monday 9am team review", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Team review");
        assert_eq!(dt.day(), 25); // following Mon
    }

    #[test]
    fn in_minutes() {
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("in 30 minutes break", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Break");
        assert_eq!(dt.hour(), 10);
        assert_eq!(dt.minute(), 30);
    }

    #[test]
    fn in_hours() {
        // Regression: "2" used to be eagerly parsed as 02:00, eating the
        // number from "in 2 hours" so the duration branch never matched.
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("in 2 hours call mom", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Call mom");
        assert_eq!(dt.day(), 18);
        assert_eq!(dt.hour(), 12);
        assert_eq!(dt.minute(), 0);
    }

    #[test]
    fn in_days() {
        // Same regression on days.
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("in 3 days dentist", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Dentist");
        assert_eq!(dt.day(), 21);
        assert_eq!(dt.hour(), 10);
    }

    #[test]
    fn inline_tags() {
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("tomorrow 9am gym #fitness #morning", now).unwrap();
        assert_eq!(p.title, "Gym");
        assert_eq!(p.tags, vec!["fitness".to_string(), "morning".to_string()]);
    }

    #[test]
    fn inline_tags_are_deduped_and_lowercased() {
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("#Work fix bug #work tomorrow", now).unwrap();
        assert_eq!(p.title, "Fix bug");
        assert_eq!(p.tags, vec!["work".to_string()]);
    }

    #[test]
    fn no_tags_means_empty_vec() {
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("tomorrow 9am gym", now).unwrap();
        assert!(p.tags.is_empty());
    }

    #[test]
    fn bare_hash_is_not_a_tag() {
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("buy # signs tomorrow", now).unwrap();
        // "#" alone (length 1) is left in the title; not parsed as a tag.
        assert!(p.tags.is_empty());
        assert!(p.title.contains('#') || p.title.to_lowercase().contains("signs"));
    }

    #[test]
    fn bare_number_is_not_a_time() {
        let now = local(2026, 5, 18, 10, 0);
        let p = parse("buy 2 milks", now).unwrap();
        // No date or time anchored — defaults to 09:00 next-occurrence (tomorrow
        // because today's 09:00 is past). What matters: "2" did NOT become a time.
        assert!(p.matched_time.is_none());
        assert_eq!(p.title, "Buy 2 milks");
    }

    #[test]
    fn time_only_in_past_bumps_to_tomorrow() {
        // 14:00 today; user says "8am gym" — clearly tomorrow.
        let now = local(2026, 5, 18, 14, 0);
        let p = parse("8am gym", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Gym");
        assert_eq!(dt.day(), 19);
        assert_eq!(dt.hour(), 8);
    }

    #[test]
    fn tonight_defaults_to_eight_pm() {
        let now = local(2026, 5, 18, 14, 0);
        let p = parse("tonight laundry", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Laundry");
        assert_eq!(dt.day(), 18);
        assert_eq!(dt.hour(), 20);
    }

    #[test]
    fn noon_keyword() {
        let now = local(2026, 5, 18, 9, 0);
        let p = parse("noon lunch", now).unwrap();
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(p.title, "Lunch");
        assert_eq!(dt.hour(), 12);
    }

    #[test]
    fn strips_remind_me_to() {
        let now = local(2026, 5, 18, 9, 0);
        let p = parse("remind me to call mom tomorrow 3pm", now).unwrap();
        assert_eq!(p.title, "Call mom");
        let dt = dt_from_ms(p.due_at_ms);
        assert_eq!(dt.day(), 19);
        assert_eq!(dt.hour(), 15);
    }

    #[test]
    fn no_title_is_an_error() {
        let now = local(2026, 5, 18, 9, 0);
        let p = parse("tomorrow 3pm", now);
        assert!(p.is_err());
    }

    #[test]
    fn empty_input_is_an_error() {
        let now = local(2026, 5, 18, 9, 0);
        let p = parse("   ", now);
        assert!(p.is_err());
    }
}
