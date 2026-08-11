# Tasks Board Persistent Order + Star Priority (v0.8.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cards on the Tasks board keep the exact position they're dragged to (persisted + synced), gain a 1–3 star priority control on the card face and editor, and lanes get a one-shot "sort by stars" action.

**Architecture:** A new nullable `REAL task_sort_key` column on `reminders` orders each lane ascending (smallest = top). Drops call a new `place_task` command that computes a midpoint key server-side from the drop's neighbors — one record written per drag, syncing through the existing record-level LWW. Stars reuse `Reminder.priority` (low/normal/high = ★/★★/★★★); no new field.

**Tech Stack:** Rust (rusqlite, Tauri v2 commands), Svelte 5 (runes), svelte-dnd-action, postcard sync protocol.

**Spec:** `docs/superpowers/specs/2026-08-11-board-order-stars-design.md`

## Global Constraints

- `KEY_STRIDE = 1024.0`, `MIN_KEY_GAP = 1e-6` — the only ordering constants; defined once in `src-tauri/src/db/reminders.rs`.
- Lanes render **ascending** by `task_sort_key`; smallest key = top of lane. New tasks land at the top (`min(lane) − 1024`, or `1024` in an empty lane).
- `svelte-check` must stay at 0 errors 0 warnings (`npm run check`) — with one sanctioned exception: Task 5's commit intentionally leaves exactly one error (TasksBoard's `setTaskLane` call), which Task 6 clears.
- `cargo test` and a zero-warning build (`RUSTFLAGS="-D warnings" cargo build`) must pass in `src-tauri/` before each commit.
- Run all cargo commands from `src-tauri/` (that's the workspace root).
- This is a **postcard wire-format break** (RemoteReminder gains a field): pre-0.8 peers fail frame decode with the existing friendly error. Version is bumped to 0.8.0 in the final task only.
- Never start an Android build while a frontend build is in flight (the APK bakes `dist/` at build start).
- End commit messages with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Priority mapping everywhere: low=1 star, normal=2 stars, high=3 stars (`Priority::as_int()` is 0/1/2 — stars are `as_int()+1`).

---

### Task 1: Migration 014 — `task_sort_key` column + backfill

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append to `MIGRATIONS` const, add test)

**Interfaces:**
- Produces: `reminders.task_sort_key REAL` column; backfilled `1024·n` per lane in today's visible order (`updated_at DESC`), so nothing visibly moves on upgrade. Non-task rows (`task_lane_id IS NULL`) keep `NULL`.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `src-tauri/src/db/migrations.rs`:

```rust
    /// Migration 014: tasks get gapped sort keys per lane, assigned in
    /// the pre-migration visible order (updated_at DESC) — the board
    /// must not visibly reshuffle on upgrade. Runs all migrations
    /// EXCEPT the last, seeds rows, then applies the last one.
    #[test]
    fn migration_014_backfills_sort_keys_in_visible_order() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
        )
        .unwrap();
        for (idx, sql) in super::MIGRATIONS
            .iter()
            .enumerate()
            .take(super::MIGRATIONS.len() - 1)
        {
            conn.execute_batch(sql).unwrap();
            conn.execute(
                "INSERT INTO schema_version(version) VALUES (?1)",
                [(idx + 1) as i64],
            )
            .unwrap();
        }
        // Three tasks in the seed Todo lane. r1 is newest → today it
        // renders on top → it must get the smallest key.
        for (id, up) in [("r1", 3000), ("r2", 2000), ("r3", 1000)] {
            conn.execute(
                "INSERT INTO reminders
                 (id, title, due_at, priority, state, created_at, updated_at, silent, tags, task_lane_id)
                 VALUES (?1, 'task', 0, 1, 'pending', 1, ?2, 1, '[]',
                         '00000000-0000-4000-8000-000000000001')",
                rusqlite::params![id, up],
            )
            .unwrap();
        }
        // A non-task reminder must stay NULL.
        conn.execute(
            "INSERT INTO reminders
             (id, title, due_at, priority, state, created_at, updated_at, silent, tags)
             VALUES ('ring', 'rings', 0, 1, 'pending', 1, 1, 0, '[]')",
            [],
        )
        .unwrap();

        super::run(&conn).unwrap();

        let key = |id: &str| -> Option<f64> {
            conn.query_row(
                "SELECT task_sort_key FROM reminders WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(key("r1"), Some(1024.0));
        assert_eq!(key("r2"), Some(2048.0));
        assert_eq!(key("r3"), Some(3072.0));
        assert_eq!(key("ring"), None, "non-tasks keep NULL");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `src-tauri/`): `cargo test migration_014 -- --nocapture`
Expected: FAIL — `no such column: task_sort_key`

- [ ] **Step 3: Append migration 014 to the `MIGRATIONS` const**

After the 013 entry (the `DROP COLUMN dirty` block), append:

```rust
    // 014 — v0.8: persistent manual card order on the Tasks board.
    //
    // Lanes render ascending by task_sort_key (smallest on top). Drops
    // write a midpoint between the new neighbors, so one row changes
    // per drag. Backfill follows the pre-0.8 visible order
    // (updated_at DESC) so the board looks identical after upgrade.
    // NULL on non-task rows.
    r#"
    ALTER TABLE reminders ADD COLUMN task_sort_key REAL;

    UPDATE reminders SET task_sort_key = (
        SELECT rn * 1024.0 FROM (
            SELECT id, ROW_NUMBER() OVER (
                PARTITION BY task_lane_id
                ORDER BY updated_at DESC, id
            ) AS rn
            FROM reminders WHERE task_lane_id IS NOT NULL
        ) ranked WHERE ranked.id = reminders.id
    )
    WHERE task_lane_id IS NOT NULL;
    "#,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test migration_014 -- --nocapture`
