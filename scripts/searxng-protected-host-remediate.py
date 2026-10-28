#!/usr/bin/env python3
"""One-shot, exact-object SearXNG host candidate. Requires separate host approval.

`apply` copies the previously reviewed settings bytes into a protected, no-replace
target and creates one STOPPED Docker candidate. It never starts or deletes one.
`recover` only publishes an already-attested incoming tree, without creating or
starting a container. `create-candidate` only creates one STOPPED container from
the already-published, freshly attested tree. `status`, `inspect`, and
`inspect-staging` are read-only.
Any interrupted/ambiguous state requires manual disposition.
Run only from SHA-256-checked bytes in the host operator's terminal.
"""

import ctypes
import hashlib
import json
import os
import stat
import subprocess
import sys


SOURCE_PARTS = ("home", "tasso", ".local", "share", "pi-overdrive", "searxng", "config")
SOURCE_NAME = "settings.yml"
# st_dev is assigned to the mount and can change across boots. Pin the inode
# historically observed on /home, then require the live /home mount throughout
# the descriptor chain within each transaction.
SOURCE_INO = 2442310
SOURCE_UID_GID = (977, 977)
SOURCE_SHA256 = "4655b183b0aba92b5a9f60febb50d939ef6e8289b2ba657739c20bb148a2b31e"
CACHE_PARTS = SOURCE_PARTS[:-1] + ("data",)
CACHE_INO = 2442309
DAEMON_ID = "b64b0d52-95ab-4b1a-a971-5f09a4d6e36d"
ORIGINAL_ID = "9cd6dd06e03d1ae28161e72df26301f43d9167671e1c1e90646e87ba804ca6e3"
ORIGINAL_NAME = "pi-overdrive-searxng"
IMAGE_ID = "sha256:e084201aa606fafce2151c8dc2844c9c3309025e90fbe7163b4f5e5183e474f0"
CONFIG_SOURCE = "/home/tasso/.local/share/pi-overdrive/searxng/config"
CACHE_SOURCE = "/home/tasso/.local/share/pi-overdrive/searxng/data"
PARENT = "/opt/phi/searxng"
INCOMING = ".incoming-e084201aa606"
TARGET = "candidate-e084201aa606"
# The separately reported host PASS_SNAPSHOT authorizes preparation for these
# exact objects only. A changed mount/device or inode requires new host review.
RECOVERY_PARENT_ID = (36, 880620)
RECOVERY_INCOMING_ID = (36, 880621)
CANDIDATE = "phi-searxng-candidate-e084201aa606"
LABEL = "phi.searxng.protected-candidate"
LABEL_VALUE = SOURCE_SHA256
DOCKER = "/usr/bin/docker"
SOCKET = "/var/run/docker.sock"
CHILD_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
MAX_BYTES = 1_000_000


class GateError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise GateError(reason)


def same(before, after):
    return all(getattr(before, key) == getattr(after, key) for key in
               ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns"))


def open_chain(parts):
    """Keep all descriptors so a user-swappable ancestor cannot redirect reads."""
    opened = [os.open("/", DIR_FLAGS)]
    try:
        for part in parts:
            require(part not in ("", ".", "..") and "/" not in part, "path_component_invalid")
            opened.append(os.open(part, DIR_FLAGS, dir_fd=opened[-1]))
        return opened
    except BaseException:
        close_all(opened)
        raise


def close_all(opened):
    for fd in reversed(opened):
        os.close(fd)


def verify_chain(opened, parts):
    for index, part in enumerate(parts):
        pinned = os.fstat(opened[index + 1])
        named = os.stat(part, dir_fd=opened[index], follow_symlinks=False)
        require(stat.S_ISDIR(named.st_mode) and
                (pinned.st_dev, pinned.st_ino) == (named.st_dev, named.st_ino),
                "source_or_cache_path_replaced")
        named_fd = os.open(part, DIR_FLAGS, dir_fd=opened[index])
        try:
            require(mount_id(named_fd) == mount_id(opened[index + 1]) and
                    same(pinned, os.fstat(named_fd)), "source_or_cache_path_replaced")
        finally:
            os.close(named_fd)


def same_source_mount(opened):
    """Reject bind mounts and cross-device substitutions below the opened /home."""
    require(len(opened) >= 2, "source_mount_identity_unavailable")
    anchor = opened[1]
    anchor_dev, anchor_mount = os.fstat(anchor).st_dev, mount_id(anchor)
    return all(os.fstat(fd).st_dev == anchor_dev and mount_id(fd) == anchor_mount
               for fd in opened[1:])


def source_bytes():
    opened = open_chain(SOURCE_PARTS)
    try:
        parent = opened[-1]
        require(sorted(os.listdir(parent)) == [SOURCE_NAME], "source_entries_changed")
        fd = os.open(SOURCE_NAME, FILE_FLAGS, dir_fd=parent)
        opened.append(fd)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                before.st_ino == SOURCE_INO and
                (before.st_uid, before.st_gid) == SOURCE_UID_GID and
                stat.S_IMODE(before.st_mode) == 0o600 and before.st_size <= MAX_BYTES,
                "source_identity_changed")
        require(same_source_mount(opened), "source_mount_changed")
        data = bytearray()
        while len(data) <= MAX_BYTES:
            block = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        require(len(data) <= MAX_BYTES and same(before, os.fstat(fd)), "source_changed_during_read")
        require(hashlib.sha256(data).hexdigest() == SOURCE_SHA256, "source_digest_mismatch")
        named = os.stat(SOURCE_NAME, dir_fd=parent, follow_symlinks=False)
        require(same(before, named) and sorted(os.listdir(parent)) == [SOURCE_NAME],
                "source_path_replaced")
        named_fd = os.open(SOURCE_NAME, FILE_FLAGS, dir_fd=parent)
        try:
            require(mount_id(named_fd) == mount_id(fd) and
                    same(before, os.fstat(named_fd)), "source_path_replaced")
        finally:
            os.close(named_fd)
        verify_chain(opened[:-1], SOURCE_PARTS)
        return bytes(data)
    finally:
        close_all(opened)


