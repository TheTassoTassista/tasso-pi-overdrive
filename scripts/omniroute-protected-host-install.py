#!/usr/bin/env python3
"""One-version OmniRoute host install. Never run install without host approval.

Usage: python3 -I scripts/omniroute-protected-host-install.py check
       python3 -I /root/<approved-pinned-copy>.py install
       python3 -I /root/<approved-pinned-copy>.py verify-installed

The operator must pin/check this script's SHA-256 before executing its root copy.
No service, Phi launcher, Pi registry, credential or core-dump operation is here.
"""

import ctypes
import errno
import hashlib
import json
import os
import posixpath
import pwd
import secrets
import stat
import sys


SOURCE = "/home/tasso/.local/share/phi/omni-derived-stage-bsuvLtRA"
MANIFEST_NAME = "derived-integrity-manifest.json"
PAYLOAD_NAME = "squashfs-root"
ASSET = "/opt/omniroute-bin/OmniRoute.AppImage"
PARENT = "/opt/phi/omniroute"
VERSION = "3.8.50"
SIDECAR = ".manifest-3.8.50.json"
MANIFEST_SHA256 = "cefef41509e534c51f1ef173c9fd25753fa1c86975b148829a6232ca4b9fcb9b"
SOURCE_MANIFEST_SHA256 = "06c927c48e456beccf64f2d0bf5f73f85359d4e87cd3063ecd0c07f7c7f719b8"
ASSET_SHA256 = "96099e33c899940ce5fd606064415c79c32d4fd75f7b58a23c640ea769347b71"
ASSET_SIZE = 341498993
REMOVED_LINK = "resources/app/node_modules/global-agent/node_modules/.bin/semver"
REMOVED_TARGET = "/home/runner/work/OmniRoute/OmniRoute/node_modules/global-agent/node_modules/semver/bin/semver.js"
SYMLINKS = {
    ".DirIcon": "usr/share/icons/hicolor/512x512/apps/omniroute-desktop.png",
    "omniroute-desktop.png": "usr/share/icons/hicolor/512x512/apps/omniroute-desktop.png",
}
FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
DIR_FLAGS = FLAGS | os.O_DIRECTORY


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def open_dir_chain(absolute):
    """Pin each directory component without following a user-swappable parent."""
    require(absolute.startswith("/") and absolute != "/", "invalid directory path")
    fd = os.open("/", DIR_FLAGS)
    try:
        for component in absolute.split("/")[1:]:
            require(component not in ("", ".", ".."), "unsafe directory component")
            next_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def hash_file(fd, copy_fd=None):
    digest = hashlib.sha256()
    length = 0
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        length += len(chunk)
        if copy_fd is not None:
            remaining = memoryview(chunk)
            while remaining:
                written = os.write(copy_fd, remaining)
                require(written > 0, "short write to protected staging")
                remaining = remaining[written:]
    return digest.hexdigest(), length


def stat_identity(before, after):
    return all(getattr(before, key) == getattr(after, key) for key in
               ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns"))


def read_pinned_file(parent_fd, name, expected_hash, max_size):
    fd = os.open(name, FLAGS | os.O_NONBLOCK, dir_fd=parent_fd)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= max_size,
                "unsafe pinned file: " + name)
        data = bytearray()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            require(len(data) <= max_size, "pinned file grew: " + name)
        require(stat_identity(before, os.fstat(fd)), "pinned file changed during read: " + name)
        require(hashlib.sha256(data).hexdigest() == expected_hash, "pinned digest mismatch: " + name)
        return bytes(data)
    finally:
        os.close(fd)


def verify_asset():
    parent_fd = open_dir_chain(posixpath.dirname(ASSET))
    try:
        for ancestor in ("/opt", posixpath.dirname(ASSET)):
            ancestor_fd = open_dir_chain(ancestor)
            try:
                ancestor_stat = os.fstat(ancestor_fd)
                require(ancestor_stat.st_uid == 0 and ancestor_stat.st_gid == 0 and
                        not (ancestor_stat.st_mode & 0o022) and
                        not any(name.startswith("system.posix_acl_") for name in os.listxattr(ancestor_fd)),
                        "unsafe original asset ancestor: " + ancestor)
            finally:
                os.close(ancestor_fd)
        fd = os.open(posixpath.basename(ASSET), FLAGS | os.O_NONBLOCK, dir_fd=parent_fd)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0 and
                    stat.S_IMODE(before.st_mode) == 0o755 and
                    before.st_nlink == 1 and before.st_size == ASSET_SIZE,
                    "original AppImage identity/size mismatch")
            digest, length = hash_file(fd)
            require(stat_identity(before, os.fstat(fd)) and length == ASSET_SIZE and
                    digest == ASSET_SHA256, "original AppImage changed or hash mismatch")
        finally:
            os.close(fd)
    finally:
        os.close(parent_fd)


