# Backups & Export — Design

**Status:** Approved, ready for implementation planning
**Date:** 2026-07-30
**Branch:** new branch off `main`
**Author:** William Herr (with Claude)

---

## 1. Problem

Klaxon's P2P design means there is no copy of the user's data anywhere
except their devices — no server to restore from is the feature, and the
risk. Today:

- If both devices die (or one device, for a single-device user), everything
  is gone.
- If the database corrupts or the user fat-fingers a bulk delete, there is
  no local rollback either.
- A replacement device starts as a stranger: new iroh identity, pairings
  gone, everything re-synced only if another paired device survives.

For an app whose pitch is "your data stays yours," the missing half of that
sentence is "…and you can keep it."

## 2. Decisions (user-approved)

1. **Both mechanisms:** automatic local snapshots (zero-discipline
   insurance against corruption/deletion) *and* a manual export (insurance
   against device loss, parked wherever the user chooses).
2. **Export is a full resurrection:** database + iroh identity, so a
   replacement device *is* the old device — pairings intact. The misuse
   case (restoring onto a second device while the original lives → two
   devices, one identity) is prevented by guardrail wording, not
   mechanism.
3. **Export is always passphrase-encrypted.** The file contains the iroh
   secret key and every peer's shared secret — enough to impersonate the
   device on the sync mesh. Plaintext exports would be a footgun
   inconsistent with the privacy pitch.

## 3. Auto snapshots

- On launch, if the newest snapshot is older than **24 h**: copy the
  database via **SQLite's online-backup API** (`rusqlite::backup`) — safe
  while the DB is open under WAL; a plain file copy is not — into
  `app_data/backups/klaxon-YYYY-MM-DD-HHMMSS.db`.
- Keep the newest **7**; delete older ones after a successful new snapshot.
- Snapshot failure is logged, never fatal, and never blocks startup.
- UI: a "Last snapshot: <relative time>" line in Settings → System.
  Nothing else — no schedule knobs, no manual-snapshot button.
- Restore-from-snapshot is a documented file swap (close app, replace
  `klaxon.db`, reopen), not a UI flow. Snapshots are plain SQLite files by
  design — inspectable, greppable, restorable with nothing but a file
  manager.
- Both platforms; the path derives from the same `app_data_dir` the DB
  uses (`Context.dataDir` on Android).

## 4. Export

- Settings → System → **Export backup…** Prompts for a passphrase twice,
  with plain wording: *"There is no recovery. If you lose this passphrase,
  this backup is unreadable."*
- Output: a single `Klaxon-backup-YYYY-MM-DD.klaxonbak`.
- **Container** (postcard-serialized, consistent with the codebase — no
  zip dependency):

  ```
  magic  b"KLXBAK"
  version u16 (1)
  argon2 salt (16 B) + parameters (m, t, p as u32s)
  AES-256-GCM nonce (12 B)
  ciphertext of postcard-encoded BackupPayload {
      manifest: { schema_version, app_version, device_name, created_ms },
      db:       Vec<u8>,   // online-backup copy of klaxon.db
      iroh_secret: Vec<u8>, // klaxon-iroh-secret.bin (32 B)
  }
  ```

- Crypto: **Argon2id** (RustCrypto `argon2`, default parameters recorded
  in the header so future versions can verify) → 32-byte key →
  **AES-256-GCM** (`aes-gcm`). Pure Rust; compiles for Android without
  ceremony. GCM's auth tag doubles as tamper detection.
- Delivery: desktop saves via file dialog (`tauri-plugin-dialog`);
  **Android hands the file to the system share sheet** — Drive, email,
  cable — the native idiom, no storage permissions.

## 5. Import (restore-on-restart)

- Settings → System → **Restore backup…** File picker → passphrase →
  guardrail, verbatim:

  > Restore this only onto a device replacing the old one. Never onto a
  > second device while the original still runs — two devices sharing one
  > identity will corrupt sync.

- On confirm: decrypt and validate (magic, version, schema_version not
  newer than this build's), then write the payload to
  `app_data/restore-staging/` and set a marker file. **Nothing live is
  touched.**
- On next launch, before `db::open`: if staging + marker exist, move the
  current `klaxon.db` and `klaxon-iroh-secret.bin` to
  `app_data/restore-undo/` (one level of oops), swap the staged files in,
  clear the marker, continue booting. The app prompts for restart after a
  successful stage ("Restart Klaxon to finish restoring").
- Failure anywhere before the swap changes nothing. A wrong passphrase or
  tampered file fails GCM authentication and reports plainly.
- A backup whose `schema_version` is *older* than the current build is
  fine — migrations run on the restored DB at open, same as any upgrade.
  *Newer* is refused with "this backup came from a newer Klaxon."

## 6. Non-goals

- Scheduled/automatic **export** — snapshots cover the zero-discipline
  case locally; placing a file off-device stays a deliberate human act.
- Cloud storage integration of any kind.
- Item-level restore (pick one reminder out of a backup).
- Importing bare `.db` files through the UI — one format, one code path.
- Data-only restore mode (decided against: full resurrection with
  guardrails, per §2).

## 7. Testing

Rust unit tests: encrypt→decrypt round-trip; wrong passphrase fails
cleanly; single-bit tamper fails GCM; container version/magic validation;
future-schema refusal; snapshot rotation keeps exactly 7 in age order;
staged-restore swap logic (pure path/file operations, temp-dir tested);
snapshot via backup API produces an openable DB containing the source
rows.

Manual: the resurrection drill on the phone — export, uninstall/wipe,
reinstall, restore, confirm the desktop still syncs with it without
re-pairing. Same drill is the documentation's recovery procedure.