Expected: PASS. Then run the full suite: `cargo test` — all green (existing migration tests must still pass).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs
git commit -m "feat(db): migration 014 — task_sort_key column + order-preserving backfill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Plumb `task_sort_key` through model, repo, and wire

**Files:**
- Modify: `src-tauri/src/models.rs` (Reminder struct)
- Modify: `src-tauri/src/db/reminders.rs` (row map, 4 SELECTs, create, update, apply_remote, new helper, tests)
- Modify: `src-tauri/src/sync/types.rs` (RemoteReminder + From impl)

**Interfaces:**
- Consumes: migration 014's column.
- Produces: `Reminder.task_sort_key: Option<f64>` (serialized to the frontend as `task_sort_key`), `RemoteReminder.task_sort_key: Option<f64>` (wire), and `pub(crate) fn top_of_lane_key(conn: &Connection, lane_id: &str) -> AppResult<f64>` in `db/reminders.rs`. `create()` assigns a top-of-lane key to laned tasks; `update()` assigns one when `task_lane_id` changes and preserves the key otherwise; `apply_remote()` round-trips the field.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/db/reminders.rs` (reuse the existing `test_conn()` and `blank_update()` helpers):

```rust
    fn mk_task(title: &str) -> ReminderCreate {
        ReminderCreate {
            title: title.into(),
            description: None,
            due_at: 0,
            priority: Priority::Normal,
            sound_path: None,
            repeat_rule: None,
            silent: true,
            tags: vec![],
            task_lane_id: None, // create() routes to the default lane
        }
    }

    /// New tasks stack on top: first task in an empty lane gets
    /// KEY_STRIDE, each subsequent one gets (lane min − KEY_STRIDE).
    #[test]
    fn created_tasks_land_on_top_of_their_lane() {
        let conn = test_conn();
        let t1 = create(&conn, mk_task("first")).unwrap();
        let t2 = create(&conn, mk_task("second")).unwrap();
        assert_eq!(t1.task_sort_key, Some(1024.0));
        assert_eq!(t2.task_sort_key, Some(0.0), "second lands above the first");
    }

    /// Changing lanes (editor dropdown path) re-keys to the top of the
    /// NEW lane; an unrelated edit must not touch the key.
    #[test]
    fn lane_change_rekeys_to_top_and_plain_edits_preserve_key() {
        let conn = test_conn();
        let t1 = create(&conn, mk_task("mover")).unwrap();
        let _t2 = create(&conn, mk_task("stayer")).unwrap();

        // Unrelated edit: key untouched.
        let edited = update(
            &conn,
            &t1.id,
            ReminderUpdate { title: Some("mover 2".into()), ..blank_update() },
        )
        .unwrap();
        assert_eq!(edited.task_sort_key, t1.task_sort_key);

        // New lane → top of that (empty) lane.
        let now = crate::models::now_ms();
        let lane = crate::db::task_lanes::Lane {
            id: uuid::Uuid::new_v4().to_string(),
            name: "elsewhere".into(),
            order_index: 50,
            is_default: false,
            created_at: now,
            updated_at: now,
        };
        crate::db::task_lanes::insert(&conn, &lane).unwrap();
        let moved = update(
            &conn,
            &t1.id,
            ReminderUpdate {
                task_lane_id: Some(Some(lane.id.clone())),
                ..blank_update()
            },
        )
        .unwrap();
        assert_eq!(moved.task_sort_key, Some(1024.0), "top of the empty new lane");
    }

    /// The key must survive the sync wire: apply_remote writes it, and
    /// converting back off the row keeps it.
    #[test]
    fn apply_remote_round_trips_task_sort_key() {
        let conn = test_conn();
        let t = create(&conn, mk_task("synced")).unwrap();
        let mut remote = crate::sync::types::RemoteReminder::from(&t);
        remote.task_sort_key = Some(512.5);
        remote.updated_at += 1; // strictly newer so LWW applies it
        assert!(super::apply_remote(&conn, &remote).unwrap());
        let got = super::get_by_id(&conn, &t.id).unwrap();
        assert_eq!(got.task_sort_key, Some(512.5));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib db::reminders`
Expected: FAIL to compile — `ReminderCreate` is fine but `Reminder` has no field `task_sort_key` / `RemoteReminder` has no field `task_sort_key`.

- [ ] **Step 3: Add the field to both structs**

In `src-tauri/src/models.rs`, append to the `Reminder` struct (after `task_lane_id`):

```rust
    /// v0.8: manual position within the task lane. Lanes render
    /// ascending (smallest on top). `None` on non-task rows.
    #[serde(default)]
    pub task_sort_key: Option<f64>,
```

In `src-tauri/src/sync/types.rs`, append to `RemoteReminder` (after `task_lane_id` — trailing, matching the ChangeSet field-order convention):

```rust
    /// v0.8: manual board position. Postcard is not self-describing, so
    /// this field is a wire-format break for pre-0.8 peers (see the
    /// ChangeSet.thoughts note) — upgrade all paired devices together.
    #[serde(default)]
    pub task_sort_key: Option<f64>,
```

And in the `From<&crate::models::Reminder> for RemoteReminder` impl, add:

```rust
            task_sort_key: r.task_sort_key,
```

- [ ] **Step 4: Plumb through `db/reminders.rs`**

Six mechanical edits plus one helper, all in `src-tauri/src/db/reminders.rs`:

1. `row_to_reminder`: add to the `Ok(Reminder { ... })` literal:

```rust
        task_sort_key: row.get("task_sort_key")?,
```

2. The four SELECT column lists in `list_all`, `next_pending`, `get_by_id`, `updated_since`: append `, task_sort_key` after `task_lane_id`.

3. Add the ordering constants and the helper near the top of the file (below the `use` block):

```rust
/// Gap between adjacent sort keys on insert/renumber. Midpoint inserts
/// halve the local gap; ~50 drops into the same slot before a renumber.
pub const KEY_STRIDE: f64 = 1024.0;
/// Below this neighbor gap a midpoint stops being representable enough —
/// renumber the lane before placing.
pub const MIN_KEY_GAP: f64 = 1e-6;

/// Key that places a task above everything currently in `lane_id`.
pub(crate) fn top_of_lane_key(conn: &Connection, lane_id: &str) -> AppResult<f64> {
    let min: Option<f64> = conn.query_row(
        "SELECT MIN(task_sort_key) FROM reminders WHERE task_lane_id = ?1",
        params![lane_id],
        |r| r.get(0),
    )?;
    Ok(match min {
        Some(m) => m - KEY_STRIDE,
        None => KEY_STRIDE,
    })
}
```

4. `create()`: after the `lane_id` resolution block, compute the key, and add the column to the INSERT:

```rust
    let sort_key = match lane_id.as_deref() {
        Some(lane) => Some(top_of_lane_key(conn, lane)?),
        None => None,
    };
```

INSERT becomes (`?12` appended):

```rust
        "INSERT INTO reminders
         (id, title, description, due_at, priority, sound_path, repeat_rule, state,
          snooze_until, created_at, updated_at, source, external_id, last_synced_at, silent, tags, task_lane_id, task_sort_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', NULL, ?8, ?8, 'local', NULL, NULL, ?9, ?10, ?11, ?12)",
```

with `sort_key,` appended to the `params![]` list.

5. `update()`: after the existing `task_lane_id` resolution, add:

```rust
    // Manual board position: preserved on ordinary edits; a lane change
    // without an explicit position (editor dropdown, task conversion)
    // lands the task at the top of the new lane. `place()` is the only
    // path that sets an explicit mid-lane key.
    let task_sort_key = if task_lane_id == existing.task_lane_id {
        existing.task_sort_key
    } else if let Some(ref lane) = task_lane_id {
        Some(top_of_lane_key(conn, lane)?)
    } else {
        None
    };
```

UPDATE statement gains `task_sort_key = ?14` in the SET list and `task_sort_key,` at the end of `params![]`.

6. `apply_remote()`: INSERT column list gains `task_sort_key` with placeholder `?16` (`r.task_sort_key` appended to params), and the `ON CONFLICT` SET list gains:

```rust
           task_sort_key = excluded.task_sort_key,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test`
Expected: PASS, including the three new tests and every pre-existing test (the mesh test still compiles because `RemoteReminder::from` fills the new field).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/db/reminders.rs src-tauri/src/sync/types.rs
git commit -m "feat(tasks): plumb task_sort_key through model, repo, and sync wire

Wire-format break for pre-0.8 peers (postcard, RemoteReminder gains a
field) — release as 0.8.0, update both devices together.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `place()` — neighbor-midpoint placement with rebalance

**Files:**
- Modify: `src-tauri/src/db/reminders.rs` (two functions + tests)

**Interfaces:**
- Consumes: `KEY_STRIDE`, `MIN_KEY_GAP`, `top_of_lane_key` from Task 2.
- Produces: `pub fn place(conn: &Connection, id: &str, lane_id: &str, before_id: Option<&str>, after_id: Option<&str>) -> AppResult<Reminder>` — Task 5's command calls this. `before_id` = card visually ABOVE the drop slot (smaller key), `after_id` = card BELOW.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/db/reminders.rs`:

```rust
    /// Drop between two neighbors → midpoint key; edges get stride
    /// offsets. The three creates stack t3 (top, key −1024), t2 (0),
    /// t1 (1024).
    #[test]
    fn place_computes_midpoints_and_edge_keys() {
        let conn = test_conn();
        let t1 = create(&conn, mk_task("one")).unwrap();   // 1024
        let t2 = create(&conn, mk_task("two")).unwrap();   // 0
        let t3 = create(&conn, mk_task("three")).unwrap(); // -1024
        let lane = t1.task_lane_id.clone().unwrap();

        // Drag t1 between t3 (above) and t2 (below): (−1024 + 0)/2.
        let placed = super::place(&conn, &t1.id, &lane, Some(&t3.id), Some(&t2.id)).unwrap();
        assert_eq!(placed.task_sort_key, Some(-512.0));

        // Drag t2 to the very top (only an `after` neighbor): −1024 − 1024.
        let top = super::place(&conn, &t2.id, &lane, None, Some(&t3.id)).unwrap();
        assert_eq!(top.task_sort_key, Some(-2048.0));

        // Drag t2 to the very bottom (only a `before` neighbor). t1's
        // key is −512 after the first placement, so bottom = −512 + 1024.
        let bottom = super::place(&conn, &t2.id, &lane, Some(&t1.id), None).unwrap();
        assert_eq!(bottom.task_sort_key, Some(512.0));
    }

    /// Cross-lane drop into an empty lane: no neighbors → KEY_STRIDE,
    /// and the lane assignment persists in the same write.
    #[test]
    fn place_moves_across_lanes() {
        let conn = test_conn();
        let t = create(&conn, mk_task("wanderer")).unwrap();
        let now = crate::models::now_ms();
        let lane = crate::db::task_lanes::Lane {
            id: uuid::Uuid::new_v4().to_string(),
            name: "target".into(),
            order_index: 60,
            is_default: false,
            created_at: now,
            updated_at: now,
        };
        crate::db::task_lanes::insert(&conn, &lane).unwrap();

        let placed = super::place(&conn, &t.id, &lane.id, None, None).unwrap();
        assert_eq!(placed.task_lane_id.as_deref(), Some(lane.id.as_str()));
        assert_eq!(placed.task_sort_key, Some(1024.0));
    }

    /// Exhausted precision between neighbors triggers a lane renumber,
    /// after which the midpoint is representable again and total order
    /// is preserved.
    #[test]
    fn place_rebalances_when_neighbor_gap_collapses() {
        let conn = test_conn();
        let t1 = create(&conn, mk_task("a")).unwrap();
        let t2 = create(&conn, mk_task("b")).unwrap();
        let t3 = create(&conn, mk_task("c")).unwrap();
        let lane = t1.task_lane_id.clone().unwrap();
        // Force t3 and t2 into a sub-MIN_KEY_GAP embrace at the top.
        conn.execute(
            "UPDATE reminders SET task_sort_key = 100.0 WHERE id = ?1",
            params![t3.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE reminders SET task_sort_key = 100.0000000001 WHERE id = ?1",
            params![t2.id],
        )
        .unwrap();

        let placed = super::place(&conn, &t1.id, &lane, Some(&t3.id), Some(&t2.id)).unwrap();

        // Order must be t3, t1, t2 — read it back by key.
        let mut stmt = conn
            .prepare(
                "SELECT id FROM reminders WHERE task_lane_id = ?1
                 ORDER BY task_sort_key ASC",
            )
            .unwrap();
        let order: Vec<String> = stmt
            .query_map(params![lane], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(order, vec![t3.id.clone(), t1.id.clone(), t2.id.clone()]);
        // And the keys are healthy again: the renumber gave t3/t2 clean
        // strides (1024/2048) and the drop landed exactly between them.
        assert_eq!(placed.task_sort_key, Some(1536.0));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib db::reminders`
Expected: FAIL to compile — `place` and `renumber_lane` not defined.

- [ ] **Step 3: Implement `place` + `renumber_lane`**

Add to `src-tauri/src/db/reminders.rs` (below `top_of_lane_key`):

```rust
/// Rewrite a lane's keys to clean 1024·n in current visual order.
/// Bumps updated_at on every row it touches (LWW churn — rare, accepted;
/// see the spec's sync section). Wrapped in a transaction so a crash
/// can't leave the lane half-renumbered.
fn renumber_lane(conn: &Connection, lane_id: &str) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id FROM reminders WHERE task_lane_id = ?1
         ORDER BY COALESCE(task_sort_key, 9e18) ASC, updated_at DESC",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![lane_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let tx = conn.unchecked_transaction()?;
    let now = now_ms();
    for (i, rid) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE reminders SET task_sort_key = ?2, updated_at = ?3 WHERE id = ?1",
            params![rid, ((i + 1) as f64) * KEY_STRIDE, now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Persist a board drop. `before_id` is the card visually ABOVE the drop
/// slot, `after_id` the card BELOW; either may be None at a lane edge.
/// Neighbors are resolved fresh from the DB (and ignored if they've left
/// the lane) so a stale frontend can't corrupt ordering. Exactly one row
/// is written — unless the neighbor gap has collapsed below MIN_KEY_GAP,
/// in which case the lane renumbers first.
pub fn place(
    conn: &Connection,
    id: &str,
    lane_id: &str,
    before_id: Option<&str>,
    after_id: Option<&str>,
) -> AppResult<Reminder> {
    // A missing/foreign-lane/NULL-key neighbor maps to None; real DB
    // errors must propagate, or place() silently misfiles the card at a
    // lane edge on e.g. an I/O failure.
    fn neighbor_key(
        conn: &Connection,
        lane_id: &str,
        nid: Option<&str>,
    ) -> AppResult<Option<f64>> {
        let Some(nid) = nid else { return Ok(None) };
        let key: Option<Option<f64>> = conn
            .query_row(
                "SELECT task_sort_key FROM reminders
                 WHERE id = ?1 AND task_lane_id = ?2",
                params![nid, lane_id],
                |r| r.get::<_, Option<f64>>(0),
            )
            .optional()?;
        Ok(key.flatten())
    }

    let mut before = neighbor_key(conn, lane_id, before_id)?;
    let mut after = neighbor_key(conn, lane_id, after_id)?;
    if let (Some(b), Some(a)) = (before, after) {
        if a - b < MIN_KEY_GAP {
            renumber_lane(conn, lane_id)?;
            before = neighbor_key(conn, lane_id, before_id)?;
            after = neighbor_key(conn, lane_id, after_id)?;
        }
    }
    let key = match (before, after) {
        (Some(b), Some(a)) => (b + a) / 2.0,
        (None, Some(a)) => a - KEY_STRIDE,
        (Some(b), None) => b + KEY_STRIDE,
        (None, None) => KEY_STRIDE,
    };

    let n = conn.execute(
        "UPDATE reminders
         SET task_lane_id = ?2, task_sort_key = ?3, updated_at = ?4
         WHERE id = ?1",
        params![id, lane_id, key, now_ms()],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("reminder {id}")));
    }
    get_by_id(conn, id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test`
Expected: PASS — the three new tests plus all pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/reminders.rs
git commit -m "feat(tasks): place() — neighbor-midpoint drop placement with lane rebalance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `sort_lane_by_stars()` — stable one-shot star sort

**Files:**
- Modify: `src-tauri/src/db/reminders.rs` (one function + tests)

**Interfaces:**
- Consumes: `KEY_STRIDE` from Task 2.
- Produces: `pub fn sort_lane_by_stars(conn: &Connection, lane_id: &str) -> AppResult<usize>` (returns rows rewritten; 0 = lane already star-sorted, no writes). Task 5's command calls this.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/db/reminders.rs`:

```rust
    /// Star sort is stable (drag order kept within a tier), rewrites
    /// only rows whose key changes, and is a no-op on a sorted lane.
    #[test]
    fn sort_lane_by_stars_is_stable_and_skips_noops() {
        let conn = test_conn();
        // Visual order (top→bottom) after creates: low, high#1, normal, high#2.
        let mk_p = |title: &str, p: Priority| ReminderCreate {
            priority: p,
            ..mk_task(title)
        };
        let hi2 = create(&conn, mk_p("high two", Priority::High)).unwrap();
        let norm = create(&conn, mk_p("normal", Priority::Normal)).unwrap();
        let hi1 = create(&conn, mk_p("high one", Priority::High)).unwrap();
        let low = create(&conn, mk_p("low", Priority::Low)).unwrap();
        let lane = low.task_lane_id.clone().unwrap();
        // Creates stack upward: current order is low, hi1, norm, hi2.

        let changed = super::sort_lane_by_stars(&conn, &lane).unwrap();
        assert!(changed > 0);

        let mut stmt = conn
            .prepare(
                "SELECT id FROM reminders WHERE task_lane_id = ?1
                 ORDER BY task_sort_key ASC",
            )
            .unwrap();
        let order: Vec<String> = stmt
            .query_map(params![lane], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // Stable: hi1 was above hi2 before the sort, so it stays above.
        assert_eq!(
            order,
            vec![hi1.id.clone(), hi2.id.clone(), norm.id.clone(), low.id.clone()]
        );

        // Second invocation: already sorted → zero writes.
        let changed_again = super::sort_lane_by_stars(&conn, &lane).unwrap();
        assert_eq!(changed_again, 0);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test sort_lane_by_stars`
Expected: FAIL to compile — `sort_lane_by_stars` not defined.

- [ ] **Step 3: Implement**

Add to `src-tauri/src/db/reminders.rs`:

```rust
/// One-shot "sort by stars": stable rewrite of a lane's keys, highest
/// priority first, ties keeping their current visual order. Returns the
/// number of rows rewritten. An already-sorted lane returns 0 with no
/// writes at all — repeat presses cost nothing and cause no sync churn.
pub fn sort_lane_by_stars(conn: &Connection, lane_id: &str) -> AppResult<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, priority, task_sort_key FROM reminders
         WHERE task_lane_id = ?1
         ORDER BY COALESCE(task_sort_key, 9e18) ASC, updated_at DESC",
    )?;
    let mut rows: Vec<(String, i32, Option<f64>)> = stmt
        .query_map(params![lane_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;

    if rows.windows(2).all(|w| w[0].1 >= w[1].1) {
        return Ok(0); // already star-sorted top-to-bottom
    }
    // Vec::sort_by_key is stable — equal priorities keep drag order.
    rows.sort_by_key(|(_, prio, _)| std::cmp::Reverse(*prio));

    let tx = conn.unchecked_transaction()?;
    let now = now_ms();
    let mut changed = 0usize;
    for (i, (rid, _, old_key)) in rows.iter().enumerate() {
        let target = ((i + 1) as f64) * KEY_STRIDE;
        if *old_key == Some(target) {
            continue;
        }
        tx.execute(
            "UPDATE reminders SET task_sort_key = ?2, updated_at = ?3 WHERE id = ?1",
            params![rid, target, now],
        )?;
        changed += 1;
    }
    tx.commit()?;
    Ok(changed)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/reminders.rs
git commit -m "feat(tasks): sort_lane_by_stars — stable star sort with no-op skip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Commands + API swap — `place_task`, `sort_lane_by_stars`; retire `set_task_lane`

**Files:**
- Modify: `src-tauri/src/commands.rs` (replace `set_task_lane`, add two commands)
- Modify: `src-tauri/src/lib.rs:432` (registration)
- Modify: `src/lib/api.ts:76-77` (swap functions)
- Modify: `src/lib/types.ts` (Reminder interface)

**Interfaces:**
- Consumes: `repo::place`, `repo::sort_lane_by_stars` (Tasks 3–4).
- Produces: Tauri commands `place_task(reminderId, laneId, beforeId?, afterId?) → Reminder` and `sort_lane_by_stars(laneId) → number`; frontend `api.placeTask(reminderId, laneId, beforeId, afterId)` and `api.sortLaneByStars(laneId)`; `Reminder.task_sort_key: number | null` in `types.ts`. Tasks 6–8 call these.

- [ ] **Step 1: Replace the command**

In `src-tauri/src/commands.rs`, replace the whole `set_task_lane` function (lines 397–433) with:

```rust
#[tauri::command]
pub fn place_task(
    state: State<'_, AppState>,
    app: AppHandle,
    reminder_id: String,
    lane_id: String,
    before_id: Option<String>,
    after_id: Option<String>,
) -> AppResult<Reminder> {
    let trimmed = lane_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("lane_id required".into()));
    }
    let updated = {
        let conn = state.db.lock();
        // Validate the lane exists so a stale UI state doesn't write a
        // dangling FK.
        if task_lanes::get_by_id(&conn, trimmed)?.is_none() {
            return Err(AppError::NotFound(format!("lane {trimmed}")));
        }
        repo::place(
            &conn,
            &reminder_id,
            trimmed,
            before_id.as_deref(),
            after_id.as_deref(),
        )?
    };
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
    Ok(updated)
}