def parse_manifest(raw):
    manifest = json.loads(raw)
    require(manifest.get("schema") == "phi-omniroute-derived-payload-v1" and
            manifest.get("version") == VERSION and
            manifest.get("assetSha256") == ASSET_SHA256 and
            manifest.get("assetSize") == ASSET_SIZE and
            manifest.get("sourceManifestSha256") == SOURCE_MANIFEST_SHA256 and
            manifest.get("violations") == [], "manifest identity/violations mismatch")
    derivation = manifest.get("derivation", {})
    require(derivation.get("decision") == "PHI-OMNIROUTE-DERIVED-PAYLOAD-001" and
            derivation.get("removedPath") == REMOVED_LINK and
            derivation.get("removedTarget") == REMOVED_TARGET, "derivation contract mismatch")
    require(manifest.get("counts") == {"directory": 3603, "file": 16861, "symlink": 2, "special": 0},
            "manifest counts mismatch")
    rows = {}
    children = {}
    for entry in manifest["entries"]:
        rel = entry["path"]
        require(isinstance(rel, str) and rel not in rows and
                (rel == "." or (not rel.startswith("/") and
                                    posixpath.normpath(rel) == rel and
                                    all(part not in ("", ".", "..") for part in rel.split("/")))) and
                "\x00" not in rel, "duplicate/unsafe manifest path")
        kind = entry["type"]
        require(kind in ("directory", "file", "symlink") and entry.get("expectedOwner") == "root:root",
                "unsafe manifest entry")
        source_mode = {"directory": "0700", "file": entry.get("expectedMode"), "symlink": "0777"}[kind]
        require(entry.get("sourceMode") == source_mode, "source mode mismatch: " + rel)
        if kind == "directory":
            require(entry.get("expectedMode") == "0755", "target directory mode mismatch")
        elif kind == "file":
            require(entry.get("expectedMode") in ("0644", "0755") and
                    isinstance(entry.get("size"), int) and entry["size"] >= 0 and
                    isinstance(entry.get("sha256"), str) and len(entry["sha256"]) == 64,
                    "invalid file contract: " + rel)
        else:
            require(rel in SYMLINKS and entry.get("target") == SYMLINKS[rel] and
                    entry.get("internal") is True and entry.get("resolves") is True,
                    "untrusted symlink: " + rel)
        rows[rel] = entry
        if rel != ".":
            parent = posixpath.dirname(rel) or "."
            children.setdefault(parent, set()).add(posixpath.basename(rel))
    require(len(rows) == 20466 and rows.get(".", {}).get("type") == "directory" and
            REMOVED_LINK not in rows and
            {p: e["target"] for p, e in rows.items() if e["type"] == "symlink"} == SYMLINKS,
            "manifest tree/delta mismatch")
    for parent in children:
        require(parent in rows and rows[parent]["type"] == "directory", "missing parent directory")
    for rel, target in SYMLINKS.items():
        destination = posixpath.normpath(posixpath.join(posixpath.dirname(rel), target))
        require(destination in rows and rows[destination]["type"] == "file",
                "unresolved symlink in manifest")
    return rows, children


