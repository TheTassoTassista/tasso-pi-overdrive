#!/usr/bin/env python3
"""One-shot, host-operator-approved test of the installed SearXNG image.

This MUTATES Docker by creating one disposable container. It never mounts the
existing SearXNG configuration/cache, publishes a port, or pulls an image.
Only an operator who reviewed this exact script hash may run it as root.
"""

import errno
import json
import os
import pathlib
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time


DOCKER = "/usr/bin/docker"
SOCKET = "/var/run/docker.sock"
ORIGINAL_NAME = "pi-overdrive-searxng"
DAEMON_ID = "b64b0d52-95ab-4b1a-a971-5f09a4d6e36d"
ORIGINAL_ID = "9cd6dd06e03d1ae28161e72df26301f43d9167671e1c1e90646e87ba804ca6e3"
IMAGE_ID = "sha256:e084201aa606fafce2151c8dc2844c9c3309025e90fbe7163b4f5e5183e474f0"
INDEX_REF = "searxng/searxng@" + IMAGE_ID
PYTHON = "/usr/local/searxng/.venv/bin/python"
MAX_SECONDS = 120
READINESS_SECONDS = 35
MAX_OUTPUT = 2_000_000
BODY_DEADLINE = None


class GateFailure(Exception):
    pass


def docker(*args, timeout=12, allow_failure=False):
    if BODY_DEADLINE is not None:
        remaining = BODY_DEADLINE - time.monotonic()
        if remaining <= 0:
            raise GateFailure("overall_test_timeout")
        timeout = min(timeout, remaining)
    command = [DOCKER, "--host", "unix://" + SOCKET, *args]
    completed = subprocess.run(
        command, capture_output=True, check=False, timeout=timeout,
        env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"},
    )
    if len(completed.stdout) > MAX_OUTPUT or len(completed.stderr) > MAX_OUTPUT:
        raise GateFailure("docker_output_oversized")
    if completed.returncode and not allow_failure:
        raise GateFailure("docker_command_failed:" + args[0])
    return completed


def docker_json(*args, timeout=12):
    result = docker(*args, timeout=timeout)
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise GateFailure("docker_json_invalid") from error


def one_inspect(reference):
    values = docker_json("container", "inspect", reference)
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise GateFailure("container_inspect_invalid")
    return values[0]


def original_identity():
    # Format only these four public fields: never fetch the original Env.
    result = docker("container", "inspect", "--format",
                    "{{.Id}} {{.Name}} {{.Image}} {{.State.Running}}", ORIGINAL_NAME)
    fields = result.stdout.decode("ascii", "strict").strip().split()
    if len(fields) != 4:
        raise GateFailure("original_inspect_invalid")
    return tuple(fields)


def preflight():
    if os.geteuid() != 0:
        raise GateFailure("host_operator_required")
    if not shutil.rmtree.avoids_symlink_attacks:
        raise GateFailure("safe_fixture_cleanup_unavailable")
    sock = os.lstat(SOCKET)
    if not stat.S_ISSOCK(sock.st_mode) or sock.st_uid != 0 or sock.st_mode & 0o002:
        raise GateFailure("docker_socket_untrusted")
    daemon_id = docker_json("info", "--format", "{{json .ID}}")
    if daemon_id != DAEMON_ID:
        raise GateFailure("daemon_identity_mismatch")
    if original_identity() != (ORIGINAL_ID, "/" + ORIGINAL_NAME, IMAGE_ID, "false"):
        raise GateFailure("original_identity_or_state_mismatch")
    images = docker_json("image", "inspect", IMAGE_ID)
    if (not isinstance(images, list) or len(images) != 1 or
            images[0].get("Id") != IMAGE_ID or
            INDEX_REF not in (images[0].get("RepoDigests") or []) or
            images[0].get("Os") != "linux" or images[0].get("Architecture") != "amd64" or
            images[0].get("Config", {}).get("Entrypoint") != ["/usr/local/searxng/entrypoint.sh"]):
        raise GateFailure("local_image_identity_mismatch")


