#!/usr/bin/env python3
"""Development-only Phi release staging and single-reference activation (Linux)."""

import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid

RELEASE_ID = re.compile(r"^[0-9a-f]{40}$")
ACTIVE = "active"
MANIFEST = ".phi-release.json"
RENAME_NOREPLACE = 1


class InstallError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise InstallError(reason)


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_file(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def plain_private_dir(directory):
    value = Path(directory)
    require(value.is_absolute() and os.path.realpath(value) == str(value), "path_not_canonical")
    info = os.lstat(value)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "directory_untrusted")
    return info


def ensure_prefix(prefix):
    prefix = Path(prefix).absolute()
    require(os.path.realpath(prefix) == str(prefix), "prefix_symlink_rejected")
    if not prefix.exists():
        prefix.mkdir(mode=0o700)
    plain_private_dir(prefix)
    releases = prefix / "releases"
    if not releases.exists():
        releases.mkdir(mode=0o700)
        sync_dir(prefix)
    plain_private_dir(releases)
    require(os.stat(prefix).st_dev == os.stat(releases).st_dev, "release_filesystem_mismatch")
    return prefix


def tree_entries(root, frozen=False):
    root = Path(root)
    entries = {}
    for base, dirs, files in os.walk(root, topdown=True, followlinks=False):
        for name in sorted(dirs + files):
            item = Path(base) / name
            relative = item.relative_to(root).as_posix()
            if relative == MANIFEST:
                continue
            info = os.lstat(item)
            require(info.st_uid == os.getuid(), "release_owner_mismatch")
            if frozen and not stat.S_ISLNK(info.st_mode):
                require(info.st_mode & 0o222 == 0, "release_permissions_changed")
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(item)
                require(not os.path.isabs(target), "release_absolute_symlink")
                resolved = os.path.realpath(item)
                require(resolved.startswith(str(root) + os.sep) and os.path.exists(resolved),
                        "release_symlink_escape_or_broken")
                entries[relative] = {"type": "link", "target": target}
                dirs[:] = [entry for entry in dirs if entry != name]
            elif stat.S_ISDIR(info.st_mode):
                entries[relative] = {"type": "directory"}
            elif stat.S_ISREG(info.st_mode):
                require(info.st_nlink == 1, "release_hardlink_rejected")
                digest = hashlib.sha256()
                with open(item, "rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                entries[relative] = {"type": "file", "sha256": digest.hexdigest(),
                                     "executable": bool(info.st_mode & 0o111)}
            else:
                raise InstallError("release_special_file_rejected")
    return entries


def manifest_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_release(root, release_id, allow_writable_root=False):
    require(RELEASE_ID.fullmatch(release_id), "release_id_invalid")
    root = Path(root)
    info = os.lstat(root)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and
            (allow_writable_root or info.st_mode & 0o222 == 0),
            "release_root_untrusted")
    marker = root / MANIFEST
    marker_info = os.lstat(marker)
    require(stat.S_ISREG(marker_info.st_mode) and marker_info.st_nlink == 1 and
            marker_info.st_uid == os.getuid() and marker_info.st_mode & 0o222 == 0,
            "release_manifest_untrusted")
    with open(marker, "rb") as stream:
        raw = stream.read(16 * 1024 * 1024 + 1)
    require(len(raw) <= 16 * 1024 * 1024, "release_manifest_oversize")
    value = json.loads(raw)
    require(set(value) == {"version", "releaseId", "entries"} and value["version"] == 1 and
            value["releaseId"] == release_id and isinstance(value["entries"], dict), "release_manifest_invalid")
    require(tree_entries(root, frozen=True) == value["entries"], "release_contents_mismatch")
    return manifest_digest(value)


def active_id(prefix):
    link = Path(prefix) / ACTIVE
    if not os.path.lexists(link):
        return None
    require(stat.S_ISLNK(os.lstat(link).st_mode), "active_reference_not_link")
    target = os.readlink(link)
    require(target.startswith("releases/") and RELEASE_ID.fullmatch(target.removeprefix("releases/")),
            "active_reference_invalid")
    return target.removeprefix("releases/")


def write_json_atomic(parent, name, value):
    temporary = Path(parent) / f".{name}.{uuid.uuid4().hex}.tmp"
    payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            require(written > 0, "receipt_write_incomplete")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(temporary, Path(parent) / name)
    sync_dir(parent)


