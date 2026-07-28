# Thoughts M2 — Desktop Global Hotkey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A system-wide hotkey that opens a small always-on-top capture box, saves a thought, and disappears — without touching the main window.

**Architecture:** A second Tauri webview window built from its own HTML entry point (`capture.html`), exactly as `alert.html` already works for alerts. The existing single-hotkey machinery in `lib.rs` is generalized to hold two registered shortcuts instead of one, since it currently stores exactly one `Shortcut` and would otherwise need a duplicate of its parse/unregister/register logic.

**Tech Stack:** Rust, Tauri 2 (`tauri-plugin-global-shortcut`, `WebviewWindowBuilder`), Svelte 5 runes, TypeScript, Vite multi-entry build.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-thoughts-design.md` §5 ("Desktop global hotkey"). This plan is **M2 only** — the Android share-target (M3) is separate.
- Builds on M1, already merged into branch `feat/thoughts`.
- `cargo test` green and `cargo build` **0 warnings**. Baseline entering M2: **71 tests, 0 warnings**.
- `npx svelte-check` **0 errors**; do not exceed the 7 pre-existing warnings.
- Everything here is **desktop-only** and must sit behind `#[cfg(desktop)]`. `Cargo.toml:55` notes the global-shortcut plugin assumes a windowed desktop OS; an ungated reference breaks the Android build, which M3 needs working.
- Reuse `ThoughtComposer.svelte` as-is. Do not fork it — the `#tag` highlighting must stay identical in both places.
- Default hotkey: **`Ctrl+Alt+KeyT`**. `Ctrl+Alt+KeyN` is taken by the existing new-reminder hotkey (`settings.rs:23`).

---

### Task 1: Capture window entry point

Mirrors the existing `alert.html` → `src/alert.ts` → `src/Alert.svelte` trio. Nothing Rust-side yet; this task ends with a page that builds.

**Files:**
- Create: `capture.html` (project root, beside `alert.html`)
- Create: `src/capture.ts`
- Create: `src/Capture.svelte`
- Modify: `vite.config.ts` (`build.rollupOptions.input`)

**Interfaces:**
- Consumes: `ThoughtComposer.svelte`, `api.createThought` from M1.
- Produces: a `/capture.html` route rendering the composer alone.

- [ ] **Step 1: Create the HTML entry**

Create `capture.html`, copying `alert.html` exactly except the mount id and script path:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Klaxon — Capture</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@400;500;700;800;900&family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="capture"></div>
    <script type="module" src="/src/capture.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the mount script**

Create `src/capture.ts`:

```ts
import "./app.css";
import Capture from "./Capture.svelte";
import { mount } from "svelte";

const app = mount(Capture, { target: document.getElementById("capture")! });

export default app;
```

- [ ] **Step 3: Create the component**

Create `src/Capture.svelte`. Esc closes the window; a successful save closes it too. Closing is `getCurrentWindow().close()` — the window is cheap to rebuild and keeping it alive would leave a stale always-on-top box around.

```svelte
<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { api } from "./lib/api";
  import ThoughtComposer from "./lib/components/ThoughtComposer.svelte";

  async function save(body: string) {
    try {
      await api.createThought({ body, tags: [] });
    } catch (e) {
      console.error("capture failed", e);
      return; // Leave the window open so the text isn't lost.
    }
    await getCurrentWindow().close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      void getCurrentWindow().close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="capture">
  <div class="bar mono-caps-faint">Capture a thought</div>
  <ThoughtComposer onCreate={save} />
</div>

<style>
  .capture {
    background: var(--bg);
    border: 1px solid var(--klaxon-dim);
    height: 100vh;
    box-sizing: border-box;
    overflow: hidden;
  }
  .bar {
    padding: 8px 16px 0;
    font-size: 9px;
    letter-spacing: 0.22em;
  }
</style>
```

- [ ] **Step 4: Register the entry with Vite**

In `vite.config.ts`, add `capture` beside the existing `main` and `alert` inputs:

```ts
      input: {
        main: resolve(__dirname, "index.html"),
        alert: resolve(__dirname, "alert.html"),
        capture: resolve(__dirname, "capture.html"),
      },
```

- [ ] **Step 5: Verify it builds and type-checks**

