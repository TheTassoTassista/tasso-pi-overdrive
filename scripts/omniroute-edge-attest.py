#!/usr/bin/env python3
"""Fail-closed validation of an OmniRoute candidate Caddy edge inspect snapshot."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys


class AttestationError(ValueError):
    pass


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise AttestationError(reason)


def _valid_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def attest_edge(
    payload: object,
    *,
    expected_id: str,
    expected_image_id: str,
    expected_image_ref: str,
    network_id: str,
    network_name: str,
    container_name: str,
    root: str,
    label_key: str,
    label_value: str,
    host_port: str,
    phase: str,
) -> None:
    _require(phase in {"pre-start", "post-start"}, "phase_invalid")
    _require(_valid_id(expected_id), "expected_container_id_invalid")
    _require(_valid_id(network_id), "expected_network_id_invalid")
    _require(
        isinstance(expected_image_id, str)
        and re.fullmatch(r"sha256:[a-f0-9]{64}", expected_image_id) is not None,
        "expected_image_id_invalid",
    )
    _require(isinstance(payload, dict), "inspect_shape_invalid")
    row = payload

    _require(row.get("Id") == expected_id, "container_identity_mismatch")
    _require(row.get("Name") == f"/{container_name}", "container_name_mismatch")
    _require(row.get("Image") == expected_image_id, "container_image_id_mismatch")
    config = row.get("Config") or {}
    _require(isinstance(config, dict), "container_config_shape_invalid")
    _require(config.get("Image") == expected_image_ref, "container_image_reference_mismatch")
    _require(config.get("User") == "0:0", "container_user_mismatch")
    _require(config.get("Entrypoint") == ["caddy"], "container_entrypoint_mismatch")
    _require(
        config.get("Cmd") == ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        "container_command_mismatch",
    )

    labels = config.get("Labels") or {}
    _require(isinstance(labels, dict), "container_labels_shape_invalid")
    _require(labels.get(label_key) == label_value, "container_label_mismatch")

    state = row.get("State") or {}
    _require(isinstance(state, dict), "container_state_shape_invalid")
    if phase == "pre-start":
        _require(state.get("Status") == "created", "container_not_created")
        _require(state.get("Running") is False and state.get("Pid") == 0, "container_created_state_invalid")
    else:
        _require(state.get("Status") == "running", "container_not_running_after_start")
        _require(state.get("Running") is True and type(state.get("Pid")) is int and state["Pid"] > 0, "container_running_state_invalid")

    host = row.get("HostConfig") or {}
    _require(isinstance(host, dict), "container_hostconfig_shape_invalid")
    _require(host.get("NetworkMode") == network_name, "container_network_mode_mismatch")
    _require(host.get("Privileged") is False, "container_privileged")
    _require(host.get("ReadonlyRootfs") is True, "container_rootfs_not_readonly")
    _require(host.get("CapDrop") == ["ALL"], "container_cap_drop_mismatch")
    _require(host.get("CapAdd") in (["NET_BIND_SERVICE"], ["CAP_NET_BIND_SERVICE"]), "container_cap_add_mismatch")
    _require(host.get("RestartPolicy", {}).get("Name") == "no", "container_restart_policy_mismatch")
    _require(
        any(value in {"no-new-privileges:true", "no-new-privileges"} for value in (host.get("SecurityOpt") or [])),
        "container_no_new_privileges_missing",
    )
    _require(host.get("PidsLimit") == 128, "container_pids_limit_mismatch")
    _require(
        host.get("PortBindings") == {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": host_port}]},
        "container_port_binding_mismatch",
    )
    _require(
        host.get("Sysctls") == {
            "net.ipv6.conf.all.disable_ipv6": "1",
            "net.ipv6.conf.default.disable_ipv6": "1",
        },
        "container_sysctls_mismatch",
    )

    tmpfs = host.get("Tmpfs") or {}
    _require(set(tmpfs) == {"/data", "/config", "/tmp"}, "container_tmpfs_paths_mismatch")
    for options in tmpfs.values():
        _require(
            set(str(options).split(",")) == {"rw", "noexec", "nosuid", "size=16m"},
            "container_tmpfs_options_mismatch",
        )

    bindings = row.get("HostConfig", {}).get("PortBindings") or {}
    _require(bindings == {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": host_port}]}, "container_host_binding_mismatch")
    mounts = row.get("Mounts") or []
    _require(isinstance(mounts, list), "container_mounts_shape_invalid")
    expected_mounts = {
        (root + "/Caddyfile", "/etc/caddy/Caddyfile", "bind", False),
        (root + "/ca.crt", "/etc/caddy/tls.crt", "bind", False),
        (root + "/tls.key", "/etc/caddy/tls.key", "bind", False),
    }
    actual_mounts = {
        (mount.get("Source"), mount.get("Destination"), mount.get("Type"), mount.get("RW"))
        for mount in mounts
        if isinstance(mount, dict)
    }
    _require(len(mounts) == 3 and actual_mounts == expected_mounts, "container_mount_mismatch")
    for mount in mounts:
        _require(mount.get("Mode") in ("", "ro"), "container_mount_mode_mismatch")

    networks = (row.get("NetworkSettings") or {}).get("Networks") or {}
    _require(isinstance(networks, dict), "container_network_settings_invalid")
    if phase == "pre-start":
        # Docker may materialize an empty network settings row at create time,
        # but it must not yet contain an endpoint or assigned address.
        _require(not networks or set(networks) == {network_name}, "container_prestart_network_set_mismatch")
        if networks:
            network = networks[network_name]
            _require(isinstance(network, dict), "container_prestart_network_row_invalid")
            _require(network.get("NetworkID") in {"", network_id}, "container_prestart_network_id_mismatch")
            _require(not network.get("EndpointID"), "container_endpoint_exists_before_start")
            _require(not network.get("IPAddress") and not network.get("GlobalIPv6Address"), "container_address_exists_before_start")
    else:
        _require(set(networks) == {network_name}, "container_poststart_network_set_mismatch")
        network = networks[network_name]
        _require(isinstance(network, dict), "container_poststart_network_row_invalid")
        _require(network.get("NetworkID") == network_id, "container_poststart_network_id_mismatch")
        _require(_valid_id(network.get("EndpointID")), "container_endpoint_id_missing_or_invalid")
        try:
            address = ipaddress.ip_address(network.get("IPAddress", ""))
        except ValueError as error:
            raise AttestationError("container_network_address_invalid") from error
        _require(address.version == 4 and not network.get("GlobalIPv6Address"), "container_network_address_invalid")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-id", required=True)
    parser.add_argument("--expected-image-id", required=True)
    parser.add_argument("--expected-image-ref", required=True)
    parser.add_argument("--network-id", required=True)
    parser.add_argument("--network-name", required=True)
    parser.add_argument("--container-name", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--label-key", required=True)
    parser.add_argument("--label-value", required=True)
    parser.add_argument("--host-port", required=True)
    parser.add_argument("--phase", choices=("pre-start", "post-start"), required=True)
    args = parser.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
        attest_edge(
            payload,
            expected_id=args.expected_id,
            expected_image_id=args.expected_image_id,
            expected_image_ref=args.expected_image_ref,
            network_id=args.network_id,
            network_name=args.network_name,
            container_name=args.container_name,
            root=args.root,
            label_key=args.label_key,
            label_value=args.label_value,
            host_port=args.host_port,
            phase=args.phase,
        )
    except (AttestationError, json.JSONDecodeError, OSError, TypeError, AttributeError, KeyError) as error:
        reason = str(error) if isinstance(error, AttestationError) else "inspect_payload_invalid"
        print(f"OMNIROUTE_EDGE_ATTESTATION=FAIL reason={reason}", file=sys.stderr)
        return 1
    print(f"OMNIROUTE_EDGE_ATTESTATION=PASS phase={args.phase} container={args.expected_id[:12]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
