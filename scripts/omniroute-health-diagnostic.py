#!/usr/bin/env python3
"""Read-only, exact-ID OmniRoute health-failure diagnostic for an operator."""

from __future__ import annotations

import ipaddress
import json
import re
import subprocess
from typing import Any


EDGE_ID = "f31a9d41602d7321cf080974bf00ca550551528d620453346ee0186d8f18f83e"
BACKEND_ID = "b5c5de6334a53acb5f4a127f5d60734ca61890b6a684271d0df288444294b74d"
NETWORK = "phi-omniroute-egress-candidate-v1"
EDGE_NAME = "phi-omniroute-egress-edge-v1"
BACKEND_NAME = "phi-omniroute-egress-backend-v1"
LABEL = "phi.omniroute.candidate.egress"
LABEL_VALUE = "v1"
TAIL_LINES = 120
COMMAND_TIMEOUT = 25

SECRET_VALUE = re.compile(
    r'''(?ix)(["']?(?:authorization|proxy-authorization|x-api-key|api[_-]?key(?:[_-]?secret)?|jwt(?:[_-]?secret)?|private[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|secret|credential|cookie|set-cookie|initial[_-]?password)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)'''
)
BEARER = re.compile(r"(?i)\b(Bearer)\s+[^\s,;\"']+")
BASIC = re.compile(r"(?i)\b(Basic)\s+[A-Za-z0-9+/=]+")
URL_CREDENTIALS = re.compile(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@")
QUERY_SECRET = re.compile(r"(?i)([?&](?:token|key|secret|password|api[_-]?key|access[_-]?token)=)[^&\s]+")
LONG_TOKEN = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_+/=-]{40,}(?![A-Za-z0-9])")
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
IPV4 = re.compile(r"(?<![\w.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![\w.])")
IPV6_CANDIDATE = re.compile(r"(?i)(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])")
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
SECRET_KEY = re.compile(r"(?i)(authorization|token|password|passwd|secret|credential|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|initial[_-]?password)")
OMIT_KEY = re.compile(r"(?i)^(?:env|environment|headers|request|response|body|prompt|content|payload|data)$")
SAFE_LOG_FIELDS = {
    "time", "timestamp", "level", "severity", "name", "logger", "msg", "message",
    "event", "status", "method", "path", "route", "code", "error", "err", "stack",
}


def _run_docker(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, errors="replace",
        timeout=COMMAND_TIMEOUT, check=False,
    )


def _safe_text(value: str, limit: int = 1200) -> str:
    value = ANSI.sub("", value)
    value = BEARER.sub(r"\1 [REDACTED]", value)
    value = BASIC.sub(r"\1 [REDACTED]", value)
    value = SECRET_VALUE.sub(r"\1[REDACTED]", value)
    value = URL_CREDENTIALS.sub(r"\1[REDACTED]@", value)
    value = QUERY_SECRET.sub(r"\1[REDACTED]", value)
    value = JWT.sub("[REDACTED_JWT]", value)
    value = LONG_TOKEN.sub("[REDACTED_LONG_VALUE]", value)
    value = IPV4.sub("[IP_REDACTED]", value)
    value = IPV6_CANDIDATE.sub(_redact_ipv6_candidate, value)
    value = "".join(char if char in "\t" or 32 <= ord(char) < 127 or ord(char) >= 160 else " " for char in value)
    return value[:limit]


def _redact_ipv6_candidate(match: re.Match[str]) -> str:
    candidate = match.group(0)
    try:
        ipaddress.IPv6Address(candidate)
    except ValueError:
        return candidate
    return "[IP_REDACTED]"


def _safe_log_line(line: str) -> str:
    text = ANSI.sub("", line).strip()
    if not text:
        return ""
    try:
        value = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _safe_text(text)
    if not isinstance(value, dict):
        return _safe_text(text)
    safe: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or SECRET_KEY.search(key):
            continue
        if OMIT_KEY.fullmatch(key):
            safe[key] = "[OMITTED]"
        elif key in SAFE_LOG_FIELDS:
            if isinstance(item, str):
                safe[key] = _safe_text(item)
            elif item is None or type(item) in {bool, int, float}:
                safe[key] = item
    if not safe:
        return "[structured log fields omitted]"
    return json.dumps(safe, separators=(",", ":"), ensure_ascii=True)[:2400]