def check_cache():
    opened = open_chain(CACHE_PARTS)
    try:
        item = os.fstat(opened[-1])
        require(stat.S_ISDIR(item.st_mode) and item.st_ino == CACHE_INO and
                (item.st_uid, item.st_gid) == SOURCE_UID_GID and
                stat.S_IMODE(item.st_mode) == 0o755, "cache_identity_changed")
        require(same_source_mount(opened), "cache_mount_changed")
        require(not os.listdir(opened[-1]), "cache_no_longer_empty")
        named = os.stat(CACHE_PARTS[-1], dir_fd=opened[-2], follow_symlinks=False)
        require(same(item, named), "cache_path_replaced")
        verify_chain(opened, CACHE_PARTS)
    finally:
        close_all(opened)


def docker(*args, missing_ok=False):
    allowed = (args == ("info", "--format", "{{json .ID}}") or
               args == ("container", "inspect", ORIGINAL_NAME) or
               args == ("image", "inspect", IMAGE_ID) or
               args == ("container", "inspect", CANDIDATE) or
               (args and args[0] == "create" and args == create_argv()))
    require(allowed, "docker_operation_forbidden")
    result = subprocess.run([DOCKER, "--host", "unix://" + SOCKET, *args],
                            capture_output=True, timeout=20, check=False,
                            env=CHILD_ENV)
    require(len(result.stdout) <= 2_000_000 and len(result.stderr) <= 8192,
            "docker_output_unbounded")
    if result.returncode:
        if missing_ok and b"No such" in result.stderr and result.returncode == 1:
            return None
        raise GateError("docker_read_or_create_failed")
    if args[0] == "create":
        value = result.stdout.decode("ascii", "strict").strip()
        require(len(value) == 64 and all(ch in "0123456789abcdef" for ch in value),
                "candidate_create_id_invalid")
        return value
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise GateError("docker_json_invalid") from error


