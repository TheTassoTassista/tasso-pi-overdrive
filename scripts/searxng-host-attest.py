#!/usr/bin/env python3
"""One-shot, read-only host report for the fixed Phi SearXNG container.

This script does not grant Docker access to Phi. Run only after the host
operator approves these exact bytes. It never prints container environment,
raw inspect output, configuration contents, or process arguments.
"""

import hashlib
import json
import os
import re
import socket
import stat
import subprocess
import sys


DOCKER = "/usr/bin/docker"
SOCKET = "/var/run/docker.sock"
NAME = "pi-overdrive-searxng"
SETTINGS = "/home/tasso/.local/share/pi-overdrive/searxng/config/settings.yml"
IMAGE_REPOSITORY = "searxng/searxng"
SETTINGS_OWNER = 977  # Observed local systemd-network UID; fixed for this host only.
MAX_OUTPUT = 2_000_000


def run_docker(*args):
    allowed = (args == ("container", "inspect", NAME) or
               args == ("info", "--format", "{{json .ID}}") or
               (len(args) == 3 and args[:2] == ("image", "inspect") and
                re.fullmatch(r"sha256:[0-9a-f]{64}", args[2])))
    if not allowed:
        raise RuntimeError("docker_operation_forbidden")
    command = [DOCKER, "--host", "unix://" + SOCKET, *args]
    completed = subprocess.run(command, capture_output=True, timeout=12, check=False,
                               env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"})
    if completed.returncode or len(completed.stdout) > MAX_OUTPUT:
        raise RuntimeError("docker_read_failed")
    try:
        return json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise RuntimeError("docker_json_invalid") from error


def file_identity():
    cursor = SETTINGS
    protected_path = True
    while cursor != "/":
        item = os.lstat(cursor)
        if stat.S_ISLNK(item.st_mode) or item.st_mode & 0o022:
            raise RuntimeError("settings_path_untrusted")
        # A user-owned ancestor can replace the path after this snapshot. Keep
        # inspecting, but never promote that configuration to trusted PASS.
        if item.st_uid != 0 and cursor != SETTINGS:
            protected_path = False
        cursor = os.path.dirname(cursor)
    descriptor = os.open(SETTINGS, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        item = os.fstat(descriptor)
        if not stat.S_ISREG(item.st_mode) or item.st_mode & 0o077:
            raise RuntimeError("settings_file_untrusted")
        digest = hashlib.sha256()
        text = bytearray()
        while True:
            block = os.read(descriptor, 65536)
            if not block:
                break
            if len(text) + len(block) > 1_000_000:
                raise RuntimeError("settings_file_oversized")
            digest.update(block)
            text.extend(block)
        after = os.fstat(descriptor)
        named = os.lstat(SETTINGS)
        if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) !=
                (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns) or
                (named.st_dev, named.st_ino) != (item.st_dev, item.st_ino)):
            raise RuntimeError("settings_changed")
        return item, digest.hexdigest(), bytes(text), protected_path
    finally:
        os.close(descriptor)


def json_format_enabled(data):
    """Recognize only a simple explicit search.formats list; ambiguity is UNKNOWN."""
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return None
    search_indent = None
    formats_indent = None
    values = []
    if sum(bool(re.match(r"^search:\s*(?:#.*)?$", line)) for line in lines) != 1:
        return None
    for line in lines:
        clean = line.split("#", 1)[0].rstrip()
        if not clean.strip():
            continue
        indent = len(clean) - len(clean.lstrip(" "))
        if "\t" in clean[:indent]:
            return None
        value = clean.strip()
        if search_indent is None:
            if re.fullmatch(r"search:\s*", value):
                search_indent = indent
            continue
        if indent <= search_indent:
            break
        if formats_indent is None:
            if re.fullmatch(r"formats:\s*", value):
                formats_indent = indent
            elif value.startswith("formats:"):
                return None
            continue
        if indent <= formats_indent:
            break
        match = re.fullmatch(r"-\s*['\"]?(html|json|csv|rss)['\"]?\s*", value)
        if not match:
            return None
        values.append(match.group(1))
    return "json" in values if formats_indent is not None and values else None


