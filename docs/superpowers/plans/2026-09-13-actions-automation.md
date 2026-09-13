# GitHub Actions automation implementation plan

> **For agentic workers:** Use the dispatching-parallel-agents skill for the independent test harness and validation tasks. The coordinating agent owns workflows and integration.

**Goal:** Run repeatable validation, Android lifecycle/sync tests, and release preparation on standard GitHub-hosted runners without requiring the maintainer's phone.

**Architecture:** Share validation between local commands and CI. Run the real Android app in an x86_64 emulator against an isolated production Iroh peer, with synthetic fixtures only. Keep arm64 release compilation separate, use bounded nightly recovery tests, retain temporary artifacts for three days, and publish only verified matching Windows and signed Android artifacts from a trusted release tag.

**Tech Stack:** GitHub Actions, Node scripts, Python/ADB, Kotlin instrumentation, Rust/Iroh, Tauri/Gradle.

**Spec:** Approved conversation design: PR validation, main-branch emulator checks, nightly recovery/upgrade checks, release artifact validation, standard runners and short retention. Cloud signing uses the existing release identity in restricted environment secrets; test jobs never receive production signing material.

## Global constraints

- Standard `windows-latest` / `ubuntu-latest` runners only; no paid device service.
- All tests use synthetic data and temporary identities. Never target the user's phone or live app database.
- Test APKs must not be published as releases. Ship Android arm64 with the existing signing certificate.
- No user-facing app behavior changes are planned; infrastructure work does not force an app upgrade.
- Keep the working v0.10.3 release intact. A release job must reject an existing release rather than replace it.
- Stop on command failures; retain failure diagnostics for three days; do not upload entire build directories or emulator images.
- NDK 27.1.12297006; align Java 21 locally and in CI; use lockfiles.

## Task 1: Shared validation and release artifact checks

Files: `scripts/verify.mjs`, `scripts/release-check.mjs`, their Node tests, `package.json`, README.

- [ ] Add a shared command that runs version checks, frontend checking/tests/build, locked Rust tests and the actual `sync_smoke` executable.
- [ ] Test version mismatch and artifact rejection behavior with isolated fixture directories and literal expected results, then implement validation.
- [ ] Verify tag, package versions, platform asset names, APK package/version/ABI/certificate, installer version, and SHA-256 hashes before publication.
- [ ] Document the commands and prerequisites; do not change application versions.

## Task 2: Real Android emulator regression

Files: Android instrumentation tests, `src-tauri/examples/android_sync_peer.rs`, emulator orchestration script.

- [ ] Launch the actual app in a disposable emulator; create synthetic peer/data fixtures with test-only utilities.
- [ ] Assert completed pull and push and actual persisted data against a production Iroh handler.
- [ ] Assert new successful sync after background/resume and process restart, retaining pairing and data.
- [ ] Exercise bounded connectivity interruption/recovery and upgrade preservation in the longer suite where supported by the fixture.
- [ ] Fail on missing assertions, crashes, or deadlines. Capture bounded logcat and test results on failure.
- [ ] Keep fixture services and test controls entirely outside production application code.

## Task 3: Workflow integration and hosted verification

Files: `.github/workflows/ci.yml`, `build.yml`, new reusable Android test/nightly/release workflows; README and AGENTS release policy if cloud signing is activated.

- [ ] Use shared verification on PR/main; keep warning checks and lockfiles.
- [ ] Add an accelerated x86_64 Android emulator job with Java 21 and pinned NDK; continue arm64 packaging checks.
- [ ] Schedule the longer suite once nightly and allow manual dispatch, with concurrency cancellation and timeouts.
- [ ] Avoid tag/main duplicate installer builds; release jobs reuse or depend on the exact source revision's validated outputs.
- [ ] Prepare release artifacts only from a version tag on main, validate both assets before publishing, and restrict signing credentials to the release job.
- [ ] Validate workflow syntax and scripts, run tests locally, push an isolated branch and run Actions.
- [ ] Fix hosted failures using logs, review the final diff, and merge after required checks pass.

## Completion evidence

Record actual hosted run URLs and covered scenarios in the final report. Distinguish emulator recovery from physical Samsung battery behavior and real cellular transitions. Nightly schedules add no compute charge for this public repository on standard runners.