def sanitize_logs(raw: str, limit: int = TAIL_LINES) -> list[str]:
    lines = raw.splitlines()[-limit:]
    result: list[str] = []
    redacting_private_key = False
    for line in lines:
        if "-----BEGIN " in line and "PRIVATE KEY-----" in line:
            redacting_private_key = True
            result.append("[private key block redacted]")
            continue
        if redacting_private_key:
            if "-----END " in line and "PRIVATE KEY-----" in line:
                redacting_private_key = False
            continue
        clean = _safe_log_line(line)
        if clean:
            result.append(clean)
    if redacting_private_key:
        result.append("[unterminated private key block redacted]")
    return result


def classify_error(error: Any) -> str:
    if not isinstance(error, str) or not error.strip():
        return "none"
    text = error.lower()
    patterns = (
        ("permission", ("permission denied", "operation not permitted", "access is denied")),
        ("port_bind", ("address already in use", "port is already allocated", "bind: cannot assign")),
        ("network", ("network", "endpoint", "no route to host", "connection refused")),
        ("timeout", ("timeout", "timed out", "deadline exceeded")),
        ("image_or_entrypoint", ("no such image", "exec format error", "executable file not found", "no such file or directory")),
        ("runtime", ("oci runtime", "containerd", "runc", "failed to create task", "failed to start")),
    )
    for label, needles in patterns:
        if any(needle in text for needle in needles):
            return label
    return "other_error_present"


def _normalized_ports(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, dict):
        return ["invalid"]
    result: list[str] = []
    for container_port, bindings in sorted(value.items()):
        if not isinstance(container_port, str) or not re.fullmatch(r"[0-9]{1,5}/(?:tcp|udp)", container_port):
            return ["invalid"]
        if bindings is None:
            result.append(f"{container_port}=unbound")
            continue
        if not isinstance(bindings, list):
            return ["invalid"]
        for binding in bindings:
            if not isinstance(binding, dict):
                return ["invalid"]
            host_ip = binding.get("HostIp", "")
            host_port = binding.get("HostPort", "")
            if not isinstance(host_ip, str) or not isinstance(host_port, str) or not host_port.isdigit() or not 1 <= int(host_port) <= 65535:
                return ["invalid"]
            if host_ip:
                try:
                    address = ipaddress.ip_address(host_ip)
                except ValueError:
                    return ["invalid"]
                host_label = "loopback" if address.is_loopback else "non-loopback"
            else:
                host_label = "unspecified"
            result.append(f"{container_port}={host_label}:{host_port}")
    return result


def summarize_container(document: Any, expected_id: str, role: str) -> dict[str, Any]:
    if not isinstance(document, dict) or document.get("Id") != expected_id:
        raise ValueError("container_identity_mismatch")
    state = document.get("State") if isinstance(document.get("State"), dict) else {}
    config = document.get("Config") if isinstance(document.get("Config"), dict) else {}
    host_config = document.get("HostConfig") if isinstance(document.get("HostConfig"), dict) else {}
    network_settings = document.get("NetworkSettings") if isinstance(document.get("NetworkSettings"), dict) else {}
    labels = config.get("Labels") if isinstance(config.get("Labels"), dict) else {}
    expected_name = EDGE_NAME if role == "EDGE" else BACKEND_NAME
    expected_mode = NETWORK if role == "EDGE" else f"container:{EDGE_ID}"
    health = state.get("Health") if isinstance(state.get("Health"), dict) else {}
    health_status = health.get("Status")
    if health_status not in {"none", "starting", "healthy", "unhealthy", None}:
        health_status = "unknown"
    health_logs = health.get("Log") if isinstance(health.get("Log"), list) else []
    latest_health = health_logs[-1] if health_logs and isinstance(health_logs[-1], dict) else {}
    health_output = latest_health.get("Output", "")
    return {
        "role": role,
        "id": expected_id,
        "identity": "PASS" if document.get("Name") == f"/{expected_name}" and labels.get(LABEL) == LABEL_VALUE else "MISMATCH",
        "status": state.get("Status") if state.get("Status") in {"created", "running", "paused", "restarting", "removing", "exited", "dead"} else "unknown",
        "exitCode": state.get("ExitCode") if type(state.get("ExitCode")) is int else None,
        "oomKilled": state.get("OOMKilled") if type(state.get("OOMKilled")) is bool else None,
        "dockerError": classify_error(state.get("Error")),
        "startedAt": state.get("StartedAt") if isinstance(state.get("StartedAt"), str) else "unknown",
        "finishedAt": state.get("FinishedAt") if isinstance(state.get("FinishedAt"), str) else "unknown",
        "healthStatus": health_status or "not_configured",
        "lastHealthExitCode": latest_health.get("ExitCode") if type(latest_health.get("ExitCode")) is int else None,
        "lastHealthOutputClass": classify_error(health_output),
        "networkMode": "expected" if host_config.get("NetworkMode") == expected_mode else "mismatch",
        "configuredHostPorts": _normalized_ports(host_config.get("PortBindings")),
        "activeHostPorts": _normalized_ports(network_settings.get("Ports")),
    }


