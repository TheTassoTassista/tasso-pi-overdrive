#!/usr/bin/env python3
"""One-shot, read-only host process snapshot for the pinned OmniRoute quarantine.

Execute only after separate approval. Output contains metadata, never process argv,
environment, mapped bytes, file contents, or credentials. PASS is time-bounded.
"""

import errno
import json
import os
import stat
import sys
import time


QUARANTINE = "/opt/phi/omniroute/.incoming-3.8.50-bc71bbfe146958f9b9848a21"
EXPECTED_DEV = 36
EXPECTED_INO = 859869
EXPECTED_MOUNT_ID = 40
EXPECTED_ENTRIES = 20466
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def fail(reason):
    print(json.dumps({"HOST_PROCESS_SNAPSHOT": "UNKNOWN", "reason": reason}, sort_keys=True))
    return 2


def directory_fd(path):
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in path.strip("/").split("/"):
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def mount_id(fd):
    with open("/proc/self/fdinfo/" + str(fd), encoding="ascii") as stream:
        for line in stream:
            if line.startswith("mnt_id:"):
                return int(line.split()[1])
    raise RuntimeError("mount_id_unavailable")


def within(path, root=QUARANTINE):
    return path == root or path.startswith(root + "/")


def unescape_mount_path(value):
    for escaped, plain in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
        value = value.replace(escaped, plain)
    return value


def mount_references(lines):
    for line in lines:
        fields = line.split(" - ", 1)[0].split()
        if len(fields) < 5:
            raise RuntimeError("mountinfo_malformed")
        if within(unescape_mount_path(fields[3])) or within(unescape_mount_path(fields[4])):
            return True
    return False


def mount_alias_references(pid, lines, ids):
    device = str(os.major(EXPECTED_DEV)) + ":" + str(os.minor(EXPECTED_DEV))
    for line in lines:
        fields = line.split(" - ", 1)[0].split()
        if len(fields) < 5:
            raise RuntimeError("mountinfo_malformed")
        if fields[2] != device:
            continue
        mountpoint = unescape_mount_path(fields[4])
        if not mountpoint.startswith("/"):
            raise RuntimeError("mountpoint_malformed")
        item = os.stat("/proc/" + pid + "/root" + mountpoint)
        if (item.st_dev, item.st_ino) in ids:
            return True
    return False


def process_identity(pid):
    with open("/proc/" + pid + "/stat", encoding="utf-8", errors="replace") as stream:
        line = stream.read()
    after_comm = line.rsplit(")", 1)[1].split()
    return after_comm[19], after_comm[0]  # start ticks, state; argv/comm never emitted


def tree_inodes(root_fd):
    ids = set()
    mapped = set()
    for _path, dirs, files, fd in os.fwalk(".", topdown=True, follow_symlinks=False, dir_fd=root_fd):
        if mount_id(fd) != EXPECTED_MOUNT_ID:
            raise RuntimeError("nested_mount_id_mismatch")
        for name in (None, *dirs, *files):
            info = os.fstat(fd) if name is None else os.stat(name, dir_fd=fd, follow_symlinks=False)
            if info.st_dev != EXPECTED_DEV:
                raise RuntimeError("tree_device_mismatch")
            ids.add((info.st_dev, info.st_ino))
            mapped.add((os.major(info.st_dev), os.minor(info.st_dev), info.st_ino))
    if len(ids) != EXPECTED_ENTRIES:
        raise RuntimeError("tree_inode_count_mismatch")
    return ids, mapped


