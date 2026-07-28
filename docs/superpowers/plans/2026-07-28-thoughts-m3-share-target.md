# Thoughts M3 — Android Share-Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Klaxon appears in the Android share sheet; sharing text or a link saves a thought and shows a toast, leaving you in the app you shared from.

**Architecture:** A separate, invisible `ShareActivity` — **not** an intent-filter on `MainActivity`, which is `launchMode="singleTask"` and would drag Klaxon to the foreground, defeating the whole point. Because a share can arrive with the app cold, the activity cannot reuse `mobile_bg`'s warm-only path; it calls a new JNI entry point that opens the SQLite file directly and inserts. The write core is a plain Rust function taking a path, so it is unit-testable on the desktop host.

**Tech Stack:** Kotlin (Android Activity + intent handling), Rust (`jni` 0.21, `rusqlite`), Android manifest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-thoughts-design.md` §5 ("Android share-target"). M3 only.
- Builds on M1 + M2, on branch `feat/thoughts`.
- `cargo test` green, `cargo build` **0 warnings**. Baseline entering M3: **71 tests, 0 warnings**.
- **Android builds need JDK 17–21.** JDK 25 fails at Gradle configure with a bare `> 25.0.2`. Use Android Studio's bundled runtime:
  ```bash
  export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
  export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
  export NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
  ```
- **The database path is `Context.dataDir`, not `filesDir`.** Tauri's `app_data_dir()` on Android resolves via `PathPlugin.getDataDir` → `activity.dataDir.absolutePath` (`tauri-2.11.0/mobile/.../PathPlugin.kt:64`), and `lib.rs:147-151` joins `klaxon.db` onto it. Using `filesDir` would write to a second database the app never reads — shares would report success and silently vanish. `Context.dataDir` is API 24+; `minSdk = 24`, so it is available.
- Everything Rust-side is `#[cfg(target_os = "android")]` except the pure write core, which must stay host-testable.
- Do not add a foreground service or a persistent notification — explicitly rejected.

---

### Task 1: Cold-start-safe write core + busy timeout

Two processes now write the same SQLite file: the app and the share activity. `db::open` sets WAL but **no busy timeout** (`db/mod.rs`), so a concurrent write fails instantly with `SQLITE_BUSY` instead of waiting. That is a pre-existing gap this milestone makes reachable.

**Files:**
- Modify: `src-tauri/src/db/mod.rs` (`open`)
- Create: `src-tauri/src/share.rs`
- Modify: `src-tauri/src/lib.rs` (module declaration)

**Interfaces:**
- Produces: `pub fn save_shared_thought(db_path: &Path, subject: Option<&str>, text: &str) -> AppResult<String>` returning the new thought id.

- [ ] **Step 1: Add the busy timeout**

In `src-tauri/src/db/mod.rs`, inside `open`, after the existing pragmas:

```rust
    // Two processes write this file on Android: the app, and the share
    // activity that receives an Android share while the app may be cold.
    // Without a busy timeout the loser of a race fails immediately with
    // SQLITE_BUSY rather than waiting for the other's transaction.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/share.rs`:

```rust
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
        assert!(got.dirty, "must be dirty so the next sync pushes it");
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
```

- [ ] **Step 3: Register the module and confirm the test fails**

In `src-tauri/src/lib.rs`, add to the module list (not gated — the core is host-testable):

```rust
pub mod share;
```

Run: `cd src-tauri && cargo test share::`
Expected: FAIL — `cannot find function save_shared_thought`.

- [ ] **Step 4: Write the core**

Add above the test module in `src-tauri/src/share.rs`:

```rust
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
    let thought = crate::db::thoughts::create(
        &conn,
        ThoughtCreate { body, tags: Vec::new() },
    )?;
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
```

- [ ] **Step 5: Verify**

Run: `cd src-tauri && cargo test share::`
Expected: 5 tests PASS.