def _call(args: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return _run_docker(args)
    except (OSError, subprocess.TimeoutExpired):
        return None


def main() -> int:
    context = _call(["context", "show"])
    if context is None or context.returncode != 0:
        print("DOCKER_CONTEXT=UNKNOWN")
        return 1
    if context.stdout.strip() != "default":
        print("DOCKER_CONTEXT=NON_DEFAULT_DIAGNOSTIC_STOPPED")
        return 1
    endpoint = _call(["context", "inspect", "default", "--format", '{{(index .Endpoints "docker").Host}}'])
    if endpoint is None or endpoint.returncode != 0 or endpoint.stdout.strip() != "unix:///var/run/docker.sock":
        print("DOCKER_ENDPOINT=NOT_EXPECTED_DIAGNOSTIC_STOPPED")
        return 1
    daemon = _call(["info", "--format", "{{.ID}}"])
    if daemon is None or daemon.returncode != 0 or not re.fullmatch(r"[0-9a-fA-F-]{36}\s*", daemon.stdout):
        print("DOCKER_DAEMON=UNKNOWN")
        return 1
    print(f"OMNIROUTE_HEALTH_DIAGNOSTIC=READ_ONLY daemon_id={daemon.stdout.strip()}")

    failures = 0
    for role, container_id in (("EDGE", EDGE_ID), ("BACKEND", BACKEND_ID)):
        inspected = _call(["inspect", container_id])
        document = None
        if inspected is None or inspected.returncode != 0:
            print(f"CONTAINER={role} INSPECT=FAIL")
            failures += 1
        else:
            try:
                rows = json.loads(inspected.stdout)
                if not isinstance(rows, list) or len(rows) != 1:
                    raise ValueError("unexpected_inspect_shape")
                document = rows[0]
                summary = summarize_container(document, container_id, role)
                print("CONTAINER=" + json.dumps(summary, sort_keys=True, separators=(",", ":")))
                if summary["identity"] != "PASS" or summary["networkMode"] != "expected":
                    failures += 1
            except (ValueError, json.JSONDecodeError):
                print(f"CONTAINER={role} INSPECT=INVALID_OR_IDENTITY_MISMATCH")
                failures += 1

        if document is None or document.get("Id") != container_id:
            print(f"LOGS={role} UNAVAILABLE_EXACT_ID_NOT_ATTESTED")
            continue
        log_result = _call(["logs", "--timestamps", "--tail", str(TAIL_LINES), container_id])
        if log_result is None or log_result.returncode != 0:
            print(f"LOGS={role} FAIL")
            failures += 1
            continue
        print(f"LOGS={role}_BEGIN count_at_most={TAIL_LINES}")
        for line in sanitize_logs(log_result.stdout):
            print(line)
        print(f"LOGS={role}_END")
    print(f"OMNIROUTE_HEALTH_DIAGNOSTIC={'COLLECTION_COMPLETE' if failures == 0 else 'COLLECTION_PARTIAL'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
