//! Saving a thought that arrived from an Android share, possibly with the
//! app cold.
//!
//! `mobile_bg` deliberately no-ops when the process is cold — it needs a
//! live `AppHandle`. A share has no such luxury: the user may not have
//! opened Klaxon in days. So this path opens the database file directly
//! and inserts, with no Tauri runtime involved.
//!
//! The core takes a path and returns an id so it is testable on the
//! desktop host; only the JNI shim below is Android-only.

use std::path::Path;

use crate::error::AppResult;
use crate::models::ThoughtCreate;

/// Save a shared thought straight into the database at `db_path`.
///
/// Opens its own connection: the caller may be a separate Android process
/// with no Tauri runtime. `db::open` runs migrations, so this works even
/// if the share is the first thing to touch the file.
pub fn save_shared_thought(
    db_path: &Path,
    subject: Option<&str>,
    text: &str,
) -> AppResult<String> {
    let body = compose_body(subject, text);
    let conn = crate::db::open(db_path)?;
    let thought =
        crate::db::thoughts::create(&conn, ThoughtCreate { body, tags: Vec::new() })?;
    Ok(thought.id)
}

/// Browsers send the page title as the subject and the URL as the text.
/// Keep both, on separate lines, so the feed shows the title as the
/// heading and the link below it. Skip the subject when it adds nothing.
fn compose_body(subject: Option<&str>, text: &str) -> String {
    match subject.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s != text.trim() => format!("{s}\n{}", text.trim()),
        _ => text.trim().to_string(),
    }
}

/// JNI entry point for the Kotlin `ShareActivity`.
///
/// Kotlin passes `Context.dataDir` — matching what Tauri's
/// `app_data_dir()` resolves to on Android — and this appends the database
/// filename, so both processes agree on one file.
///
/// A null/empty subject is passed as an empty string and treated as absent.
/// `catch_unwind` keeps a Rust panic from unwinding across the FFI
/// boundary, which is undefined behaviour — same discipline as
/// `mobile_bg`'s entry points.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_klaxon_app_ShareActivity_nativeSaveThought<'local>(
    mut env: jni::JNIEnv<'local>,
    _this: jni::objects::JObject<'local>,
    data_dir: jni::objects::JString<'local>,
    subject: jni::objects::JString<'local>,
    text: jni::objects::JString<'local>,
) -> jni::sys::jint {
    crate::mobile_bg::ensure_android_logging();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let Ok(dir) = env.get_string(&data_dir) else {
            return -2;
        };
        let Ok(body) = env.get_string(&text) else {
            return -2;
        };
        let subject: String = env.get_string(&subject).map(Into::into).unwrap_or_default();

        let dir: String = dir.into();
        let body: String = body.into();
        let db_path = std::path::Path::new(&dir).join("klaxon.db");

        let subject = if subject.trim().is_empty() {
            None
        } else {
            Some(subject.as_str())
        };

        match save_shared_thought(&db_path, subject, &body) {
            Ok(id) => {
                log::info!("saved shared thought {id}");
                0
            }
            Err(e) => {
                log::error!("share save failed: {e}");
                -1
            }
        }
    }));
    result.unwrap_or(-3)
}

#[cfg(test)]
mod tests {
    use super::save_shared_thought;

    fn temp_db() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("klaxon-share-test-{}.db", uuid::Uuid::new_v4()));
        p
    }

    #[test]
    fn saves_plain_text_into_a_fresh_database() {
        let path = temp_db();
        // A share can be the first thing that ever touches this file, so
        // the write path has to create and migrate it, not assume the app
        // has run before.
        let id = save_shared_thought(&path, None, "an idea from the phone").unwrap();
        assert!(!id.is_empty());

        let conn = crate::db::open(&path).unwrap();
        let got = crate::db::thoughts::get_by_id(&conn, &id).unwrap();
        assert_eq!(got.body, "an idea from the phone");
        assert!(got.updated_at > 0, "updated_at set — the watermark the next sync selects on");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn browser_shares_keep_both_subject_and_url() {
        let path = temp_db();
        // Chrome sends the page title as EXTRA_SUBJECT and the URL as
        // EXTRA_TEXT; keeping only one loses half the point of the share.
        let id = save_shared_thought(
            &path,
            Some("Some Article Title"),
            "https://example.com/article",
        )
        .unwrap();

        let conn = crate::db::open(&path).unwrap();
        let got = crate::db::thoughts::get_by_id(&conn, &id).unwrap();
        assert!(got.body.contains("Some Article Title"));
        assert!(got.body.contains("https://example.com/article"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_subject_identical_to_the_text_is_not_duplicated() {
        let path = temp_db();
        let id = save_shared_thought(&path, Some("same"), "same").unwrap();
        let conn = crate::db::open(&path).unwrap();
        assert_eq!(crate::db::thoughts::get_by_id(&conn, &id).unwrap().body, "same");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn inline_tags_in_shared_text_still_become_tags() {
        let path = temp_db();
        let id = save_shared_thought(&path, None, "read later #article").unwrap();
        let conn = crate::db::open(&path).unwrap();
        assert_eq!(
            crate::db::thoughts::get_by_id(&conn, &id).unwrap().tags,
            vec!["article".to_string()]
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn empty_shares_are_rejected() {
        let path = temp_db();
        assert!(save_shared_thought(&path, None, "   ").is_err());
        std::fs::remove_file(&path).ok();
    }
}
