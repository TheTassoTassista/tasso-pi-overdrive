#!/usr/bin/env python3
"""Install and verify a candidate-only, runtime (non-persistent) Docker egress guard.

The helper deliberately refuses to infer the Docker firewall backend from the
host's nft/iptables frontend. It reads the live daemon-reported backend and
uses only a separately-owned nft table or the documented DOCKER-USER hook.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Sequence

EXPECTED_DOCKER_SERVER = "29.8.1"
NETWORK_LABEL = "phi.omniroute.candidate.egress"
NETWORK_LABEL_VALUE = "v1"
SPECIAL_V4 = (
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.31.196.0/24",
    "192.52.193.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "192.175.48.0/24",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "255.255.255.255/32",
    # Azure platform/metadata virtual address; other common metadata IPs are
    # included by link-local/CGNAT ranges above.
    "168.63.129.16/32",
)
IPTABLES_TARGETS = ("LOCAL", "HOSTLOCAL", "HOST_ORIGINAL", "SPECIAL", "UDP443", "TCP_OTHER", "OTHER", "ALLOW443")


class PolicyError(RuntimeError):
    pass


def _run(argv: Sequence[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(argv, input=input_text, text=True, capture_output=True, check=False)
    if result.returncode:
        # Commands carry only daemon/network identifiers, addresses and rules;
        # still avoid echoing arbitrary stderr from host utilities.
        raise PolicyError(f"command_failed:{os.path.basename(argv[0])}:{result.returncode}")
    return result.stdout


def _valid_id(value: str) -> bool:
    return bool(re.fullmatch(r"[a-f0-9]{64}", value))


def _valid_daemon_id(value: str) -> bool:
    return bool(re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", value))


def validate_runtime_facts(server_version: str, backend: str, daemon_id: str, expected_daemon_id: str, live_restore: str = "false") -> None:
    if server_version != EXPECTED_DOCKER_SERVER:
        raise PolicyError("docker_server_version_mismatch")
    if backend not in {"iptables", "nftables"}:
        raise PolicyError("docker_firewall_backend_unknown")
    if not _valid_daemon_id(daemon_id) or daemon_id != expected_daemon_id:
        raise PolicyError("docker_daemon_identity_mismatch")
    if live_restore != "false":
        raise PolicyError("docker_live_restore_must_be_disabled")


@dataclass(frozen=True)
class NetworkFacts:
    network_id: str
    bridge: str
    subnet: str
    gateway: str
    containers: tuple[str, ...]
    host_addresses: tuple[str, ...] = ()
    docker_subnets: tuple[str, ...] = ()
    egress_interface: str = ""


def validate_network_payload(payload: dict, expected_network_id: str, *, require_empty: bool) -> NetworkFacts:
    if not isinstance(payload, dict) or payload.get("Id") != expected_network_id or not _valid_id(expected_network_id):
        raise PolicyError("docker_network_identity_mismatch")
    if payload.get("Driver") != "bridge" or payload.get("Internal") is not False or payload.get("Attachable") is not False or payload.get("EnableIPv6") is not False:
        raise PolicyError("docker_network_security_mismatch")
    if (payload.get("Labels") or {}).get(NETWORK_LABEL) != NETWORK_LABEL_VALUE:
        raise PolicyError("docker_network_ownership_mismatch")
    options = payload.get("Options") or {}
    bridge = options.get("com.docker.network.bridge.name") or f"br-{expected_network_id[:12]}"
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge):
        raise PolicyError("docker_bridge_identity_invalid")
    configs = (payload.get("IPAM") or {}).get("Config") or []
    v4 = [entry for entry in configs if isinstance(entry, dict) and "." in str(entry.get("Subnet", ""))]
    if len(v4) != 1:
        raise PolicyError("docker_network_ipv4_subnet_unknown")
    try:
        subnet = ipaddress.ip_network(v4[0]["Subnet"], strict=True)
        gateway = ipaddress.ip_address(v4[0]["Gateway"])
    except (KeyError, ValueError, TypeError) as error:
        raise PolicyError("docker_network_ipam_invalid") from error
    if subnet.version != 4 or gateway not in subnet:
        raise PolicyError("docker_network_ipam_invalid")
    containers = payload.get("Containers") or {}
    if not isinstance(containers, dict):
        raise PolicyError("docker_network_endpoint_state_unknown")
    ids = tuple(sorted(containers))
    if require_empty and ids:
        raise PolicyError("docker_network_has_endpoints_before_policy")
    return NetworkFacts(expected_network_id, bridge, str(subnet), str(gateway), ids)


def policy_names(network_id: str) -> dict[str, str]:
    if not _valid_id(network_id):
        raise PolicyError("docker_network_identity_invalid")
    short = hashlib.sha256(network_id.encode("ascii")).hexdigest()[:8]
    return {
        "table": f"phi_omni_{short}",
        "main": f"PHOE{short}_MAIN",
        "input": f"PHOE{short}_INPUT",
        **{name: f"PHOE{short}_{name}" for name in IPTABLES_TARGETS},
    }


def _normalize_subnets(subnets: Sequence[str]) -> tuple[str, ...]:
    try:
        parsed = sorted({ipaddress.ip_network(value, strict=True) for value in subnets}, key=lambda network: (int(network.network_address), network.prefixlen))
    except ValueError as error:
        raise PolicyError("docker_ipv4_subnet_invalid") from error
    if len(parsed) > 512 or any(network.version != 4 for network in parsed):
        raise PolicyError("docker_ipv4_subnet_snapshot_invalid")
    return tuple(str(network) for network in parsed)


def _normalize_host_addresses(host_addresses: Sequence[str]) -> tuple[str, ...]:
    try:
        parsed = sorted({ipaddress.ip_address(value) for value in host_addresses}, key=int)
    except ValueError as error:
        raise PolicyError("host_ipv4_address_invalid") from error
    if not parsed or len(parsed) > 64 or any(address.version != 4 for address in parsed):
        raise PolicyError("host_ipv4_address_snapshot_invalid")
    return tuple(str(address) for address in parsed)


def _validate_interface(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", value) or value == "lo":
        raise PolicyError("host_egress_interface_invalid")
    return value


def render_nft_batch(network_id: str, bridge: str, subnet: str, host_addresses: Sequence[str], docker_subnets: Sequence[str] = (), egress_interface: str = "") -> str:
    names = policy_names(network_id)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge):
        raise PolicyError("docker_bridge_identity_invalid")
    egress_interface = _validate_interface(egress_interface)
    subnet = str(ipaddress.ip_network(subnet, strict=True))
    host_addresses = _normalize_host_addresses(host_addresses)
    blocked = ", ".join(sorted(set([*SPECIAL_V4, subnet, *_normalize_subnets(docker_subnets)]), key=lambda value: (int(ipaddress.ip_network(value).network_address), ipaddress.ip_network(value).prefixlen)))
    host_set = ", ".join(host_addresses)
    marker = f"phi-omni:{network_id[:12]}:"
    return (
        f"table inet {names['table']} {{\n"
        " chain forward {\n"
        "  type filter hook forward priority -10; policy accept;\n"
        f'  iifname "{bridge}" ip saddr {subnet} ct original ip daddr {{ {host_set} }} counter drop comment "{marker}blocked_host_original"\n'
        f'  iifname "{bridge}" ip saddr {subnet} ip daddr {{ {blocked} }} counter drop comment "{marker}blocked_special"\n'
        f'  iifname "{bridge}" ip saddr {subnet} fib daddr type local counter drop comment "{marker}blocked_host_local"\n'
        f'  iifname "{bridge}" ip saddr {subnet} oifname "{egress_interface}" meta nfproto ipv4 tcp dport 443 counter accept comment "{marker}allowed_tcp443"\n'
        f'  iifname "{bridge}" ip saddr {subnet} udp dport 443 counter drop comment "{marker}blocked_udp443"\n'
        f'  iifname "{bridge}" ip saddr {subnet} counter drop comment "{marker}blocked_all_other_egress"\n'
        " }\n"
        " chain input {\n"
        "  type filter hook input priority -10; policy accept;\n"
        f'  iifname "{bridge}" ip saddr {subnet} fib daddr type local counter drop comment "{marker}blocked_host_input"\n'
        " }\n"
        "}\n"
    )


def iptables_plan(network_id: str, bridge: str, subnet: str, host_addresses: Sequence[str], docker_subnets: Sequence[str] = (), egress_interface: str = "") -> list[list[str]]:
    names = policy_names(network_id)
    subnet = str(ipaddress.ip_network(subnet, strict=True))
    host_addresses = _normalize_host_addresses(host_addresses)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge):
        raise PolicyError("docker_bridge_identity_invalid")
    egress_interface = _validate_interface(egress_interface)
    main = names["main"]
    commands: list[list[str]] = []
    for target in IPTABLES_TARGETS:
        commands.append(["iptables", "-w", "-t", "filter", "-N", names[target]])
    commands.append(["iptables", "-w", "-t", "filter", "-N", names["input"]])
    commands.append(["iptables", "-w", "-t", "filter", "-N", main])
    for target in ("LOCAL", "HOSTLOCAL", "HOST_ORIGINAL", "SPECIAL", "UDP443", "TCP_OTHER", "OTHER"):
        commands.append(["iptables", "-w", "-t", "filter", "-A", names[target], "-m", "comment", "--comment", f"phi-omni:{network_id[:12]}:blocked_{target.lower()}", "-j", "DROP"])
    commands.append(["iptables", "-w", "-t", "filter", "-A", names["ALLOW443"], "-m", "comment", "--comment", f"phi-omni:{network_id[:12]}:allowed_tcp443", "-j", "ACCEPT"])
    for address in host_addresses:
        commands.append(["iptables", "-w", "-t", "filter", "-A", main, "-m", "conntrack", "--ctorigdst", address, "-j", names["HOST_ORIGINAL"]])
    commands.append(["iptables", "-w", "-t", "filter", "-A", main, "-m", "addrtype", "--dst-type", "LOCAL", "-j", names["LOCAL"]])
    for cidr in sorted(set((subnet, *SPECIAL_V4, *_normalize_subnets(docker_subnets))), key=lambda value: (int(ipaddress.ip_network(value).network_address), ipaddress.ip_network(value).prefixlen)):
        commands.append(["iptables", "-w", "-t", "filter", "-A", main, "-d", cidr, "-j", names["SPECIAL"]])
    commands.extend([
        ["iptables", "-w", "-t", "filter", "-A", main, "-o", egress_interface, "-p", "tcp", "--dport", "443", "-j", names["ALLOW443"]],
        ["iptables", "-w", "-t", "filter", "-A", main, "-p", "udp", "--dport", "443", "-j", names["UDP443"]],
        ["iptables", "-w", "-t", "filter", "-A", main, "-p", "tcp", "-j", names["TCP_OTHER"]],
        ["iptables", "-w", "-t", "filter", "-A", main, "-j", names["OTHER"]],
        ["iptables", "-w", "-t", "filter", "-A", names["input"], "-m", "addrtype", "--dst-type", "LOCAL", "-j", names["HOSTLOCAL"]],
        ["iptables", "-w", "-t", "filter", "-A", names["input"], "-j", "RETURN"],
    ])
    # Build the complete restrictive chains before installing any live hook.
    commands.extend([
        ["iptables", "-w", "-t", "filter", "-I", "DOCKER-USER", "1", "-i", bridge, "-s", subnet, "-m", "comment", "--comment", f"phi-omni:{network_id[:12]}:candidate_egress", "-j", main],
        ["iptables", "-w", "-t", "filter", "-I", "INPUT", "1", "-i", bridge, "-s", subnet, "-m", "comment", "--comment", f"phi-omni:{network_id[:12]}:blocked_host_input", "-j", names["input"]],
    ])
    return commands


def validate_route_payload(payload: list, bridge: str, subnet: str | None) -> None:
    candidate = ipaddress.ip_network(subnet, strict=True) if subnet else None
    if not isinstance(payload, list):
        raise PolicyError("host_route_snapshot_invalid")
    for route in payload:
        if not isinstance(route, dict) or route.get("dev") == bridge:
            continue
        destination = route.get("dst")
        if not destination or destination == "default":
            continue
        try:
            network = ipaddress.ip_network(destination, strict=False)
        except ValueError as error:
            raise PolicyError("host_route_entry_invalid") from error
        if candidate is not None and candidate.version == network.version and candidate.overlaps(network):
            raise PolicyError("candidate_subnet_overlaps_existing_host_route")


def _docker_facts(expected_daemon_id: str) -> tuple[str, str, str]:
    result = _run(["docker", "info", "--format", "{{.ID}}|{{.ServerVersion}}|{{if .FirewallBackend}}{{.FirewallBackend.Driver}}{{end}}|{{.LiveRestoreEnabled}}"])
    fields = result.strip().split("|")
    if len(fields) != 4:
        raise PolicyError("docker_effective_firewall_backend_unavailable")
    daemon_id, version, backend, live_restore = fields
    validate_runtime_facts(version, backend, daemon_id, expected_daemon_id, live_restore)
    return daemon_id, version, backend


def _network_facts(network_id: str, require_empty: bool) -> NetworkFacts:
    raw = _run(["docker", "network", "inspect", "--format", "{{json .}}", network_id])
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PolicyError("docker_network_inspect_invalid") from error
    validated = validate_network_payload(payload, network_id, require_empty=require_empty)
    host_addresses = _host_ipv4_addresses()
    docker_subnets, docker_bridges = _docker_network_inventory(network_id)
    if validated.subnet not in docker_subnets:
        raise PolicyError("candidate_network_missing_from_docker_subnet_snapshot")
    route_probe = _run(["ip", "-j", "route", "get", "1.1.1.1"])
    egress_interface = _effective_egress_interface(route_probe, docker_bridges)
    facts = NetworkFacts(validated.network_id, validated.bridge, validated.subnet, validated.gateway, validated.containers, host_addresses, docker_subnets, egress_interface)
    routes = _run(["ip", "-j", "route", "show", "table", "all"])
    try:
        validate_route_payload(json.loads(routes), facts.bridge, facts.subnet)
    except json.JSONDecodeError as error:
        raise PolicyError("host_route_snapshot_invalid") from error
    return facts


def _host_ipv4_addresses() -> tuple[str, ...]:
    raw = _run(["ip", "-j", "-4", "address", "show"])
    try:
        rows = json.loads(raw)
        values = {
            entry["local"]
            for interface in rows
            for entry in interface.get("addr_info", [])
            if entry.get("family") == "inet" and isinstance(entry.get("local"), str)
        }
    except (json.JSONDecodeError, AttributeError, KeyError, TypeError) as error:
        raise PolicyError("host_ipv4_address_snapshot_invalid") from error
    return _normalize_host_addresses(sorted(values))


def _effective_egress_interface(raw: str, docker_bridges: Sequence[str]) -> str:
    try:
        rows = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PolicyError("host_public_route_snapshot_invalid") from error
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise PolicyError("host_public_route_snapshot_invalid")
    interface = _validate_interface(rows[0].get("dev"))
    if interface in set(docker_bridges):
        raise PolicyError("public_egress_route_uses_docker_bridge")
    return interface


def _docker_network_inventory(candidate_id: str, *, require_candidate: bool = True) -> tuple[tuple[str, ...], tuple[str, ...]]:
    identifiers = _run(["docker", "network", "ls", "--no-trunc", "--format", "{{.ID}}"]).splitlines()
    if not identifiers or len(identifiers) > 512 or len(set(identifiers)) != len(identifiers) or any(not _valid_id(identifier) for identifier in identifiers):
        raise PolicyError("docker_network_inventory_invalid")
    subnets: set[str] = set()
    bridges: set[str] = set()
    candidate_seen = False
    for identifier in identifiers:
        raw = _run(["docker", "network", "inspect", "--format", "{{json .}}", identifier])
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            raise PolicyError("docker_network_ipam_snapshot_invalid") from error
        if not isinstance(payload, dict) or payload.get("Id") != identifier:
            raise PolicyError("docker_network_identity_snapshot_invalid")
        ipam = payload.get("IPAM")
        if ipam is None:
            ipam = {}
        if not isinstance(ipam, dict):
            raise PolicyError("docker_network_ipam_snapshot_invalid")
        configs = ipam.get("Config")
        if configs is None:
            configs = []
        if not isinstance(configs, list):
            raise PolicyError("docker_network_ipam_snapshot_invalid")
        if payload.get("Driver") == "bridge":
            options = payload.get("Options")
            if options is None:
                options = {}
            if not isinstance(options, dict):
                raise PolicyError("docker_network_bridge_snapshot_invalid")
            bridge = options.get("com.docker.network.bridge.name") or f"br-{identifier[:12]}"
            if not isinstance(bridge, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge):
                raise PolicyError("docker_network_bridge_snapshot_invalid")
            bridges.add(bridge)
        for entry in configs:
            if not isinstance(entry, dict):
                raise PolicyError("docker_network_ipam_snapshot_invalid")
            if not entry.get("Subnet"):
                continue
            try:
                network = ipaddress.ip_network(entry["Subnet"], strict=True)
            except ValueError as error:
                raise PolicyError("docker_network_ipam_snapshot_invalid") from error
            if network.version == 4:
                subnets.add(str(network))
        if identifier == candidate_id:
            candidate_seen = True
    normalized = _normalize_subnets(sorted(subnets))
    if require_candidate and not candidate_seen:
        raise PolicyError("candidate_network_missing_from_docker_inventory")
    return normalized, tuple(sorted(bridges))


def _docker_ipv4_subnets(candidate_id: str, *, require_candidate: bool = True) -> tuple[str, ...]:
    return _docker_network_inventory(candidate_id, require_candidate=require_candidate)[0]


def _iptables_apply(facts: NetworkFacts) -> None:
    plan = iptables_plan(facts.network_id, facts.bridge, facts.subnet, facts.host_addresses, facts.docker_subnets, facts.egress_interface)
    # First ensure both documented user hooks exist. No Docker-managed chain is
    # edited; the final rules are isolated custom chains plus DOCKER-USER hooks.
    _run(["iptables", "-w", "-t", "filter", "-S", "DOCKER-USER"])
    # Reject partial/stale same-ID state instead of appending/retrying.
    names = policy_names(facts.network_id)
    existing = _run(["iptables", "-w", "-t", "filter", "-S"])
    if any(name in existing for name in names.values()):
        raise PolicyError("iptables_policy_objects_already_exist")
    for command in plan:
        _run(command)


def _nft_apply(facts: NetworkFacts) -> None:
    names = policy_names(facts.network_id)
    listed = subprocess.run(["nft", "list", "table", "inet", names["table"]], text=True, capture_output=True, check=False)
    if listed.returncode == 0:
        raise PolicyError("nft_policy_table_already_exists")
    if listed.returncode not in {1}:
        raise PolicyError("nft_policy_table_state_unknown")
    _run(["nft", "-f", "-"], input_text=render_nft_batch(facts.network_id, facts.bridge, facts.subnet, facts.host_addresses, facts.docker_subnets, facts.egress_interface))


def _verify_iptables(network_id: str, facts: NetworkFacts) -> None:
    names = policy_names(network_id)
    docker_user = _run(["iptables", "-w", "-t", "filter", "-S", "DOCKER-USER"]).splitlines()
    input_rules = _run(["iptables", "-w", "-t", "filter", "-S", "INPUT"]).splitlines()
    forward_hooks = [line for line in docker_user if line.startswith("-A ")]
    expected_forward = f"-A DOCKER-USER -i {facts.bridge} -s {facts.subnet} -m comment --comment phi-omni:{network_id[:12]}:candidate_egress -j {names['main']}"
    if not forward_hooks or forward_hooks[0] != expected_forward:
        raise PolicyError("iptables_forward_hook_missing")
    expected_input = f"-A INPUT -i {facts.bridge} -s {facts.subnet} -m comment --comment phi-omni:{network_id[:12]}:blocked_host_input -j {names['input']}"
    input_hooks = [line for line in input_rules if line.startswith("-A INPUT ")]
    if not input_hooks or input_hooks[0] != expected_input:
        raise PolicyError("iptables_host_input_hook_missing")
    expected = iptables_plan(network_id, facts.bridge, facts.subnet, facts.host_addresses, facts.docker_subnets, facts.egress_interface)
    created = {names[key] for key in IPTABLES_TARGETS} | {names["main"], names["input"]}
    for chain in created:
        actual = _run(["iptables", "-w", "-t", "filter", "-S", chain]).splitlines()
        wanted = ["-N " + chain]
        wanted.extend("-A " + " ".join(args[args.index("-A") + 1:]) for args in expected if "-A" in args and args[args.index("-A") + 1] == chain)
        if actual != wanted:
            raise PolicyError("iptables_custom_chain_mismatch")


def _verify_nft(network_id: str, facts: NetworkFacts) -> None:
    table = policy_names(network_id)["table"]
    raw = _run(["nft", "--numeric", "list", "table", "inet", table])
    lines = [" ".join(line.strip().split()) for line in raw.splitlines() if line.strip()]
    if not lines or lines[0] != f"table inet {table} {{" or lines[-1] != "}":
        raise PolicyError("nft_policy_table_identity_mismatch")
    def parse_table(table_lines: list[str], *, rendered: bool) -> dict[str, tuple[str, list[str]]]:
        result: dict[str, tuple[str, list[str]]] = {}
        current: str | None = None
        header: str | None = None
        rules: list[str] = []
        for line in table_lines[1:-1]:
            if line.startswith("chain ") and line.endswith(" {"):
                if current is not None:
                    raise PolicyError("nft_policy_chain_nesting_invalid")
                current = line[len("chain "):-2]
                if current in result:
                    raise PolicyError("nft_policy_chain_set_mismatch")
                header = None
                rules = []
            elif line == "}" and current is not None:
                if header is None:
                    raise PolicyError("nft_policy_hook_mismatch")
                result[current] = (header, rules)
                current = None
            elif current is not None and line.startswith("type filter hook "):
                if header is not None:
                    raise PolicyError("nft_policy_hook_mismatch")
                header = line.rstrip(";")
                if not rendered:
                    expected_prefix = f"type filter hook {current} priority "
                    allowed = (f"{expected_prefix}-10", f"{expected_prefix}filter - 10")
                    if not any(header.startswith(prefix) for prefix in allowed) or not header.endswith("policy accept"):
                        raise PolicyError("nft_policy_hook_mismatch")
            elif current is not None:
                if header is None:
                    raise PolicyError("nft_policy_hook_mismatch")
                normalized = re.sub(r"counter packets [0-9]+ bytes [0-9]+", "counter", line)
                rules.append(" ".join(normalized.rstrip(";").split()))
            else:
                raise PolicyError("nft_policy_object_set_mismatch")
        if current is not None:
            raise PolicyError("nft_policy_chain_nesting_invalid")
        return result

    expected_lines = [" ".join(line.strip().split()) for line in render_nft_batch(network_id, facts.bridge, facts.subnet, facts.host_addresses, facts.docker_subnets, facts.egress_interface).splitlines() if line.strip()]
    actual = parse_table(lines, rendered=False)
    expected = parse_table(expected_lines, rendered=True)
    if set(actual) != {"forward", "input"} or set(expected) != {"forward", "input"}:
        raise PolicyError("nft_policy_chain_set_mismatch")
    for name in ("forward", "input"):
        actual_header, actual_rules = actual[name]
        expected_header, expected_rules = expected[name]
        if name not in actual_header:
            raise PolicyError("nft_policy_hook_mismatch")
        if "priority -10" not in expected_header or "policy accept" not in actual_header:
            raise PolicyError("nft_policy_hook_mismatch")
        if actual_rules != expected_rules:
            raise PolicyError("nft_policy_rule_semantics_mismatch")


def _counter_snapshot(network_id: str, facts: NetworkFacts, backend: str) -> dict[str, int]:
    names = policy_names(network_id)
    if backend == "nftables":
        raw = _run(["nft", "--numeric", "list", "table", "inet", names["table"]])
        # nft's human-readable counters are parsed below; keep the parser
        # conservative and require exactly one counter for every owned rule.
        result = {}
        for line in raw.splitlines():
            comment = re.search(r'comment "phi-omni:' + re.escape(network_id[:12]) + r':([a-z0-9_]+)"', line)
            counter = re.search(r"counter packets ([0-9]+) bytes [0-9]+", line)
            if comment and counter:
                result[comment.group(1)] = int(counter.group(1))
        required = {"blocked_host_original", "blocked_special", "blocked_host_local", "allowed_tcp443", "blocked_udp443", "blocked_all_other_egress", "blocked_host_input"}
        if set(result) != required:
            raise PolicyError("nft_policy_counters_incomplete")
        return result

    def packets(chain: str, family: str = "iptables") -> int:
        output = _run([family, "-w", "-t", "filter", "-nvxL", chain])
        for line in output.splitlines():
            fields = line.split()
            if len(fields) >= 3 and fields[0].isdigit() and fields[1].isdigit() and fields[2] in {"DROP", "ACCEPT", "RETURN"}:
                return int(fields[0])
        raise PolicyError("iptables_policy_counter_unavailable")

    return {
        "blocked_special": packets(names["SPECIAL"]),
        "blocked_host_local": packets(names["LOCAL"]),
        "blocked_host_original": packets(names["HOST_ORIGINAL"]),
        "allowed_tcp443": packets(names["ALLOW443"]),
        "blocked_udp443": packets(names["UDP443"]),
        "blocked_tcp_other": packets(names["TCP_OTHER"]),
        "blocked_other": packets(names["OTHER"]),
        "blocked_host_input": packets(names["HOSTLOCAL"]),
    }


def _main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "apply", "verify", "counters", "rollback"))
    parser.add_argument("--network-id")
    parser.add_argument("--daemon-id", required=True)
    parser.add_argument("--bridge")
    parser.add_argument("--subnet")
    parser.add_argument("--egress-interface")
    parser.add_argument("--expect-empty", action="store_true")
    parser.add_argument("--expected-endpoint-id")
    args = parser.parse_args(argv)
    if not _valid_daemon_id(args.daemon_id):
        raise PolicyError("identity_argument_invalid")
    if os.geteuid() != 0:
        raise PolicyError("authorized_host_root_required")
    _, _, backend = _docker_facts(args.daemon_id)
    if args.action == "preflight":
        for command in ("docker", "ip"):
            if shutil.which(command) is None:
                raise PolicyError(f"required_command_unavailable:{command}")
        if backend == "nftables":
            if shutil.which("nft") is None:
                raise PolicyError("nft_command_unavailable")
        else:
            if shutil.which("iptables") is None:
                raise PolicyError("iptables_command_unavailable")
            _run(["iptables", "-w", "-t", "filter", "-S", "DOCKER-USER"])
        host_addresses = _host_ipv4_addresses()
        routes_raw = _run(["ip", "-j", "route", "show", "table", "all"])
        try:
            validate_route_payload(json.loads(routes_raw), "", None)
        except json.JSONDecodeError as error:
            raise PolicyError("host_route_snapshot_invalid") from error
        route = _run(["ip", "-j", "route", "get", "1.1.1.1"])
        _, docker_bridges = _docker_network_inventory("0" * 64, require_candidate=False)
        egress = _effective_egress_interface(route, docker_bridges)
        print(f"OMNIROUTE_EGRESS_POLICY=READY backend={backend} host_ipv4_count={len(host_addresses)} egress={egress}")
        return 0
    if not _valid_id(args.network_id):
        raise PolicyError("network_identity_argument_invalid")
    if args.action == "apply":
        facts = _network_facts(args.network_id, require_empty=True)
        if _run(["docker", "network", "inspect", "--format", "{{.Name}}", args.network_id]).strip() != "phi-omniroute-egress-candidate-v1":
            raise PolicyError("docker_network_name_mismatch")
        _, _, backend = _docker_facts(args.daemon_id)
        if backend == "nftables":
            _nft_apply(facts)
            _verify_nft(args.network_id, facts)
        else:
            _iptables_apply(facts)
            _verify_iptables(args.network_id, facts)
        print(f"OMNIROUTE_EGRESS_POLICY=APPLIED backend={backend} network={args.network_id[:12]} bridge={facts.bridge} subnet={facts.subnet} gateway={facts.gateway} egress={facts.egress_interface}")
        return 0
    if args.action == "verify":
        facts = _network_facts(args.network_id, require_empty=args.expect_empty)
        if args.expected_endpoint_id and facts.containers != (args.expected_endpoint_id,):
            raise PolicyError("docker_network_endpoint_identity_mismatch")
        _, _, backend = _docker_facts(args.daemon_id)
        if backend == "nftables":
            _verify_nft(args.network_id, facts)
        else:
            _verify_iptables(args.network_id, facts)
        print(f"OMNIROUTE_EGRESS_POLICY=VERIFIED backend={backend} network={args.network_id[:12]}")
        return 0
    if args.action == "counters":
        facts = _network_facts(args.network_id, require_empty=False)
        if args.expected_endpoint_id and facts.containers != (args.expected_endpoint_id,):
            raise PolicyError("docker_network_endpoint_identity_mismatch")
        _, _, backend = _docker_facts(args.daemon_id)
        if backend == "nftables":
            _verify_nft(args.network_id, facts)
        else:
            _verify_iptables(args.network_id, facts)
        print(json.dumps(_counter_snapshot(args.network_id, facts, backend), sort_keys=True))
        return 0
    # Rollback never removes rules while a network that could acquire a new
    # endpoint exists. The operator must first remove this exact candidate's
    # containers and network; Docker's network removal serializes that step.
    listed = _run(["docker", "network", "ls", "--no-trunc", "--filter", f"id={args.network_id}", "--format", "{{.ID}}"])
    if args.network_id in listed.splitlines():
        raise PolicyError("rollback_refused_candidate_network_still_exists")
    candidates = _run(["docker", "container", "ls", "--all", "--no-trunc", "--filter", f"label={NETWORK_LABEL}={NETWORK_LABEL_VALUE}", "--format", "{{.ID}}"])
    if candidates.strip():
        raise PolicyError("rollback_refused_candidate_containers_still_exist")
    _, _, backend = _docker_facts(args.daemon_id)
    if backend == "nftables":
        if not args.bridge or not args.subnet:
            raise PolicyError("rollback_bridge_and_subnet_required")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", args.bridge):
            raise PolicyError("rollback_bridge_invalid")
        if not args.egress_interface:
            raise PolicyError("rollback_egress_interface_required")
        facts = NetworkFacts(args.network_id, args.bridge, str(ipaddress.ip_network(args.subnet, strict=True)), "0.0.0.0", (), _host_ipv4_addresses(), _docker_ipv4_subnets(args.network_id, require_candidate=False), _validate_interface(args.egress_interface))
        _verify_nft(args.network_id, facts)
        _run(["nft", "delete", "table", "inet", policy_names(args.network_id)["table"]])
    else:
        if not args.bridge or not args.subnet:
            raise PolicyError("rollback_bridge_and_subnet_required")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", args.bridge):
            raise PolicyError("rollback_bridge_invalid")
        if not args.egress_interface:
            raise PolicyError("rollback_egress_interface_required")
        facts = NetworkFacts(args.network_id, args.bridge, str(ipaddress.ip_network(args.subnet, strict=True)), "0.0.0.0", (), _host_ipv4_addresses(), _docker_ipv4_subnets(args.network_id, require_candidate=False), _validate_interface(args.egress_interface))
        _verify_iptables(args.network_id, facts)
        names = policy_names(args.network_id)
        _run(["iptables", "-w", "-t", "filter", "-D", "DOCKER-USER", "-i", facts.bridge, "-s", facts.subnet, "-m", "comment", "--comment", f"phi-omni:{args.network_id[:12]}:candidate_egress", "-j", names["main"]])
        _run(["iptables", "-w", "-t", "filter", "-D", "INPUT", "-i", facts.bridge, "-s", facts.subnet, "-m", "comment", "--comment", f"phi-omni:{args.network_id[:12]}:blocked_host_input", "-j", names["input"]])
        for chain in (names["main"], names["input"], names["LOCAL"], names["HOSTLOCAL"], names["HOST_ORIGINAL"], names["SPECIAL"], names["UDP443"], names["TCP_OTHER"], names["OTHER"], names["ALLOW443"]):
            _run(["iptables", "-w", "-t", "filter", "-F", chain])
            _run(["iptables", "-w", "-t", "filter", "-X", chain])
    print(f"OMNIROUTE_EGRESS_POLICY=ROLLED_BACK backend={backend} network={args.network_id[:12]}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except PolicyError as error:
        print(f"OMNIROUTE_EGRESS_POLICY=FAIL reason={error}", file=sys.stderr)
        raise SystemExit(1)