#[tauri::command]
pub fn sort_lane_by_stars(
    state: State<'_, AppState>,
    app: AppHandle,
    lane_id: String,
) -> AppResult<usize> {
    let changed = {
        let conn = state.db.lock();
        repo::sort_lane_by_stars(&conn, &lane_id)?
    };
    if changed > 0 {
        let _ = app.emit("klaxon://reminders-changed", ());
        nudge_write(&state);
    }
    Ok(changed)
}
```

- [ ] **Step 2: Update registration**

In `src-tauri/src/lib.rs` (the `generate_handler!` list, line 432), replace `commands::set_task_lane,` with:

```rust
            commands::place_task,
            commands::sort_lane_by_stars,
```

- [ ] **Step 3: Verify no Rust caller remains, then build**

Run: `grep -rn "set_task_lane" src-tauri/src/` → expect no hits.
Run (in `src-tauri/`): `cargo test` and `RUSTFLAGS="-D warnings" cargo build`
Expected: both green.

- [ ] **Step 4: Swap the frontend API**

In `src/lib/api.ts`, replace the `setTaskLane` entry (lines 76–77) with:

```ts
  placeTask: (
    reminderId: string,
    laneId: string,
    beforeId: string | null,
    afterId: string | null,
  ) => invoke<Reminder>("place_task", { reminderId, laneId, beforeId, afterId }),
  sortLaneByStars: (laneId: string) =>
    invoke<number>("sort_lane_by_stars", { laneId }),