Run: `npx svelte-check --threshold error`
Expected: 0 errors.

Run: `npm run build`
Expected: build succeeds and the output lists a `capture` chunk alongside `main` and `alert`.

- [ ] **Step 6: Commit**

```bash
git add capture.html src/capture.ts src/Capture.svelte vite.config.ts
git commit -m "feat(thoughts): capture window entry point"
```

---

### Task 2: Spawn the capture window from Rust

**Files:**
- Create: `src-tauri/src/capture.rs`
- Modify: `src-tauri/src/lib.rs` (module declaration)

**Interfaces:**
- Produces: `pub fn spawn(app: &AppHandle)` — opens the capture window, or focuses it if already open.

- [ ] **Step 1: Write the module**

Create `src-tauri/src/capture.rs`. The centering and monitor-selection logic follows `alerts/popup.rs`, which already solves "which screen is the user looking at":

```rust
//! The global-hotkey capture window: a small always-on-top box holding
//! just the thought composer.
//!
//! Deliberately its own window rather than focusing the main one — the
//! point of hotkey capture is to not pull the user out of what they were
//! doing. Closing it discards the window entirely; it is cheap to rebuild
//! and leaving it alive would keep a stale always-on-top box around.

use tauri::{AppHandle, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "capture";
const W: f64 = 560.0;
const H: f64 = 190.0;

pub fn spawn(app: &AppHandle) {
    // Already open — focus it instead of stacking a second box.
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let (x, y) = centered_position(app);

    let result = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("capture.html".into()))
        .title("Klaxon — Capture")
        .inner_size(W, H)
        .position(x, y)
        .always_on_top(true)
        .skip_taskbar(true)
        .decorations(false)
        .resizable(false)
        // Unlike an alert, this window exists to be typed into, so it
        // takes focus immediately.
        .focused(true)
        .visible(true)
        .build();

    if let Err(e) = result {
        log::error!("failed to spawn capture window: {e}");
    }
}

/// The monitor holding the main window, falling back to primary — same
/// heuristic `alerts::popup` uses to pick the screen in front of the user.
fn target_monitor(app: &AppHandle) -> Option<Monitor> {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(Some(m)) = w.current_monitor() {
            return Some(m);
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Horizontally centered, one third down — where the eye already is,
/// rather than dead centre over whatever the user was reading.
fn centered_position(app: &AppHandle) -> (f64, f64) {
    let Some(monitor) = target_monitor(app) else {
        return (240.0, 240.0);
    };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    let x = pos.x + (size.width - W) / 2.0;
    let y = pos.y + (size.height - H) / 3.0;
    (x, y)
}
```

- [ ] **Step 2: Declare the module**

In `src-tauri/src/lib.rs`, add to the module list. It must be desktop-gated — the Android build has no such window:

```rust
#[cfg(desktop)]
mod capture;
```

- [ ] **Step 3: Verify it compiles clean**

Run: `cd src-tauri && cargo build 2>&1 | grep -c "^warning"`
Expected: `0`. An "unused function" warning here means Step 2's `#[cfg]` gate or the module name is wrong — do not silence it with `#[allow(dead_code)]`, Task 3 is what calls it.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/capture.rs src-tauri/src/lib.rs
git commit -m "feat(thoughts): capture window spawner"
```

---

### Task 3: A second global hotkey

`install_global_hotkey` (`lib.rs:308`) currently owns exactly one `Shortcut`, stored in `AppState.current_hotkey: Arc<Mutex<Option<Shortcut>>>`. Rather than duplicate its parse/unregister/register logic, it gains a parameter for what the shortcut should *do*.

**Files:**
- Modify: `src-tauri/src/lib.rs:308-350` (`install_global_hotkey`, `AppState`, setup)
- Modify: `src-tauri/src/db/settings.rs:23` (defaults)
- Modify: `src-tauri/src/commands.rs:171-181` (`set_global_hotkey`, plus a new command)

**Interfaces:**
- Produces:
  - `pub enum HotkeyAction { NewReminder, CaptureThought }`
  - `pub fn install_global_hotkey(app, slot, combo, action) -> AppResult<()>`
  - `AppState.capture_hotkey: Arc<Mutex<Option<Shortcut>>>`
  - setting key `global_hotkey_capture`, default `Ctrl+Alt+KeyT`
  - command `set_capture_hotkey(combo: String)`

- [ ] **Step 1: Add the setting default**

In `src-tauri/src/db/settings.rs`, beside the existing hotkey defaults:

```rust
        ("global_hotkey_capture", "Ctrl+Alt+KeyT"),
