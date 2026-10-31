#!/usr/bin/env python3
"""Install and verify a candidate-only, runtime (non-persistent) Docker egress guard.

The helper deliberately refuses to infer the Docker firewall backend from the
host's nft/iptables frontend. It reads the live daemon-reported backend and
uses only a separately-owned nft table or the documented DOCKER-USER hook.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Sequence

EXPECTED_DOCKER_SERVER = "29.8.1"
NETWORK_LABEL = "phi.omniroute.candidate.egress"
NETWORK_LABEL_VALUE = "v1"
RECOVERY_DAEMON_ID = "b64b0d52-95ab-4b1a-a971-5f09a4d6e36d"
RECOVERY_NETWORK_ID = "a2428c56b520dabc38140474ff2559bcfc50a84587ab4953460b1fd80445ae0f"
RECOVERY_EDGE_ID = "f31a9d41602d7321cf080974bf00ca550551528d620453346ee0186d8f18f83e"
RECOVERY_LEGACY_BACKEND_ID = "b5c5de6334a53acb5f4a127f5d60734ca61890b6a684271d0df288444294b74d"
RECOVERY_AUTH_BACKEND_ID = "b225f9f2456449c7f6287713baa67f1de203f63ec864fd165f468468851c0f02"
RECOVERY_NETWORK_NAME = "phi-omniroute-egress-candidate-v1"
RECOVERY_BRIDGE = "br-a2428c56b520"
RECOVERY_SUBNET = "172.19.0.0/16"
RECOVERY_EDGE_NAME = "phi-omniroute-egress-edge-v1"
RECOVERY_LEGACY_BACKEND_NAME = "phi-omniroute-egress-backend-v1"
RECOVERY_AUTH_BACKEND_NAME = "phi-omniroute-egress-backend-auth-v1"
RECOVERY_OMNI_IMAGE = "diegosouzapw/omniroute@sha256:085c57adf499a8aaa9f35ccde95c0df9c11bd9ecd18d6c9edbf3b68b8079ba9d"
RECOVERY_CADDY_IMAGE = "docker.io/library/caddy@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f"
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
    if len(configs) != 1 or not isinstance(configs[0], dict) or "." not in str(configs[0].get("Subnet", "")):
        raise PolicyError("docker_network_ipv4_subnet_unknown")
    try:
        subnet = ipaddress.ip_network(configs[0]["Subnet"], strict=True)
        gateway = ipaddress.ip_address(configs[0]["Gateway"])
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


def render_nft_batch(network_id: str, bridge: str, subnet: str, host_addresses: Sequence[str], docker_subnets: Sequence[str] = (), egress_interface: str = "", *, established_reply: bool = True) -> str:
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
        + (
            f'  iifname "{bridge}" ip saddr {subnet} fib daddr type local meta l4proto tcp ct state established ct direction reply return comment "{marker}allowed_host_reply"\n'
            if established_reply else ""
        )
        + f'  iifname "{bridge}" ip saddr {subnet} fib daddr type local counter drop comment "{marker}blocked_host_input"\n'
        + " }\n"
        "}\n"
    )


def _iptables_input_reply_rule(network_id: str, bridge: str, subnet: str) -> list[str]:
    # Return only established TCP replies arriving on this network's attested
    # bridge/source range and destined to a host-local address. RETURN resumes
    # the host's ordinary INPUT rules; it never ACCEPTs a new candidate flow.
    names = policy_names(network_id)
    return [
        "iptables", "-w", "-t", "filter", "-A", names["input"],
        "-i", bridge, "-s", subnet, "-p", "tcp",
        "-m", "conntrack", "--ctstate", "ESTABLISHED", "--ctdir", "REPLY",
        "-m", "addrtype", "--dst-type", "LOCAL",
        "-m", "comment", "--comment", f"phi-omni:{network_id[:12]}:allowed_host_reply",
        "-j", "RETURN",
    ]


def iptables_plan(network_id: str, bridge: str, subnet: str, host_addresses: Sequence[str], docker_subnets: Sequence[str] = (), egress_interface: str = "", *, established_reply: bool = True) -> list[list[str]]:
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
        *([_iptables_input_reply_rule(network_id, bridge, subnet)] if established_reply else []),
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


_IPTABLES_RULE_OPTIONS = frozenset({
    "-i", "-o", "-s", "-d", "-p", "-m", "--comment", "--ctorigdst", "--ctorigdstport",
    "--ctstate", "--ctdir", "--dst-type", "--dport", "-j",
})


def _iptables_rule_semantics(rule: str | Sequence[str], *, expected_chain: str | None = None) -> tuple[str, tuple[tuple[str, str], ...]]:
    """Parse one iptables-save/-S rule and normalize option order only.

    The parser intentionally accepts only the option vocabulary emitted by
    ``iptables_plan``. It strips shell quoting (notably around comments),
    preserves all values and duplicates, and rejects unknown or valueless
    arguments instead of treating a different rule as equivalent.
    """
    try:
        tokens = shlex.split(rule, posix=True) if isinstance(rule, str) else list(rule)
    except ValueError as error:
        raise PolicyError("iptables_rule_quoting_invalid") from error
    if len(tokens) < 4 or tokens[0] != "-A" or not re.fullmatch(r"[A-Za-z0-9_.-]{1,28}", tokens[1]):
        raise PolicyError("iptables_rule_shape_invalid")
    chain = tokens[1]
    if expected_chain is not None and chain != expected_chain:
        raise PolicyError("iptables_rule_chain_mismatch")
    arguments = tokens[2:]
    if len(arguments) % 2:
        raise PolicyError("iptables_rule_arity_invalid")
    pairs = []
    for index in range(0, len(arguments), 2):
        option, value = arguments[index:index + 2]
        if option not in _IPTABLES_RULE_OPTIONS or not value or value.startswith("-") and option != "--comment":
            raise PolicyError("iptables_rule_option_invalid")
        pairs.append((option, value))
    single_value_options = [option for option, _ in pairs if option != "-m"]
    modules = [value for option, value in pairs if option == "-m"]
    if len(set(single_value_options)) != len(single_value_options) or len(set(modules)) != len(modules):
        raise PolicyError("iptables_rule_duplicate_option")
    # xtables may serialize the protocol extension explicitly even when the
    # plan's ``-p tcp/udp --dport`` already loads it implicitly. Treat only a
    # matching explicit module as redundant; a mismatched or extra module
    # remains in the semantic tuple and therefore fails exact comparison.
    pair_set = set(pairs)
    protocol = next((value for option, value in pairs if option == "-p"), None)
    for module in ("tcp", "udp"):
        if ("-m", module) in pair_set and protocol == module and any(option == "--dport" for option, _ in pairs):
            pairs.remove(("-m", module))
    return chain, tuple(sorted(pairs))


def _iptables_chain_rules(raw: str, chain: str) -> list[tuple[str, tuple[tuple[str, str], ...]]]:
    """Validate an ``iptables -S CHAIN`` dump and return ordered rules."""
    lines = [line for line in raw.splitlines() if line.strip()]
    if not lines:
        raise PolicyError("iptables_chain_dump_empty")
    try:
        first = shlex.split(lines[0], posix=True)
    except ValueError as error:
        raise PolicyError("iptables_chain_dump_invalid") from error
    if first != ["-N", chain]:
        raise PolicyError("iptables_chain_declaration_mismatch")
    rules = []
    for line in lines[1:]:
        try:
            tokens = shlex.split(line, posix=True)
        except ValueError as error:
            raise PolicyError("iptables_chain_dump_invalid") from error
        if len(tokens) < 2 or tokens[0] != "-A" or tokens[1] != chain:
            raise PolicyError("iptables_chain_unexpected_statement")
        rules.append(_iptables_rule_semantics(tokens, expected_chain=chain))
    return rules


def _iptables_hook_rules(raw: str, chain: str) -> list[tuple[str, tuple[tuple[str, str], ...]]]:
    """Select ordered append rules from a built-in chain, ignoring its policy."""
    result = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            tokens = shlex.split(line, posix=True)
        except ValueError as error:
            raise PolicyError("iptables_builtin_chain_dump_invalid") from error
        if tokens[:2] == ["-A", chain]:
            result.append(_iptables_rule_semantics(tokens, expected_chain=chain))
    return result


def _verify_iptables(network_id: str, facts: NetworkFacts, *, established_reply: bool = True) -> None:
    names = policy_names(network_id)
    docker_user = _iptables_hook_rules(_run(["iptables", "-w", "-t", "filter", "-S", "DOCKER-USER"]), "DOCKER-USER")
    input_rules = _iptables_hook_rules(_run(["iptables", "-w", "-t", "filter", "-S", "INPUT"]), "INPUT")
    expected_forward = _iptables_rule_semantics([
        "-A", "DOCKER-USER", "-i", facts.bridge, "-s", facts.subnet,
        "-m", "comment", "--comment", f"phi-omni:{network_id[:12]}:candidate_egress", "-j", names["main"],
    ], expected_chain="DOCKER-USER")
    forward_owned = [rule for rule in docker_user if any(
        option == "-j" and value == names["main"] or option == "--comment" and value.startswith(f"phi-omni:{network_id[:12]}:")
        for option, value in rule[1]
    )]
    if not docker_user or docker_user[0] != expected_forward or forward_owned != [expected_forward]:
        raise PolicyError("iptables_forward_hook_missing")
    expected_input = _iptables_rule_semantics([
        "-A", "INPUT", "-i", facts.bridge, "-s", facts.subnet,
        "-m", "comment", "--comment", f"phi-omni:{network_id[:12]}:blocked_host_input", "-j", names["input"],
    ], expected_chain="INPUT")
    input_owned = [rule for rule in input_rules if any(
        option == "-j" and value == names["input"] or option == "--comment" and value.startswith(f"phi-omni:{network_id[:12]}:")
        for option, value in rule[1]
    )]
    if not input_rules or input_rules[0] != expected_input or input_owned != [expected_input]:
        raise PolicyError("iptables_host_input_hook_missing")
    expected = iptables_plan(network_id, facts.bridge, facts.subnet, facts.host_addresses, facts.docker_subnets, facts.egress_interface, established_reply=established_reply)
    # Stable plan order makes the first reported discrepancy reproducible.
    created = [names[key] for key in IPTABLES_TARGETS] + [names["main"], names["input"]]
    for chain in created:
        actual = _iptables_chain_rules(_run(["iptables", "-w", "-t", "filter", "-S", chain]), chain)
        wanted = [
            _iptables_rule_semantics(args[args.index("-A"):], expected_chain=chain)
            for args in expected if "-A" in args and args[args.index("-A") + 1] == chain
        ]
        if actual != wanted:
            for index in range(max(len(actual), len(wanted))):
                actual_rule = actual[index] if index < len(actual) else "<missing>"
                wanted_rule = wanted[index] if index < len(wanted) else "<missing>"
                if actual_rule != wanted_rule:
                    raise PolicyError(
                        f"iptables_custom_chain_mismatch:chain={chain}:rule={index}:"
                        f"actual={actual_rule!r}:wanted={wanted_rule!r}"
                    )
            raise PolicyError(f"iptables_custom_chain_mismatch:chain={chain}:rules_unknown")


def _verify_nft(network_id: str, facts: NetworkFacts, *, established_reply: bool = True) -> None:
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

    expected_lines = [" ".join(line.strip().split()) for line in render_nft_batch(network_id, facts.bridge, facts.subnet, facts.host_addresses, facts.docker_subnets, facts.egress_interface, established_reply=established_reply).splitlines() if line.strip()]
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


def _verify_firewall(network_id: str, facts: NetworkFacts, backend: str, *, established_reply: bool = True) -> None:
    if backend == "iptables":
        _verify_iptables(network_id, facts, established_reply=established_reply)
    elif backend == "nftables":
        _verify_nft(network_id, facts, established_reply=established_reply)
    else:
        raise PolicyError("docker_firewall_backend_unknown")


def _iptables_save_has_owned_state(raw: str, network_id: str) -> bool:
    """Detect this network's rules/chains in a complete iptables-save dump."""
    names = set(policy_names(network_id).values())
    marker = f"phi-omni:{network_id[:12]}:"
    for line in raw.splitlines():
        if marker in line:
            return True
        if line.startswith(":"):
            chain = line[1:].split(None, 1)[0]
            if chain in names:
                return True
        elif line.startswith("-A "):
            try:
                tokens = shlex.split(line, posix=True)
            except ValueError as error:
                raise PolicyError("firewall_iptables_snapshot_unparseable") from error
            if len(tokens) < 3 or tokens[0] != "-A":
                raise PolicyError("firewall_iptables_snapshot_unparseable")
            if tokens[1] in names or any(
                tokens[index] == "-j" and tokens[index + 1] in names
                for index in range(2, len(tokens) - 1)
            ):
                return True
    return False