```

In `src/lib/types.ts`, add to the `Reminder` interface (after `task_lane_id` — check the interface; it lists reminder fields around line 17-36):

```ts
  /** v0.8: manual board position; lanes render ascending. Null on non-tasks. */
  task_sort_key: number | null;
```

- [ ] **Step 5: Run svelte-check — expect ONE known failure**

Run: `npm run check`
Expected: FAIL with exactly one error — `TasksBoard.svelte` still calls `api.setTaskLane`. That's Task 6's job; the error proves the retirement is complete everywhere else. If other errors appear, fix them now.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/api.ts src/lib/types.ts
git commit -m "feat(tasks): place_task + sort_lane_by_stars commands; retire set_task_lane

Board wiring lands in the next commit; svelte-check is transiently red
on TasksBoard's setTaskLane call.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Board wiring — render by key, persist drops via `place_task`

**Files:**
- Modify: `src/lib/components/TasksBoard.svelte` (derive effect + `onCardFinalize`)

**Interfaces:**
- Consumes: `api.placeTask` (Task 5), `Reminder.task_sort_key` (Task 5).
- Produces: lanes ordered by `task_sort_key` ascending; every drop persisted with neighbors.

- [ ] **Step 1: Sort the derive by key**

In the `$effect` that builds `cardsByLane` (line ~76), replace:

```ts
    for (const k in next) {
      next[k].sort((a, b) => b.updated_at - a.updated_at);
    }