def no_replace_rename(parent, old, new):
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        result = libc.renameat2(fd, os.fsencode(old), fd, os.fsencode(new), RENAME_NOREPLACE)
        if result != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
    finally:
        os.close(fd)


def write_reference(prefix, release_id, fault=None):
    temporary = Path(prefix) / f".active-{uuid.uuid4().hex}"
    os.symlink(f"releases/{release_id}", temporary)
    sync_dir(prefix)
    if fault == "before_switch":
        raise InstallError("injected_before_switch")
    os.replace(temporary, Path(prefix) / ACTIVE)
    sync_dir(prefix)
    if fault == "after_switch":
        raise InstallError("injected_after_switch")


def receipt(prefix):
    file = Path(prefix) / "transition.json"
    if not os.path.lexists(file):
        return None
    info = os.lstat(file)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and
            info.st_mode & 0o077 == 0, "receipt_untrusted")
    with open(file, "rb") as stream:
        raw = stream.read(64 * 1024 + 1)
    require(len(raw) <= 64 * 1024, "receipt_oversize")
    value = json.loads(raw)
    require(set(value) == {"version", "state", "from", "to", "fromDigest", "toDigest"} and
            value["version"] == 1 and value["state"] in ("INTENT", "OBSERVED"), "receipt_invalid")
    return value


def diagnose(prefix):
    prefix = Path(prefix).absolute()
    plain_private_dir(prefix)
    plain_private_dir(prefix / "releases")
    allowed = {"releases", ACTIVE, "transition.json", "install.lock"}
    for item in prefix.iterdir():
        require(item.name in allowed or item.name.startswith(".stage-") or
                item.name.startswith(".active-") or item.name.startswith(".transition.json."),
                "unexpected_install_entry")
    lock_path = prefix / "install.lock"
    if os.path.lexists(lock_path):
        lock_info = os.lstat(lock_path)
        require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == os.getuid() and
                lock_info.st_nlink == 1 and lock_info.st_mode & 0o077 == 0, "install_lock_untrusted")
    active = active_id(prefix)
    record = receipt(prefix)
    versions = {}
    for item in sorted((prefix / "releases").iterdir()):
        require(RELEASE_ID.fullmatch(item.name), "unknown_release_entry")
        try:
            versions[item.name] = {"status": "PASS", "digest": verify_release(item, item.name)}
        except Exception:
            versions[item.name] = {"status": "FAIL"}
    if active is not None:
        require(versions.get(active, {}).get("status") == "PASS", "active_release_invalid")
    state = "STABLE"
    if record:
        require(versions.get(record["to"], {}).get("digest") == record["toDigest"],
                "receipt_candidate_mismatch")
        if record["from"] is not None:
            require(versions.get(record["from"], {}).get("digest") == record["fromDigest"],
                    "receipt_previous_mismatch")
        if record["state"] == "OBSERVED":
            require(active == record["to"], "observed_reference_mismatch")
        elif active == record["from"]:
            state = "INTENT_BEFORE_SWITCH"
        elif active == record["to"]:
            state = "SWITCHED_UNCONFIRMED"
        else:
            raise InstallError("ambiguous_transition")
    temporary = list(prefix.glob(".active-*")) + list(prefix.glob(".transition.json.*.tmp"))
    if temporary and state == "STABLE":
        state = "TEMPORARY_ARTIFACTS"
    return {"status": "PASS", "state": state, "active": active,
            "releases": versions, "stagingCount": len(list(prefix.glob(".stage-*"))),
            "temporaryCount": len(temporary), "lockPresent": os.path.lexists(lock_path)}