def inspect_process(pid, ids, mapped, attestor_fd=None):
    base = "/proc/" + pid
    start, state = process_identity(pid)
    if state == "Z":
        return start, [], None
    hits = []
    for label in ("cwd", "root", "exe"):
        try:
            item = os.stat(base + "/" + label)
        except FileNotFoundError:
            # A kernel thread may have no executable/cwd. Do not infer this for userspace.
            with open(base + "/status", encoding="utf-8", errors="replace") as status:
                kernel_thread = any(line.startswith("Kthread:") and line.split()[1] == "1" for line in status)
            if kernel_thread:
                continue
            raise RuntimeError("process_" + label + "_unavailable")
        if (item.st_dev, item.st_ino) in ids:
            hits.append(label)
    with os.scandir(base + "/fd") as entries:
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                item = os.stat(entry.path)
            except FileNotFoundError:
                raise RuntimeError("fd_changed_during_snapshot")
            # The pinned quarantine directory FD is held by this scanner itself.
            # Exempt only that exact descriptor in this exact process; every other
            # FD, including another read-only FD in this process, is still checked.
            if pid == str(os.getpid()) and attestor_fd is not None and entry.name == str(attestor_fd):
                continue
            indexed = (item.st_dev, item.st_ino) in ids
            stale_named = False
            if not indexed and item.st_dev == EXPECTED_DEV:
                target = os.readlink(entry.path).removesuffix(" (deleted)")
                stale_named = within(target)
            if not indexed and not stale_named:
                continue
            with open(base + "/fdinfo/" + entry.name, encoding="ascii") as info:
                flags = next((int(line.split()[1], 8) for line in info if line.startswith("flags:")), None)
            if flags is None:
                raise RuntimeError("fd_flags_unavailable")
            kind = "write_fd" if flags & os.O_ACCMODE else "read_fd"
            hits.append("stale_" + kind if stale_named else kind)
    with open(base + "/maps", encoding="utf-8", errors="replace") as maps:
        for line in maps:
            fields = line.split(None, 5)
            if len(fields) < 5:
                raise RuntimeError("maps_malformed")
            major, minor = (int(number, 16) for number in fields[3].split(":"))
            indexed = (major, minor, int(fields[4])) in mapped
            stale_named = len(fields) > 5 and within(fields[5].rstrip("\n").removesuffix(" (deleted)"))
            if indexed or stale_named:
                kind = "writable_map" if "w" in fields[1] else "read_map"
                hits.append("stale_" + kind if stale_named and not indexed else kind)
    with open(base + "/mountinfo", encoding="utf-8", errors="replace") as mounts:
        mount_lines = mounts.readlines()
        if mount_references(mount_lines) or mount_alias_references(pid, mount_lines, ids):
            hits.append("mount_reference")
    namespace = os.readlink(base + "/ns/mnt")
    final_start, _ = process_identity(pid)
    if final_start != start:
        raise RuntimeError("pid_reused_during_snapshot")
    return start, sorted(set(hits)), namespace


def main():
    if os.geteuid() != 0:
        return fail("approved_host_operator_required")
    started = time.time_ns()
    try:
        root_fd = directory_fd(QUARANTINE)
        try:
            before = os.fstat(root_fd)
            if not (stat.S_ISDIR(before.st_mode) and before.st_dev == EXPECTED_DEV and
                    before.st_ino == EXPECTED_INO and before.st_uid == 0 and before.st_gid == 0 and
                    stat.S_IMODE(before.st_mode) == 0o755 and mount_id(root_fd) == EXPECTED_MOUNT_ID):
                return fail("quarantine_identity_mismatch")
            with open("/proc/self/mountinfo", encoding="utf-8") as mounts:
                if mount_references(mounts):
                    return fail("unexpected_quarantine_submount")
            ids, mapped = tree_inodes(root_fd)  # metadata only; no payload bytes read
            seen = set()
            namespaces = set()
            hits = []
            unknown = []
            for pid in sorted(name for name in os.listdir("/proc") if name.isdigit()):
                try:
                    start, references, namespace = inspect_process(pid, ids, mapped, root_fd)
                except (FileNotFoundError, ProcessLookupError):
                    if os.path.exists("/proc/" + pid):
                        unknown.append("pid_" + pid + "_changed")
                    continue
                except (OSError, RuntimeError, ValueError, IndexError) as error:
                    unknown.append("pid_" + pid + "_" + (str(error) if isinstance(error, RuntimeError) else "unreadable"))
                    continue
                seen.add(pid)
                if namespace is not None:
                    namespaces.add(namespace)
                if references:
                    hits.append({"pid": int(pid), "startTicks": start, "kinds": references})
            final_ids, final_mapped = tree_inodes(root_fd)
            if final_ids != ids or final_mapped != mapped:
                return fail("quarantine_entries_changed_during_snapshot")
            after = os.fstat(root_fd)
            named_fd = directory_fd(QUARANTINE)
            try:
                named = os.fstat(named_fd)
                named_mount_id = mount_id(named_fd)
            finally:
                os.close(named_fd)
            identity = lambda item: (item.st_dev, item.st_ino, item.st_mode,
                                     item.st_uid, item.st_gid, item.st_ctime_ns)
            if (identity(after) != identity(before) or identity(named) != identity(before) or
                    mount_id(root_fd) != EXPECTED_MOUNT_ID or named_mount_id != EXPECTED_MOUNT_ID):
                return fail("quarantine_changed_during_snapshot")
            result = "UNKNOWN" if unknown else "IN_USE" if hits else "PASS"
            print(json.dumps({"HOST_PROCESS_SNAPSHOT": result, "quarantineDev": before.st_dev,
                              "quarantineIno": before.st_ino, "mountId": EXPECTED_MOUNT_ID,
                              "entriesIndexed": len(ids), "pidsChecked": len(seen),
                              "mountNamespacesSeen": len(namespaces), "hits": hits[:32],
                              "hitCount": len(hits), "unknown": unknown[:32],
                              "unknownCount": len(unknown), "startedNs": started,
                              "finishedNs": time.time_ns()}, sort_keys=True))
            return 0 if result == "PASS" else 1 if result == "IN_USE" else 2
        finally:
            os.close(root_fd)
    except (OSError, RuntimeError, ValueError, IndexError) as error:
        return fail(str(error) if isinstance(error, RuntimeError) else "host_snapshot_unavailable")


if __name__ == "__main__":
    sys.exit(main())
