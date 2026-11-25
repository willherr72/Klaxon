"""Inspect the pinned debug NSIS fixture without installing or launching it."""
import hashlib
import subprocess
from pathlib import Path


def verify():
    debug = Path(__file__).resolve().parent / "src-tauri/target/debug"
    installer = debug / "bundle/nsis/Klaxon P0 Reminder Fixture_0.1.0_x64-setup.exe"
    binary = "klaxon-p0-reminder-fixture.exe"
    listing = subprocess.check_output(["7z", "l", "-ba", "-slt", str(installer)], text=True)
    entries = [line.removeprefix("Path = ") for line in listing.splitlines() if line.startswith("Path = ")]
    plugins = ["System.dll", "nsDialogs.dll", "nsis_tauri_utils.dll", "StartMenu.dll", "modern-wizard.bmp"]
    expected = [binary] + ["$PLUGINSDIR\\" + name for name in plugins]
    if sorted(entries) != sorted(expected):
        raise ValueError(f"Unexpected NSIS payload inventory: {entries}")

    # Tauri CLI stamps the NSIS bundle type in the packaged PE and restores
    # the original marker on disk. Every other byte must match the local build.
    original = (debug / binary).read_bytes()
    marker = b"__TAURI_BUNDLE_TYPE_VAR_UNK"
    packaged = subprocess.check_output(["7z", "x", "-so", str(installer), binary])
    if original.count(marker) != 1 or packaged != original.replace(marker, b"__TAURI_BUNDLE_TYPE_VAR_NSS"):
        raise ValueError("The packaged fixture differs from the compiled executable")
    if b"dev.klaxon.p0reminderfixture" not in packaged:
        raise ValueError("The fixture identifier is missing from the packaged executable")
    definitions = (debug / "nsis/x64/installer.nsi").read_text(encoding="utf-8-sig").splitlines()
    for key, value in {
        "PRODUCTNAME": "Klaxon P0 Reminder Fixture", "MAINBINARYNAME": binary.removesuffix(".exe"),
        "BUNDLEID": "dev.klaxon.p0reminderfixture", "INSTALLMODE": "currentUser",
        "INSTALLWEBVIEW2MODE": "", "WEBVIEW2BOOTSTRAPPERPATH": "", "WEBVIEW2INSTALLERPATH": "",
    }.items():
        if f'!define {key} "{value}"' not in definitions:
            raise ValueError(f"Unexpected rendered installer setting for {key}")
    print("Verified installer settings, app executable and NSIS resources.")
    print("Installer SHA-256", hashlib.sha256(installer.read_bytes()).hexdigest())


if __name__ == "__main__":
    verify()
