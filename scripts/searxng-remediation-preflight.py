#!/usr/bin/env python3
"""Read-only, fixed-object inputs for a possible SearXNG host migration.

The source is user-replaceable and is never promoted to trusted configuration
by this probe. It returns classifications only, not configuration or env values.
Host execution requires separate approval of the exact script hash.
"""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys


DOCKER = "/usr/bin/docker"
SOCKET = "/var/run/docker.sock"
SOURCE_PARTS = ("home", "tasso", ".local", "share", "pi-overdrive", "searxng", "config")
SOURCE_FILE = "settings.yml"
SOURCE_DEV_INO = (52, 2442310)
CACHE_DEV_INO = (52, 2442309)
SOURCE_UID_GID = (977, 977)
DAEMON_ID = "b64b0d52-95ab-4b1a-a971-5f09a4d6e36d"
CONTAINER_ID = "9cd6dd06e03d1ae28161e72df26301f43d9167671e1c1e90646e87ba804ca6e3"
IMAGE_ID = "sha256:e084201aa606fafce2151c8dc2844c9c3309025e90fbe7163b4f5e5183e474f0"
ORIGINAL_NAME = "pi-overdrive-searxng"
CONFIG_PATH = "/home/tasso/.local/share/pi-overdrive/searxng/config"
CACHE_PATH = "/home/tasso/.local/share/pi-overdrive/searxng/data"
MAX_BYTES = 1_000_000


