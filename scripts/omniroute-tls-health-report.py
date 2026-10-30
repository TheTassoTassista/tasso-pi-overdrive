#!/usr/bin/env python3
"""Strict, secret-free summaries for the live OmniRoute HTTPS health gate."""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
import re
import stat
import sys
from dataclasses import dataclass


EXPECTED_BINDINGS = {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "20129"}]}
METRIC_NAMES = ("time_connect", "time_appconnect", "time_starttransfer", "time_total")
_CONTAINER_ID_RE = re.compile(r"[a-f0-9]{64}\Z")
MAX_MODELS_RESPONSE_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class CurlProbe:
    exit_code: int
    http_status: str
    times: tuple[float, float, float, float]
    phase: str


def _json_object(raw: str) -> dict:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("object_required")
    return value


def port_publication(snapshot: str) -> tuple[bool, bool]:
    """Return configured/active only for the exact loopback binding."""
    configured_raw, separator, active_raw = snapshot.partition("|")
    if not separator or "|" in active_raw:
        raise ValueError("port_snapshot_shape_invalid")
    configured_value = json.loads(configured_raw)
    active_value = json.loads(active_raw)
    configured = isinstance(configured_value, dict) and configured_value == EXPECTED_BINDINGS
    active = isinstance(active_value, dict)
    if active:
        live_binding = active_value.get("8443/tcp")
        active = live_binding == EXPECTED_BINDINGS["8443/tcp"]
        # Docker may include image-declared, unpublished ports with null/empty
        # bindings. No additional live host mapping is acceptable.
        active = active and all(
            name == "8443/tcp" or binding in (None, [])
            for name, binding in active_value.items()
        )
    return configured, active


def attested_edge_ipv4(
    edge_snapshot: str,
    network_snapshot: str,
    *,
    expected_edge_id: str,
    expected_network_id: str,
    network_name: str,
    expected_subnet: str | None = None,
) -> str:
    """Return an edge address only when exact container/network endpoint identity agrees."""
    if not _CONTAINER_ID_RE.fullmatch(expected_edge_id):
        raise ValueError("expected_edge_id_invalid")
    if not _CONTAINER_ID_RE.fullmatch(expected_network_id):
        raise ValueError("expected_network_id_invalid")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", network_name):
        raise ValueError("network_name_invalid")

    edge_id, separator, raw_networks = edge_snapshot.partition("|")
    if not separator or "|" in raw_networks or edge_id != expected_edge_id:
        raise ValueError("edge_identity_mismatch")
    networks = _json_object(raw_networks)
    if set(networks) != {network_name}:
        raise ValueError("edge_network_set_mismatch")
    endpoint = networks[network_name]
    if not isinstance(endpoint, dict):
        raise ValueError("edge_endpoint_invalid")
    if endpoint.get("NetworkID") != expected_network_id:
        raise ValueError("edge_network_identity_mismatch")
    if not isinstance(endpoint.get("EndpointID"), str) or not _CONTAINER_ID_RE.fullmatch(endpoint["EndpointID"]):
        raise ValueError("edge_endpoint_identity_invalid")
    if endpoint.get("GlobalIPv6Address") not in (None, ""):
        raise ValueError("edge_ipv6_address_unexpected")
    raw_address = endpoint.get("IPAddress")
    if not isinstance(raw_address, str) or not raw_address:
        raise ValueError("edge_ipv4_missing")
    try:
        address = ipaddress.ip_address(raw_address)
    except ValueError as error:
        raise ValueError("edge_ipv4_invalid") from error
    if (
        address.version != 4 or not address.is_private or address.is_loopback or address.is_link_local
        or address.is_multicast or address.is_unspecified or address.is_reserved
    ):
        raise ValueError("edge_ipv4_scope_invalid")

    network_id, separator, raw_ipam = network_snapshot.partition("|")
    if not separator or "|" in raw_ipam or network_id != expected_network_id:
        raise ValueError("network_identity_mismatch")
    configs = json.loads(raw_ipam)
    if not isinstance(configs, list) or len(configs) != 1 or not isinstance(configs[0], dict):
        raise ValueError("network_subnet_ambiguous")
    try:
        raw_subnet = configs[0].get("Subnet")
        if not isinstance(raw_subnet, str) or not raw_subnet:
            raise ValueError("network_subnet_missing")
        subnet = ipaddress.ip_network(raw_subnet, strict=True)
    except ValueError as error:
        raise ValueError("network_subnet_invalid") from error
    if subnet.version != 4 or not subnet.is_private or address not in subnet:
        raise ValueError("edge_ipv4_outside_network")
    if address in {subnet.network_address, subnet.broadcast_address}:
        raise ValueError("edge_ipv4_not_host_address")
    if expected_subnet is not None:
        try:
            approved_subnet = ipaddress.ip_network(expected_subnet, strict=True)
        except ValueError as error:
            raise ValueError("approved_subnet_invalid") from error
        if approved_subnet.version != 4 or subnet != approved_subnet:
            raise ValueError("network_subnet_mismatch")
    return str(address)