Run: `cd src-tauri && cargo test && cargo build 2>&1 | grep -c "^warning"`
Expected: 76 tests pass; warning count `0`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/share.rs src-tauri/src/db/mod.rs src-tauri/src/lib.rs
git commit -m "feat(thoughts): cold-start-safe share write path + busy timeout"
```

---

### Task 2: JNI entry point

**Files:**
- Modify: `src-tauri/src/share.rs` (append)

**Interfaces:**
- Produces: `Java_com_klaxon_app_ShareActivity_nativeSaveThought(env, this, dbPath: JString, subject: JString, text: JString) -> jint`. Returns `0` on success, `-1` on a Rust error, `-2` on a JNI string failure, `-3` on panic.

- [ ] **Step 1: Write the shim**

Append to `src-tauri/src/share.rs`. Follows the `catch_unwind` discipline `mobile_bg.rs` already uses — a panic unwinding across the FFI boundary is undefined behaviour:

```rust
/// JNI entry point for the Kotlin `ShareActivity`.
///
/// Kotlin passes `Context.dataDir` — matching what Tauri's
/// `app_data_dir()` resolves to on Android — and this appends the database
/// filename, so both processes agree on one file.
///
/// A null/empty subject is passed as an empty string and treated as absent.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_klaxon_app_ShareActivity_nativeSaveThought<'local>(
    mut env: jni::JNIEnv<'local>,
    _this: jni::objects::JObject<'local>,
    data_dir: jni::objects::JString<'local>,
    subject: jni::objects::JString<'local>,
    text: jni::objects::JString<'local>,
) -> jni::sys::jint {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let Ok(dir) = env.get_string(&data_dir) else {
            return -2;
        };
        let Ok(body) = env.get_string(&text) else {
            return -2;
        };
        let subject: String = env
            .get_string(&subject)
            .map(Into::into)
            .unwrap_or_default();

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
```

- [ ] **Step 2: Verify both targets compile**

Run: `cd src-tauri && cargo build 2>&1 | grep -c "^warning"`
Expected: `0` — the shim is cfg'd out on desktop, so only the core compiles here.

Run (with the Android env from Global Constraints): `npm run tauri android build -- --debug`
Expected: build succeeds. This is the only check that actually compiles the JNI shim.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/share.rs
git commit -m "feat(thoughts): JNI entry point for the Android share target"
```

---

### Task 3: ShareActivity and manifest

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/ShareActivity.kt`
- Modify: `src-tauri/gen/android/app/src/main/AndroidManifest.xml`

`gen/android` is generated but **tracked in git** (confirmed via `git check-ignore`), so edits here persist — the same way `MainActivity.kt` already carries hand-written background-sync code.

**Interfaces:**
- Consumes: the JNI entry point from Task 2.
- Produces: Klaxon in the system share sheet for `text/plain`.

- [ ] **Step 1: Write the activity**

Create `ShareActivity.kt`:

```kotlin
package com.klaxon.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast

/**
 * Receives an Android share and writes it straight to the database.
 *
 * Deliberately NOT an intent-filter on MainActivity: that activity is
 * launchMode="singleTask", so routing shares through it would bring Klaxon
 * to the foreground. The point of this path is that you stay in whatever
 * app you shared from.
 *
 * The insert runs on the main thread. It is a single INSERT into a local
 * SQLite file — sub-millisecond in practice — and the activity has nothing
 * to render while waiting.
 */
class ShareActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val text = intent?.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent?.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""

    if (text.isNullOrBlank()) {
      toast("Nothing to save")
      finish()
      return
    }

    val code = try {
      System.loadLibrary("klaxon_lib")
      // Context.dataDir, not filesDir — this must match what Tauri's
      // app_data_dir() resolves to, or the thought lands in a second
      // database the app never reads.
      nativeSaveThought(applicationContext.dataDir.absolutePath, subject, text)
    } catch (e: Throwable) {
      -99
    }

    toast(if (code == 0) "Saved to Klaxon" else "Klaxon couldn't save that")
    finish()
  }

  private fun toast(msg: String) {
    Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
  }

  private external fun nativeSaveThought(
    dataDir: String,
    subject: String,
    text: String,
  ): Int
}
```

- [ ] **Step 2: Declare it in the manifest**

In `AndroidManifest.xml`, inside `<application>` after the existing `<activity>`:

```xml
        <!-- Share target. Translucent rather than Theme.NoDisplay: NoDisplay
             crashes if the activity reaches onResume without finishing, and
             a slow first-run migration could do exactly that. noHistory and
             excludeFromRecents keep this invisible activity out of the
             recents list. -->
        <activity
            android:name=".ShareActivity"
            android:exported="true"
            android:theme="@android:style/Theme.Translucent.NoTitleBar"
            android:noHistory="true"
            android:excludeFromRecents="true"
            android:label="@string/app_name">
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
        </activity>
```

- [ ] **Step 3: Build and install**

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
npm run tauri android build -- --debug
"$ANDROID_HOME/platform-tools/adb" install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Expected: `Success`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/klaxon/app/ShareActivity.kt \
        src-tauri/gen/android/app/src/main/AndroidManifest.xml
git commit -m "feat(thoughts): Android share target"
```

---

### Task 4: On-device verification

The JNI signature, the intent filter, and the path agreement can only be proven on hardware — a wrong JNI name links fine and fails at runtime with `UnsatisfiedLinkError`.

**Files:** none.

- [ ] **Step 1: Watch the log**

```bash
"$ANDROID_HOME/platform-tools/adb" logcat -c
"$ANDROID_HOME/platform-tools/adb" logcat | grep -iE "klaxon|UnsatisfiedLink|ShareActivity"
```

- [ ] **Step 2: Verify each behaviour**

1. **Force-stop Klaxon first** (Settings → Apps → Klaxon → Force stop) so the share hits a genuinely cold process — the case `mobile_bg` cannot handle and the one most likely to break.
2. Share a link from Chrome. A toast says "Saved to Klaxon", and **Chrome stays in the foreground**.
3. Open Klaxon → Thoughts. The thought is there, with the page title on the first line and the URL below.
4. Confirm the log shows `saved shared thought <id>` and no `UnsatisfiedLinkError`.
5. Share plain selected text from any app — saves with no subject line.
6. Share text containing `#idea` — the tag chip appears, proving extraction runs on this path too.
7. Share **while Klaxon is open in the background**, then foreground it. The thought appears once you enter the Thoughts view. (Known gap: a share cannot emit `klaxon://thoughts-changed` into the other process, so a feed already on screen will not live-update.)
8. With desktop Klaxon running and paired, confirm the shared thought syncs across.

- [ ] **Step 3: Record the outcome**

Add a Thoughts entry to `CHANGELOG.md` covering M1–M3, noting the sync-refresh gap in point 7.

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the Thoughts feed"
```
