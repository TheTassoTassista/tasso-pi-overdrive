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
DATA = "/home/tasso/.local/share/pi-overdrive/searxng/data"
IMAGE_REPOSITORY = "searxng/searxng"
# Must be filled only from independent, authenticated image provenance.
# Local Docker RepoDigests are observations, not the trust anchor.
TRUSTED_IMAGE_DIGEST = None
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
    settings_item = None
    while cursor != "/":
        item = os.lstat(cursor)
        if cursor == SETTINGS:
            settings_item = item
        if stat.S_ISLNK(item.st_mode) or item.st_mode & 0o022:
            raise RuntimeError("settings_path_untrusted")
        # A user-owned ancestor can replace the path after this snapshot. Keep
        # inspecting, but never promote that configuration to trusted PASS.
        if item.st_uid != 0 and cursor != SETTINGS:
            protected_path = False
        cursor = os.path.dirname(cursor)
    if not protected_path:
        # Report Docker metadata, but never open a root-private file through
        # user-replaceable ancestors. Its digest/JSON state stays UNKNOWN.
        return settings_item, None, None, False
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


def remediation_inputs(container, image):
    """Selected Docker metadata needed to plan, never raw inspect/env/arguments."""
    def safe(value):
        return value if isinstance(value, str) and len(value) <= 256 and re.fullmatch(r"[A-Za-z0-9_./:@-]+", value) else None

    def bindings(value):
        if not isinstance(value, dict) or len(value) > 8:
            return None
        output = []
        for port, entries in sorted(value.items()):
            if not safe(port) or entries is not None and (not isinstance(entries, list) or len(entries) > 8):
                return None
            if any(not isinstance(item, dict) for item in (entries or [])):
                return None
            output.append({"containerPort": port, "hosts": [
                {"address": safe(item.get("HostIp")), "port": safe(item.get("HostPort"))}
                for item in (entries or [])
            ]})
        return output

    mounts = container.get("Mounts")
    selected_mounts = None if not isinstance(mounts, list) or len(mounts) > 8 or any(not isinstance(item, dict) for item in mounts) else [
        {"type": safe(item.get("Type")), "source": safe(item.get("Source")),
         "destination": safe(item.get("Destination")), "name": safe(item.get("Name")) if item.get("Name") else None,
         "readOnly": item.get("RW") is False}
        for item in mounts
    ]
    config = container.get("Config") or {}
    host = container.get("HostConfig") or {}
    network = container.get("NetworkSettings") or {}
    return {
        "imageReference": safe(config.get("Image")),
        "repoDigests": [safe(value) for value in (image.get("RepoDigests") or [])[:8]],
        "repoDigestCount": len(image.get("RepoDigests") or []),
        "repoTags": [safe(value) for value in (image.get("RepoTags") or [])[:8]],
        "mounts": selected_mounts,
        "requestedPorts": bindings(host.get("PortBindings") or {}),
        "effectivePorts": bindings(network.get("Ports") or {}),
        "networkMode": safe(host.get("NetworkMode")),
        "containerUser": safe(config.get("User")),
        "readOnlyRootfs": host.get("ReadonlyRootfs") is True,
        "restartPolicy": safe((host.get("RestartPolicy") or {}).get("Name")),
        "environmentCount": len(config.get("Env") or []),
        "composeManaged": "com.docker.compose.project" in (config.get("Labels") or {}),
    }