def assess(container, image, settings_item, settings_sha, json_enabled, protected_path):
    if not isinstance(container, dict) or not isinstance(image, dict):
        raise RuntimeError("inspect_shape_invalid")
    if not isinstance(container.get("Config"), dict) or not isinstance(container.get("HostConfig"), dict) or not isinstance(container.get("State"), dict):
        raise RuntimeError("inspect_shape_invalid")
    identity = container.get("Id", "")
    image_id = container.get("Image", "")
    if not re.fullmatch(r"[0-9a-f]{64}", identity) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise RuntimeError("identity_invalid")
    if container.get("Name") != "/" + NAME or image.get("Id") != image_id:
        raise RuntimeError("identity_mismatch")
    reference = container.get("Config", {}).get("Image")
    digests = image.get("RepoDigests", [])
    matching_digests = sorted(d for d in digests if isinstance(d, str) and
                              re.fullmatch(IMAGE_REPOSITORY + r"@sha256:[0-9a-f]{64}", d))
    mounts = container.get("Mounts", [])
    settings_mount = [m for m in mounts if m.get("Type") == "bind" and m.get("RW") is False and
                      ((m.get("Source") == SETTINGS and m.get("Destination") == "/etc/searxng/settings.yml") or
                       (m.get("Source") == os.path.dirname(SETTINGS) and m.get("Destination") == "/etc/searxng"))]
    host = container.get("HostConfig", {})
    ports = host.get("PortBindings") or {}
    bindings = ports.get("8080/tcp") or []
    loopback_only = len(ports) == 1 and bool(bindings) and all(
        b.get("HostIp") == "127.0.0.1" and b.get("HostPort") == "8888" for b in bindings)
    privileged = host.get("Privileged") is True
    cap_add = host.get("CapAdd") or []
    security_opts = host.get("SecurityOpt") or []
    security_ok = (not privileged and not cap_add and
                   not any("unconfined" in str(o).lower() for o in security_opts) and
                   host.get("PidMode") in ("", "private", None) and
                   host.get("IpcMode") in ("", "private", None) and
                   host.get("NetworkMode") not in ("host", "none", None))
    state = container.get("State", {})
    running = state.get("Running") is True
    checks = {
        "image_repository": reference in matching_digests,
        "settings_bind": len(mounts) == 1 and len(settings_mount) == 1,
        "settings_private": settings_item.st_mode & 0o077 == 0,
        "settings_owner": settings_item.st_uid == SETTINGS_OWNER,
        "settings_protected_path": protected_path,
        "json_format": json_enabled is True,
        "loopback_port": loopback_only,
        "not_privileged": security_ok,
        "running": running,
    }
    return {
        "HOST_ATTESTATION": "PASS" if all(checks.values()) else "FAIL",
        "containerId": identity,
        "imageId": image_id,
        "imageDigest": matching_digests[0] if matching_digests else None,
        "imageProvenance": "local_docker_metadata_only",
        "settingsSha256": settings_sha,
        "settingsOwner": settings_item.st_uid,
        "settingsMode": oct(stat.S_IMODE(settings_item.st_mode)),
        "jsonEnabled": json_enabled,
        "networkModeClass": (host.get("NetworkMode") if host.get("NetworkMode") in ("bridge", "host", "none")
                             else "custom_or_unknown"),
        "mountCount": len(mounts),
        "capAddCount": len(cap_add),
        "checks": checks,
    }


def main():
    if os.geteuid() != 0:
        raise RuntimeError("host_operator_required")
    sock = os.lstat(SOCKET)
    if not stat.S_ISSOCK(sock.st_mode) or sock.st_uid != 0 or sock.st_mode & 0o002:
        raise RuntimeError("docker_socket_untrusted")
    settings, digest, data, protected_path = file_identity()
    container_list = run_docker("container", "inspect", NAME)
    if not isinstance(container_list, list) or len(container_list) != 1:
        raise RuntimeError("container_not_unique")
    container = container_list[0]
    image_id = container.get("Image", "") if isinstance(container, dict) else ""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise RuntimeError("image_identity_invalid")
    daemon_id = run_docker("info", "--format", "{{json .ID}}")
    if not isinstance(daemon_id, str) or not daemon_id:
        raise RuntimeError("daemon_identity_unavailable")
    image_list = run_docker("image", "inspect", image_id)
    if not isinstance(image_list, list) or len(image_list) != 1:
        raise RuntimeError("image_not_unique")
    report = assess(container, image_list[0], settings, digest, json_format_enabled(data), protected_path)
    report["dockerEndpoint"] = "unix:///var/run/docker.sock"
    report["daemonId"] = daemon_id
    print(json.dumps(report, sort_keys=True))
    return 0 if report["HOST_ATTESTATION"] == "PASS" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) else "host_read_unavailable"
        print(json.dumps({"HOST_ATTESTATION": "UNKNOWN", "reason": reason}, sort_keys=True))
        sys.exit(2)