def _curl_phase(exit_code: int, status: str, times: tuple[float, float, float, float]) -> str:
    if exit_code == 0:
        return {
            "200": "HTTP_200",
            "401": "HTTP_401_AUTH",
            "403": "HTTP_403_FORBIDDEN",
            "502": "HTTP_502_UPSTREAM",
            "503": "HTTP_503_BACKEND_NOT_READY",
        }.get(status, "HTTP_STATUS" if status != "000" else "HTTP_STATUS_MISSING")
    connect, appconnect, starttransfer, _ = times
    if exit_code == 6:
        return "DNS_RESOLUTION_FAILED"
    if exit_code == 7:
        return "TCP_CONNECT_FAILED"
    if exit_code == 28:
        if connect == 0:
            return "TCP_CONNECT_TIMEOUT"
        if appconnect == 0:
            return "TLS_HANDSHAKE_TIMEOUT"
        if starttransfer == 0:
            return "HTTP_FIRST_BYTE_TIMEOUT"
        return "HTTP_TRANSFER_TIMEOUT"
    if exit_code in {35, 51, 58, 60, 77}:
        return "TLS_OR_CA_FAILURE"
    if exit_code in {52, 55, 56}:
        return "CONNECTION_CLOSED_OR_RESET"
    return "CURL_TRANSPORT_FAILURE"


def parse_curl_probe(exit_code: int, raw: str) -> CurlProbe:
    if type(exit_code) is not int or not 0 <= exit_code <= 255:
        raise ValueError("curl_exit_invalid")
    fields = raw.strip().split("|")
    if len(fields) != 5 or not re.fullmatch(r"[0-9]{3}", fields[0]):
        raise ValueError("curl_writeout_invalid")
    times = []
    for field in fields[1:]:
        try:
            number = float(field)
        except ValueError as error:
            raise ValueError("curl_timing_invalid") from error
        if not math.isfinite(number) or number < 0:
            raise ValueError("curl_timing_invalid")
        times.append(number)
    timings = tuple(times)
    status = fields[0]
    return CurlProbe(exit_code, status, timings, _curl_phase(exit_code, status, timings))