def _walk_nft_values(value: object):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key, child
            yield from _walk_nft_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_nft_values(child)


def _nft_ruleset_has_owned_state(raw: str, network_id: str) -> bool:
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PolicyError("firewall_nft_snapshot_invalid") from error
    if not isinstance(document, dict) or not isinstance(document.get("nftables"), list):
        raise PolicyError("firewall_nft_snapshot_invalid")
    names = set(policy_names(network_id).values())
    marker = f"phi-omni:{network_id[:12]}:"
    table = policy_names(network_id)["table"]
    # `nft list ruleset` also renders iptables-nft compatibility rules from
    # `ip filter`. Those are inventoried separately through iptables-nft-save;
    # counting their generated chains/comments here would make a correct
    # iptables policy look like both nftables and iptables. The dedicated nft
    # implementation uses an `inet` table, but still treat its exact table
    # name as owned if it appears under the wrong family. Also detect renamed
    # or partial objects carrying our stable names/comments outside the
    # iptables compatibility table.
    for entry in document["nftables"]:
        if not isinstance(entry, dict):
            continue
        owned_objects = [entry[key] for key in ("table", "chain", "rule") if isinstance(entry.get(key), dict)]
        if any(row.get("name") == table or row.get("table") == table for row in owned_objects):
            return True
        is_iptables_compat = any(
            row.get("family") == "ip" and row.get("table") == "filter"
            for row in owned_objects
        )
        if is_iptables_compat:
            continue
        for key, value in _walk_nft_values(entry):
            if isinstance(value, str) and (marker in value or value in names or key == "name" and value == table):
                return True
    return False


