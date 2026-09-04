#!/usr/bin/env python3
"""Stage and archive one explicit HTMLTrust native artifact bundle.

This helper intentionally uses only the Python standard library. Build scripts
perform compilation and pass the resulting files here; this module owns the
portable manifest and deterministic archive layout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import time
import zipfile
from pathlib import Path


def command_output(command: list[str]) -> str | None:
    try:
        return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def git_metadata(root: Path) -> dict[str, object]:
    revision = command_output(["git", "-C", str(root), "rev-parse", "HEAD"])
    dirty = bool(command_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"]))
    timestamp = command_output(["git", "-C", str(root), "show", "-s", "--format=%ct", "HEAD"])
    try:
        source_date_epoch = int(os.environ.get("SOURCE_DATE_EPOCH", timestamp or "0"))
    except ValueError:
        source_date_epoch = 0
    return {
        "revision": revision or "unknown",
        "dirty": dirty,
        "source_date_epoch": source_date_epoch,
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_required(source: str, destination: Path) -> Path:
    path = Path(source).resolve()
    if not path.is_file():
        raise SystemExit(f"artifact input is missing: {path}")
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / path.name
    shutil.copy2(path, target)
    return target


def archive_timestamp(epoch: int) -> tuple[int, int, int, int, int, int]:
    # ZIP timestamps cannot represent dates before 1980.
    value = max(epoch, 315532800)
    return time.gmtime(value)[:6]


def make_tar_gz(stage: Path, archive: Path, epoch: int) -> None:
    import gzip

    archive.parent.mkdir(parents=True, exist_ok=True)
    with archive.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", mtime=max(epoch, 0), filename="") as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as bundle:
                for source in sorted(stage.rglob("*")):
                    if not source.is_file():
                        continue
                    relative = source.relative_to(stage).as_posix()
                    info = bundle.gettarinfo(str(source), arcname=relative)
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    info.mtime = max(epoch, 0)
                    with source.open("rb") as stream:
                        bundle.addfile(info, stream)


def make_zip(stage: Path, archive: Path, epoch: int) -> None:
    archive.parent.mkdir(parents=True, exist_ok=True)
    timestamp = archive_timestamp(epoch)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for source in sorted(stage.rglob("*")):
            if not source.is_file():
                continue
            relative = source.relative_to(stage).as_posix()
            info = zipfile.ZipInfo(relative, timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o644 & 0xFFFF) << 16
            with source.open("rb") as stream:
                bundle.writestr(info, stream.read())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--abi-version", required=True, type=int)
    parser.add_argument("--target", required=True)
    parser.add_argument("--format", choices=("tar.gz", "zip"), required=True)
    parser.add_argument("--dynamic", required=True)
    parser.add_argument("--static", required=True)
    parser.add_argument("--import", dest="import_library")
    parser.add_argument("--header", required=True)
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", args.name):
        raise SystemExit("name contains unsupported path characters")
    if not args.root.is_absolute() or not args.output_root.is_absolute():
        raise SystemExit("root and output-root must be absolute paths")
    if args.abi_version < 1:
        raise SystemExit("abi-version must be a positive integer")

    root = args.root.resolve()
    output_root = args.output_root.resolve()
    if not root.is_dir():
        raise SystemExit("root must resolve to a directory")
    output_root.mkdir(parents=True, exist_ok=True)

    stage = output_root / ".staging" / args.name
    archive = output_root / f"{args.name}.{'tar.gz' if args.format == 'tar.gz' else 'zip'}"
    sidecar = output_root / f"{args.name}.manifest.json"
    checksum = output_root / f"{args.name}.sha256"
    if stage.exists():
        shutil.rmtree(stage)
    for path in (archive, sidecar, checksum):
        path.unlink(missing_ok=True)

    files: list[tuple[Path, str]] = []
    files.append((copy_required(args.dynamic, stage / "lib"), "shared-library"))
    files.append((copy_required(args.static, stage / "lib"), "static-library"))
    if args.import_library:
        files.append((copy_required(args.import_library, stage / "lib"), "import-library"))
    files.append((copy_required(args.header, stage / "include"), "c-header"))
    license_path = root / "LICENSE"
    files.append((copy_required(str(license_path), stage), "license"))

    source = git_metadata(root)
    epoch = int(source["source_date_epoch"])
    manifest = {
        "schema": 1,
        "artifact": args.name,
        "package_version": args.version,
        "abi_version": args.abi_version,
        "target": args.target,
        "source": source,
        "toolchain": {
            "rustc": command_output(["rustc", "-Vv"]),
            "cargo": command_output(["cargo", "-V"]),
            "host_os": platform.system().lower(),
            "host_arch": platform.machine().lower(),
        },
        "files": [],
    }
    for path, kind in sorted(files, key=lambda entry: entry[0].relative_to(stage).as_posix()):
        relative = path.relative_to(stage).as_posix()
        manifest["files"].append({
            "path": relative,
            "kind": kind,
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })
    manifest_path = stage / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if args.format == "tar.gz":
        make_tar_gz(stage, archive, epoch)
    else:
        make_zip(stage, archive, epoch)
    archive_digest = sha256(archive)
    manifest["archive"] = {
        "path": archive.name,
        "bytes": archive.stat().st_size,
        "sha256": archive_digest,
    }
    sidecar.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    checksum.write_text(f"{archive_digest}  {archive.name}\n", encoding="ascii")
    shutil.rmtree(stage)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