```

- [ ] **Step 2: Generalize the installer**

In `src-tauri/src/lib.rs`, add above `install_global_hotkey`:

```rust
/// What a registered global hotkey does when pressed.
#[cfg(desktop)]
#[derive(Debug, Clone, Copy)]
pub enum HotkeyAction {
    /// Raise the main window and open the new-reminder editor.
    NewReminder,
    /// Open the standalone thought-capture box, leaving the main window
    /// alone — the whole point is not to interrupt what's on screen.
    CaptureThought,
}
```

Then change the signature and the `on_shortcut` body. Everything else in the function is unchanged:

```rust
pub fn install_global_hotkey(
    app: &AppHandle,
    current: &Mutex<Option<Shortcut>>,
    combo: &str,
    action: HotkeyAction,
) -> AppResult<()> {
```

```rust
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _sc, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            match action {
                HotkeyAction::NewReminder => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                    let _ = app.emit(tray::EVT_OPEN_NEW, ());
                }
                HotkeyAction::CaptureThought => crate::capture::spawn(app),
            }
        })
```

- [ ] **Step 3: Add the state slot**

In `AppState` (`lib.rs:33`), beside `current_hotkey`:

```rust
    #[cfg(desktop)]
    pub capture_hotkey: Arc<Mutex<Option<Shortcut>>>,
```

- [ ] **Step 4: Register both at startup**

In the setup block near `lib.rs:235`, the existing call gains its new argument and a second registration follows. Create `capture_hotkey` the same way `current_hotkey` is created, and pass it into `AppState`:

```rust
            #[cfg(desktop)]
            let capture_hotkey: Arc<Mutex<Option<Shortcut>>> = Arc::new(Mutex::new(None));
            #[cfg(desktop)]
            {
                let stored = cfg::get(&conn, "global_hotkey_capture")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "Ctrl+Alt+KeyT".to_string());
                if let Err(e) = install_global_hotkey(
                    &app.handle().clone(),
                    &capture_hotkey,
                    &stored,
                    HotkeyAction::CaptureThought,
                ) {
                    log::warn!("could not register capture hotkey {stored:?}: {e}");
                }
            }
```

Match the surrounding code's exact way of reading a setting — copy the shape of the existing `global_hotkey_new` block rather than the sketch above if they differ.

- [ ] **Step 5: Add the command**

In `src-tauri/src/commands.rs`, update the existing `set_global_hotkey` call site to pass `HotkeyAction::NewReminder`, then add:

```rust
/// Re-register the thought-capture hotkey. An empty string clears it.
#[cfg(desktop)]
#[tauri::command]
pub fn set_capture_hotkey(
    state: State<'_, AppState>,
    app: AppHandle,
    combo: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock();
        cfg::set(&conn, "global_hotkey_capture", &combo)?;
    }
    crate::install_global_hotkey(
        &app,
        &state.capture_hotkey,
        &combo,
        crate::HotkeyAction::CaptureThought,
    )
}
```

Register it in `lib.rs`'s `generate_handler!`, gated exactly like the neighbouring `set_global_hotkey`:

```rust
            #[cfg(desktop)]
            commands::set_capture_hotkey,
```

- [ ] **Step 6: Verify**

Run: `cd src-tauri && cargo test 2>&1 | grep -E "^test result"`
Expected: 71 passing, 0 failed.

Run: `cd src-tauri && cargo build 2>&1 | grep -c "^warning"`
Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/src/db/settings.rs
git commit -m "feat(thoughts): register a second global hotkey for capture"
```

---

### Task 4: Settings UI

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/lib/components/SettingsModal.svelte`

**Interfaces:**
- Produces: `api.setCaptureHotkey(combo: string)`; a hotkey field in Settings beside the existing one.

- [ ] **Step 1: Add the API binding**

In `src/lib/api.ts`, beside `setGlobalHotkey`:

```ts
  setCaptureHotkey: (combo: string) =>
    invoke<void>("set_capture_hotkey", { combo }),