def _firewall_owned_presence(network_id: str) -> dict[str, bool]:
    """Inventory every supported v4 firewall backend plus dedicated nft rules.

    Missing tools or unreadable/malformed snapshots are UNKNOWN, never absence.
    IPv6 firewall variants are included when installed; the candidate policy
    itself has no IPv6 rules because its network and namespace disable IPv6.
    """
    result: dict[str, bool] = {}
    for command, key in (("iptables-nft-save", "iptables-nft"), ("iptables-legacy-save", "iptables-legacy")):
        if shutil.which(command) is None:
            raise PolicyError(f"firewall_backend_inventory_unavailable:{key}")
        result[key] = _iptables_save_has_owned_state(_run([command]), network_id)
    for command, key in (("ip6tables-nft-save", "ip6tables-nft"), ("ip6tables-legacy-save", "ip6tables-legacy")):
        if shutil.which(command) is not None:
            result[key] = _iptables_save_has_owned_state(_run([command]), network_id)
    if shutil.which("nft") is None:
        raise PolicyError("firewall_backend_inventory_unavailable:nftables")
    result["nftables"] = _nft_ruleset_has_owned_state(_run(["nft", "--json", "list", "ruleset"]), network_id)
    return result


def _iptables_active_variant() -> str:
    version = _run(["iptables", "--version"])
    if "(nf_tables)" in version:
        return "iptables-nft"
    if "(legacy)" in version:
        return "iptables-legacy"
    raise PolicyError("iptables_active_variant_unknown")


