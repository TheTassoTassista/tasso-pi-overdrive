#!/usr/bin/env python3
"""Fail-closed validation of an OmniRoute egress backend inspect snapshot."""

from __future__ import annotations

import argparse
import json
import re
import sys


class AttestationError(ValueError):
    pass


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise AttestationError(reason)


def attest_backend(
    payload: object,
    *,
    expected_id: str,
    expected_image_id: str,
    expected_image_ref: str,
    edge_id: str,
    container_name: str,
    label_key: str,
    label_value: str,
    phase: str,
) -> None:
    _require(phase in {"pre-start", "post-start"}, "phase_invalid")
    _require(isinstance(expected_id, str) and re.fullmatch(r"[a-f0-9]{64}", expected_id) is not None, "expected_container_id_invalid")
    _require(isinstance(edge_id, str) and re.fullmatch(r"[a-f0-9]{64}", edge_id) is not None, "expected_edge_id_invalid")
    _require(isinstance(expected_image_id, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", expected_image_id) is not None, "expected_image_id_invalid")
    _require(isinstance(expected_image_ref, str) and re.fullmatch(r"diegosouzapw/omniroute@sha256:[a-f0-9]{64}", expected_image_ref) is not None, "expected_image_ref_invalid")
    _require(isinstance(payload, dict), "inspect_shape_invalid")

    row = payload
    _require(row.get("Id") == expected_id, "container_identity_mismatch")
    _require(row.get("Name") == f"/{container_name}", "container_name_mismatch")
    _require(row.get("Image") == expected_image_id, "container_image_id_mismatch")

    config = row.get("Config") or {}
    _require(isinstance(config, dict), "container_config_shape_invalid")
    _require(config.get("Image") == expected_image_ref, "container_image_reference_mismatch")
    labels = config.get("Labels") or {}
    _require(isinstance(labels, dict) and labels.get(label_key) == label_value, "container_label_mismatch")

    state = row.get("State") or {}
    _require(isinstance(state, dict), "container_state_shape_invalid")
    if phase == "pre-start":
        _require(state.get("Status") in {"created", "exited"}, "container_not_stopped_for_resume")
        _require(state.get("Running") is False and state.get("Pid") == 0, "container_stopped_state_invalid")
    else:
        _require(state.get("Status") == "running", "container_not_running_after_start")
        _require(state.get("Running") is True and type(state.get("Pid")) is int and state["Pid"] > 0, "container_running_state_invalid")

    host = row.get("HostConfig") or {}
    _require(isinstance(host, dict), "container_hostconfig_shape_invalid")
    _require(host.get("NetworkMode") == f"container:{edge_id}", "container_namespace_target_mismatch")
    _require(host.get("Privileged") is False, "container_privileged")
    _require(host.get("CapDrop") == ["ALL"], "container_cap_drop_mismatch")
    _require(host.get("CapAdd") in (None, []), "container_cap_add_mismatch")
    restart = host.get("RestartPolicy")
    _require(isinstance(restart, dict) and restart.get("Name") == "no", "container_restart_policy_mismatch")
    security_options = host.get("SecurityOpt") or []
    _require(isinstance(security_options, list) and all(isinstance(value, str) for value in security_options), "container_security_options_shape_invalid")
    _require(any(value in {"no-new-privileges:true", "no-new-privileges"} for value in security_options), "container_no_new_privileges_missing")
    _require(host.get("PidsLimit") == 256, "container_pids_limit_mismatch")
    _require(host.get("PortBindings") in (None, {}), "container_port_binding_present")
    _require(host.get("Binds") in (None, []), "container_bind_mount_present")
    mounts = row.get("Mounts") or []
    _require(isinstance(mounts, list) and not mounts, "container_mount_present_or_invalid")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-id", required=True)
    parser.add_argument("--expected-image-id", required=True)
    parser.add_argument("--expected-image-ref", required=True)
    parser.add_argument("--edge-id", required=True)
    parser.add_argument("--container-name", required=True)
    parser.add_argument("--label-key", required=True)
    parser.add_argument("--label-value", required=True)
    parser.add_argument("--phase", choices=("pre-start", "post-start"), required=True)
    args = parser.parse_args(argv)
    try:
        attest_backend(
            json.load(sys.stdin),
            expected_id=args.expected_id,
            expected_image_id=args.expected_image_id,
            expected_image_ref=args.expected_image_ref,
            edge_id=args.edge_id,
            container_name=args.container_name,
            label_key=args.label_key,
            label_value=args.label_value,
            phase=args.phase,
        )
    except (AttestationError, json.JSONDecodeError, OSError):
        print("OMNIROUTE_BACKEND_ATTESTATION=FAIL_CLOSED", file=sys.stderr)
        return 1
    print(f"OMNIROUTE_BACKEND_ATTESTATION=PASS phase={args.phase} id={args.expected_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