def fixed_docker_state(expect_candidate_absent=True):
    sock = os.lstat(SOCKET)
    require(stat.S_ISSOCK(sock.st_mode) and sock.st_uid == 0 and not sock.st_mode & 0o002,
            "docker_socket_untrusted")
    daemon = docker("info", "--format", "{{json .ID}}")
    originals = docker("container", "inspect", ORIGINAL_NAME)
    images = docker("image", "inspect", IMAGE_ID)
    require(daemon == DAEMON_ID and isinstance(originals, list) and len(originals) == 1 and
            isinstance(images, list) and len(images) == 1, "docker_identity_unavailable")
    original, image = originals[0], images[0]
    require(original.get("Id") == ORIGINAL_ID and original.get("Name") == "/" + ORIGINAL_NAME and
            original.get("Image") == IMAGE_ID and image.get("Id") == IMAGE_ID and
            original.get("State", {}).get("Running") is False and
            original.get("State", {}).get("Pid") == 0, "original_identity_or_state_changed")
    mounts = original.get("Mounts")
    require(isinstance(mounts, list) and len(mounts) == 2 and
            all(isinstance(m, dict) and m.get("Type") == "bind" for m in mounts) and
            {(m.get("Source"), m.get("Destination"), m.get("RW")) for m in mounts} ==
            {(CONFIG_SOURCE, "/etc/searxng", True), (CACHE_SOURCE, "/var/cache/searxng", True)},
            "original_mounts_changed")
    host = original.get("HostConfig", {})
    require(host.get("PortBindings") == {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8888"}]} and
            host.get("NetworkMode") == "bridge" and host.get("Privileged") is False and
            not host.get("CapAdd") and (host.get("RestartPolicy") or {}).get("Name") in ("no", ""),
            "original_host_contract_changed")
    config, image_config = original.get("Config"), image.get("Config")
    require(isinstance(config, dict) and isinstance(image_config, dict) and
            environment_map(config.get("Env")) == environment_map(image_config.get("Env")) and
            len(config["Env"]) == 16 and
            "FORCE_OWNERSHIP" not in environment_map(image_config.get("Env")) and
            config.get("Entrypoint") == image_config.get("Entrypoint") ==
            ["/usr/local/searxng/entrypoint.sh"] and config.get("Cmd") == image_config.get("Cmd"),
            "original_image_config_changed")
    if expect_candidate_absent:
        require(docker("container", "inspect", CANDIDATE, missing_ok=True) is None,
                "candidate_already_exists")


def environment_map(entries):
    require(isinstance(entries, list) and len(entries) <= 128, "environment_shape_invalid")
    result = {}
    for entry in entries:
        require(isinstance(entry, str) and len(entry) <= 8192 and "=" in entry,
                "environment_shape_invalid")
        key, value = entry.split("=", 1)
        require(key and key not in result, "environment_key_ambiguous")
        result[key] = value
    return result


def create_argv():
    root = PARENT + "/" + TARGET
    return ("create", "--pull=never", "--name", CANDIDATE,
            "--label", LABEL + "=" + LABEL_VALUE, "--network", "bridge",
            "--publish", "127.0.0.1:8888:8080/tcp", "--user", "977:977",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--restart", "no", "--ulimit", "core=0:0", "--pids-limit", "64",
            "--memory", "512m", "--cpus", "1",
            "--mount", "type=bind,src=" + root + "/config,dst=/etc/searxng,readonly",
            "--mount", "type=bind,src=" + root + "/cache,dst=/var/cache/searxng",
            "--env", "FORCE_OWNERSHIP=false", IMAGE_ID)


def protected_opt_fd():
    opened = open_chain(("opt", "phi"))
    try:
        root = os.fstat(opened[0])
        require(root.st_uid == 0 and not root.st_mode & 0o022, "root_untrusted")
        for fd in opened[1:]:
            item = os.fstat(fd)
            require(stat.S_ISDIR(item.st_mode) and item.st_uid == item.st_gid == 0 and
                    not item.st_mode & 0o022 and
                    not any(name.startswith("system.posix_acl_") for name in os.listxattr(fd)),
                    "opt_ancestor_untrusted")
        return opened
    except BaseException:
        close_all(opened)
        raise


def no_entry(parent_fd, name):
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return True
    return False


def verify_acl(path, expected):
    require(path.startswith(PARENT + "/") or path == PARENT, "acl_path_invalid")
    result = subprocess.run(["/usr/bin/getfacl", "-ncp", path],
                            capture_output=True, timeout=8, check=False, env=CHILD_ENV)
    require(result.returncode == 0 and len(result.stdout) <= 4096, "acl_verify_unavailable")
    entries = {line for line in result.stdout.decode("ascii", "strict").splitlines() if line and not line.startswith("#")}
    want = ({"user::rwx", "user:977:--x", "group::---", "mask::--x", "other::---"}
            if expected == "traverse" else
            {"user::rw-", "user:977:r--", "group::---", "mask::r--", "other::---"})
    require(entries == want, "acl_unexpected")


def acl(path, expected):
    require(path.startswith(PARENT + "/") or path == PARENT, "acl_path_invalid")
    modify = "u:977:--x" if expected == "traverse" else "u:977:r--"
    result = subprocess.run(["/usr/bin/setfacl", "-m", modify, path],
                            capture_output=True, timeout=8, check=False, env=CHILD_ENV)
    require(result.returncode == 0, "acl_apply_failed")
    verify_acl(path, expected)


def fsync_dir(fd):
    os.fsync(fd)


def mount_id(fd):
    with open("/proc/self/fdinfo/" + str(fd), encoding="ascii") as stream:
        for line in stream:
            if line.startswith("mnt_id:"):
                return int(line.split()[1])
    raise GateError("mount_identity_unavailable")


def rename_noreplace(parent_fd, old, new):
    libc = ctypes.CDLL(None, use_errno=True)
    require(hasattr(libc, "renameat2"), "noreplace_unavailable")
    call = libc.renameat2
    call.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    call.restype = ctypes.c_int
    if call(parent_fd, old.encode(), parent_fd, new.encode(), 1) != 0:
        raise GateError("publication_noreplace_failed")


def stage_copy(parent_fd, data):
    require(no_entry(parent_fd, INCOMING) and no_entry(parent_fd, TARGET), "target_or_incoming_exists")
    os.mkdir(INCOMING, 0o700, dir_fd=parent_fd)
    fsync_dir(parent_fd)
    stage_fd = os.open(INCOMING, DIR_FLAGS, dir_fd=parent_fd)
    try:
        stage_stat = os.fstat(stage_fd)
        require(stage_stat.st_uid == stage_stat.st_gid == 0 and
                stat.S_IMODE(stage_stat.st_mode) == 0o700, "incoming_untrusted")
        stage_path = PARENT + "/" + INCOMING
        acl(stage_path, "traverse")
        os.mkdir("config", 0o700, dir_fd=stage_fd)
        os.mkdir("cache", 0o700, dir_fd=stage_fd)
        config_fd = os.open("config", DIR_FLAGS, dir_fd=stage_fd)
        cache_fd = os.open("cache", DIR_FLAGS, dir_fd=stage_fd)
        try:
            acl(stage_path + "/config", "traverse")
            settings_fd = os.open("settings.yml", os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                  os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=config_fd)
            try:
                with os.fdopen(settings_fd, "wb", closefd=False) as stream:
                    stream.write(data)
                    stream.flush()
                os.fsync(settings_fd)
            finally:
                os.close(settings_fd)
            acl(stage_path + "/config/settings.yml", "read")
            os.fchown(cache_fd, 977, 977)
            require(not os.listdir(cache_fd), "new_cache_not_empty")
            marker = {"schema": "phi-searxng-candidate-v1", "image": IMAGE_ID,
                      "original": ORIGINAL_ID, "sourceSha256": SOURCE_SHA256}
            fd = os.open(".phi-candidate.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=stage_fd)
            try:
                os.write(fd, json.dumps(marker, sort_keys=True).encode("ascii"))
                os.fsync(fd)
            finally:
                os.close(fd)
            verify_file(config_fd, "settings.yml", SOURCE_SHA256, 0, 0)
            require(sorted(os.listdir(config_fd)) == ["settings.yml"] and
                    not os.listdir(cache_fd) and
                    sorted(os.listdir(stage_fd)) == [".phi-candidate.json", "cache", "config"],
                    "staged_entries_changed")
            fsync_dir(config_fd)
            fsync_dir(cache_fd)
        finally:
            os.close(cache_fd)
            os.close(config_fd)
        fsync_dir(stage_fd)
        require(no_entry(parent_fd, TARGET), "target_already_exists")
        rename_noreplace(parent_fd, INCOMING, TARGET)
        fsync_dir(parent_fd)
    finally:
        os.close(stage_fd)


def verify_file(parent_fd, name, digest, uid, gid):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent_fd)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                (before.st_uid, before.st_gid) == (uid, gid) and before.st_size <= MAX_BYTES,
                "protected_file_metadata_invalid")
        data = bytearray()
        while len(data) <= MAX_BYTES:
            block = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        require(len(data) <= MAX_BYTES and same(before, os.fstat(fd)) and
                hashlib.sha256(data).hexdigest() == digest, "protected_file_digest_invalid")
    finally:
        os.close(fd)