```

with:

```ts
    for (const k in next) {
      // Ascending by manual position; nulls sink (defensive only —
      // migration 014 backfills every laned task).
      next[k].sort(
        (a, b) =>
          (a.task_sort_key ?? Number.MAX_VALUE) -
            (b.task_sort_key ?? Number.MAX_VALUE) ||
          b.updated_at - a.updated_at,
      );
    }
```

- [ ] **Step 2: Persist drops with neighbors**

In `onCardFinalize` (line ~102), replace the `DROPPED_INTO_ZONE` block:

```ts
      if (e.detail.info.trigger === TRIGGERS.DROPPED_INTO_ZONE) {
        const droppedId = e.detail.info.id;
        api
          .setTaskLane(droppedId, laneId)
          .catch((err) => console.error("setTaskLane failed", err));
      }
```

with:

```ts
      if (e.detail.info.trigger === TRIGGERS.DROPPED_INTO_ZONE) {
        const droppedId = e.detail.info.id;
        const items = e.detail.items;
        const idx = items.findIndex((r) => r.id === droppedId);
        // Neighbors in the finalized visual order; the backend recomputes
        // their keys fresh, so this is a position hint, not float math.
        const beforeId = idx > 0 ? items[idx - 1].id : null;
        const afterId =
          idx >= 0 && idx < items.length - 1 ? items[idx + 1].id : null;
        api
          .placeTask(droppedId, laneId, beforeId, afterId)
          .catch((err) => console.error("placeTask failed", err));
      }
