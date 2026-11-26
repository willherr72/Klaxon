"""CLI for exporting and verifying a local Klaxon v1 migration projection."""

import argparse
import hashlib
import os
import re
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

from legacy_reconcile import FORMAT_VERSION, envelope, reconcile
from legacy_source import SCHEMA_VERSION, MigrationError, canonical, read_snapshot, sha256, strict_json

MANIFEST_NAME = "manifest.json"
ARTIFACTS = ("projection.json", "report.json")
ORIGIN = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


def digest_file(path):
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path, data):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as temp:
            temp_path = Path(temp.name)
            temp.write(data)
            temp.flush()
            os.fsync(temp.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def checked_file(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise MigrationError("output files must be regular files")
    return path


@contextmanager
def output_lock(output):
    path = checked_file(output / ".export.lock")
    with path.open("a+b") as lock:
        try:
            if os.name == "nt":
                from msvcrt import LK_NBLCK, locking
                lock.seek(0)
                locking(lock.fileno(), LK_NBLCK, 1)
            else:
                from fcntl import LOCK_EX, LOCK_NB, flock
                flock(lock, LOCK_EX | LOCK_NB)
        except OSError:
            raise MigrationError("output is locked by another export") from None
        # Closing the descriptor releases the lock, including after interruption.
        yield


def is_digest(value):
    return isinstance(value, str) and DIGEST.fullmatch(value) is not None


def load_manifest(path):
    try:
        manifest = strict_json(path.read_text(encoding="utf-8"))
    except UnicodeError:
        manifest = None
    if not isinstance(manifest, dict) or (
        manifest.get("format") != "klaxon-legacy-manifest"
        or type(manifest.get("version")) is not int
        or manifest["version"] != FORMAT_VERSION
        or type(manifest.get("sourceSchemaVersion")) is not int
        or manifest["sourceSchemaVersion"] != SCHEMA_VERSION
        or manifest.get("status") not in ("writing", "complete")
    ):
        raise MigrationError("invalid or unsupported migration manifest")
    artifacts = manifest.get("artifacts")
    sources = manifest.get("sources")
    if (not isinstance(artifacts, dict) or set(artifacts) != set(ARTIFACTS)
            or not all(is_digest(value) for value in artifacts.values())
            or not isinstance(sources, dict) or not sources
            or not all(ORIGIN.fullmatch(origin) and isinstance(summary, dict) and is_digest(summary.get("sha256"))
                       for origin, summary in sources.items())):
        raise MigrationError("invalid migration manifest checksums")
    return manifest


def check_artifact(path, expected):
    if digest_file(path) != expected:
        raise MigrationError(f"checksum mismatch for {path.name}")


def verify_export(output):
    path = checked_file(output / MANIFEST_NAME)
    if not path.exists():
        raise MigrationError("migration manifest is missing")
    manifest = load_manifest(path)
    if manifest["status"] != "complete":
        raise MigrationError("migration export is incomplete")
    for name, digest in manifest["artifacts"].items():
        artifact = checked_file(output / name)
        if not artifact.exists():
            raise MigrationError(f"missing migration artifact {name}")
        check_artifact(artifact, digest)
    return manifest


def source_paths(entries):
    sources = {}
    for entry in entries:
        origin, _, filename = entry.partition("=")
        if not ORIGIN.fullmatch(origin) or not filename:
            raise MigrationError("source must be a pseudonymous label and path (LABEL=PATH)")
        if origin in sources:
            raise MigrationError("source labels must be unique")
        try:
            path = Path(filename).resolve(strict=True)
            if not path.is_file():
                raise OSError
        except (OSError, ValueError):
            raise MigrationError(f"{origin}: source must be an existing SQLite file") from None
        if any(path.samefile(other) for other in sources.values()):
            raise MigrationError("give each source SQLite file a single label")
        sources[origin] = path
    return sources


def export(sources, output):
    snapshots = [read_snapshot(path, origin) for origin, path in sorted(sources.items())]
    projection, report = reconcile(snapshots)
    artifacts = {name: canonical(data) for name, data in zip(ARTIFACTS, (projection, report))}
    manifest = envelope("manifest", status="writing", sources={
        snapshot.origin: {"sha256": snapshot.sha256, "counts": snapshot.counts, "states": snapshot.states}
        for snapshot in snapshots
    }, artifacts={name: sha256(data) for name, data in artifacts.items()})

    output.mkdir(parents=True, exist_ok=True)
    with output_lock(output):
        path = checked_file(output / MANIFEST_NAME)
        paths = {name: checked_file(output / name) for name in ARTIFACTS}
        if path.exists():
            current = load_manifest(path)
            if current["sources"] != manifest["sources"]:
                raise MigrationError("source projections differ from the manifest; use a new output directory")
            if current["artifacts"] != manifest["artifacts"]:
                raise MigrationError("artifact hashes differ from the manifest; use a new output directory")
            if current["status"] == "complete":
                verify_export(output)
                return "already complete"
            for name, artifact in paths.items():
                if artifact.exists():
                    check_artifact(artifact, manifest["artifacts"][name])
        else:
            if any(artifact.exists() for artifact in paths.values()):
                raise MigrationError("output contains migration artifacts without a manifest")
            atomic_write(path, canonical(manifest))

        for name, artifact in paths.items():
            if not artifact.exists():
                atomic_write(artifact, artifacts[name])
        manifest["status"] = "complete"
        atomic_write(path, canonical(manifest))
        verify_export(output)
        return "complete"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    export_parser = subcommands.add_parser("export", help="extract and reconcile named SQLite sources")
    export_parser.add_argument("--source", action="append", metavar="LABEL=PATH", required=True)
    verify_parser = subcommands.add_parser("verify", help="verify a completed export's checksums")
    for command in (export_parser, verify_parser):
        command.add_argument("--output", type=Path, required=True, metavar="DIR")
    args = parser.parse_args(argv)
    try:
        output = args.output.resolve()
        if args.command == "verify":
            verify_export(output)
            print("Migration export checksums verified.")
        else:
            sources = source_paths(args.source)
            # Reject using an input under a reserved output name. A source can
            # otherwise live in the same directory as the portable artifacts.
            reserved = {output / name for name in (MANIFEST_NAME, *ARTIFACTS, ".export.lock")}
            if reserved.intersection(sources.values()):
                raise MigrationError("SQLite source conflicts with a reserved output filename")
            status = export(sources, output)
            print(f"Migration export {status}.")
    except MigrationError as error:
        print(f"Migration error: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"Migration error: local file operation failed (errno {error.errno})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