def verify_tree(parent_fd, tree_name):
    require(tree_name in (INCOMING, TARGET), "tree_name_invalid")
    target_fd = os.open(tree_name, DIR_FLAGS, dir_fd=parent_fd)
    try:
        target = os.fstat(target_fd)
        require(stat.S_ISDIR(target.st_mode) and target.st_uid == target.st_gid == 0 and
                stat.S_IMODE(target.st_mode) == 0o710 and
                target.st_dev == os.fstat(parent_fd).st_dev and
                mount_id(target_fd) == mount_id(parent_fd) and
                set(os.listxattr(target_fd)) <= {"system.posix_acl_access"} and
                sorted(os.listdir(target_fd)) == [".phi-candidate.json", "cache", "config"],
                "target_structure_invalid")
        verify_acl(PARENT, "traverse")
        tree_path = PARENT + "/" + tree_name
        verify_acl(tree_path, "traverse")
        config_fd = os.open("config", DIR_FLAGS, dir_fd=target_fd)
        cache_fd = os.open("cache", DIR_FLAGS, dir_fd=target_fd)
        try:
            config, cache = os.fstat(config_fd), os.fstat(cache_fd)
            require(stat.S_ISDIR(config.st_mode) and
                    config.st_uid == config.st_gid == 0 and
                    stat.S_IMODE(config.st_mode) == 0o710 and
                    config.st_dev == target.st_dev and
                    mount_id(config_fd) == mount_id(target_fd) and
                    set(os.listxattr(config_fd)) <= {"system.posix_acl_access"} and
                    stat.S_ISDIR(cache.st_mode) and
                    (cache.st_uid, cache.st_gid) == SOURCE_UID_GID and
                    stat.S_IMODE(cache.st_mode) == 0o700 and
                    cache.st_dev == target.st_dev and
                    mount_id(cache_fd) == mount_id(target_fd) and
                    not os.listxattr(cache_fd) and
                    sorted(os.listdir(config_fd)) == ["settings.yml"] and
                    not os.listdir(cache_fd),
                    "target_metadata_invalid")
            verify_acl(tree_path + "/config", "traverse")
            verify_acl(tree_path + "/config/settings.yml", "read")
            verify_file(config_fd, "settings.yml", SOURCE_SHA256, 0, 0)
            settings_fd = os.open("settings.yml", FILE_FLAGS, dir_fd=config_fd)
            try:
                settings = os.fstat(settings_fd)
                require(stat.S_ISREG(settings.st_mode) and settings.st_nlink == 1 and
                        settings.st_uid == settings.st_gid == 0 and
                        stat.S_IMODE(settings.st_mode) == 0o640 and
                        settings.st_dev == target.st_dev and
                        mount_id(settings_fd) == mount_id(target_fd) and
                        set(os.listxattr(settings_fd)) <= {"system.posix_acl_access"} and
                        same(settings, os.stat("settings.yml", dir_fd=config_fd,
                                                    follow_symlinks=False)),
                        "target_settings_metadata_invalid")
            finally:
                os.close(settings_fd)
            require(same(config, os.fstat(config_fd)) and
                    same(config, os.stat("config", dir_fd=target_fd, follow_symlinks=False)) and
                    same(cache, os.fstat(cache_fd)) and
                    same(cache, os.stat("cache", dir_fd=target_fd, follow_symlinks=False)) and
                    not os.listdir(cache_fd) and
                    sorted(os.listdir(config_fd)) == ["settings.yml"],
                    "target_children_changed")
        finally:
            os.close(cache_fd)
            os.close(config_fd)
        marker_fd = os.open(".phi-candidate.json", FILE_FLAGS, dir_fd=target_fd)
        try:
            marker_stat = os.fstat(marker_fd)
            require(stat.S_ISREG(marker_stat.st_mode) and marker_stat.st_uid == marker_stat.st_gid == 0 and
                    marker_stat.st_nlink == 1 and stat.S_IMODE(marker_stat.st_mode) == 0o600 and
                    marker_stat.st_dev == target.st_dev and
                    mount_id(marker_fd) == mount_id(target_fd) and
                    not os.listxattr(marker_fd) and 0 < marker_stat.st_size <= 4096,
                    "target_marker_metadata_invalid")
            raw = os.read(marker_fd, 4097)
            require(len(raw) == marker_stat.st_size and
                    same(marker_stat, os.fstat(marker_fd)) and
                    same(marker_stat, os.stat(".phi-candidate.json", dir_fd=target_fd,
                                                   follow_symlinks=False)),
                    "target_marker_changed")
        finally:
            os.close(marker_fd)
        marker = {"schema": "phi-searxng-candidate-v1", "image": IMAGE_ID,
                  "original": ORIGINAL_ID, "sourceSha256": SOURCE_SHA256}
        require(raw == json.dumps(marker, sort_keys=True).encode("ascii"),
                "target_marker_mismatch")
        require(sorted(os.listdir(target_fd)) == [".phi-candidate.json", "cache", "config"] and
                same(target, os.fstat(target_fd)) and
                same(target, os.stat(tree_name, dir_fd=parent_fd, follow_symlinks=False)),
                "target_identity_changed")
        return (target.st_dev, target.st_ino)
    finally:
        os.close(target_fd)


def verify_published(parent_fd):
    return verify_tree(parent_fd, TARGET)