def classify_recovery_policy_state(
    presence: dict[str, bool],
    *,
    network_id: str,
    facts: NetworkFacts,
    backend: str,
    active_iptables: str | None = None,
) -> str:
    """Classify only complete current policy or total absence as recoverable."""
    expected_keys = {"iptables-nft", "iptables-legacy", "nftables"}
    if not expected_keys.issubset(presence) or not set(presence).issubset(expected_keys | {"ip6tables-nft", "ip6tables-legacy"}) or any(type(value) is not bool for value in presence.values()):
        raise PolicyError("firewall_backend_inventory_incomplete")
    present = {key for key, value in presence.items() if value}
    expected_backend = "nftables" if backend == "nftables" else active_iptables
    if backend == "iptables" and expected_backend not in {"iptables-nft", "iptables-legacy"}:
        raise PolicyError("iptables_active_variant_unknown")
    try:
        _verify_firewall(network_id, facts, backend)
        current_verified = True
    except PolicyError:
        current_verified = False
    if current_verified:
        if present != {expected_backend}:
            raise PolicyError("recovery_policy_duplicate_or_backend_mismatch")
        return "VERIFIED"
    try:
        _verify_firewall(network_id, facts, backend, established_reply=False)
    except PolicyError:
        legacy_verified = False
    else:
        legacy_verified = True
    if legacy_verified:
        raise PolicyError("recovery_legacy_policy_requires_explicit_migration")
    if not present:
        return "ABSENT"
    raise PolicyError("recovery_policy_partial_or_modified")