```

Keep the surrounding comment about the TARGET zone firing `DROPPED_INTO_ZONE` — it still explains why source zones are ignored.

- [ ] **Step 3: Run svelte-check to verify it's green again**

Run: `npm run check`
Expected: 0 errors 0 warnings (the Task 5 transient error is gone).

- [ ] **Step 4: Manual smoke test (dev app)**

Run: `npm run tauri dev` (close the production Klaxon first if it's running — they share a data dir; reopen it afterwards).
- Drag a card to the middle of its lane → it stays put (no snap-to-top).
- Restart the dev app → the order survived.
- Drag a card into another lane at a specific position → position survives a restart.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/TasksBoard.svelte
git commit -m "feat(tasks): board renders by task_sort_key; drops persist via place_task

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Star helpers module + card-face star control

**Files:**
- Create: `src/lib/stars.ts`
- Modify: `src/lib/components/TasksBoard.svelte` (card meta row + handler + CSS)

**Interfaces:**
- Consumes: `api.updateReminder` (existing), `Priority` type (existing).
- Produces: `starCount(p: Priority): number` and `priorityForStars(n: number): Priority` in `src/lib/stars.ts` — Task 8's editor row uses the same two functions.

- [ ] **Step 1: Create the helpers module**

Create `src/lib/stars.ts`:

```ts
import type { Priority } from "./types";

/// Single source of the star mapping: low = ★, normal = ★★, high = ★★★.
/// Index order must match Priority's semantic order.
const LEVELS: Priority[] = ["low", "normal", "high"];

export function starCount(p: Priority): number {
  return LEVELS.indexOf(p) + 1;
}

export function priorityForStars(n: number): Priority {
  return LEVELS[Math.min(Math.max(n, 1), 3) - 1];
}
```

- [ ] **Step 2: Add the star control to the card**

In `src/lib/components/TasksBoard.svelte`:

Script additions (top of `<script>`, with the other imports):

```ts
  import { starCount, priorityForStars } from "../stars";
```

and below the `dueChip` function:

```ts
  function setCardStars(card: Reminder, n: number) {
    const p = priorityForStars(n);
    if (p === card.priority) return;
    api
      .updateReminder(card.id, { priority: p })
      .catch((err) => console.error("set priority failed", err));
  }