def stage_release(prefix, repository, release_id, fault=None):
    require(RELEASE_ID.fullmatch(release_id), "release_id_invalid")
    require(subprocess.run(["git", "-C", repository, "cat-file", "-t", release_id],
                           capture_output=True, check=True).stdout.strip() == b"commit", "commit_invalid")
    tracked = subprocess.run(["git", "-C", repository, "ls-tree", "-r", "-z", release_id],
                             capture_output=True, check=True).stdout
    require(all(not row.startswith(b"120000 ") for row in tracked.split(b"\0") if row),
            "tracked_symlink_rejected")
    stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=prefix))
    archive = subprocess.run(["git", "-C", repository, "archive", "--format=tar", release_id],
                             capture_output=True, check=True).stdout
    with tarfile.open(fileobj=__import__("io").BytesIO(archive), mode="r:") as package:
        for member in package.getmembers():
            relative = Path(member.name)
            require(not relative.is_absolute() and ".." not in relative.parts and
                    (member.isfile() or member.isdir()) and not member.islnk() and not member.issym(),
                    "archive_entry_rejected")
        package.extractall(stage, filter="data")
    require((stage / "package.json").is_file() and (stage / "bin" / "phi.mjs").is_file(),
            "phi_runtime_missing")
    mcp = stage / "runtime" / "mcp"
    if mcp.exists():
        subprocess.run(["npm", "ci", "--prefix", str(mcp), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                       check=True, stdout=subprocess.DEVNULL)
    if fault == "staging":
        raise InstallError("injected_staging")
    entries = tree_entries(stage)
    value = {"version": 1, "releaseId": release_id, "entries": entries}
    (stage / MANIFEST).write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    for base, dirs, files in os.walk(stage, topdown=False, followlinks=False):
        for name in files:
            item = Path(base) / name
            if not item.is_symlink():
                mode = os.lstat(item).st_mode
                os.chmod(item, 0o555 if mode & 0o111 else 0o444)
                sync_file(item)
        for name in dirs:
            item = Path(base) / name
            if not item.is_symlink():
                os.chmod(item, 0o555)
                sync_dir(item)
    sync_dir(stage)
    digest = verify_release(stage, release_id, allow_writable_root=True)
    releases = Path(prefix) / "releases"
    no_replace_rename(prefix, stage.name, f"releases/{release_id}")
    os.chmod(releases / release_id, 0o555)
    sync_dir(releases / release_id)
    sync_dir(releases)
    sync_dir(prefix)
    require(verify_release(releases / release_id, release_id) == digest, "published_release_invalid")
    return digest


def transact(prefix, action, repository=None, release_id=None, fault=None):
    prefix = ensure_prefix(prefix)
    lock = prefix / "install.lock"
    lock_fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock_fd)
        require(info.st_uid == os.getuid() and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                info.st_mode & 0o077 == 0, "install_lock_untrusted")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError("concurrent_installer") from error
        before = diagnose(prefix)
        require(before["state"] == "STABLE" and before["stagingCount"] == 0 and
                before["temporaryCount"] == 0,
                "recovery_required")
        previous = before["active"]
        if action == "install":
            require(repository is not None and release_id is not None, "install_arguments_missing")
            if release_id in before["releases"]:
                require(before["releases"][release_id]["status"] == "PASS", "existing_release_invalid")
                digest = before["releases"][release_id]["digest"]
            else:
                digest = stage_release(prefix, repository, release_id, fault)
            if previous == release_id:
                return {"status": "PASS", "action": "REINSTALLED", "active": previous}
            to_id = release_id
            to_digest = digest
        elif action == "rollback":
            old = receipt(prefix)
            require(old and old["state"] == "OBSERVED" and old["to"] == previous and old["from"] is not None,
                    "rollback_not_bounded")
            to_id = old["from"]
            to_digest = verify_release(prefix / "releases" / to_id, to_id)
        else:
            raise InstallError("action_invalid")
        from_digest = verify_release(prefix / "releases" / previous, previous) if previous else None
        record = {"version": 1, "state": "INTENT", "from": previous, "to": to_id,
                  "fromDigest": from_digest, "toDigest": to_digest}
        write_json_atomic(prefix, "transition.json", record)
        write_reference(prefix, to_id, fault)
        require(active_id(prefix) == to_id and verify_release(prefix / "releases" / to_id, to_id) == to_digest,
                "post_switch_mismatch")
        record["state"] = "OBSERVED"
        write_json_atomic(prefix, "transition.json", record)
        return {"status": "PASS", "action": "ACTIVATED" if action == "install" else "ROLLED_BACK",
                "active": to_id, "previous": previous}
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["install", "rollback", "inspect"])
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--repository")
    parser.add_argument("--release-id")
    args = parser.parse_args()
    try:
        result = diagnose(args.prefix) if args.action == "inspect" else transact(
            args.prefix, args.action, args.repository, args.release_id)
        print(json.dumps(result, sort_keys=True))
    except (InstallError, OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        reason = str(error) if isinstance(error, InstallError) else "filesystem_or_dependency_failure"
        print(json.dumps({"status": "FAIL_CLOSED", "reason": reason}, sort_keys=True))
        sys.exit(1)


if __name__ == "__main__":
    main()