def verify_or_copy_tree(root_fd, rows, children, expected_uid, expected_gid, target=False, copy_root_fd=None):
    def walk(source_fd, rel, dest_fd):
        current = rows[rel]
        st = os.fstat(source_fd)
        mode = int(current["expectedMode" if target else "sourceMode"], 8)
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == expected_uid and st.st_gid == expected_gid and
                stat.S_IMODE(st.st_mode) == mode and not (st.st_mode & 0o6000),
                "directory identity/mode mismatch: " + rel)
        wanted = children.get(rel, set())
        actual = set(os.listdir(source_fd))
        if actual != wanted:
            raise RuntimeError("directory children mismatch: " + rel +
                               " missing=" + repr(sorted(wanted - actual)) +
                               " added=" + repr(sorted(actual - wanted)))
        for name in sorted(wanted):
            child = name if rel == "." else rel + "/" + name
            entry = rows[child]
            before = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            require(before.st_uid == expected_uid and before.st_gid == expected_gid and
                    not (before.st_mode & 0o6000),
                    "owner/privilege mismatch: " + child)
            expected_mode = int(entry["expectedMode" if target else "sourceMode"], 8) if entry["type"] != "symlink" else None
            if entry["type"] == "directory":
                require(stat.S_ISDIR(before.st_mode) and stat.S_IMODE(before.st_mode) == expected_mode,
                        "directory type/mode mismatch: " + child)
                source_child = os.open(name, DIR_FLAGS, dir_fd=source_fd)
                try:
                    require(stat_identity(before, os.fstat(source_child)), "directory replaced: " + child)
                    if dest_fd is not None:
                        os.mkdir(name, 0o700, dir_fd=dest_fd)
                        dest_child = os.open(name, DIR_FLAGS, dir_fd=dest_fd)
                    else:
                        dest_child = None
                    try:
                        walk(source_child, child, dest_child)
                        if dest_child is not None:
                            os.fchown(dest_child, 0, 0)
                            os.fchmod(dest_child, 0o755)
                            os.fsync(dest_child)
                    finally:
                        if dest_child is not None:
                            os.close(dest_child)
                finally:
                    os.close(source_child)
            elif entry["type"] == "file":
                require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                        stat.S_IMODE(before.st_mode) == expected_mode and before.st_size == entry["size"],
                        "file type/mode/size mismatch: " + child)
                source_child = os.open(name, FLAGS | os.O_NONBLOCK, dir_fd=source_fd)
                try:
                    require(stat_identity(before, os.fstat(source_child)), "file replaced: " + child)
                    if dest_fd is not None:
                        dest_child = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                             0o600, dir_fd=dest_fd)
                    else:
                        dest_child = None
                    try:
                        digest, length = hash_file(source_child, dest_child)
                        require(digest == entry["sha256"] and length == entry["size"] and
                                stat_identity(before, os.fstat(source_child)), "file changed/hash mismatch: " + child)
                        if dest_child is not None:
                            os.fchown(dest_child, 0, 0)
                            os.fchmod(dest_child, int(entry["expectedMode"], 8))
                            os.fsync(dest_child)
                    finally:
                        if dest_child is not None:
                            os.close(dest_child)
                finally:
                    os.close(source_child)
            else:
                require(stat.S_ISLNK(before.st_mode) and before.st_nlink == 1 and
                        os.readlink(name, dir_fd=source_fd) == entry["target"],
                        "symlink mismatch: " + child)
                if dest_fd is not None:
                    os.symlink(entry["target"], name, dir_fd=dest_fd)
                    os.chown(name, 0, 0, dir_fd=dest_fd, follow_symlinks=False)
            require(stat_identity(before, os.stat(name, dir_fd=source_fd, follow_symlinks=False)),
                    "source changed during scan: " + child)
        actual = set(os.listdir(source_fd))
        if actual != wanted:
            raise RuntimeError("directory changed during scan: " + rel +
                               " missing=" + repr(sorted(wanted - actual)) +
                               " added=" + repr(sorted(actual - wanted)))
    walk(root_fd, ".", copy_root_fd)