def _models_body_state(path: str) -> tuple[str, str, str, int | None]:
    """Validate only the OpenAI-compatible envelope and safe model identifiers."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return "UNAVAILABLE", "UNKNOWN", "UNKNOWN", None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return "UNAVAILABLE", "UNKNOWN", "UNKNOWN", None
        if info.st_size > MAX_MODELS_RESPONSE_BYTES:
            return "OVERSIZE", "UNKNOWN", "UNKNOWN", None
        chunks = bytearray()
        while len(chunks) <= MAX_MODELS_RESPONSE_BYTES:
            block = os.read(descriptor, min(65536, MAX_MODELS_RESPONSE_BYTES + 1 - len(chunks)))
            if not block:
                break
            chunks.extend(block)
        if len(chunks) > MAX_MODELS_RESPONSE_BYTES:
            return "OVERSIZE", "UNKNOWN", "UNKNOWN", None
    finally:
        os.close(descriptor)

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate_json_key")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("nonstandard_json_constant")

    try:
        value = json.loads(chunks.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (UnicodeDecodeError, ValueError):
        return "INVALID", "NOT_CHECKED", "UNKNOWN", None
    if not isinstance(value, dict):
        return "VALID", "INVALID", "UNKNOWN", None
    if value.get("object") != "list" or not isinstance(value.get("data"), list):
        return "VALID", "INVALID", "UNKNOWN", None
    models = value["data"]
    if any(not isinstance(model, dict) or not isinstance(model.get("id"), str) or not model["id"].strip() for model in models):
        return "VALID", "INVALID", "INVALID", None
    count = len(models)
    return "VALID", "PASS", "PRESENT" if count else "EMPTY", count


def models_response_report(exit_code: int, curl_output: str, body_file: str) -> tuple[str, bool]:
    """Return a secret-free status line and whether the catalog is usable."""
    probe = parse_curl_probe(exit_code, curl_output)
    json_state, schema_state, models_state, count = "NOT_CHECKED", "NOT_CHECKED", "UNKNOWN", None
    if probe.exit_code == 0 and probe.http_status == "200":
        json_state, schema_state, models_state, count = _models_body_state(body_file)
    count_text = str(count) if count is not None else "UNKNOWN"
    success = (
        probe.exit_code == 0
        and probe.http_status == "200"
        and probe.phase == "HTTP_200"
        and json_state == "VALID"
        and schema_state == "PASS"
        and models_state == "PRESENT"
    )
    result = "PASS" if success else "FAIL"
    return (
        f"OMNIROUTE_MODELS={result} curl_exit={probe.exit_code} phase={probe.phase} "
        f"http_status={probe.http_status} json={json_state} schema={schema_state} "
        f"models={models_state} count={count_text}",
        success,
    )


def report_models(args: argparse.Namespace) -> int:
    try:
        receipt, success = models_response_report(args.curl_exit, args.curl_output, args.body_file)
    except (OSError, ValueError):
        print("OMNIROUTE_MODELS=UNKNOWN phase=DIAGNOSTICS_INPUT_INVALID curl_exit=UNKNOWN http_status=UNKNOWN json=UNKNOWN schema=UNKNOWN models=UNKNOWN count=UNKNOWN")
        return 2
    print(receipt)
    return 0 if success else 1


def _parse_inner(exit_code: int, raw: str) -> str:
    if type(exit_code) is not int or not 0 <= exit_code <= 255:
        return "UNKNOWN"
    try:
        value = _json_object(raw)
    except (json.JSONDecodeError, ValueError):
        return "UNAVAILABLE" if exit_code else "UNKNOWN"
    required = {"phase", "status", "errorCode", "timeConnect", "timeAppconnect", "timeTotal"}
    if set(value) != required:
        return "UNKNOWN"
    phase = value["phase"]
    status = value["status"]
    error = value["errorCode"]
    if phase not in {"http", "connect", "tls", "timeout", "input"}:
        return "UNKNOWN"
    if status is not None and (type(status) is not int or not 100 <= status <= 599):
        return "UNKNOWN"
    if error is not None and (not isinstance(error, str) or not re.fullmatch(r"[A-Z0-9_]{1,48}", error)):
        return "UNKNOWN"
    for key in ("timeConnect", "timeAppconnect", "timeTotal"):
        number = value[key]
        if type(number) not in {int, float} or not math.isfinite(number) or number < 0:
            return "UNKNOWN"
    if status is not None:
        return f"HTTP_{status}"
    if phase == "connect":
        return "TCP_CONNECT_FAILED"
    if phase == "tls":
        return "TLS_OR_CA_FAILURE"
    if phase == "timeout":
        return "TIMEOUT"
    return "UNKNOWN"


def _host_input_delta(before: str, after: str, after_exit: int) -> str:
    if after_exit != 0:
        return "unknown"
    try:
        first = _json_object(before).get("blocked_host_input")
        last = _json_object(after).get("blocked_host_input")
    except (json.JSONDecodeError, ValueError):
        return "unknown"
    if any(type(value) is not int or value < 0 for value in (first, last)) or last < first:
        return "unknown"
    return "observed" if last > first else "unchanged"


def build_curl_config(ca_file: str, env_file: str, edge_address: str) -> str:
    try:
        edge_ip = ipaddress.IPv4Address(edge_address)
    except ipaddress.AddressValueError as error:
        raise ValueError("edge_address_invalid") from error
    if not edge_ip.is_private or edge_ip.is_loopback or edge_ip.is_link_local:
        raise ValueError("edge_address_not_candidate_private_ipv4")
    if not re.fullmatch(r"/[A-Za-z0-9_./-]{1,255}", ca_file):
        raise ValueError("ca_path_invalid")
    with open(ca_file, "r", encoding="ascii") as stream:
        ca = stream.read(65537)
    if len(ca) > 65536 or "-----BEGIN CERTIFICATE-----" not in ca or "-----END CERTIFICATE-----" not in ca:
        raise ValueError("ca_file_invalid")
    with open(env_file, "r", encoding="ascii") as stream:
        rows = stream.read(8193).splitlines()
    prefix = "OMNIROUTE_PROXY_TOKEN="
    tokens = [row[len(prefix):] for row in rows if row.startswith(prefix)]
    if len(rows) != 1 or len(tokens) != 1 or not re.fullmatch(r"[A-Fa-f0-9]{64,4096}", tokens[0]):
        raise ValueError("proxy_auth_material_invalid")
    return "\n".join((
        "silent",
        'output = "/dev/null"',
        'write-out = "%{http_code}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}"',
        f'cacert = "{ca_file}"',
        f'connect-to = "127.0.0.1:8443:{edge_ip}:8443"',
        f'header = "Authorization: Bearer {tokens[0]}"',
        'url = "https://127.0.0.1:8443/healthz"',
        'noproxy = "*"',
        "connect-timeout = 1",
        "max-time = 3",
    )) + "\n"


def classify_failure(
    port_snapshot: str,
    curl_exit: int,
    curl_output: str,
    backend_exit: int,
    backend_output: str,
    edge_exit: int,
    edge_output: str,
    auth_edge_exit: int,
    auth_edge_output: str,
    counter_before: str = "",
    counter_after: str = "",
    counter_after_exit: int = 1,
) -> str:
    try:
        configured, active = port_publication(port_snapshot)
    except (json.JSONDecodeError, ValueError):
        return "PORT_SNAPSHOT_UNKNOWN"
    if not configured:
        return "DOCKER_PORT_BINDING_MISMATCH"
    if not active:
        return "DOCKER_RUNTIME_PORT_UNPUBLISHED"
    loopback = parse_curl_probe(curl_exit, curl_output)
    backend = _parse_inner(backend_exit, backend_output)
    edge = _parse_inner(edge_exit, edge_output)
    auth_edge = parse_curl_probe(auth_edge_exit, auth_edge_output)
    host_drop = _host_input_delta(counter_before, counter_after, counter_after_exit)
    if backend != "HTTP_200":
        return "BACKEND_UNREACHABLE" if backend in {"UNAVAILABLE", "TCP_CONNECT_FAILED", "TIMEOUT"} else "BACKEND_NOT_READY_OR_HTTP_ERROR"
    if edge in {"UNAVAILABLE", "TCP_CONNECT_FAILED", "TIMEOUT"}:
        return "CADDY_UNREACHABLE"
    if edge == "TLS_OR_CA_FAILURE":
        return "DIRECT_EDGE_TLS_OR_CA_FAILURE"
    if edge == "HTTP_200":
        return "CADDY_AUTH_GUARD_NOT_ENFORCED"
    if edge != "HTTP_401":
        return "CADDY_OR_UPSTREAM_HTTP_ERROR"
    if auth_edge.phase != "HTTP_200":
        if auth_edge.phase == "HTTP_401_AUTH":
            return "EDGE_AUTHENTICATION_REJECTED"
        if auth_edge.phase in {"TCP_CONNECT_FAILED", "TCP_CONNECT_TIMEOUT", "TLS_HANDSHAKE_TIMEOUT"} and host_drop == "observed":
            return "HOST_INPUT_FIREWALL_DROP_CORRELATED"
        return "DIRECT_EDGE_AUTHENTICATED_PATH_FAILURE"
    if loopback.phase == "HTTP_401_AUTH":
        return "HOST_ENDPOINT_AUTH_REJECTED"
    if loopback.phase == "HTTP_403_FORBIDDEN":
        return "HOST_ENDPOINT_FORBIDDEN"
    if loopback.phase == "HTTP_502_UPSTREAM":
        return "HOST_ENDPOINT_UPSTREAM_ERROR"
    if loopback.phase == "HTTP_503_BACKEND_NOT_READY":
        return "HOST_ENDPOINT_BACKEND_NOT_READY"
    if loopback.phase == "HTTP_FIRST_BYTE_TIMEOUT":
        return "HOST_INPUT_FIREWALL_DROP_CORRELATED" if host_drop == "observed" else "HTTP_PROXY_FIRST_BYTE_TIMEOUT"
    if loopback.phase == "HTTP_TRANSFER_TIMEOUT":
        return "HTTP_PROXY_TRANSFER_TIMEOUT"
    if loopback.phase in {"TCP_CONNECT_FAILED", "TCP_CONNECT_TIMEOUT"}:
        return "HOST_INPUT_FIREWALL_DROP_CORRELATED" if host_drop == "observed" else "HOST_PUBLISHED_PATH_UNRESOLVED"
    if loopback.phase == "TLS_OR_CA_FAILURE" or loopback.phase == "TLS_HANDSHAKE_TIMEOUT":
        return "HOST_ENDPOINT_TLS_OR_CA_FAILURE"
    return "HOST_ENDPOINT_FAILURE_WITH_INNER_HEALTH_PASS"


def _format_seconds(value: float) -> str:
    return f"{value:.3f}"


def report_failure(args: argparse.Namespace) -> int:
    try:
        configured, active = port_publication(args.port_snapshot)
        loopback = parse_curl_probe(args.curl_exit, args.curl_output)
    except (json.JSONDecodeError, ValueError):
        print("OMNIROUTE_TLS_DIAGNOSTIC=FAIL phase=INPUT_INVALID")
        return 1
    backend = _parse_inner(args.backend_exit, args.backend_output)
    edge = _parse_inner(args.edge_exit, args.edge_output)
    auth_edge = parse_curl_probe(args.auth_edge_curl_exit, args.auth_edge_curl_output)
    host_drop = _host_input_delta(args.counter_before, args.counter_after, args.counter_after_exit)
    overall = classify_failure(
        args.port_snapshot, args.curl_exit, args.curl_output,
        args.backend_exit, args.backend_output, args.edge_exit, args.edge_output,
        args.auth_edge_curl_exit, args.auth_edge_curl_output,
        args.counter_before, args.counter_after, args.counter_after_exit,
    )
    connect, appconnect, starttransfer, total = loopback.times
    print(
        "OMNIROUTE_TLS_HEALTH=FAIL "
        f"phase={loopback.phase} curl_exit={loopback.exit_code} http_status={loopback.http_status} "
        f"time_connect={_format_seconds(connect)} time_appconnect={_format_seconds(appconnect)} "
        f"time_starttransfer={_format_seconds(starttransfer)} time_total={_format_seconds(total)}"
    )
    port_config = "PASS" if configured else "FAIL"
    port_runtime = "PASS" if active else "FAIL"
    print(
        "OMNIROUTE_TLS_COMPONENTS=FAIL "
        f"classification={overall} host_port_config={port_config} host_port_runtime={port_runtime} "
        f"backend={backend} edge_tls_noauth={edge} direct_edge_auth={auth_edge.phase} host_input_drop={host_drop}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    edge_ip = subparsers.add_parser("edge-ip")
    edge_ip.add_argument("--edge-snapshot", required=True)
    edge_ip.add_argument("--network-snapshot", required=True)
    edge_ip.add_argument("--expected-edge-id", required=True)
    edge_ip.add_argument("--expected-network-id", required=True)
    edge_ip.add_argument("--network-name", required=True)
    edge_ip.add_argument("--expected-subnet")
    ports = subparsers.add_parser("ports")
    ports.add_argument("--snapshot", required=True)
    config = subparsers.add_parser("curl-config")
    config.add_argument("--ca-file", required=True)
    config.add_argument("--env-file", required=True)
    config.add_argument("--edge-address", required=True)
    failure = subparsers.add_parser("failure")
    failure.add_argument("--port-snapshot", required=True)
    failure.add_argument("--curl-exit", type=int, required=True)
    failure.add_argument("--curl-output", required=True)
    failure.add_argument("--backend-exit", type=int, required=True)
    failure.add_argument("--backend-output", required=True)
    failure.add_argument("--edge-exit", type=int, required=True)
    failure.add_argument("--edge-output", required=True)
    failure.add_argument("--auth-edge-curl-exit", type=int, required=True)
    failure.add_argument("--auth-edge-curl-output", required=True)
    failure.add_argument("--counter-before", default="")
    failure.add_argument("--counter-after", default="")
    failure.add_argument("--counter-after-exit", type=int, default=1)
    models = subparsers.add_parser("models")
    models.add_argument("--curl-exit", type=int, required=True)
    models.add_argument("--curl-output", required=True)
    models.add_argument("--body-file", required=True)
    args = parser.parse_args(argv)
    if args.command == "edge-ip":
        try:
            address = attested_edge_ipv4(
                args.edge_snapshot,
                args.network_snapshot,
                expected_edge_id=args.expected_edge_id,
                expected_network_id=args.expected_network_id,
                network_name=args.network_name,
                expected_subnet=args.expected_subnet,
            )
        except (json.JSONDecodeError, ValueError):
            print("OMNIROUTE_EDGE_IP=FAIL phase=ATTESTATION_INVALID", file=sys.stderr)
            return 1
        # This address is consumed by command substitution, not emitted by the
        # candidate's public receipt. It is never logged or used as TLS identity.
        print(address)
        return 0
    if args.command == "ports":
        try:
            configured, active = port_publication(args.snapshot)
        except (json.JSONDecodeError, ValueError):
            print("OMNIROUTE_TLS_PORTS=UNKNOWN phase=SNAPSHOT_INVALID")
            return 1
        if configured and active:
            print("OMNIROUTE_TLS_PORTS=PASS config=EXPECTED runtime=ACTIVE")
            return 0
        print(
            "OMNIROUTE_TLS_PORTS=FAIL "
            f"config={'EXPECTED' if configured else 'MISMATCH'} "
            f"runtime={'ACTIVE' if active else 'UNPUBLISHED'}"
        )
        return 1
    if args.command == "curl-config":
        try:
            sys.stdout.write(build_curl_config(args.ca_file, args.env_file, args.edge_address))
        except (OSError, UnicodeError, ValueError):
            print("OMNIROUTE_TLS_CURL_CONFIG=FAIL phase=INPUT_VALIDATION", file=sys.stderr)
            return 1
        return 0
    if args.command == "models":
        return report_models(args)
    return report_failure(args)


if __name__ == "__main__":
    raise SystemExit(main())