```

Replace the conditional card-meta block (lines ~322–333):

```svelte
              {#if (card.tags && card.tags.length > 0) || due}
                <div class="card-meta">
                  {#if due}
                    <span class="card-due mono-caps-faint">{due}</span>
                  {/if}
                  {#if card.tags}
                    {#each card.tags as tag (tag)}
                      <span class="card-tag">#{tag}</span>
                    {/each}
                  {/if}
                </div>
              {/if}
```

with an unconditional row (stars always render):

```svelte
              <div class="card-meta">
                <!-- Buttons are exempt from drag-start (the dnd zone's
                     nested-input guard checks `target.value`), so stars
                     are tappable without fighting hold-to-drag. -->
                <div class="card-stars" role="group" aria-label="Priority">
                  {#each [1, 2, 3] as n (n)}
                    <button
                      class="star"
                      class:lit={n <= starCount(card.priority)}
                      class:high={card.priority === "high"}
                      onclick={(e) => {
                        e.stopPropagation();
                        setCardStars(card, n);
                      }}
                      title={`Set priority: ${priorityForStars(n)}`}
                    >{n <= starCount(card.priority) ? "★" : "☆"}</button>
                  {/each}
                </div>
                {#if due}
                  <span class="card-due mono-caps-faint">{due}</span>
                {/if}
                {#if card.tags}
                  {#each card.tags as tag (tag)}
                    <span class="card-tag">#{tag}</span>
                  {/each}
                {/if}
              </div>
```

Guard the card's keydown so Enter/Space on a star doesn't also open the
editor (the card's handler currently fires on bubbled key events).
In the card's `onkeydown` (line ~311), add a target check as the first line:

```ts
              onkeydown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(card);
                }
              }}
```

CSS (append near the `.card-tag` rules):

```css
  .card-stars {
    display: inline-flex;
    gap: 2px;
  }
  .star {
    background: transparent;
    border: none;
    padding: 0 1px;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    color: var(--text-faint);
  }
  .star.lit {
    color: var(--text-muted);
  }
  .star.lit.high {
    color: var(--klaxon);
  }
  .star:hover {
    color: var(--klaxon);
  }
```

- [ ] **Step 3: Run svelte-check**

Run: `npm run check`
Expected: 0 errors 0 warnings.

- [ ] **Step 4: Manual smoke test (dev app)**

- Cards show ★★ (muted) by default; tap the third star → ★★★ turns klaxon orange; tap the first → ★.
- Tapping stars does NOT open the editor and does NOT start a drag.
- Card click elsewhere still opens the editor; hold-drag still works.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stars.ts src/lib/components/TasksBoard.svelte
git commit -m "feat(tasks): star priority control on card faces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Editor star row for tasks

**Files:**
- Modify: `src/lib/components/ReminderEditor.svelte` (silent-mode field + CSS)

**Interfaces:**
- Consumes: `starCount`, `priorityForStars` from `src/lib/stars.ts` (Task 7); the editor's existing `priority` state (already included in the save payload for silent reminders — `ReminderEditor.svelte:150`).

- [ ] **Step 1: Add the field**

In `src/lib/components/ReminderEditor.svelte`, import the helpers:

```ts
  import { starCount, priorityForStars } from "../stars";
```

Inside the `{#if silent}` block (after the Lane field's closing `</div>` at line ~290, before the `{/if}`), add:

```svelte
      <div class="field">
        <span class="mono-caps-faint">Priority</span>
        <div class="star-row" role="group" aria-label="Priority">
          {#each [1, 2, 3] as n (n)}
            <button
              type="button"
              class="star-btn"
              class:lit={n <= starCount(priority)}
              onclick={() => (priority = priorityForStars(n))}
            >{n <= starCount(priority) ? "★" : "☆"}</button>
          {/each}
        </div>
      </div>
```

CSS (append near the `.prio` rules in the component's `<style>`):

```css
  .star-row {
    display: flex;
    gap: 4px;
  }
  .star-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 4px 12px;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    transition: color 80ms var(--ease), border-color 80ms var(--ease);
  }
  .star-btn.lit {
    color: var(--klaxon);
    border-color: var(--klaxon-dim);
  }
  .star-btn:hover {
    border-color: var(--klaxon);
  }
```

- [ ] **Step 2: Run svelte-check**

Run: `npm run check`
Expected: 0 errors 0 warnings.

- [ ] **Step 3: Manual smoke test (dev app)**

- Open a task in the editor → PRIORITY star row shows, reflecting the card's stars.
- Change stars, save → the card face updates.
- A ringing (non-silent) reminder still shows the signal-light selector, not stars.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/ReminderEditor.svelte
git commit -m "feat(tasks): editor star row — tasks get their first priority control

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Lane-header sort button

**Files:**
- Modify: `src/lib/components/TasksBoard.svelte` (header markup + handler + CSS)

**Interfaces:**
- Consumes: `api.sortLaneByStars` (Task 5).

- [ ] **Step 1: Add handler + button**

Script (below `setCardStars`):

```ts
  function sortLane(laneId: string) {
    api
      .sortLaneByStars(laneId)
      .catch((err) => console.error("sortLaneByStars failed", err));
  }
```

In the lane header markup, after the `lane-count` span (line ~282) and before the `{#if !lane.is_default}` delete-button block, add:

```svelte
            <button
              class="lane-sort"
              onclick={() => sortLane(lane.id)}
              title="Sort by stars — ★★★ first; ties keep their order"
            >★↓</button>
```

CSS (near `.lane-delete`):

```css
  .lane-sort {
    background: transparent;
    border: none;
    color: var(--text-faint);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    letter-spacing: -0.05em;
  }
  .lane-sort:hover {
    color: var(--klaxon);
  }
```

- [ ] **Step 2: Run svelte-check**

Run: `npm run check`
Expected: 0 errors 0 warnings.

- [ ] **Step 3: Manual smoke test (dev app)**

- Mixed-star lane → press ★↓ → 3★ cards float to the top, ties keep their previous relative order.
- Press again → nothing changes (and the backend logged no writes — returns 0).
- Drag a card afterwards → manual order wins again.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/TasksBoard.svelte
git commit -m "feat(tasks): per-lane one-shot sort-by-stars button

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Mesh test — pin `task_sort_key` forwarding

**Files:**
- Modify: `src-tauri/src/sync/ops.rs` (extend `changes_forward_across_three_devices_via_watermarks`)

**Interfaces:**
- Consumes: `create()`'s top-of-lane key (Task 2), the wire field (Task 2).

- [ ] **Step 1: Extend the failing-then-passing assertions**

In the test's "Local writes on A" block, add a silent task alongside the existing creates (adjust the destructured tuple accordingly — it becomes 5 ids):

```rust
            let task = crate::db::reminders::create(
                &conn,
                ReminderCreate {
                    title: "ordered task".into(),
                    description: None,
                    due_at: 0,
                    priority: Priority::High,
                    sound_path: None,
                    repeat_rule: None,
                    silent: true,
                    tags: vec![],
                    task_lane_id: None, // default lane
                },
            )
            .unwrap();
            assert_eq!(task.task_sort_key, Some(1024.0));
```

Return `task.id` from the block (e.g. as `task_id`), update the hop2
reminder-count assertion from 1 to 2:

```rust
        assert_eq!(hop2.reminders.len(), 2, "forwarded reminders in B's pull");
```

and in the final C-side block add:

```rust
            let got_task = crate::db::reminders::get_by_id(&conn, &task_id).unwrap();
            assert_eq!(
                got_task.task_sort_key,
                Some(1024.0),
                "sort key must forward through the mesh unchanged"
            );
            assert_eq!(got_task.priority, Priority::High);
```

- [ ] **Step 2: Run the test**

Run: `cargo test changes_forward_across_three_devices`
Expected: PASS. (If the count assertion fails at 1, the task's create didn't happen before `pull(&a, 0)` — check placement inside the A-writes block.)

- [ ] **Step 3: Full gates**

Run: `cargo test` and `RUSTFLAGS="-D warnings" cargo build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sync/ops.rs
git commit -m "test(sync): mesh test pins task_sort_key forwarding via watermarks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Polish — drag auto-scroll in scrolling lanes

**Files:**
- Possibly modify: `src/lib/components/TasksBoard.svelte` (only if broken)

- [ ] **Step 1: Manual verification (dev app)**

In a lane taller than the window: start dragging a card, hold it near the
bottom edge of the lane's card list, then near the top edge.
Expected: the list auto-scrolls so you can drop beyond the visible cards.
Also drag horizontally toward an off-screen lane and confirm the board
scrolls (this worked pre-0.7.5 via the document scroller; re-confirm).

- [ ] **Step 2: If auto-scroll does NOT work**

svelte-dnd-action ≥0.9.60 scrolls scrollable ancestor containers during a
drag automatically (multi-scroller). If the `.cards` container doesn't
auto-scroll, debug in this order:
1. Confirm the installed version supports it: `npm ls svelte-dnd-action`
   and grep the changelog/dist for "scroll".
2. Check whether the scroller requires the scrollable element to BE the
   dndzone (it is — `.cards` carries `use:dndzone`) vs. an ancestor.
3. If genuinely unsupported, timebox to ~1h; an acceptable fallback is
   documenting the gap in the changelog (drag + manual scroll of a
   long lane is a rare compound action). Do NOT hand-roll a scroller
   inside this task — if it needs one, report back and we re-plan.

- [ ] **Step 3: Commit (only if code changed)**

```bash
git add src/lib/components/TasksBoard.svelte
git commit -m "fix(tasks): drag auto-scroll in scrolling lanes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Release prep — v0.8.0 bump + changelog (publish gated on hardware drill)

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (klaxon entry), `src-tauri/tauri.conf.json` — all `0.7.5` → `0.8.0`
- Modify: `CHANGELOG.md` (new entry on top)

- [ ] **Step 1: Bump the four version sites**

Same procedure as every release: `"version": "0.8.0"` in package.json and
tauri.conf.json, `version = "0.8.0"` in Cargo.toml line 3, and the
`name = "klaxon"` package entry in Cargo.lock.

- [ ] **Step 2: Changelog entry**

Prepend to `CHANGELOG.md` (adjust the date to the actual release day):

```markdown
## [0.8.0] — 2026-08-XX

**Update both devices together** — the sync wire format changed; a
0.7.x peer can't decode 0.8.0 changesets (it reports a version
mismatch until upgraded).

### Added

- **Cards stay where you drag them.** The Tasks board finally persists
  manual order — within a lane and across lanes — synced between
  devices. Previously any drag silently snapped the card back to the
  top of its lane.
- **Star priority on tasks.** Every card shows ★ / ★★ / ★★★ (the
  existing low/normal/high priority — tasks just never had a control
  for it). Tap the stars on a card or use the editor's new PRIORITY
  row. Three-star tasks glow klaxon orange.
- **Sort a lane by stars.** The ★↓ button in a lane header does a
  one-shot sort — highest first, ties keep their dragged order.
```

- [ ] **Step 3: Full gates**

Run: `cargo test`, `RUSTFLAGS="-D warnings" cargo build` (in `src-tauri/`), `npm run check`.
Expected: all green.

- [ ] **Step 4: Commit and push**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "v0.8.0: persistent card order + star priority — version bump + changelog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 5: STOP — hardware drill before publishing**

Do NOT publish the GitHub release yet. Build both artifacts (desktop
`npm run tauri build`; Android `npm run tauri -- android build --verbose`
with `JAVA_HOME` = Android Studio jbr; string-verify per the memory
ritual), then the user drills on real hardware:
- drag order persists across restart AND across a sync round-trip
  between desktop and the Fold;
- stars settable from card + editor on both platforms;
- sort-by-stars; touch scroll and hold-drag still work (0.7.5
  regression check).

Only after the drill passes: `gh release create v0.8.0` with the
contract asset names (`Klaxon_0.8.0_x64-setup.exe`,
`klaxon-0.8.0-arm64.apk`) and release notes leading with the
update-both-devices warning, following the 0.7.5 release procedure.