def validate_recovery_container_snapshots(
    listed_ids: Sequence[str],
    snapshots: dict[str, object],
    *,
    edge_image_id: str,
    backend_image_id: str,
    expected_api_key_sha256: str | None = None,
) -> None:
    """Require the exact three stopped, labelled candidate objects by full ID."""
    expected_ids = {RECOVERY_EDGE_ID, RECOVERY_LEGACY_BACKEND_ID, RECOVERY_AUTH_BACKEND_ID}
    if len(listed_ids) != len(set(listed_ids)) or set(listed_ids) != expected_ids or set(snapshots) != expected_ids:
        raise PolicyError("recovery_candidate_container_inventory_mismatch")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", edge_image_id) or not re.fullmatch(r"sha256:[a-f0-9]{64}", backend_image_id):
        raise PolicyError("recovery_image_identity_invalid")
    expected = {
        RECOVERY_EDGE_ID: (RECOVERY_EDGE_NAME, edge_image_id, RECOVERY_CADDY_IMAGE, "v1", RECOVERY_NETWORK_NAME),
        RECOVERY_LEGACY_BACKEND_ID: (RECOVERY_LEGACY_BACKEND_NAME, backend_image_id, RECOVERY_OMNI_IMAGE, "v1", f"container:{RECOVERY_EDGE_ID}"),
        RECOVERY_AUTH_BACKEND_ID: (RECOVERY_AUTH_BACKEND_NAME, backend_image_id, RECOVERY_OMNI_IMAGE, "auth-v1", f"container:{RECOVERY_EDGE_ID}"),
    }
    for identifier, (name, image_id, image_ref, label_value, network_mode) in expected.items():
        row = snapshots[identifier]
        if not isinstance(row, dict) or row.get("Id") != identifier:
            raise PolicyError("recovery_candidate_container_identity_mismatch")
        if row.get("Name") != f"/{name}":
            raise PolicyError("recovery_candidate_container_name_mismatch")
        if row.get("Image") != image_id:
            raise PolicyError("recovery_candidate_container_image_id_mismatch")
        config = row.get("Config")
        if not isinstance(config, dict) or config.get("Image") != image_ref:
            raise PolicyError("recovery_candidate_container_image_mismatch")
        labels = config.get("Labels") or {}
        if not isinstance(labels, dict) or labels.get(NETWORK_LABEL) != label_value:
            raise PolicyError("recovery_candidate_container_ownership_mismatch")
        state = row.get("State")
        if not isinstance(state, dict) or state.get("Status") not in {"created", "exited"} or state.get("Running") is not False or state.get("Pid") != 0:
            raise PolicyError("recovery_candidate_container_active_or_unknown")
        host = row.get("HostConfig")
        if not isinstance(host, dict) or host.get("NetworkMode") != network_mode:
            raise PolicyError("recovery_candidate_container_network_mode_mismatch")
        restart = host.get("RestartPolicy")
        if not isinstance(restart, dict) or restart.get("Name") != "no" or host.get("Privileged") is not False:
            raise PolicyError("recovery_candidate_container_security_mismatch")
    auth_env_rows = snapshots[RECOVERY_AUTH_BACKEND_ID]["Config"].get("Env")
    if not isinstance(auth_env_rows, list):
        raise PolicyError("recovery_auth_backend_environment_unknown")
    auth_env = {}
    for value in auth_env_rows:
        if not isinstance(value, str):
            raise PolicyError("recovery_auth_backend_environment_unknown")
        key, separator, item = value.partition("=")
        if not separator or not key or key in auth_env:
            raise PolicyError("recovery_auth_backend_environment_unknown")
        auth_env[key] = item
    if auth_env.get("REQUIRE_API_KEY") != "true" or not auth_env.get("OMNIROUTE_API_KEY") or auth_env.get("ROUTER_API_KEY"):
        raise PolicyError("recovery_auth_backend_api_key_policy_mismatch")
    if expected_api_key_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", expected_api_key_sha256):
        raise PolicyError("recovery_expected_api_key_digest_invalid")
    _attest_recovery_container_payloads(snapshots, edge_image_id, backend_image_id, expected_api_key_sha256)


def _load_attestor(script_name: str, module_name: str):
    script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), script_name)
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise PolicyError("recovery_attestor_unavailable")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except (OSError, ImportError, AttributeError) as error:
        raise PolicyError("recovery_attestor_unavailable") from error
    return module


def _attest_recovery_container_payloads(
    snapshots: dict[str, object],
    edge_image_id: str,
    backend_image_id: str,
    expected_api_key_sha256: str | None,
) -> None:
    edge_attestor = _load_attestor("omniroute-edge-attest.py", "phi_recovery_edge_attestor")
    backend_attestor = _load_attestor("omniroute-backend-attest.py", "phi_recovery_backend_attestor")
    try:
        edge_attestor.attest_edge(
            snapshots[RECOVERY_EDGE_ID], expected_id=RECOVERY_EDGE_ID, expected_image_id=edge_image_id,
            expected_image_ref=RECOVERY_CADDY_IMAGE, network_id=RECOVERY_NETWORK_ID,
            network_name=RECOVERY_NETWORK_NAME, container_name=RECOVERY_EDGE_NAME,
            root="/etc/phi-omniroute-candidate", label_key=NETWORK_LABEL, label_value="v1",
            host_port="20129", phase="pre-start",
        )
        backend_attestor.attest_backend(
            snapshots[RECOVERY_LEGACY_BACKEND_ID], expected_id=RECOVERY_LEGACY_BACKEND_ID,
            expected_image_id=backend_image_id, expected_image_ref=RECOVERY_OMNI_IMAGE,
            edge_id=RECOVERY_EDGE_ID, container_name=RECOVERY_LEGACY_BACKEND_NAME,
            label_key=NETWORK_LABEL, label_value="v1", phase="pre-start", expected_auth_mode="legacy",
        )
        backend_attestor.attest_backend(
            snapshots[RECOVERY_AUTH_BACKEND_ID], expected_id=RECOVERY_AUTH_BACKEND_ID,
            expected_image_id=backend_image_id, expected_image_ref=RECOVERY_OMNI_IMAGE,
            edge_id=RECOVERY_EDGE_ID, container_name=RECOVERY_AUTH_BACKEND_NAME,
            label_key=NETWORK_LABEL, label_value="auth-v1", phase="pre-start",
            expected_auth_mode="enforced" if expected_api_key_sha256 is not None else None,
            expected_api_key_sha256=expected_api_key_sha256,
        )
    except (AttributeError, KeyError, ValueError) as error:
        # Canonical attestors emit stable reason codes (not snapshot values).
        # Preserve only that bounded vocabulary so a host operator can tell
        # which invariant failed without exposing environment/config contents.
        reason = str(error)
        if not re.fullmatch(r"[a-z0-9_]{1,80}", reason):
            reason = "unknown"
        raise PolicyError(f"recovery_candidate_security_attestation_failed:{reason}") from error