def fixture_text():
    # Synthetic key is never printed or copied from the installed service.
    key = secrets.token_urlsafe(32)
    return (
        "use_default_settings: true\n"
        "server:\n"
        "  secret_key: '" + key + "'\n"
        "  limiter: false\n"
        "search:\n"
        "  formats:\n"
        "    - html\n"
        "    - json\n"
        "outgoing:\n"
        "  request_timeout: 1.0\n"
    )


def prepare_fixture():
    root = pathlib.Path(tempfile.mkdtemp(prefix="phi-searxng-ro-", dir="/run"))
    identity = os.lstat(root)
    try:
        os.chmod(root, 0o755)
        config = root / "config"
        cache = root / "cache"
        config.mkdir(mode=0o755)
        cache.mkdir(mode=0o700)
        settings = config / "settings.yml"
        fd = os.open(settings, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(fixture_text())
        os.chmod(settings, 0o444)
        os.chown(cache, 977, 977)
        return root, (identity.st_dev, identity.st_ino), config, cache
    except BaseException:
        # Only our freshly created, root-owned /run directory is removable.
        current = os.lstat(root)
        if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
            shutil.rmtree(root)
        raise


def create_argv(name, marker, config, cache):
    return (
        "create", "--pull=never", "--name", name, "--label", "phi.searxng.runtime-test=" + marker,
        "--network", "none", "--user", "977:977", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--restart", "no", "--ulimit", "core=0:0",
        "--pids-limit", "64", "--memory", "512m",
        "--cpus", "1", "--mount", "type=bind,src=" + str(config) + ",dst=/etc/searxng,readonly",
        "--mount", "type=bind,src=" + str(cache) + ",dst=/var/cache/searxng",
        "--env", "FORCE_OWNERSHIP=false", "--env", "GRANIAN_HOST=127.0.0.1", IMAGE_ID,
    )


def owned_container(name, marker):
    result = docker("container", "inspect", name, allow_failure=True)
    if result.returncode:
        error = result.stderr.decode("utf-8", "replace").lower()
        if "no such object" in error or "no such container" in error:
            return None
        raise GateFailure("temporary_inspect_unavailable")
    try:
        values = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        raise GateFailure("owned_inspect_invalid")
    if not isinstance(values, list) or len(values) != 1:
        raise GateFailure("owned_inspect_invalid")
    item = values[0]
    if (item.get("Name") != "/" + name or item.get("Image") != IMAGE_ID or
            item.get("Config", {}).get("Labels", {}).get("phi.searxng.runtime-test") != marker):
        raise GateFailure("temporary_container_ownership_mismatch")
    return item


def verify_isolation(item, config, cache):
    host = item.get("HostConfig", {})
    mounts = item.get("Mounts", [])
    expected = {(str(config), "/etc/searxng", False), (str(cache), "/var/cache/searxng", True)}
    actual = {(m.get("Source"), m.get("Destination"), m.get("RW")) for m in mounts}
    if (host.get("NetworkMode") != "none" or host.get("PortBindings") or
            host.get("Privileged") is not False or item.get("Config", {}).get("User") != "977:977" or
            actual != expected or len(mounts) != 2):
        raise GateFailure("temporary_isolation_mismatch")


FILE_PROBE = r'''
import errno, os, tempfile
path = '/etc/searxng/settings.yml'
if not os.statvfs('/etc/searxng').f_flag & os.ST_RDONLY:
    raise SystemExit(21)
if os.statvfs('/var/cache/searxng').f_flag & os.ST_RDONLY:
    raise SystemExit(22)
with open(path, 'rb') as source:
    if b'    - json' not in source.read(65536):
        raise SystemExit(11)
try:
    fd = os.open('/etc/searxng/phi-write-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except OSError as error:
    if error.errno not in (errno.EROFS, errno.EACCES):
        raise SystemExit(17)
else:
    os.close(fd)
    os.unlink('/etc/searxng/phi-write-probe')
    raise SystemExit(12)
with tempfile.NamedTemporaryFile(dir='/var/cache/searxng') as probe:
    probe.write(b'phi-cache-probe')
    probe.flush()
print('FILE_PROBE_PASS')
'''


NETWORK_PROBE = r'''
import socket
if {name for _index, name in socket.if_nameindex()} != {'lo'}:
    raise SystemExit(19)
with open('/proc/net/route', encoding='ascii') as routes:
    if any(line.split()[0] != 'lo' for line in routes.readlines()[1:] if line.split()):
        raise SystemExit(20)
print('NETWORK_NONE_PASS')
'''


HEALTH_PROBE = r'''
import urllib.error, urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:8080/', timeout=2) as response:
        if response.status != 200:
            raise SystemExit(13)
except urllib.error.URLError:
    raise SystemExit(18)
print('HEALTH_PASS')
'''


JSON_PROBE = r'''
import json, urllib.error, urllib.request
url = 'http://127.0.0.1:8080/search?q=phi-isolated-runtime-fixture&format=json'
try:
    with urllib.request.urlopen(url, timeout=10) as response:
        if response.status != 200:
            raise SystemExit(14)
        body = response.read(262145)
        if len(body) > 262144:
            raise SystemExit(15)
except urllib.error.HTTPError as error:
    raise SystemExit(43 if error.code == 403 else 44)
except urllib.error.URLError:
    raise SystemExit(46)
try:
    data = json.loads(body)
except (UnicodeDecodeError, ValueError):
    raise SystemExit(45)
if not isinstance(data, dict) or not isinstance(data.get('results'), list):
    raise SystemExit(16)
print('JSON_API_PASS')
'''


def probe(container_id, source, timeout=12):
    result = docker("exec", "--user", "977:977", container_id, PYTHON, "-c", source,
                    timeout=timeout, allow_failure=True)
    return result.returncode


def runtime_test(name, marker, config, cache, state):
    state["createAttempted"] = True
    created = docker(*create_argv(name, marker, config, cache), timeout=25)
    container_id = created.stdout.decode("ascii", "strict").strip()
    if len(container_id) != 64 or any(ch not in "0123456789abcdef" for ch in container_id):
        raise GateFailure("temporary_id_invalid")
    state["createConfirmed"] = True
    state["containerId"] = container_id
    item = owned_container(name, marker)
    if item is None or item.get("Id") != container_id:
        raise GateFailure("temporary_id_mismatch")
    verify_isolation(item, config, cache)
    docker("start", container_id, timeout=20)
    state["phaseReached"] = "container_started"
    item = owned_container(name, marker)
    verify_isolation(item, config, cache)
    if item.get("State", {}).get("Running") is not True:
        raise GateFailure("temporary_process_not_running")
    network_code = probe(container_id, NETWORK_PROBE)
    if network_code:
        raise GateFailure("network_probe_exit_" + str(network_code))
    state["phaseReached"] = "network_probe_pass"
    file_code = probe(container_id, FILE_PROBE)
    if file_code:
        raise GateFailure("file_probe_exit_" + str(file_code))
    state["phaseReached"] = "file_probe_pass"
    until = time.monotonic() + READINESS_SECONDS
    while time.monotonic() < until:
        if probe(container_id, HEALTH_PROBE, timeout=5) == 0:
            break
        if owned_container(name, marker).get("State", {}).get("Running") is not True:
            raise GateFailure("server_exited_before_readiness")
        time.sleep(1)
    else:
        raise GateFailure("server_readiness_timeout")
    state["phaseReached"] = "health_pass"
    json_code = probe(container_id, JSON_PROBE, timeout=18)
    if json_code:
        raise GateFailure("json_probe_exit_" + str(json_code))
    state["phaseReached"] = "json_probe_pass"
    return container_id


def residual_processes(container_id):
    if not container_id:
        return 0
    count = 0
    for entry in os.scandir("/proc"):
        if not entry.name.isdecimal():
            continue
        try:
            data = pathlib.Path(entry.path, "cgroup").read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except (OSError, UnicodeDecodeError):
            return None
        if container_id in data:
            count += 1
    return count


def cleanup(name, marker, root, root_identity, container_id_hint=None):
    result = {"containerRemoved": False, "ownedObserved": False,
              "fixtureRemoved": root is None, "residualProcesses": None}
    item = owned_container(name, marker)
    result["ownedObserved"] = item is not None
    container_id = item.get("Id") if item else None
    if item is not None:
        if item.get("State", {}).get("Running") is True:
            stopped = docker("stop", "--time", "5", container_id, timeout=12, allow_failure=True)
            if stopped.returncode:
                # Forced cleanup is limited to our random, label-attested object.
                item = owned_container(name, marker)
                if item is not None:
                    docker("rm", "--force", item["Id"], timeout=12)
        item = owned_container(name, marker)
        if item is not None:
            docker("rm", item["Id"], timeout=12)
    result["containerRemoved"] = owned_container(name, marker) is None
    result["residualProcesses"] = residual_processes(container_id or container_id_hint)
    if root is not None:
        current = os.lstat(root)
        if (root.parent != pathlib.Path("/run") or not root.name.startswith("phi-searxng-ro-") or
                not stat.S_ISDIR(current.st_mode) or current.st_uid != 0 or
                (current.st_dev, current.st_ino) != root_identity):
            raise GateFailure("fixture_identity_changed")
        shutil.rmtree(root)
        result["fixtureRemoved"] = not root.exists()
    return result


def traceback_summaries(log_text):
    """Extract bounded traceback identity, never exception messages or source lines."""
    summaries = []
    frame = None
    in_traceback = False
    for line in log_text.splitlines():
        if "Traceback (most recent call last):" in line:
            in_traceback = True
            frame = None
            continue
        if not in_traceback:
            continue
        match = re.match(r'^\s*File "([^"]+)", line ([0-9]{1,7})(?:, in [A-Za-z_][A-Za-z0-9_]*)?\s*$', line)
        if match:
            path = match.group(1)
            if path.startswith("/usr/local/searxng/"):
                location = path.removeprefix("/usr/local/searxng/")
                if not re.fullmatch(r"[A-Za-z0-9_./-]{1,160}", location) or ".." in pathlib.PurePosixPath(location).parts:
                    location = "IMAGE_PATH_REDACTED"
            else:
                location = "OTHER_PATH_REDACTED"
            frame = {"file": location, "line": int(match.group(2))}
            continue
        exception = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_.]{0,127}(?:Error|Exception|Timeout|Failure))\s*:', line)
        if exception:
            summaries.append({"exceptionType": exception.group(1), "lastFrame": frame})
            in_traceback = False
            if len(summaries) == 3:
                break
    return summaries


