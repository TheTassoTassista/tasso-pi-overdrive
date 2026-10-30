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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exit-code", type=int, required=True)
    args = parser.parse_args(argv)
    result = classify(sys.stdin.buffer.read(65536), args.exit_code)
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