def _recovery_container_snapshot(
    edge_image_id: str,
    backend_image_id: str,
    expected_api_key_sha256: str | None = None,
) -> None:
    raw_ids = _run([
        "docker", "container", "ls", "--all", "--no-trunc", "--filter",
        f"label={NETWORK_LABEL}", "--format", "{{.ID}}",
    ])
    listed_ids = [row.strip() for row in raw_ids.splitlines() if row.strip()]
    snapshots: dict[str, object] = {}
    for identifier in (RECOVERY_EDGE_ID, RECOVERY_LEGACY_BACKEND_ID, RECOVERY_AUTH_BACKEND_ID):
        raw = _run(["docker", "container", "inspect", "--format", "{{json .}}", identifier])
        try:
            snapshots[identifier] = json.loads(raw)
        except json.JSONDecodeError as error:
            raise PolicyError("recovery_candidate_container_inspect_invalid") from error
    validate_recovery_container_snapshots(
        listed_ids, snapshots, edge_image_id=edge_image_id, backend_image_id=backend_image_id,
        expected_api_key_sha256=expected_api_key_sha256,
    )


def _recovery_preconditions(
    network_id: str,
    daemon_id: str,
    edge_image_id: str,
    backend_image_id: str,
    expected_api_key_sha256: str | None = None,
) -> tuple[NetworkFacts, str, str]:
    if daemon_id != RECOVERY_DAEMON_ID or network_id != RECOVERY_NETWORK_ID:
        raise PolicyError("recovery_scope_identity_mismatch")
    _, _, backend = _docker_facts(daemon_id)
    if _docker_network_name(network_id) != RECOVERY_NETWORK_NAME:
        raise PolicyError("docker_network_name_mismatch")
    _recovery_container_snapshot(edge_image_id, backend_image_id, expected_api_key_sha256)
    facts = _network_facts(network_id, require_empty=True)
    if facts.bridge != RECOVERY_BRIDGE or facts.subnet != RECOVERY_SUBNET or ipaddress.ip_address(facts.gateway) not in ipaddress.ip_network(RECOVERY_SUBNET):
        raise PolicyError("recovery_network_configuration_mismatch")
    presence = _firewall_owned_presence(network_id)
    active = _iptables_active_variant() if backend == "iptables" else None
    state = classify_recovery_policy_state(
        presence, network_id=network_id, facts=facts, backend=backend, active_iptables=active,
    )
    return facts, backend, state


def _docker_network_name(network_id: str) -> str:
    return _run(["docker", "network", "inspect", "--format", "{{.Name}}", network_id]).strip()


def _recover_missing_policy(
    network_id: str,
    daemon_id: str,
    edge_image_id: str,
    backend_image_id: str,
    expected_api_key_sha256: str,
) -> tuple[str, NetworkFacts, str]:
    """Recover only total absence for the exact empty, stopped candidate.

    If an iptables multi-command apply fails halfway, no automatic cleanup is
    attempted: the partial owned state is retained and every subsequent run
    fails closed for manual inspection. A complete existing policy is a no-op.
    """
    initial, backend, state = _recovery_preconditions(network_id, daemon_id, edge_image_id, backend_image_id, expected_api_key_sha256)
    if state == "VERIFIED":
        return "ALREADY_VERIFIED", initial, backend
    # Take an immediately-pre-mutation snapshot and refuse drift. This does
    # not claim to serialize unrelated privileged Docker/firewall operators.
    current, current_backend, current_state = _recovery_preconditions(network_id, daemon_id, edge_image_id, backend_image_id, expected_api_key_sha256)
    if current_backend != backend or current_state != "ABSENT":
        raise PolicyError("recovery_precondition_changed_before_apply")
    if (current.network_id, current.bridge, current.subnet, current.gateway, current.containers) != (
        initial.network_id, initial.bridge, initial.subnet, initial.gateway, initial.containers,
    ):
        raise PolicyError("recovery_network_identity_changed_before_apply")
    try:
        if backend == "nftables":
            _nft_apply(current)
        elif backend == "iptables":
            _iptables_apply(current)
        else:
            raise PolicyError("docker_firewall_backend_unknown")
    except (PolicyError, OSError) as error:
        raise PolicyError("recovery_apply_failed_state_preserved") from error
    try:
        final_facts, final_backend, final_state = _recovery_preconditions(network_id, daemon_id, edge_image_id, backend_image_id, expected_api_key_sha256)
        if final_backend != backend or final_state != "VERIFIED":
            raise PolicyError("recovery_policy_postverify_mismatch")
        if (final_facts.network_id, final_facts.bridge, final_facts.subnet, final_facts.gateway, final_facts.containers) != (
            current.network_id, current.bridge, current.subnet, current.gateway, (),
        ):
            raise PolicyError("recovery_network_postverify_mismatch")
    except PolicyError as error:
        raise PolicyError("recovery_postverify_failed_state_preserved") from error
    return "RECOVERED", final_facts, final_backend