class PreflightError(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise PreflightError(reason)


def source_snapshot():
    """Pin every path component; reject changed identity/metadata and never write."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    opened = []
    try:
        parent = os.open("/", flags)
        opened.append(parent)
        for part in SOURCE_PARTS:
            parent = os.open(part, flags, dir_fd=parent)
            opened.append(parent)
        require(sorted(os.listdir(parent)) == [SOURCE_FILE], "source_entries_changed")
        fd = os.open(SOURCE_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        opened.append(fd)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and (before.st_dev, before.st_ino) == SOURCE_DEV_INO,
                "source_identity_changed")
        require((before.st_uid, before.st_gid) == SOURCE_UID_GID and
                stat.S_IMODE(before.st_mode) == 0o600 and before.st_size <= MAX_BYTES,
                "source_metadata_changed")
        data = bytearray()
        while len(data) <= MAX_BYTES:
            block = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        require(len(data) <= MAX_BYTES, "source_oversized")
        after = os.fstat(fd)
        same = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        require(same(before) == same(after), "source_changed_during_read")
        named = os.stat(SOURCE_FILE, dir_fd=parent, follow_symlinks=False)
        require((named.st_dev, named.st_ino) == SOURCE_DEV_INO,
                "source_replaced_during_read")
        return bytes(data)
    finally:
        for fd in reversed(opened):
            os.close(fd)


def cache_empty_snapshot():
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    opened = []
    try:
        parent = os.open("/", flags)
        opened.append(parent)
        for part in SOURCE_PARTS[:-1] + ("data",):
            parent = os.open(part, flags, dir_fd=parent)
            opened.append(parent)
        item = os.fstat(parent)
        require((item.st_dev, item.st_ino) == CACHE_DEV_INO and
                (item.st_uid, item.st_gid) == SOURCE_UID_GID,
                "cache_identity_changed")
        return not os.listdir(parent)
    finally:
        for fd in reversed(opened):
            os.close(fd)


def json_format_state(data):
    """Only an unambiguous literal search.formats list can establish JSON state."""
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return "UNKNOWN"
    if sum(bool(re.fullmatch(r"search:\s*(?:#.*)?", line)) for line in lines) != 1:
        return "UNKNOWN"
    search_indent = formats_indent = None
    values = []
    for line in lines:
        clean = line.split("#", 1)[0].rstrip()
        if not clean.strip():
            continue
        indent = len(clean) - len(clean.lstrip(" "))
        if "\t" in clean[:indent]:
            return "UNKNOWN"
        value = clean.strip()
        if search_indent is None:
            if value == "search:":
                search_indent = indent
            continue
        if indent <= search_indent:
            break
        if formats_indent is None:
            if value == "formats:":
                formats_indent = indent
            elif value.startswith("formats:"):
                return "UNKNOWN"
            continue
        if indent <= formats_indent:
            break
        match = re.fullmatch(r"-\s*['\"]?(html|json|csv|rss)['\"]?\s*", value)
        if not match:
            return "UNKNOWN"
        values.append(match.group(1))
    if formats_indent is None or not values:
        return "UNKNOWN"
    return "ENABLED" if "json" in values else "DISABLED"


def docker_json(*args):
    permitted = (args == ("info", "--format", "{{json .ID}}") or
                 args == ("container", "inspect", ORIGINAL_NAME) or
                 args == ("image", "inspect", IMAGE_ID))
    require(permitted, "docker_operation_forbidden")
    result = subprocess.run([DOCKER, "--host", "unix://" + SOCKET, *args],
                            capture_output=True, timeout=12, check=False,
                            env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"})
    require(result.returncode == 0 and len(result.stdout) <= 2_000_000,
            "docker_read_failed")
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise PreflightError("docker_json_invalid") from error


def classify_docker(daemon, containers, images):
    """No raw inspect or environment values are returned to the caller."""
    require(daemon == DAEMON_ID and isinstance(containers, list) and len(containers) == 1 and
            isinstance(images, list) and len(images) == 1,
            "docker_identity_unavailable")
    container, image = containers[0], images[0]
    require(isinstance(container, dict) and isinstance(image, dict) and
            container.get("Id") == CONTAINER_ID and
            container.get("Name") == "/" + ORIGINAL_NAME and
            container.get("Image") == IMAGE_ID and image.get("Id") == IMAGE_ID,
            "docker_identity_changed")
    config, image_config = container.get("Config"), image.get("Config")
    host, state = container.get("HostConfig"), container.get("State")
    require(all(isinstance(value, dict) for value in (config, image_config, host, state)),
            "docker_shape_invalid")
    require(state.get("Running") is False and state.get("Pid") == 0,
            "original_not_stopped")
    mounts = container.get("Mounts")
    expected = {(CONFIG_PATH, "/etc/searxng", True),
                (CACHE_PATH, "/var/cache/searxng", True)}
    require(isinstance(mounts, list) and len(mounts) == 2 and
            all(isinstance(m, dict) for m in mounts) and
            {(m.get("Source"), m.get("Destination"), m.get("RW")) for m in mounts} == expected and
            all(m.get("Type") == "bind" for m in mounts),
            "original_mounts_changed")
    require(host.get("PortBindings") == {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8888"}]} and
            host.get("NetworkMode") == "bridge" and host.get("Privileged") is False and
            not (host.get("CapAdd") or []) and
            (host.get("RestartPolicy") or {}).get("Name") in ("no", ""),
            "original_host_contract_changed")
    env = config.get("Env")
    image_env = image_config.get("Env")
    require(isinstance(env, list) and isinstance(image_env, list) and
            all(isinstance(value, str) for value in env + image_env),
            "environment_shape_invalid")
    return {"identity": "PASS", "originalStopped": True,
            "mountsAndLoopback": "PASS",
            "environmentEqualsImage": env == image_env,
            "imageEntrypointUnchanged": config.get("Entrypoint") == image_config.get("Entrypoint") and
                                         config.get("Cmd") == image_config.get("Cmd")}


def main():
    require(sys.argv[1:] == [], "arguments_forbidden")
    require(os.geteuid() == 0, "host_operator_required")
    sock = os.lstat(SOCKET)
    require(stat.S_ISSOCK(sock.st_mode) and sock.st_uid == 0 and not sock.st_mode & 0o002,
            "docker_socket_untrusted")
    source = source_snapshot()
    cache_empty = cache_empty_snapshot()
    docker_state = classify_docker(docker_json("info", "--format", "{{json .ID}}"),
                                   docker_json("container", "inspect", ORIGINAL_NAME),
                                   docker_json("image", "inspect", IMAGE_ID))
    report = {"SEARXNG_REMEDIATION_PREFLIGHT": "PASS", "sourceSnapshot": "PASS",
              "sourceSha256": hashlib.sha256(source).hexdigest(),
              "jsonFormat": json_format_state(source), "cacheEmpty": cache_empty,
              **docker_state}
    report["transactionPredicatesReady"] = (report["jsonFormat"] == "ENABLED" and cache_empty and
                                            docker_state["environmentEqualsImage"] and
                                            docker_state["imageEntrypointUnchanged"])
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (PreflightError, OSError, subprocess.TimeoutExpired) as error:
        reason = str(error) if isinstance(error, PreflightError) else "host_read_unavailable"
        print(json.dumps({"SEARXNG_REMEDIATION_PREFLIGHT": "UNKNOWN", "reason": reason}, sort_keys=True))
        sys.exit(2)
