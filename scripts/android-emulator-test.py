#!/usr/bin/env python3
"""Run real Klaxon sync/lifecycle tests on a fresh, explicitly selected emulator."""

import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import time

PACKAGE = "com.klaxon.app"
RUNNER = PACKAGE + ".test/androidx.test.runner.AndroidJUnitRunner"


def require_test_success(output):
    # `am instrument` can exit zero even when no test ran or the app crashed.
    if not re.search(r"^OK \(1 test\)\s*$", output, re.MULTILINE):
        raise RuntimeError("Instrumentation did not report exactly one passing test")
    if re.search(r"FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed|shortMsg=", output):
        raise RuntimeError("Instrumentation reported a crash or failure")


class Harness:
    def __init__(self, args):
        self.args = args
        self.output = args.output.resolve()
        self.peer = None
        self.events = []

    def adb(self, *args, timeout=45, check=True):
        result = subprocess.run(
            ["adb", "-s", self.args.serial, *args], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
        )
        if check and result.returncode:
            raise RuntimeError(f"adb {args[:3]} failed ({result.returncode}): {result.stdout}")
        return result.stdout

    def read_json(self, name):
        if self.peer.poll() is not None:
            raise RuntimeError(f"Peer exited with {self.peer.returncode}; see peer.log")
        try:
            return json.loads((self.output / "peer" / name).read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def wait(self, description, condition, seconds=25):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if condition():
                return
            time.sleep(0.2)
        raise RuntimeError(f"Deadline exceeded: {description}")

    def instrument(self, phase, label=None):
        fixture = base64.b64encode(json.dumps(self.fixture).encode()).decode()
        self.adb("shell", "am", "force-stop", PACKAGE)
        output = self.adb(
            "shell", "am", "instrument", "-w", "-r",
            "-e", "class", PACKAGE + ".SyncLifecycleTest#realSyncAndLifecycle",
            "-e", "phase", phase, "-e", "fixture", fixture,
            "-e", "disposable_emulator", "true", RUNNER,
            timeout=300, check=False,
        )
        (self.output / f"instrumentation-{label or phase}.txt").write_text(output)
        require_test_success(output)
        self.events.append({"phase": phase, "instrumentation": "passed"})
        print(f"PASS Android {phase}", flush=True)

    def stage(self, phase):
        pending = self.output / "peer" / "stage.pending"
        pending.write_text(phase)
        pending.replace(self.output / "peer" / "stage.txt")
        self.wait(f"host prepares {phase}", lambda: self.read_json("report.json").get("stage") == phase)
        self.instrument(phase)
        expected = {"id": f"android-{phase}", "title": f"Android fixture {phase}",
                    "repeat_rule": '{"kind":"weekly","weekdays":[1,3,5]}'}
        self.wait(
            f"production host committed outgoing {phase}",
            lambda: expected in self.read_json("report.json").get("received", []),
        )
        self.events[-1]["host_received"] = expected
        print(f"PASS host persisted Android fixture {phase}", flush=True)

    def install(self, apk):
        self.adb("install", "-r", "-g", str(apk.resolve()), timeout=120)

    def installed_version(self):
        metadata = self.adb("shell", "dumpsys", "package", PACKAGE)
        match = re.search(r"\bversionCode=(\d+)\b", metadata)
        if not match:
            raise RuntimeError("Installed APK has no readable versionCode")
        return int(match.group(1))

    def run(self):
        if not re.fullmatch(r"emulator-\d+", self.args.serial):
            raise RuntimeError("Only an explicit emulator-NNNN serial is allowed; physical devices are forbidden")
        if self.adb("shell", "getprop", "ro.kernel.qemu").strip() != "1":
            raise RuntimeError("Selected device did not identify itself as an emulator")
        # `pm path` exits 1 when absent, which is the expected fresh state.
        # Listing packages exits successfully for an empty result and still
        # preserves ADB/PackageManager failures as errors.
        if f"package:{PACKAGE}" in self.adb("shell", "pm", "list", "packages", PACKAGE).splitlines():
            raise RuntimeError("Use a fresh emulator: refusing to overwrite an existing Klaxon installation")
        self.output.mkdir(parents=True, exist_ok=False)
        with (self.output / "peer.log").open("w") as peer_log:
            try:
                self.peer = subprocess.Popen(
                    [str(self.args.peer.resolve()), str(self.output / "peer")],
                    stdout=peer_log, stderr=subprocess.STDOUT,
                )
                self.wait("host fixture is ready", lambda: bool(self.read_json("fixture.json")))
                self.fixture = self.read_json("fixture.json")
                self.install(self.args.apk)
                current_version = self.installed_version()
                self.install(self.args.test_apk)
                self.adb("logcat", "-c")
                self.instrument("seed")
                self.instrument("identity")
                for phase in ("initial", "resume", "restart"):
                    self.stage(phase)
                if self.args.extended:
                    self.stage("outage")
                    # Only the synthetic installation created above is removed.
                    self.adb("uninstall", PACKAGE)
                    self.install(self.args.previous_apk)
                    previous_version = self.installed_version()
                    if previous_version >= current_version:
                        raise RuntimeError("Upgrade baseline must have a strictly older versionCode")
                    self.install(self.args.test_apk)
                    self.instrument("seed", label="seed-upgrade")
                    self.instrument("identity", label="identity-upgrade")
                    self.adb("shell", "am", "force-stop", PACKAGE)
                    self.install(self.args.apk)  # PackageManager upgrade, preserving app data.
                    if self.installed_version() != current_version:
                        raise RuntimeError("PackageManager did not install the current version")
                    self.stage("upgrade")
                    self.events[-1]["upgrade_version_codes"] = [previous_version, current_version]
                (self.output / "results.json").write_text(json.dumps({"passed": True, "phases": self.events}, indent=2))
            except Exception as error:
                (self.output / "results.json").write_text(json.dumps({"passed": False, "error": str(error), "phases": self.events}, indent=2))
                raise
            finally:
                for name, command in (
                    ("logcat.txt", ("logcat", "-d", "-t", "5000", "-v", "threadtime")),
                    ("activity.txt", ("shell", "dumpsys", "activity", "activities")),
                    ("package.txt", ("shell", "dumpsys", "package", PACKAGE)),
                ):
                    try:
                        (self.output / name).write_text(self.adb(*command, timeout=15, check=False))
                    except Exception as error:
                        (self.output / name).write_text(str(error))
                if self.peer:
                    if (self.output / "peer").is_dir():
                        (self.output / "peer" / "stop").touch()
                    try:
                        self.peer.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        self.peer.kill()
                        self.peer.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--test-apk", type=Path, required=True)
    parser.add_argument("--peer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New directory for bounded diagnostics")
    parser.add_argument("--extended", action="store_true")
    parser.add_argument("--previous-apk", type=Path)
    args = parser.parse_args()
    if args.extended and not args.previous_apk:
        parser.error("--extended requires --previous-apk; upgrade coverage is mandatory")
    for path in (args.apk, args.test_apk, args.peer, args.previous_apk):
        if path is not None and not path.is_file():
            parser.error(f"File not found: {path}")
    Harness(args).run()


if __name__ == "__main__":
    main()
