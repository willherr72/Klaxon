# Reliability hardening implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent pairing and lifecycle investigations; root integrates and verifies.

**Goal:** Enforce CI before merges, cover real pairing decisions, and identify Android Activity shutdown behavior.

**Architecture:** Keep disposable emulator tests outside production. A direct UDP host sends real pairing offers to the Android handler; instrumentation operates the actual WebView dialog. Backend closure events dismiss expired requests. Normal launcher Back is required coverage; explicit Activity destruction has a separate diagnostic workflow.

**Tech Stack:** Rust/Iroh/Tauri, Svelte/Vitest, Kotlin/AndroidJUnitRunner, Python, GitHub Actions.

**Spec:** User-approved reliability improvements in this session.

## Constraints

- Preserve user data, pairings, signing certificate, and unrelated generated vendor files.
- Use only disposable emulators; never send release credentials to tests.
- Production changes require a new version with Windows and signed Android assets.
- Do not suppress native failures or ship an unverified process-exit workaround.

## Tasks

- [x] Require `Windows validation` and `Android smoke / emulator` on `main`, bound to GitHub Actions app15368, with no human review gate.
- [ ] Add `PairingFlowTest.kt` and `android_pair_peer.rs`: approve/decline in smoke; actual120s expiration in extended; approved handshake must subsequently sync.
- [ ] Reproduce stale pairing UI with focused component tests, then emit request-scoped backend closure events and safely clean up listeners.
- [ ] Add `NativeLifecycleTest.kt`: usable native IPC and preserved identity/reminder after normal launcher Back; separate recreate/finish probes.
- [ ] Integrate fixture processes and UDP redirects in `android-emulator-test.py`; retain bounded crash-buffer and process-exit diagnostics.
- [ ] Run local verification, cloud smoke/extended tests and explicit lifecycle probes. Record native root-cause limits honestly.
- [ ] Review, align versions/changelog, merge through required checks, publish new signed release through the authorized release workflow.