def root_parent():
    fd = open_dir_chain("/opt")
    try:
        for component in ("phi", "omniroute"):
            st = os.fstat(fd)
            require(st.st_uid == 0 and st.st_gid == 0 and stat.S_ISDIR(st.st_mode) and
                    not (st.st_mode & 0o022),
                    "unsafe target ancestor")
            require(not any(name.startswith("system.posix_acl_") for name in os.listxattr(fd)),
                    "target ancestor has an ACL")
            try:
                child = os.open(component, DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(component, 0o755, dir_fd=fd)
                os.fsync(fd)
                child = os.open(component, DIR_FLAGS, dir_fd=fd)
                os.fchown(child, 0, 0)
                os.fchmod(child, 0o755)
            os.close(fd)
            fd = child
        st = os.fstat(fd)
        require(st.st_uid == 0 and st.st_gid == 0 and stat.S_ISDIR(st.st_mode) and
                not (st.st_mode & 0o022),
                "unsafe target parent")
        require(not any(name.startswith("system.posix_acl_") for name in os.listxattr(fd)),
                "target parent has an ACL")
        for name in (VERSION, SIDECAR):
            try:
                os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise RuntimeError("target or sidecar already exists: " + name)
        return fd
    except BaseException:
        os.close(fd)
        raise


def verify_installed():
    for ancestor in ("/opt", "/opt/phi", PARENT):
        fd = open_dir_chain(ancestor)
        try:
            st = os.fstat(fd)
            require(st.st_uid == 0 and st.st_gid == 0 and stat.S_ISDIR(st.st_mode) and
                    not (st.st_mode & 0o022) and
                    not any(name.startswith("system.posix_acl_") for name in os.listxattr(fd)),
                    "unsafe installed ancestor: " + ancestor)
        finally:
            os.close(fd)
    parent_fd = open_dir_chain(PARENT)
    try:
        sidecar_stat = os.stat(SIDECAR, dir_fd=parent_fd, follow_symlinks=False)
        require(stat.S_ISREG(sidecar_stat.st_mode) and sidecar_stat.st_uid == 0 and
                sidecar_stat.st_gid == 0 and
                stat.S_IMODE(sidecar_stat.st_mode) == 0o600,
                "installed sidecar owner/mode mismatch")
        raw = read_pinned_file(parent_fd, SIDECAR, MANIFEST_SHA256, 8 * 1024 * 1024)
        rows, children = parse_manifest(raw)
        target_fd = os.open(VERSION, DIR_FLAGS, dir_fd=parent_fd)
        try:
            verify_or_copy_tree(target_fd, rows, children, 0, 0, target=True)
        finally:
            os.close(target_fd)
    finally:
        os.close(parent_fd)
    print("VERIFY_INSTALLED_PASS " + PARENT + "/" + VERSION)


def no_replace_rename(parent_fd, old, new):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    renameat2.restype = ctypes.c_int
    if renameat2(parent_fd, old.encode(), parent_fd, new.encode(), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), new)


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in ("check", "install", "verify-installed"),
            "usage: check|install|verify-installed")
    mode = sys.argv[1]
    if mode in ("install", "verify-installed"):
        require(os.geteuid() == 0, "host operation requires separately approved root operator")
    if mode == "verify-installed":
        verify_asset()
        verify_installed()
        return
    if mode == "install":
        require(hasattr(ctypes.CDLL(None), "renameat2"), "renameat2 NOREPLACE unavailable")
    os.umask(0o077)
    source_parent_fd = open_dir_chain(SOURCE)
    try:
        source_user = pwd.getpwnam("tasso")
        source_uid, source_gid = source_user.pw_uid, source_user.pw_gid
        require(os.fstat(source_parent_fd).st_uid == source_uid and
                os.fstat(source_parent_fd).st_gid == source_gid and
                stat.S_IMODE(os.fstat(source_parent_fd).st_mode) == 0o700,
                "untrusted source stage owner/mode")
        manifest_stat = os.stat(MANIFEST_NAME, dir_fd=source_parent_fd, follow_symlinks=False)
        require(manifest_stat.st_uid == source_uid and manifest_stat.st_gid == source_gid and
                stat.S_ISREG(manifest_stat.st_mode) and
                stat.S_IMODE(manifest_stat.st_mode) == 0o600,
                "untrusted source manifest owner/mode")
        raw = read_pinned_file(source_parent_fd, MANIFEST_NAME, MANIFEST_SHA256, 8 * 1024 * 1024)
        rows, children = parse_manifest(raw)
        verify_asset()
        source_root_fd = os.open(PAYLOAD_NAME, DIR_FLAGS, dir_fd=source_parent_fd)
        try:
            verify_or_copy_tree(source_root_fd, rows, children, source_uid, source_gid)
            if mode == "check":
                print("CHECK_PASS asset, manifest, complete source tree; no writes")
                return
            parent_fd = root_parent()
            try:
                quarantine = ".incoming-3.8.50-" + secrets.token_hex(12)
                os.mkdir(quarantine, 0o700, dir_fd=parent_fd)
                print("ROOT_QUARANTINE=" + PARENT + "/" + quarantine, flush=True)
                dest_fd = os.open(quarantine, DIR_FLAGS, dir_fd=parent_fd)
                try:
                    verify_or_copy_tree(source_root_fd, rows, children, source_uid, source_gid,
                                        copy_root_fd=dest_fd)
                    os.fchown(dest_fd, 0, 0)
                    os.fchmod(dest_fd, 0o755)
                    os.fsync(dest_fd)
                    verify_or_copy_tree(dest_fd, rows, children, 0, 0, target=True)
                finally:
                    os.close(dest_fd)
                sidecar_fd = os.open(SIDECAR, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                     0o600, dir_fd=parent_fd)
                try:
                    os.fchown(sidecar_fd, 0, 0)
                    remaining = memoryview(raw)
                    while remaining:
                        written = os.write(sidecar_fd, remaining)
                        require(written > 0, "short write to protected manifest")
                        remaining = remaining[written:]
                    os.fsync(sidecar_fd)
                finally:
                    os.close(sidecar_fd)
                os.fsync(parent_fd)
                no_replace_rename(parent_fd, quarantine, VERSION)
                os.fsync(parent_fd)
                published_fd = os.open(VERSION, DIR_FLAGS, dir_fd=parent_fd)
                try:
                    verify_or_copy_tree(published_fd, rows, children, 0, 0, target=True)
                finally:
                    os.close(published_fd)
                verify_installed()
                print("INSTALL_PASS " + PARENT + "/" + VERSION + " (service/activation not changed)")
            finally:
                os.close(parent_fd)
        finally:
            os.close(source_root_fd)
    finally:
        os.close(source_parent_fd)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print("INSTALL_FAIL_CLOSED: " + str(error), file=sys.stderr)
        sys.exit(1)