def _validate_recovery_cli(args: argparse.Namespace) -> None:
    if (
        args.edge_container_id != RECOVERY_EDGE_ID
        or args.legacy_backend_container_id != RECOVERY_LEGACY_BACKEND_ID
        or args.auth_backend_container_id != RECOVERY_AUTH_BACKEND_ID
    ):
        raise PolicyError("recovery_candidate_identity_mismatch")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.expected_edge_image_id or "") or not re.fullmatch(r"sha256:[a-f0-9]{64}", args.expected_backend_image_id or ""):
        raise PolicyError("recovery_image_identity_invalid")
    if args.expected_api_key_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", args.expected_api_key_sha256):
        raise PolicyError("recovery_expected_api_key_digest_invalid")
    if args.action == "recover" and args.expected_api_key_sha256 is None:
        raise PolicyError("recovery_expected_api_key_digest_required")
    edge_actual = _run(["docker", "image", "inspect", RECOVERY_CADDY_IMAGE, "--format", "{{.Id}}"] ).strip()
    backend_actual = _run(["docker", "image", "inspect", RECOVERY_OMNI_IMAGE, "--format", "{{.Id}}"] ).strip()
    if edge_actual != args.expected_edge_image_id or backend_actual != args.expected_backend_image_id:
        raise PolicyError("recovery_local_image_identity_mismatch_no_pull")


def _input_migration_preflight(network_id: str, facts: NetworkFacts, backend: str) -> str:
    try:
        _verify_firewall(network_id, facts, backend)
        return "VERIFIED"
    except PolicyError:
        pass
    try:
        _verify_firewall(network_id, facts, backend, established_reply=False)
        return "LEGACY_VERIFIED"
    except PolicyError as error:
        raise PolicyError("input_policy_migration_preflight_unrecognized") from error


def _nft_input_reply_expression(network_id: str, bridge: str, subnet: str) -> str:
    marker = f"phi-omni:{network_id[:12]}:allowed_host_reply"
    return (
        f'iifname "{bridge}" ip saddr {subnet} fib daddr type local meta l4proto tcp '
        f'ct state established ct direction reply return comment "{marker}"'
    )


def _iptables_input_reply_command(network_id: str, bridge: str, subnet: str, action: str) -> list[str]:
    rule = _iptables_input_reply_rule(network_id, bridge, subnet)
    chain = policy_names(network_id)["input"]
    if action == "insert":
        return [*rule[:4], "-I", chain, "1", *rule[rule.index("-A") + 2:]]
    if action == "delete":
        return [*rule[:4], "-D", chain, *rule[rule.index("-A") + 2:]]
    raise PolicyError("input_migration_action_invalid")


def _migrate_input_reply(network_id: str, facts: NetworkFacts, backend: str) -> bool:
    """Migrate only an exact legacy policy, or attest an already migrated one.

    The sole mutation inserts one reply-only rule into the network-owned INPUT
    chain. A failed/ambiguous state is retained for inspection; rerunning this
    operation is safe only when the complete current or legacy policy verifies.
    """
    try:
        _verify_firewall(network_id, facts, backend)
        return False
    except PolicyError:
        pass
    try:
        _verify_firewall(network_id, facts, backend, established_reply=False)
    except PolicyError as error:
        raise PolicyError("input_migration_precondition_unrecognized") from error

    names = policy_names(network_id)
    if backend == "iptables":
        _run(_iptables_input_reply_command(network_id, facts.bridge, facts.subnet, "insert"))
    elif backend == "nftables":
        _run(
            ["nft", "-f", "-"],
            input_text=(
                f"insert rule inet {names['table']} input "
                f"{_nft_input_reply_expression(network_id, facts.bridge, facts.subnet)}\n"
            ),
        )
    else:
        raise PolicyError("docker_firewall_backend_unknown")
    try:
        _verify_firewall(network_id, facts, backend)
    except PolicyError as error:
        raise PolicyError("input_migration_postverify_failed_state_preserved") from error
    return True


def _nft_input_reply_handle(network_id: str) -> str:
    table = policy_names(network_id)["table"]
    raw = _run(["nft", "-a", "list", "chain", "inet", table, "input"])
    marker = f'comment "phi-omni:{network_id[:12]}:allowed_host_reply"'
    handles = []
    for line in raw.splitlines():
        if marker not in line:
            continue
        match = re.search(r"# handle ([0-9]+)\s*$", line)
        if match is None:
            raise PolicyError("input_migration_rollback_handle_unknown")
        handles.append(match.group(1))
    if len(handles) != 1:
        raise PolicyError("input_migration_rollback_rule_identity_mismatch")
    return handles[0]