def diagnostics(name, marker):
    item = owned_container(name, marker)
    if item is None:
        return None
    logs = docker("logs", "--tail", "200", item["Id"], allow_failure=True)
    if logs.returncode:
        return {"status": "UNKNOWN", "reason": "docker_logs_unavailable"}
    raw_text = (logs.stdout + logs.stderr).decode("utf-8", "replace")
    text = raw_text.lower()
    return {
        "exitCode": item.get("State", {}).get("ExitCode"),
        "runningAtDiagnostics": item.get("State", {}).get("Running"),
        "oomKilled": item.get("State", {}).get("OOMKilled"),
        "logReadOnlyError": "read-only file system" in text,
        "logPermissionError": "permission denied" in text,
        "logChownError": "chown" in text and ("error" in text or "denied" in text),
        "logTraceback": "traceback" in text,
        "tracebackSummaries": traceback_summaries(raw_text),
    }


def main():
    global BODY_DEADLINE
    if len(sys.argv) != 1:
        raise GateFailure("arguments_forbidden")
    BODY_DEADLINE = time.monotonic() + MAX_SECONDS
    preflight()
    marker = secrets.token_hex(16)
    name = "phi-searxng-ro-" + marker
    root = None
    root_identity = None
    outcome = "UNKNOWN"
    reason = None
    cleanup_result = None
    failure_diagnostics = None
    state = {"createAttempted": False, "createConfirmed": False,
             "containerId": None, "phaseReached": "preflight_pass"}
    started = time.monotonic()
    try:
        root, root_identity, config, cache = prepare_fixture()
        runtime_test(name, marker, config, cache, state)
        outcome = "PASS"
    except (GateFailure, subprocess.TimeoutExpired, OSError, KeyboardInterrupt) as error:
        outcome = "FAIL"
        reason = error.args[0] if isinstance(error, GateFailure) else type(error).__name__
    finally:
        BODY_DEADLINE = None  # Cleanup has its own bounded Docker-command timeouts.
        try:
            failure_diagnostics = diagnostics(name, marker)
        except (GateFailure, subprocess.TimeoutExpired, OSError):
            failure_diagnostics = {"status": "UNKNOWN"}
        if outcome == "PASS":
            if failure_diagnostics is None or failure_diagnostics.get("status") == "UNKNOWN":
                outcome = "UNKNOWN"
                reason = "runtime_logs_unavailable"
            elif any(failure_diagnostics[key] for key in (
                    "logReadOnlyError", "logPermissionError", "logChownError", "logTraceback", "oomKilled")):
                outcome = "FAIL"
                reason = "runtime_log_or_oom_error"
        try:
            cleanup_result = cleanup(name, marker, root, root_identity, state["containerId"])
        except (GateFailure, subprocess.TimeoutExpired, OSError):
            cleanup_result = {"containerRemoved": None, "fixtureRemoved": None,
                              "residualProcesses": None, "status": "UNKNOWN"}
        try:
            original_unchanged = original_identity() == (ORIGINAL_ID, "/" + ORIGINAL_NAME, IMAGE_ID, "false")
        except (GateFailure, subprocess.TimeoutExpired, OSError):
            original_unchanged = None
        if (original_unchanged is None or cleanup_result.get("containerRemoved") is None or
                cleanup_result.get("fixtureRemoved") is None or cleanup_result.get("residualProcesses") is None):
            outcome = "UNKNOWN"
        elif (state["createAttempted"] and not state["createConfirmed"] and
              not cleanup_result.get("ownedObserved")):
            # A timed-out create can complete in the daemon after the CLI exits.
            outcome = "UNKNOWN"
            reason = reason or "create_completion_unknown"
        elif (not original_unchanged or cleanup_result.get("containerRemoved") is not True or
              cleanup_result.get("fixtureRemoved") is not True or cleanup_result.get("residualProcesses") != 0):
            outcome = "FAIL"
            reason = reason or "cleanup_or_original_state_failed"
    print(json.dumps({"SEARXNG_EXACT_IMAGE_RO_RUNTIME": outcome, "reason": reason,
                      "originalUnchanged": original_unchanged, "cleanup": cleanup_result,
                      "phaseReached": state["phaseReached"],
                      "diagnostics": failure_diagnostics,
                      "elapsedSeconds": round(time.monotonic() - started, 2)}, sort_keys=True))
    return 0 if outcome == "PASS" else 1 if outcome == "FAIL" else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        reason = error.args[0] if isinstance(error, GateFailure) else type(error).__name__
        print(json.dumps({"SEARXNG_EXACT_IMAGE_RO_RUNTIME": "UNKNOWN", "reason": reason}, sort_keys=True))
        sys.exit(2)