def candidate_state():
    require(docker("info", "--format", "{{json .ID}}") == DAEMON_ID,
            "candidate_daemon_changed")
    item = docker("container", "inspect", CANDIDATE, missing_ok=True)
    if item is None:
        return "ABSENT"
    require(isinstance(item, list) and len(item) == 1, "candidate_inspect_invalid")
    candidate = item[0]
    images = docker("image", "inspect", IMAGE_ID)
    require(isinstance(images, list) and len(images) == 1 and images[0].get("Id") == IMAGE_ID,
            "candidate_image_changed")
    image_config = images[0].get("Config", {})
    image_env = environment_map(image_config.get("Env"))
    require("FORCE_OWNERSHIP" not in image_env, "candidate_image_environment_changed")
    expected_env = {**image_env, "FORCE_OWNERSHIP": "false"}
    mounts = candidate.get("Mounts", [])
    expected = {(PARENT + "/" + TARGET + "/config", "/etc/searxng", False),
                (PARENT + "/" + TARGET + "/cache", "/var/cache/searxng", True)}
    host = candidate.get("HostConfig", {})
    config = candidate.get("Config", {})
    require(isinstance(host, dict) and isinstance(config, dict),
            "candidate_inspect_invalid")
    require(candidate.get("Name") == "/" + CANDIDATE and candidate.get("Image") == IMAGE_ID and
            config.get("Labels", {}).get(LABEL) == LABEL_VALUE and
            config.get("User") == "977:977" and
            config.get("Entrypoint") == image_config.get("Entrypoint") and
            config.get("Cmd") == image_config.get("Cmd") and
            candidate.get("State", {}).get("Running") is False and
            candidate.get("State", {}).get("Pid") == 0 and
            host.get("NetworkMode") == "bridge" and host.get("Privileged") is False and
            host.get("CapDrop") == ["ALL"] and
            not host.get("CapAdd") and
            not host.get("Devices") and not host.get("DeviceRequests") and
            not host.get("Binds") and
            host.get("SecurityOpt") == ["no-new-privileges:true"] and
            (host.get("RestartPolicy") or {}).get("Name") == "no" and
            host.get("PortBindings") == {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8888"}]} and
            len(mounts) == 2 and all(m.get("Type") == "bind" for m in mounts) and
            {(m.get("Source"), m.get("Destination"), m.get("RW")) for m in mounts} == expected and
            environment_map(config.get("Env")) == expected_env,
            "candidate_identity_or_contract_changed")
    return "STOPPED_ATTESTED"


def status(parent_fd):
    incoming = not no_entry(parent_fd, INCOMING)
    target = not no_entry(parent_fd, TARGET)
    if incoming and target:
        return "AMBIGUOUS_MANUAL"
    if incoming:
        return "INCOMING_MANUAL"
    if target:
        verify_published(parent_fd)
        candidate = candidate_state()
        return "PUBLISHED_CANDIDATE_STOPPED" if candidate == "STOPPED_ATTESTED" else "PUBLISHED_NO_CANDIDATE"
    return "PARENT_EMPTY_MANUAL"


def inspect_parent(phi_fd):
    """Selected metadata only: no raw config, environment, Docker inspect or unknown names."""
    report = {"HOST_PARENT_INSPECTION": "UNKNOWN", "hostParent": "ABSENT"}
    if no_entry(phi_fd, "searxng"):
        report["HOST_PARENT_INSPECTION"] = "FAIL"
        return report
    parent_fd = os.open("searxng", DIR_FLAGS, dir_fd=phi_fd)
    try:
        parent = os.fstat(parent_fd)
        named_before = os.stat("searxng", dir_fd=phi_fd, follow_symlinks=False)
        parent_acl = "PASS"
        parent_acl_reason = None
        try:
            verify_acl(PARENT, "traverse")
        except GateError as error:
            parent_acl = "FAIL_OR_UNKNOWN"
            parent_acl_reason = str(error)
        except (OSError, subprocess.TimeoutExpired):
            parent_acl = "FAIL_OR_UNKNOWN"
            parent_acl_reason = "acl_read_unavailable"
        names = sorted(os.listdir(parent_fd))
        expected_names = {INCOMING, TARGET}
        entries = {}
        for name in (INCOMING, TARGET):
            if name not in names:
                continue
            item = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            info = {"type": "directory" if stat.S_ISDIR(item.st_mode) else
                    "symlink" if stat.S_ISLNK(item.st_mode) else "other",
                    "dev": item.st_dev, "ino": item.st_ino, "uid": item.st_uid,
                    "gid": item.st_gid, "mode": oct(stat.S_IMODE(item.st_mode))}
            if stat.S_ISDIR(item.st_mode):
                child_fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
                try:
                    child_names = os.listdir(child_fd)
                    info["directEntries"] = {"config": "config" in child_names,
                                             "cache": "cache" in child_names,
                                             "marker": ".phi-candidate.json" in child_names,
                                             "otherCount": len(set(child_names) -
                                                               {"config", "cache", ".phi-candidate.json"})}
                finally:
                    os.close(child_fd)
            entries[name] = info
        parent_checks = {
            "directory": stat.S_ISDIR(parent.st_mode),
            "rootOwnership": parent.st_uid == parent.st_gid == 0,
            "mode0710": stat.S_IMODE(parent.st_mode) == 0o710,
            "sameDeviceAsPhi": parent.st_dev == os.fstat(phi_fd).st_dev,
            "sameMountAsPhi": mount_id(parent_fd) == mount_id(phi_fd),
            "acl": parent_acl == "PASS",
            "namedIdentityBefore": same(parent, named_before),
            "noUnexpectedXattrs": set(os.listxattr(parent_fd)) <= {"system.posix_acl_access"},
        }
        report.update({"hostParent": "PRESENT", "parent": {
            "dev": parent.st_dev, "ino": parent.st_ino,
            "uid": parent.st_uid, "gid": parent.st_gid,
            "mode": oct(stat.S_IMODE(parent.st_mode)),
            "mtimeNs": parent.st_mtime_ns, "ctimeNs": parent.st_ctime_ns,
            "sameMountAsPhi": parent_checks["sameMountAsPhi"],
            "acl": parent_acl, "aclReason": parent_acl_reason,
            "checks": parent_checks, "protected": False},
            "knownEntries": entries, "unexpectedEntryCount": len(set(names) - expected_names)})
        try:
            report["transactionState"] = status(parent_fd)
        except GateError as error:
            report["transactionState"] = "FAIL_CLOSED_MANUAL"
            report["transactionReason"] = str(error)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            report["transactionState"] = "FAIL_CLOSED_MANUAL"
            report["transactionReason"] = "read_or_inspect_unavailable"
        target_info = entries.get(TARGET)
        report["postPublishChecks"] = {
            "incomingAbsent": INCOMING not in names,
            "targetPresent": TARGET in names,
            "targetIdentityApproved": bool(target_info and
                                           (target_info["dev"], target_info["ino"]) ==
                                           RECOVERY_INCOMING_ID),
            "onlyTargetEntry": names == [TARGET],
            "targetVerifiedNoCandidate": report["transactionState"] ==
                                         "PUBLISHED_NO_CANDIDATE",
        }
        named_after = os.stat("searxng", dir_fd=phi_fd, follow_symlinks=False)
        parent_checks["stableDescriptor"] = same(parent, os.fstat(parent_fd))
        parent_checks["namedIdentityAfter"] = same(parent, named_after)
        protected = all(parent_checks.values())
        report["parent"]["protected"] = protected
    finally:
        os.close(parent_fd)
    for label, check in (("sourceIntegrity", source_bytes), ("originalCacheIntegrity", check_cache),
                         ("originalDockerAndCandidateAbsence", fixed_docker_state)):
        try:
            check()
            report[label] = "PASS"
        except GateError as error:
            report[label] = "FAIL_OR_UNKNOWN"
            report[label + "Reason"] = str(error)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            report[label] = "FAIL_OR_UNKNOWN"
            report[label + "Reason"] = "read_or_inspect_unavailable"
    report["HOST_PARENT_INSPECTION"] = (
        "TRUSTED_EMPTY_SNAPSHOT" if protected and not names and
        all(report[key] == "PASS" for key in
            ("sourceIntegrity", "originalCacheIntegrity", "originalDockerAndCandidateAbsence")) else
        "FAIL_CLOSED_MANUAL")
    return report


def inspect_staging(phi_fd):
    """Full selected-object attestation; no publication or Docker mutation."""
    parent_report = inspect_parent(phi_fd)
    checks = (
        ("host_parent_present", parent_report.get("hostParent") == "PRESENT"),
        ("host_parent_protected", parent_report.get("parent", {}).get("protected") is True),
        ("incoming_transaction_state", parent_report.get("transactionState") == "INCOMING_MANUAL"),
        ("incoming_only_known_entry", set(parent_report.get("knownEntries", {})) == {INCOMING}),
        ("no_unexpected_parent_entries", parent_report.get("unexpectedEntryCount") == 0),
        ("original_source_integrity", parent_report.get("sourceIntegrity") == "PASS"),
        ("original_cache_integrity", parent_report.get("originalCacheIntegrity") == "PASS"),
        ("original_docker_and_candidate_absence",
         parent_report.get("originalDockerAndCandidateAbsence") == "PASS"),
    )
    for predicate, passed in checks:
        if not passed:
            return {"STAGING_INTEGRITY": "FAIL_CLOSED_MANUAL", "failedPredicate": predicate,
                    "parentChecks": parent_report.get("parent", {}).get("checks"),
                    "parentAclReason": parent_report.get("parent", {}).get("aclReason"),
                    "transactionState": parent_report.get("transactionState", "UNKNOWN"),
                    "knownIncoming": INCOMING in parent_report.get("knownEntries", {}),
                    "knownTarget": TARGET in parent_report.get("knownEntries", {}),
                    "unexpectedEntryCount": parent_report.get("unexpectedEntryCount"),
                    "sourceIntegrity": parent_report.get("sourceIntegrity", "UNKNOWN"),
                    "sourceReason": parent_report.get("sourceIntegrityReason"),
                    "originalCacheIntegrity": parent_report.get("originalCacheIntegrity", "UNKNOWN"),
                    "originalCacheReason": parent_report.get("originalCacheIntegrityReason"),
                    "originalDockerAndCandidateAbsence": parent_report.get(
                        "originalDockerAndCandidateAbsence", "UNKNOWN"),
                    "originalDockerReason": parent_report.get(
                        "originalDockerAndCandidateAbsenceReason"),
                    "publicationAuthorized": False}
    parent_fd = os.open("searxng", DIR_FLAGS, dir_fd=phi_fd)
    try:
        parent = os.fstat(parent_fd)
        require((parent.st_dev, parent.st_ino) ==
                (parent_report["parent"]["dev"], parent_report["parent"]["ino"]) and
                parent.st_uid == parent.st_gid == 0 and
                stat.S_IMODE(parent.st_mode) == 0o710 and
                parent.st_mtime_ns == parent_report["parent"]["mtimeNs"] and
                parent.st_ctime_ns == parent_report["parent"]["ctimeNs"] and
                mount_id(parent_fd) == mount_id(phi_fd) and
                set(os.listxattr(parent_fd)) <= {"system.posix_acl_access"} and
                no_entry(parent_fd, TARGET), "staging_parent_or_target_changed")
        verify_acl(PARENT, "traverse")
        stage_identity = verify_tree(parent_fd, INCOMING)
        require(stage_identity ==
                (parent_report["knownEntries"][INCOMING]["dev"],
                 parent_report["knownEntries"][INCOMING]["ino"]),
                "staging_identity_changed")
        source_bytes()
        check_cache()
        fixed_docker_state()
        require(verify_tree(parent_fd, INCOMING) == stage_identity and
                no_entry(parent_fd, TARGET) and
                same(parent, os.fstat(parent_fd)) and
                same(parent, os.stat("searxng", dir_fd=phi_fd, follow_symlinks=False)) and
                sorted(os.listdir(parent_fd)) == [INCOMING],
                "staging_changed_during_inspection")
        return {"STAGING_INTEGRITY": "PASS_SNAPSHOT", "parentDev": parent.st_dev,
                "parentIno": parent.st_ino, "stagingDev": stage_identity[0],
                "stagingIno": stage_identity[1], "sourceSha256": SOURCE_SHA256,
                "originalAndCandidateState": "PASS_STOPPED_AND_CANDIDATE_ABSENT",
                "historicalCreator": "UNKNOWN", "publicationAuthorized": False}
    finally:
        os.close(parent_fd)


def sync_staging(parent_fd):
    """Make the preexisting verified tree durable before its no-replace rename."""
    stage_fd = os.open(INCOMING, DIR_FLAGS, dir_fd=parent_fd)
    try:
        config_fd = os.open("config", DIR_FLAGS, dir_fd=stage_fd)
        cache_fd = os.open("cache", DIR_FLAGS, dir_fd=stage_fd)
        try:
            for directory_fd, name in ((config_fd, "settings.yml"),
                                       (stage_fd, ".phi-candidate.json")):
                file_fd = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
                try:
                    os.fsync(file_fd)
                finally:
                    os.close(file_fd)
            fsync_dir(config_fd)
            fsync_dir(cache_fd)
        finally:
            os.close(cache_fd)
            os.close(config_fd)
        fsync_dir(stage_fd)
    finally:
        os.close(stage_fd)
    fsync_dir(parent_fd)


def recover_staging(phi_fd):
    """Freshly attest and publish exactly one incoming tree; never create Docker state."""
    snapshot = inspect_staging(phi_fd)
    require(snapshot["STAGING_INTEGRITY"] == "PASS_SNAPSHOT",
            "recovery_precondition_" + snapshot.get("failedPredicate", "unknown"))
    require((snapshot["parentDev"], snapshot["parentIno"]) == RECOVERY_PARENT_ID,
            "recovery_parent_not_approved")
    require((snapshot["stagingDev"], snapshot["stagingIno"]) == RECOVERY_INCOMING_ID,
            "recovery_staging_not_approved")
    parent_fd = os.open("searxng", DIR_FLAGS, dir_fd=phi_fd)
    try:
        parent = os.fstat(parent_fd)
        require((parent.st_dev, parent.st_ino) ==
                (snapshot["parentDev"], snapshot["parentIno"]) and
                parent.st_uid == parent.st_gid == 0 and
                stat.S_IMODE(parent.st_mode) == 0o710 and
                mount_id(parent_fd) == mount_id(phi_fd) and
                sorted(os.listdir(parent_fd)) == [INCOMING] and
                no_entry(parent_fd, TARGET), "recovery_parent_changed")
        verify_acl(PARENT, "traverse")
        identity = verify_tree(parent_fd, INCOMING)
        require(identity == (snapshot["stagingDev"], snapshot["stagingIno"]),
                "recovery_staging_changed")
        sync_staging(parent_fd)
        require(verify_tree(parent_fd, INCOMING) == identity and
                same(parent, os.fstat(parent_fd)) and
                same(parent, os.stat("searxng", dir_fd=phi_fd, follow_symlinks=False)) and
                sorted(os.listdir(parent_fd)) == [INCOMING] and
                no_entry(parent_fd, TARGET), "recovery_state_changed_before_publish")
        source_bytes()
        check_cache()
        fixed_docker_state()
        require(verify_tree(parent_fd, INCOMING) == identity and
                same(parent, os.fstat(parent_fd)) and
                same(parent, os.stat("searxng", dir_fd=phi_fd, follow_symlinks=False)) and
                mount_id(parent_fd) == mount_id(phi_fd) and
                sorted(os.listdir(parent_fd)) == [INCOMING],
                "recovery_state_changed_before_publish")
        rename_noreplace(parent_fd, INCOMING, TARGET)
        fsync_dir(parent_fd)
        require(no_entry(parent_fd, INCOMING) and
                verify_tree(parent_fd, TARGET) == identity and
                sorted(os.listdir(parent_fd)) == [TARGET], "recovery_postpublish_invalid")
        fixed_docker_state()
        return {"SEARXNG_HOST_REMEDIATION": "PUBLISHED_NO_CANDIDATE",
                "target": PARENT + "/" + TARGET,
                "targetDev": identity[0], "targetIno": identity[1],
                "configSha256": SOURCE_SHA256, "candidateCreated": False,
                "serviceStarted": False}
    finally:
        os.close(parent_fd)


def create_candidate(phi_fd):
    """Create once from a published tree; never publish, start, clean or retry."""
    snapshot = inspect_parent(phi_fd)
    parent_snapshot = snapshot.get("parent")
    entries_snapshot = snapshot.get("knownEntries")
    post_publish = snapshot.get("postPublishChecks")
    require(isinstance(snapshot, dict) and isinstance(parent_snapshot, dict) and
            isinstance(entries_snapshot, dict) and isinstance(post_publish, dict) and
            parent_snapshot.get("protected") is True and
            snapshot.get("transactionState") == "PUBLISHED_NO_CANDIDATE" and
            snapshot.get("unexpectedEntryCount") == 0 and
            all(post_publish.get(key) is True for key in
                ("incomingAbsent", "onlyTargetEntry", "targetIdentityApproved",
                 "targetPresent", "targetVerifiedNoCandidate")) and
            all(snapshot.get(key) == "PASS" for key in
                ("sourceIntegrity", "originalCacheIntegrity",
                 "originalDockerAndCandidateAbsence")),
            "candidate_published_precondition_failed")
    require(isinstance(entries_snapshot.get(TARGET), dict) and
            (parent_snapshot.get("dev"), parent_snapshot.get("ino")) == RECOVERY_PARENT_ID and
            (entries_snapshot[TARGET].get("dev"),
             entries_snapshot[TARGET].get("ino")) == RECOVERY_INCOMING_ID and
            isinstance(parent_snapshot.get("mtimeNs"), int) and
            isinstance(parent_snapshot.get("ctimeNs"), int),
            "candidate_approved_identity_changed")
    parent_fd = os.open("searxng", DIR_FLAGS, dir_fd=phi_fd)
    try:
        parent = os.fstat(parent_fd)

        def recheck_tree():
            require((parent.st_dev, parent.st_ino) == RECOVERY_PARENT_ID and
                    parent.st_uid == parent.st_gid == 0 and
                    stat.S_IMODE(parent.st_mode) == 0o710 and
                    mount_id(parent_fd) == mount_id(phi_fd) and
                    set(os.listxattr(parent_fd)) <= {"system.posix_acl_access"} and
                    sorted(os.listdir(parent_fd)) == [TARGET] and
                    same(parent, os.fstat(parent_fd)) and
                    same(parent, os.stat("searxng", dir_fd=phi_fd,
                                         follow_symlinks=False)) and
                    verify_published(parent_fd) == RECOVERY_INCOMING_ID,
                    "candidate_published_tree_changed")

        require(same(parent, os.stat("searxng", dir_fd=phi_fd,
                                     follow_symlinks=False)) and
                parent.st_mtime_ns == parent_snapshot["mtimeNs"] and
                parent.st_ctime_ns == parent_snapshot["ctimeNs"],
                "candidate_parent_changed_after_snapshot")
        recheck_tree()
        source_bytes()
        check_cache()
        fixed_docker_state()
        recheck_tree()
        # The only Docker mutation. A timeout/nonzero/malformed result can still
        # have created the object; leave it untouched for exact-state inspection.
        try:
            created = docker(*create_argv())
        except (GateError, OSError, subprocess.TimeoutExpired, ValueError) as error:
            raise GateError("candidate_create_outcome_unknown") from error
        require(candidate_state() == "STOPPED_ATTESTED" and
                docker("container", "inspect", CANDIDATE)[0].get("Id") == created,
                "candidate_postcreate_invalid")
        fixed_docker_state(expect_candidate_absent=False)
        recheck_tree()
        source_bytes()
        check_cache()
        require(status(parent_fd) == "PUBLISHED_CANDIDATE_STOPPED",
                "candidate_final_classification_failed")
        return {"SEARXNG_HOST_REMEDIATION": "PUBLISHED_STOPPED_CANDIDATE",
                "candidateId": created, "targetDev": RECOVERY_INCOMING_ID[0],
                "targetIno": RECOVERY_INCOMING_ID[1], "configSha256": SOURCE_SHA256,
                "serviceStarted": False}
    finally:
        os.close(parent_fd)


def main():
    require(len(sys.argv) == 2 and sys.argv[1] in
            ("apply", "status", "inspect", "inspect-staging", "recover",
             "create-candidate"),
            "mode_invalid")
    require(os.geteuid() == 0, "host_operator_required")
    original_umask = os.umask(0o077)
    try:
        opt = protected_opt_fd()
        try:
            phi_fd = opt[-1]
            if sys.argv[1] == "inspect":
                report = inspect_parent(phi_fd)
                print(json.dumps(report, sort_keys=True))
                return 0 if report["HOST_PARENT_INSPECTION"] == "TRUSTED_EMPTY_SNAPSHOT" else 1
            if sys.argv[1] == "inspect-staging":
                report = inspect_staging(phi_fd)
                print(json.dumps(report, sort_keys=True))
                return 0 if report["STAGING_INTEGRITY"] == "PASS_SNAPSHOT" else 1
            if sys.argv[1] == "recover":
                report = recover_staging(phi_fd)
                print(json.dumps(report, sort_keys=True))
                return 0
            if sys.argv[1] == "create-candidate":
                report = create_candidate(phi_fd)
                print(json.dumps(report, sort_keys=True))
                return 0
            if sys.argv[1] == "status":
                if no_entry(phi_fd, "searxng"):
                    print(json.dumps({"SEARXNG_HOST_STATE": "ABSENT"}))
                    return 0
                parent_fd = os.open("searxng", DIR_FLAGS, dir_fd=phi_fd)
                try:
                    print(json.dumps({"SEARXNG_HOST_STATE": status(parent_fd)}))
                    return 0
                finally:
                    os.close(parent_fd)
            require(no_entry(phi_fd, "searxng"), "host_parent_already_exists")
            data = source_bytes()
            check_cache()
            fixed_docker_state()
            require(source_bytes() == data, "source_changed_before_staging")
            check_cache()
            require(no_entry(phi_fd, "searxng"), "host_parent_already_exists")
            os.mkdir("searxng", 0o700, dir_fd=phi_fd)
            fsync_dir(phi_fd)
            parent_fd = os.open("searxng", DIR_FLAGS, dir_fd=phi_fd)
            try:
                acl(PARENT, "traverse")
                stage_copy(parent_fd, data)
                require(status(parent_fd) == "PUBLISHED_NO_CANDIDATE",
                        "publication_classification_failed")
                # Re-attest original immediately before the only Docker mutation.
                fixed_docker_state()
                created = docker(*create_argv())
                require(candidate_state() == "STOPPED_ATTESTED", "candidate_postcreate_failed")
                require(docker("container", "inspect", CANDIDATE)[0].get("Id") == created,
                        "candidate_id_changed")
                fixed_docker_state(expect_candidate_absent=False)
                require(status(parent_fd) == "PUBLISHED_CANDIDATE_STOPPED",
                        "final_classification_failed")
                print(json.dumps({"SEARXNG_HOST_REMEDIATION": "PUBLISHED_STOPPED_CANDIDATE",
                                  "candidateId": created, "configSha256": SOURCE_SHA256}, sort_keys=True))
            finally:
                os.close(parent_fd)
        finally:
            close_all(opt)
        return 0
    finally:
        os.umask(original_umask)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (GateError, OSError, subprocess.TimeoutExpired, ValueError) as error:
        reason = str(error) if isinstance(error, GateError) else "host_operation_unavailable"
        print(json.dumps({"SEARXNG_HOST_REMEDIATION": "FAIL_CLOSED_MANUAL", "reason": reason}, sort_keys=True))
        sys.exit(2)
