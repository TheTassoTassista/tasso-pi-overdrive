#!/usr/bin/env python3
"""Allowlist-only sanitizer/classifier for the private runtime probe receipt."""

from __future__ import annotations

import argparse
import json
import sys


CHECKS = (
    "dnsViaDockerResolver",
    "publicIpv4Tcp443",
    "publicIpv4Tcp80Blocked",
    "udp443Blocked",
    "directTcpDnsBlocked",
    "directUdpDnsBlocked",
    "privateIpv4Blocked",
    "metadataIpv4Blocked",
    "dockerGatewayBlocked",
    "hostIpv4Blocked",
    "ipv6Disabled",
    "ipv6Unassigned",
    "ipv6NoDefaultRoute",
    "ipv6EgressBlocked",
)
PHASES = {
    "INPUT_VALIDATION",
    "RESOLVER_CONFIG_READ",
    "DNS_RESOLUTION",
    "PUBLIC_NETWORK_PROBES",
    "SYSCTL_READ",
    "IPV6_PROBES",
    "REPORT_SERIALIZATION",
    "UNKNOWN_PROBE_FAILURE",
    "DOCKER_EXEC",
    "NODE_LAUNCH",
    "NODE_EXECUTION",
    "PROBE_OUTPUT_VALIDATION",
    "POLICY_CHECKS",
}
COUNTER_KEYSETS = (
    frozenset({
        "blocked_host_original", "blocked_special", "blocked_host_local",
        "allowed_tcp443", "blocked_udp443", "blocked_all_other_egress",
        "blocked_host_input",
    }),
    frozenset({
        "blocked_host_original", "blocked_special", "blocked_host_local",
        "allowed_tcp443", "blocked_udp443", "blocked_tcp_other",
        "blocked_other", "blocked_host_input",
    }),
)


def classify(raw: bytes, exit_code: int) -> dict[str, object]:
    phase = "PROBE_OUTPUT_VALIDATION"
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        if exit_code == 125:
            phase = "DOCKER_EXEC"
        elif exit_code in {126, 127}:
            phase = "NODE_LAUNCH"
        else:
            phase = "NODE_EXECUTION"
        return {"status": "FAIL", "phase": phase, "checks": {}}

    if not isinstance(value, dict):
        return {"status": "FAIL", "phase": phase, "checks": {}}
    if set(value) == {"probeStatus", "phase"} and value.get("probeStatus") == "FAIL":
        reported_phase = value.get("phase")
        if reported_phase not in PHASES:
            reported_phase = "PROBE_OUTPUT_VALIDATION"
        return {"status": "FAIL", "phase": reported_phase, "checks": {}}

    checks = value.get("checks")
    if set(value) != {"probeStatus", "phase", "checks"} or value.get("probeStatus") not in {"PASS", "FAIL"} or value.get("phase") not in {"COMPLETE", "POLICY_CHECKS"}:
        return {"status": "FAIL", "phase": phase, "checks": {}}
    if not isinstance(checks, dict) or set(checks) != set(CHECKS) or any(type(checks.get(key)) is not bool for key in CHECKS):
        return {"status": "FAIL", "phase": phase, "checks": {}}
    normalized = {key: checks[key] for key in CHECKS}
    if value["phase"] == "POLICY_CHECKS" or value["probeStatus"] == "FAIL" or not all(normalized.values()):
        phase = "POLICY_CHECKS"
    elif exit_code != 0:
        phase = "NODE_EXECUTION"
    else:
        return {"status": "PASS", "phase": "COMPLETE", "checks": normalized}
    return {"status": "FAIL", "phase": phase, "checks": normalized}


def classify_counter_gate(before_raw: str, after_raw: str, after_exit_code: int, probe_raw: bytes) -> dict[str, str]:
    """Compare only bounded counter/probe JSON and return fixed safe diagnostics."""
    try:
        before = json.loads(before_raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return {"status": "FAIL", "phase": "COUNTERS_BEFORE_JSON_INVALID"}
    if not isinstance(before, dict):
        return {"status": "FAIL", "phase": "COUNTERS_BEFORE_JSON_INVALID"}
    if type(after_exit_code) is not int or after_exit_code != 0:
        return {"status": "FAIL", "phase": "COUNTERS_AFTER_COMMAND_FAILED"}
    try:
        after = json.loads(after_raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return {"status": "FAIL", "phase": "COUNTERS_AFTER_JSON_INVALID"}
    if not isinstance(after, dict):
        return {"status": "FAIL", "phase": "COUNTERS_AFTER_JSON_INVALID"}
    try:
        probe = json.loads(probe_raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"status": "FAIL", "phase": "PROBE_REPORT_JSON_INVALID"}
    if not isinstance(probe, dict):
        return {"status": "FAIL", "phase": "PROBE_REPORT_INVALID"}
    if set(probe) != {"status", "phase", "checks"} or probe.get("status") != "PASS" or probe.get("phase") != "COMPLETE":
        return {"status": "FAIL", "phase": "PROBE_REPORT_NOT_PASS"}
    checks = probe.get("checks")
    if not isinstance(checks, dict) or set(checks) != set(CHECKS) or any(type(checks.get(key)) is not bool for key in CHECKS) or not all(checks.values()):
        return {"status": "FAIL", "phase": "PROBE_CHECKS_INVALID"}

    before_keys = frozenset(before)
    after_keys = frozenset(after)
    if before_keys not in COUNTER_KEYSETS or after_keys != before_keys:
        return {"status": "FAIL", "phase": "COUNTER_SCHEMA_INVALID"}
    if any(type(value) is not int or value < 0 for value in before.values()) or any(type(value) is not int or value < 0 for value in after.values()):
        return {"status": "FAIL", "phase": "COUNTER_SCHEMA_INVALID"}

    def increased(name: str) -> bool:
        return name in before and after[name] > before[name]

    required_deltas = (
        increased("allowed_tcp443"),
        increased("blocked_tcp_other") or increased("blocked_all_other_egress"),
        increased("blocked_udp443"),
        increased("blocked_other") or increased("blocked_all_other_egress"),
        increased("blocked_special"),
        increased("blocked_host_input") or increased("blocked_host_local") or increased("blocked_host_original"),
    )
    if not all(required_deltas):
        return {"status": "FAIL", "phase": "COUNTER_DELTAS_INSUFFICIENT"}
    return {"status": "PASS", "phase": "COMPLETE"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--exit-code", type=int)
    mode.add_argument("--counter-gate", action="store_true")
    parser.add_argument("--before-json")
    parser.add_argument("--after-json")
    parser.add_argument("--after-exit-code", type=int)
    args = parser.parse_args(argv)
    if args.counter_gate:
        if args.before_json is None or args.after_json is None or args.after_exit_code is None:
            result = {"status": "FAIL", "phase": "COUNTER_VALIDATOR_ARGUMENTS_INVALID"}
        else:
            probe_raw = sys.stdin.buffer.read(65537)
            if len(probe_raw) > 65536:
                result = {"status": "FAIL", "phase": "PROBE_REPORT_TOO_LARGE"}
            else:
                result = classify_counter_gate(args.before_json, args.after_json, args.after_exit_code, probe_raw)
        print(f"OMNIROUTE_EGRESS_COUNTERS={result['status']} phase={result['phase']}")
    else:
        result = classify(sys.stdin.buffer.read(65536), args.exit_code)
        print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