```

- [ ] **Step 2: Add the settings field**

`SettingsModal.svelte` drives hotkey recording off a `HotkeySlot` union (`:45`), so a third slot has to be threaded through five places. All of them:

1. Widen the union (`:45`) and add the state (`:43-44`):

```ts
  let captureHotkey_ = $state("Ctrl+Alt+KeyT");
  type HotkeySlot = "global" | "quickadd" | "capture" | null;
```

Note the trailing underscore: there is already a **function** named `captureHotkey` at `:203` that records a key combo. A state variable of the same name would shadow it and break every hotkey field in the modal, silently.

2. Load it (`:106-107`):

```ts
      captureHotkey_ = settings["global_hotkey_capture"] ?? "Ctrl+Alt+KeyT";
```

3. Handle the slot in `captureHotkey()` — both the clear branch (`:215-216`) and the assign branch (`:224-225`):

```ts
      else if (slot === "capture") captureHotkey_ = "";
```

```ts
      else if (slot === "capture") captureHotkey_ = combo;
```

4. Persist it in the save path, beside the existing `api.setGlobalHotkey` call (`:160`), inside the same `try`/`catch` so a rejected combo surfaces in `error`:

```ts
          await api.setCaptureHotkey(captureHotkey_ ?? "");
```

5. Reset it in the defaults handler (`:189-190`):

```ts
    captureHotkey_ = "Ctrl+Alt+KeyT";
```

Then add the row inside the same `{#if !isMobile}` block as the Global · New Reminder row — it is desktop-only and must not appear on Android:

```svelte
              <div class="hotkey-row">
                <span class="hotkey-label-text">Global · Capture Thought</span>
                <button
                  class="hotkey-btn"
                  class:recording={recordingSlot === "capture"}
                  onclick={() => (recordingSlot = recordingSlot === "capture" ? null : "capture")}
                >
                  {#if recordingSlot === "capture"}
                    <span class="rec-dot"></span>
                    <span>Press combo… (Esc cancel · Del clear)</span>
                  {:else}
                    <span class="hotkey-value">{prettyShortcut(captureHotkey_)}</span>
                  {/if}
                </button>
                <button
                  class="hotkey-clear"
                  onclick={() => { captureHotkey_ = ""; recordingSlot = null; }}
                  disabled={!captureHotkey_}
                >
                  Clear
                </button>
              </div>
```

Registration failure stays visible for free: the backend returns an error for a combo another app already owns, and the existing `catch` at `:161-163` writes it to `error`.

- [ ] **Step 3: Verify**

Run: `npx svelte-check --threshold error`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/lib/components/SettingsModal.svelte
git commit -m "feat(thoughts): capture hotkey setting"
```

---

### Task 5: Manual verification

**Files:** none.

- [ ] **Step 1: Run the dev build**

Run: `npm run tauri dev`

- [ ] **Step 2: Verify each behaviour**

1. Press `Ctrl+Alt+KeyT` with Klaxon **not** focused — a small box appears, already focused, over whatever you were doing. The main window does **not** come forward.
2. Type a thought, press Enter — the box closes and the thought is in the feed.
3. Press the hotkey, type nothing, press Esc — the box closes and no thought is saved.
4. Type `#idea` in the box — it highlights orange, same as the main composer.
5. Press the hotkey twice in a row — one box, focused, not two.
6. Press `Ctrl+Alt+KeyN` — the old new-reminder hotkey still works and still raises the main window.
7. Change the capture hotkey in Settings, then confirm the new combo works and the old one does nothing.
8. Set the capture hotkey to `Ctrl+Alt+KeyN` (already taken) — the error surfaces in Settings rather than failing silently.
9. Close the box while the main window is hidden in the tray — Klaxon keeps running, no stray window.

- [ ] **Step 3: Confirm the Android build still compiles**

The whole milestone is desktop-only; this catches a missing `#[cfg(desktop)]` before M3 depends on it.

Run: `npm run tauri android build -- --debug`
Expected: compiles. A `cannot find module capture` or global-shortcut error means a gate is missing.

- [ ] **Step 4: Commit any fixes and update the changelog**

```bash
git add -A
git commit -m "docs: changelog entry for hotkey capture"
```
