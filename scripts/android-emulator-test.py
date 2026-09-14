#!/usr/bin/env python3
"""Run real Klaxon sync/lifecycle tests on a fresh, explicitly selected emulator."""

import argparse
import base64
import json
from pathlib import Path
import re
import socket
import subprocess
import threading
import time

PACKAGE = "com.klaxon.app"
RUNNER = PACKAGE + ".test/androidx.test.runner.AndroidJUnitRunner"


class AppLogCapture:
    """Continuously drain app-UID logs, retaining bounded startup and final output."""
    LIMIT = 1024 * 1024

    def __init__(self, serial, uid, path):
        self.path = path
        self.head = bytearray()
        self.tail = bytearray()
        self.closed = False
        self.process = subprocess.Popen(
            ["adb", "-s", serial, "logcat", f"--uid={uid}", "-v", "threadtime"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        self.reader = threading.Thread(target=self.drain, daemon=True)
        self.reader.start()

    def drain(self):
        while True:
            chunk = self.process.stdout.read(8192)
            if not chunk:
                return
            available = self.LIMIT - len(self.head)
            self.head.extend(chunk[:available])
            self.tail.extend(chunk[available:])
            if len(self.tail) > self.LIMIT:
                del self.tail[:-self.LIMIT]

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        separator = b"\n--- end of retained startup; retained final logs follow ---\n" if self.tail else b""
        self.path.write_bytes(self.head + separator + self.tail)


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
        self.app_log = None
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
            # Test phases own lifecycle transitions. Do not inject Activity.finish()
            # teardown before the runner reports results; host force-stop stays explicit.
            "-e", "waitForActivitiesToComplete", "false",
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

    def native_lifecycle(self, phase):
        self.adb("shell", "am", "force-stop", PACKAGE)
        output = self.adb(
            "shell", "am", "instrument", "-w", "-r",
            "-e", "waitForActivitiesToComplete", "false",
            "-e", "class", PACKAGE + ".NativeLifecycleTest#lifecycleProbe",
            "-e", "phase", phase, "-e", "disposable_emulator", "true", RUNNER,
            timeout=300, check=False,
        )
        (self.output / f"native-{phase}.txt").write_text(output)
        marker = self.adb("shell", "run-as", PACKAGE, "cat",
                          f"files/ci-native-lifecycle-{phase}.json", check=False)
        (self.output / f"native-{phase}-marker.txt").write_text(marker)
        require_test_success(output)
        self.events.append({"phase": phase, "instrumentation": "passed"})
        print(f"PASS Android native lifecycle {phase}", flush=True)

    def pairing(self, scenario):
        directory = self.output / f"pair-{scenario}"
        directory.mkdir()
        for name in ("ready", "offer", "result"):
            self.adb("shell", "run-as", PACKAGE, "rm", "-f", f"files/ci-pair-{name}.json")
        self.adb("shell", "am", "force-stop", PACKAGE)
        redirects = []
        pair_peer = None
        with (directory / "instrumentation.txt").open("w") as log, (directory / "peer.log").open("w") as peer_log:
            instrument = subprocess.Popen([
                "adb", "-s", self.args.serial, "shell", "am", "instrument", "-w", "-r",
                "-e", "waitForActivitiesToComplete", "false",
                "-e", "class", PACKAGE + ".PairingFlowTest#incomingPairingUi",
                "-e", "scenario", scenario, "-e", "disposable_emulator", "true", RUNNER,
            ], stdout=log, stderr=subprocess.STDOUT)
            try:
                ready = {}
                def read_ready():
                    nonlocal ready
                    if instrument.poll() is not None:
                        raise RuntimeError("Pairing instrumentation exited before endpoint discovery")
                    raw = self.adb("shell", "run-as", PACKAGE, "cat", "files/ci-pair-ready.json", check=False)
                    try:
                        ready = json.loads(raw)
                        return ready.get("scenario") == scenario and bool(ready.get("udp_ports"))
                    except json.JSONDecodeError:
                        return False
                self.wait("Android pairing endpoint", read_ready, seconds=100)
                addresses = []
                for guest_port in ready["udp_ports"]:
                    if not isinstance(guest_port, int) or not 1 <= guest_port <= 65535 or guest_port == 5353:
                        continue
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reservation:
                        reservation.bind(("127.0.0.1", 0))
                        host_port = reservation.getsockname()[1]
                    reply = self.adb("emu", "redir", "add", f"udp:{host_port}:{guest_port}")
                    if "KO:" in reply or "OK" not in reply:
                        raise RuntimeError(f"Emulator UDP redirect failed: {reply}")
                    redirects.append(host_port)
                    addresses.append({"Ip": f"127.0.0.1:{host_port}"})
                if not addresses:
                    raise RuntimeError("Android exposed no usable UDP pairing socket")
                input_file = directory / "input.json"
                input_file.write_text(json.dumps({"scenario": scenario, "node_id": ready["node_id"], "endpoint_addrs": addresses}))
                peer_directory = directory / "peer"
                pair_peer = subprocess.Popen([str(self.args.pair_peer.resolve()), str(peer_directory), str(input_file)],
                                             stdout=peer_log, stderr=subprocess.STDOUT)
                def transfer(name):
                    source = peer_directory / f"{name}.json"
                    if not source.is_file():
                        if pair_peer.poll() is not None:
                            raise RuntimeError(f"Pairing peer exited before {name}; see pair-{scenario}/peer.log")
                        if instrument.poll() is not None:
                            raise RuntimeError(f"Pairing instrumentation exited before {name}")
                        return False
                    destination = f"/data/local/tmp/klaxon-ci-pair-{name}.json"
                    self.adb("push", str(source), destination)
                    target = "result" if name == "report" else name
                    self.adb("shell", "run-as", PACKAGE, "cp", destination, f"files/ci-pair-{target}.json")
                    self.adb("shell", "rm", "-f", destination)
                    return True
                self.wait("host pairing offer", lambda: transfer("offer"), seconds=45)
                self.wait("host pairing result", lambda: transfer("report"), seconds=200)
                instrument.wait(timeout=120)
                pair_peer.wait(timeout=30)
                log.flush()
                require_test_success((directory / "instrumentation.txt").read_text())
                if pair_peer.returncode:
                    raise RuntimeError(f"Pairing peer failed with exit {pair_peer.returncode}")
                self.events.append({"phase": f"pair-{scenario}", "instrumentation": "passed"})
                print(f"PASS real pairing {scenario}", flush=True)
            finally:
                for process in (instrument, pair_peer):
                    if process is not None and process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                for port in redirects:
                    self.adb("emu", "redir", "del", f"udp:{port}", check=False)

    def install(self, apk):
        self.adb("install", "-r", "-g", str(apk.resolve()), timeout=120)

    def installed_version(self):
        metadata = self.adb("shell", "dumpsys", "package", PACKAGE)
        match = re.search(r"\bversionCode=(\d+)\b", metadata)
        if not match:
            raise RuntimeError("Installed APK has no readable versionCode")
        return int(match.group(1))

    def installed_uid(self):
        # Ask the installed debug app's process identity directly. PackageManager
        # changed its diagnostic field from userId to appId on newer Android.
        uid = self.adb("shell", "run-as", PACKAGE, "id", "-u").strip()
        if not re.fullmatch(r"\d+", uid):
            raise RuntimeError("Cannot identify synthetic app UID for startup log capture")
        return uid

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
                self.app_log = AppLogCapture(self.args.serial, self.installed_uid(), self.output / "app-startup-and-final.log")
                self.instrument("seed")
                self.instrument("identity")
                for phase in ("initial", "resume", "restart"):
                    self.stage(phase)
                self.native_lifecycle("normal_back")
                for scenario in ("approve", "decline"):
                    self.pairing(scenario)
                if self.args.extended:
                    self.pairing("expire")
                    self.stage("outage")
                    # Only the synthetic installation created above is removed.
                    self.adb("uninstall", PACKAGE)
                    self.install(self.args.previous_apk)
                    # Reinstall may assign a new UID; retain the initial run log
                    # and start a separate bounded capture before baseline seed.
                    self.app_log.close()
                    self.app_log = AppLogCapture(self.args.serial, self.installed_uid(), self.output / "upgrade-startup-and-final.log")
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
                if self.args.lifecycle_probe:
                    self.native_lifecycle(self.args.lifecycle_probe)
                (self.output / "results.json").write_text(json.dumps({"passed": True, "phases": self.events}, indent=2))
            except Exception as error:
                (self.output / "results.json").write_text(json.dumps({"passed": False, "error": str(error), "phases": self.events}, indent=2))
                raise
            finally:
                if self.app_log:
                    try:
                        self.app_log.close()
                    except Exception as error:
                        (self.output / "app-log-capture-error.txt").write_text(str(error))
                for name, command in (
                    ("logcat.txt", ("logcat", "-d", "-t", "5000", "-v", "threadtime")),
                    ("activity.txt", ("shell", "dumpsys", "activity", "activities")),
                    ("package.txt", ("shell", "dumpsys", "package", PACKAGE)),
                    ("native-crash.txt", ("logcat", "-b", "crash", "-d", "-t", "2000", "-v", "threadtime")),
                    ("process-exit.txt", ("shell", "dumpsys", "activity", "exit-info", PACKAGE)),
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
    parser.add_argument("--pair-peer", type=Path, required=True)
    parser.add_argument("--lifecycle-probe", choices=("recreate", "finish"))
    parser.add_argument("--output", type=Path, required=True, help="New directory for bounded diagnostics")
    parser.add_argument("--extended", action="store_true")
    parser.add_argument("--previous-apk", type=Path)
    args = parser.parse_args()
    if args.extended and not args.previous_apk:
        parser.error("--extended requires --previous-apk; upgrade coverage is mandatory")
    for path in (args.apk, args.test_apk, args.peer, args.pair_peer, args.previous_apk):
        if path is not None and not path.is_file():
            parser.error(f"File not found: {path}")
    Harness(args).run()


if __name__ == "__main__":
    main()
