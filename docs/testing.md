# Testing and release baseline

## P0-01, November 23, 2026

Baseline commit c89b655a4e04c38cc8155a8e76a977d156942727. The package and native configuration agree on 0.11.1. The latest release inspected included the updater-compatible Windows NSIS installer, Android arm64 APK and release manifest. [GitHub release](https://github.com/willherr72/Klaxon/releases/tag/v0.11.1)

The Svelte 5/Vite frontend uses Tauri 2 commands for native access. The Rust domain module handles shared UI and agent mutations and dispatches side effects. SQLite stores domain data and revision journals. Iroh handles v1 peer transport. Windows tray, capture, scheduler and alerts, and Android background sync and alarms have native integration points. Pin Node 24.12.0 and Rust 1.97.1 for comparable runs.

| Command or evidence | Observed result |
| --- | --- |
| npm ci followed by npm run verify -- --frontend | 23 tooling tests and 65 Vitest tests passed across 10 files. Svelte check reported zero errors and warnings. Production Vite build succeeded. |
| cargo test --locked --manifest-path src-tauri/Cargo.toml --lib | 186 Rust library tests passed on Windows, including versioned migration, restore and sync regressions. |
| python -m unittest discover -s scripts/tests -v | Four Android instrumentation-result and log-retention harness tests passed. |
| Read-only SQLite projection of temporary synthetic schema 17 fixture | Passed integrity, relation, recurrence, local date and unchanged file hash checks. See [migration](migration.md). |
| Exact-commit Windows CI | Passed shared verification including Rust tests and sync smoke, warnings-as-errors build and live MCP assertions. [Run 42159611795](https://github.com/willherr72/Klaxon/actions/runs/42159611795) |
| Exact-commit Android smoke | Failed at “Run real sync and lifecycle assertions”. The instrumentation parser reported that it did not receive exactly one passing test. The underlying device cause is unresolved. [Run 42159611795](https://github.com/willherr72/Klaxon/actions/runs/42159611795) |
| Exact-commit nightly | One Android upgrade run failed while building the older test-signed APK. A later nightly passed at the same revision. [Failed run](https://github.com/willherr72/Klaxon/actions/runs/43731382286) · [Later passing run](https://github.com/willherr72/Klaxon/actions/runs/45258299066) |

## CI and release boundaries

The Windows CI command npm run verify checks version alignment, tooling, frontend, Cargo tests and two-peer sync smoke. Nightly adds transport recovery and Android upgrade/recovery from v0.10.2 on a test-signed x86_64 emulator. Android instrumentation-result parsing detects zero-test successes. These workflows exercise v1; P0 device acceptance requires separate evidence for Convex, account/token refresh and push.

The Build workflow produces Windows and unsigned Android artifacts. The Release workflow checks exact revision, newer tag, dated changelog, provenance, signing identity and artifact metadata before publication. Only the restricted release environment receives signing credentials. P0 uses synthetic records and requires no release.

## V2 evidence requirements

For each backlog ID record the exact revision or isolated spike path, command, target/device, observed result and unresolved failures. Auth needs sign-in, sign-out, refresh and reactive propagation on web, Windows and Android. Push needs foreground, background and closed-app evidence on actual Windows and Android devices. Distinguish local mock, emulator, disposable deployment and physical-device results. Record denied cross-workspace access and revision/retry behavior once real authenticated contracts exist. Keep accepted migration evidence, discrepancy counts and rollback rehearsal alongside the migration runbook.
