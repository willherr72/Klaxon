#!/usr/bin/env bash
set -euo pipefail

mapfile -t apks < <(find src-tauri/gen/android/app/build/outputs/apk -name '*-debug.apk' ! -path '*/androidTest/*')
mapfile -t tests < <(find src-tauri/gen/android/app/build/outputs/apk/androidTest -name '*-androidTest.apk')
[ "${#apks[@]}" -eq 1 ]
[ "${#tests[@]}" -eq 1 ]
arguments=(--serial emulator-5554 --apk "${apks[0]}" --test-apk "${tests[0]}"
  --peer src-tauri/target/debug/examples/android_sync_peer --output emulator-results)
if [ "${1:-false}" = true ]; then
  arguments+=(--extended --previous-apk "$RUNNER_TEMP/klaxon-baseline.apk")
fi
python3 scripts/android-emulator-test.py "${arguments[@]}"
cat emulator-results/results.json >> "$GITHUB_STEP_SUMMARY"
