# P1-01 repository foundation implementation plan

**Approved scope.** Will accepted the P0 gate and authorized P1-01 on November 25, 2026 (Central time). The first change should produce one shared frontend build that opens in a browser and both packaged clients. The existing root package and native crate still serve v1. [Approved backlog and proposed layout](../../../KLAXON_V2_DESIGN_AND_IMPLEMENTATION_PLAN.md) · [P0 decisions](../../adr/p0-architecture.md)

**Baseline.** At `9f08ddd826a4afa4208d35a70d4be36a8b814c66`, the Linux job builds the P0 portable HTML, tests it, and passes the artifact to the Windows job. The Galaxy test used a separately packaged debug APK. These are reference implementations for testing artifact reuse and Android packaging. A P1 pass requires running the new application entry points. [Unsigned CI](../../../.github/workflows/v2-validation.yml) · [Physical phone result](../../klaxon-v2-progress.md#physical-android-hosted-session)

## Shared build and configuration

- [x] Create an isolated npm package and lockfile in `apps/web/` with a static Svelte/Vite entry point. Use the repository Node pin and the versions in its locked toolchain. Add shared package boundaries when a real consumer needs them. The first consumer is the native shell loading the web build.
- [x] Add one command, `npm --prefix apps/web run verify`, for lint, Svelte/TypeScript checks, unit tests and the static build. Exercise the checker with an invalid component prop and the linter with a violation of a configured rule. Confirm each fails the command. Remove the injected errors and verify a clean install builds without an existing output directory.
- [x] Keep local and Development configuration explicit. The default test build must boot without credentials and must make zero external requests. In a browser test, open and reload the built app under a nested static mount with no rewrite rules. Require the app to render and all required assets to load on both navigations. Use the P0 mount-relative link behavior as a reference.
- [x] Test invalid configuration *at build time*. A hosted build with a missing or invalid origin must exit unsuccessfully before publishing output. Build with an inert sentinel in the deploy-key environment and search the frontend output, including source maps, for that sentinel. Zero matches are required. Grant access and provider lifecycle tests belong to P1-03.

## Unsigned native consumers

- [x] Add the v2 Tauri shell under `apps/native/` with a separate application identifier and data directory. Set its frontend asset path to the verified `apps/web/dist/` output. Build desktop and Android debug packages from the same staged assets. Keep signing and publishing in the existing release workflow.
- [x] Record hashes of the browser-tested HTML and its referenced local assets. Require both packaging jobs to compare their input against that manifest. Exercise a mismatched asset case that fails before packaging. A matching input hash is evidence of artifact transfer. Also open the built Windows app and the Android app on a disposable emulator and verify the shared frontend renders.
- [ ] Extend the existing `v2` PR validation workflow with those checks using the existing free CI capacity. Run the root frontend verification and synthetic migration probe alongside the foundation jobs. Record the head SHA, exact commands, package identities, runtime results and any skipped checks in the living register.

## Handoff to P1-02

One lead integrates build configuration and the dependency lock. The web build and the independent tests for package identity and asset integrity can be prepared in parallel once the output path is agreed. Start schema work after both packages consume the tested frontend and the v1 regressions pass. P1-01 supplies build evidence only. The P1 phase gate still requires cross-owner denial, revision conflicts, atomic replay, two-client propagation and migration/export round trips with synthetic data. [Domain boundary](../../api/README.md) · [Migration procedure](../../migration.md)