def assess(container, image, settings_item, settings_sha, json_enabled, protected_path, trusted_image_digest=None):
    if not isinstance(container, dict) or not isinstance(image, dict):
        raise RuntimeError("inspect_shape_invalid")
    if (not isinstance(container.get("Config"), dict) or not isinstance(container.get("HostConfig"), dict) or
            not isinstance(container.get("State"), dict) or not isinstance(container.get("NetworkSettings"), dict)):
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
                              re.fullmatch(r"(?:docker.io/)?" + IMAGE_REPOSITORY + r"@sha256:[0-9a-f]{64}", d))
    normalized_reference = reference.removeprefix("docker.io/") if isinstance(reference, str) else ""
    repository_ok = bool(matching_digests) and bool(re.fullmatch(
        IMAGE_REPOSITORY + r"(?::[A-Za-z0-9_.-]+|@sha256:[0-9a-f]{64})", normalized_reference))
    provenance_ok = (isinstance(trusted_image_digest, str) and
                     re.fullmatch(r"sha256:[0-9a-f]{64}", trusted_image_digest) is not None and
                     any(d.endswith("@" + trusted_image_digest) for d in matching_digests))
    mounts = container.get("Mounts", [])
    if not isinstance(mounts, list) or any(not isinstance(m, dict) for m in mounts):
        raise RuntimeError("inspect_shape_invalid")
    settings_mount = [m for m in mounts if m.get("Type") == "bind" and
                      m.get("Source") == os.path.dirname(SETTINGS) and m.get("Destination") == "/etc/searxng"]
    data_mount = [m for m in mounts if m.get("Type") == "bind" and
                  m.get("Source") == DATA and m.get("Destination") == "/var/cache/searxng"]
    mounts_exact = len(mounts) == 2 and len(settings_mount) == 1 and len(data_mount) == 1
    host = container.get("HostConfig", {})
    ports = host.get("PortBindings") or {}
    bindings = ports.get("8080/tcp") or []
    effective_ports = container["NetworkSettings"].get("Ports") or {}
    effective_bindings = effective_ports.get("8080/tcp") or []
    requested_loopback = len(ports) == 1 and bool(bindings) and all(
        b.get("HostIp") == "127.0.0.1" and b.get("HostPort") == "8888" for b in bindings)
    running_state = container.get("State", {})
    running = running_state.get("Running") is True and type(running_state.get("Pid")) is int and running_state["Pid"] > 0
    effective_loopback = (len(effective_ports) == 1 and bool(effective_bindings) and all(
        b.get("HostIp") == "127.0.0.1" and b.get("HostPort") == "8888" for b in effective_bindings)) if running else None
    privileged = host.get("Privileged") is True
    cap_add = host.get("CapAdd") or []
    security_opts = host.get("SecurityOpt") or []
    security_ok = (not privileged and not cap_add and
                   not any("unconfined" in str(o).lower() for o in security_opts) and
                   host.get("PidMode") in ("", "private", None) and
                   host.get("IpcMode") in ("", "private", None) and
                   host.get("NetworkMode") not in ("host", "none", None))
    checks = {
        "image_repository": repository_ok,
        "image_provenance": provenance_ok,
        "settings_bind": mounts_exact,
        "config_read_only": settings_mount[0].get("RW") is False if mounts_exact else False,
        "cache_writable": data_mount[0].get("RW") is True if mounts_exact else False,
        "settings_private": settings_item.st_mode & 0o077 == 0,
        "settings_owner": settings_item.st_uid == SETTINGS_OWNER,
        "settings_protected_path": protected_path,
        "json_format": None if json_enabled is None else json_enabled is True,
        "requested_loopback_port": requested_loopback,
        "effective_loopback_port": effective_loopback,
        "not_privileged": security_ok,
        "running": running,
    }
    attestation = "FAIL" if False in checks.values() else "UNKNOWN" if None in checks.values() else "PASS"
    return {
        "HOST_ATTESTATION": attestation,
        "containerId": identity,
        "imageId": image_id,
        "imageDigest": matching_digests[0] if matching_digests else None,
        "imageProvenance": "independent_digest_matched" if provenance_ok else "local_docker_metadata_only",
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
    if sys.argv[1:] not in ([], ["--remediation-inputs"]):
        raise RuntimeError("argument_forbidden")
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
    report = assess(container, image_list[0], settings, digest,
                    json_format_enabled(data) if data is not None else None, protected_path, TRUSTED_IMAGE_DIGEST)
    if sys.argv[1:] == ["--remediation-inputs"]:
        report["remediationInputs"] = remediation_inputs(container, image_list[0])
    report["dockerEndpoint"] = "unix:///var/run/docker.sock"
    report["daemonId"] = daemon_id
    print(json.dumps(report, sort_keys=True))
    return {"PASS": 0, "FAIL": 1, "UNKNOWN": 2}[report["HOST_ATTESTATION"]]


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) else "host_read_unavailable"
        print(json.dumps({"HOST_ATTESTATION": "UNKNOWN", "reason": reason}, sort_keys=True))
        sys.exit(2)