def _rollback_input_reply(network_id: str, facts: NetworkFacts, backend: str) -> bool:
    """Remove only the exact reply exception and verify the exact old policy."""
    try:
        _verify_firewall(network_id, facts, backend, established_reply=False)
        return False
    except PolicyError:
        pass
    try:
        _verify_firewall(network_id, facts, backend)
    except PolicyError as error:
        raise PolicyError("input_migration_rollback_precondition_unrecognized") from error

    names = policy_names(network_id)
    if backend == "iptables":
        _run(_iptables_input_reply_command(network_id, facts.bridge, facts.subnet, "delete"))
    elif backend == "nftables":
        handle = _nft_input_reply_handle(network_id)
        _run(["nft", "delete", "rule", "inet", names["table"], "input", "handle", handle])
    else:
        raise PolicyError("docker_firewall_backend_unknown")
    try:
        _verify_firewall(network_id, facts, backend, established_reply=False)
    except PolicyError as error:
        raise PolicyError("input_migration_rollback_postverify_failed_state_preserved") from error
    return True


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
    parser.add_argument("action", choices=("preflight", "apply", "verify", "facts", "counters", "preflight-input", "migrate-input", "rollback-input", "recovery-preflight", "recover", "rollback"))
    parser.add_argument("--network-id")
    parser.add_argument("--daemon-id", required=True)
    parser.add_argument("--bridge")
    parser.add_argument("--subnet")
    parser.add_argument("--egress-interface")
    parser.add_argument("--expect-empty", action="store_true")
    parser.add_argument("--expected-endpoint-id")
    parser.add_argument("--edge-container-id")
    parser.add_argument("--legacy-backend-container-id")
    parser.add_argument("--auth-backend-container-id")
    parser.add_argument("--expected-edge-image-id")
    parser.add_argument("--expected-backend-image-id")
    parser.add_argument("--expected-api-key-sha256")
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
    if args.action in {"recovery-preflight", "recover"}:
        if not args.expect_empty:
            raise PolicyError("recovery_requires_empty_candidate_network")
        _validate_recovery_cli(args)
        if args.action == "recovery-preflight":
            _, backend, state = _recovery_preconditions(
                args.network_id, args.daemon_id, args.expected_edge_image_id, args.expected_backend_image_id,
                args.expected_api_key_sha256,
            )
            status = "RECOVERY_ABSENT" if state == "ABSENT" else "RECOVERY_VERIFIED"
        else:
            status, _, backend = _recover_missing_policy(
                args.network_id, args.daemon_id, args.expected_edge_image_id, args.expected_backend_image_id,
                args.expected_api_key_sha256,
            )
            status = f"RECOVERY_{status}"
        print(f"OMNIROUTE_EGRESS_POLICY={status} backend={backend} network={args.network_id[:12]}")
        return 0
    if args.action in {"preflight-input", "migrate-input", "rollback-input"}:
        if not args.expect_empty:
            raise PolicyError("input_migration_requires_empty_candidate_network")
        facts = _network_facts(args.network_id, require_empty=True)
        if _run(["docker", "network", "inspect", "--format", "{{.Name}}", args.network_id]).strip() != "phi-omniroute-egress-candidate-v1":
            raise PolicyError("docker_network_name_mismatch")
        _, _, backend = _docker_facts(args.daemon_id)
        if args.action == "preflight-input":
            state = _input_migration_preflight(args.network_id, facts, backend)
            print(f"OMNIROUTE_EGRESS_POLICY={state} backend={backend} network={args.network_id[:12]} input_migration=ready")
        elif args.action == "migrate-input":
            changed = _migrate_input_reply(args.network_id, facts, backend)
            state = "MIGRATED" if changed else "ALREADY_VERIFIED"
            print(f"OMNIROUTE_EGRESS_POLICY={state} backend={backend} network={args.network_id[:12]} rule=host_reply_only")
        else:
            changed = _rollback_input_reply(args.network_id, facts, backend)
            state = "ROLLED_BACK" if changed else "ALREADY_LEGACY"
            print(f"OMNIROUTE_EGRESS_POLICY={state} backend={backend} network={args.network_id[:12]} rule=host_reply_only")
        return 0
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
    if args.action in {"verify", "facts"}:
        facts = _network_facts(args.network_id, require_empty=args.expect_empty)
        if args.expected_endpoint_id and facts.containers != (args.expected_endpoint_id,):
            raise PolicyError("docker_network_endpoint_identity_mismatch")
        _, _, backend = _docker_facts(args.daemon_id)
        if backend == "nftables":
            _verify_nft(args.network_id, facts)
        else:
            _verify_iptables(args.network_id, facts)
        if args.action == "facts":
            print(f"OMNIROUTE_EGRESS_POLICY=VERIFIED backend={backend} network={args.network_id[:12]} bridge={facts.bridge} subnet={facts.subnet} gateway={facts.gateway} egress={facts.egress_interface}")
        else:
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
