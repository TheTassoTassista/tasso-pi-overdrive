import importlib.util
import contextlib
import hashlib
import io
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("omniroute_egress_policy", ROOT / "scripts" / "omniroute-egress-policy.py")
POLICY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = POLICY
SPEC.loader.exec_module(POLICY)
EDGE_SPEC = importlib.util.spec_from_file_location("omniroute_edge_attest", ROOT / "scripts" / "omniroute-edge-attest.py")
EDGE = importlib.util.module_from_spec(EDGE_SPEC)
sys.modules[EDGE_SPEC.name] = EDGE
EDGE_SPEC.loader.exec_module(EDGE)
BACKEND_SPEC = importlib.util.spec_from_file_location("omniroute_backend_attest", ROOT / "scripts" / "omniroute-backend-attest.py")
BACKEND = importlib.util.module_from_spec(BACKEND_SPEC)
sys.modules[BACKEND_SPEC.name] = BACKEND
BACKEND_SPEC.loader.exec_module(BACKEND)
REPORT_SPEC = importlib.util.spec_from_file_location("omniroute_egress_probe_report", ROOT / "scripts" / "omniroute-egress-probe-report.py")
REPORT = importlib.util.module_from_spec(REPORT_SPEC)
sys.modules[REPORT_SPEC.name] = REPORT
REPORT_SPEC.loader.exec_module(REPORT)
TLS_REPORT_SPEC = importlib.util.spec_from_file_location("omniroute_tls_health_report", ROOT / "scripts" / "omniroute-tls-health-report.py")
TLS_REPORT = importlib.util.module_from_spec(TLS_REPORT_SPEC)
sys.modules[TLS_REPORT_SPEC.name] = TLS_REPORT
TLS_REPORT_SPEC.loader.exec_module(TLS_REPORT)

NETWORK_ID = "a" * 64
DAEMON_ID = "01234567-89ab-cdef-0123-456789abcdef"
BRIDGE = "br-aaaaaaaaaaaa"
SUBNET = "172.29.88.0/24"
DOCKER_SUBNETS = ("172.29.88.0/24", "10.90.0.0/16", "203.0.113.0/24")
HOST_ADDRESSES = ("127.0.0.1", "172.29.88.1", "198.51.100.27")
EGRESS_INTERFACE = "enp5s0"
RECOVERY_IMAGE_ID = "sha256:" + "1" * 64
RECOVERY_OMNI_IMAGE_ID = "sha256:" + "2" * 64
RECOVERY_API_KEY = "e" * 64
RECOVERY_API_KEY_SHA256 = hashlib.sha256(RECOVERY_API_KEY.encode()).hexdigest()


def payload(**changes):
    value = {
        "Id": NETWORK_ID,
        "Name": "phi-omniroute-egress-candidate-v1",
        "Driver": "bridge",
        "Internal": False,
        "Attachable": False,
        "EnableIPv6": False,
        "Labels": {POLICY.NETWORK_LABEL: POLICY.NETWORK_LABEL_VALUE},
        "Options": {},
        "IPAM": {"Config": [{"Subnet": SUBNET, "Gateway": "172.29.88.1"}]},
        "Containers": {},
    }
    value.update(changes)
    return value


def recovery_facts(containers=()):
    return POLICY.NetworkFacts(
        POLICY.RECOVERY_NETWORK_ID, "br-a2428c56b520", "172.19.0.0/16", "172.19.0.1",
        tuple(containers), ("127.0.0.1", "172.19.0.1"), ("172.19.0.0/16", "10.0.0.0/8"), "enp5s0",
    )


def recovery_container_snapshots(*, running_id=None):
    ids = (POLICY.RECOVERY_EDGE_ID, POLICY.RECOVERY_LEGACY_BACKEND_ID, POLICY.RECOVERY_AUTH_BACKEND_ID)
    specs = (
        (POLICY.RECOVERY_EDGE_NAME, RECOVERY_IMAGE_ID, POLICY.RECOVERY_CADDY_IMAGE, "v1", POLICY.RECOVERY_NETWORK_NAME),
        (POLICY.RECOVERY_LEGACY_BACKEND_NAME, RECOVERY_OMNI_IMAGE_ID, POLICY.RECOVERY_OMNI_IMAGE, "v1", f"container:{POLICY.RECOVERY_EDGE_ID}"),
        (POLICY.RECOVERY_AUTH_BACKEND_NAME, RECOVERY_OMNI_IMAGE_ID, POLICY.RECOVERY_OMNI_IMAGE, "auth-v1", f"container:{POLICY.RECOVERY_EDGE_ID}"),
    )
    snapshots = {}
    for identifier, (name, image_id, image_ref, label_value, network_mode) in zip(ids, specs, strict=True):
        active = identifier == running_id
        is_edge = identifier == POLICY.RECOVERY_EDGE_ID
        env = [] if is_edge else (["REQUIRE_API_KEY=false"] if identifier == POLICY.RECOVERY_LEGACY_BACKEND_ID else ["REQUIRE_API_KEY=true", f"OMNIROUTE_API_KEY={RECOVERY_API_KEY}"])
        host = {
            "NetworkMode": network_mode, "RestartPolicy": {"Name": "no"}, "Privileged": False,
            "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
            "PidsLimit": 128 if is_edge else 256,
            "PortBindings": {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "20129"}]} if is_edge else {},
        }
        config = {"Image": image_ref, "Labels": {POLICY.NETWORK_LABEL: label_value}, "Env": env}
        mounts = []
        networks = {}
        if is_edge:
            config.update({
                "User": "0:0", "Entrypoint": ["caddy"],
                "Cmd": ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
            })
            host.update({
                "ReadonlyRootfs": True, "CapAdd": ["NET_BIND_SERVICE"],
                "Sysctls": {"net.ipv6.conf.all.disable_ipv6": "1", "net.ipv6.conf.default.disable_ipv6": "1"},
                "Tmpfs": {path: "rw,noexec,nosuid,size=16m" for path in ("/data", "/config", "/tmp")},
            })
            mounts = [
                {"Source": "/etc/phi-omniroute-candidate/Caddyfile", "Destination": "/etc/caddy/Caddyfile", "Type": "bind", "RW": False, "Mode": "ro"},
                {"Source": "/etc/phi-omniroute-candidate/ca.crt", "Destination": "/etc/caddy/tls.crt", "Type": "bind", "RW": False, "Mode": "ro"},
                {"Source": "/etc/phi-omniroute-candidate/tls.key", "Destination": "/etc/caddy/tls.key", "Type": "bind", "RW": False, "Mode": "ro"},
            ]
            networks = {POLICY.RECOVERY_NETWORK_NAME: {"NetworkID": "", "EndpointID": "", "IPAddress": "", "GlobalIPv6Address": ""}}
        snapshots[identifier] = {
            "Id": identifier, "Name": f"/{name}", "Image": image_id,
            "Config": config,
            "State": {"Status": "running" if active else "created", "Running": active, "Pid": 123 if active else 0},
            "HostConfig": host, "Mounts": mounts, "NetworkSettings": {"Networks": networks},
        }
    return list(ids), snapshots


RECOVERY_PRESENT_KEYS = {"iptables-nft": False, "iptables-legacy": False, "nftables": False}


class FirewallRecoveryTests(unittest.TestCase):
    def test_recovery_network_configuration_is_exact_and_endpoints_must_be_empty(self):
        facts = POLICY.validate_network_payload(
            {
                **payload(Id=POLICY.RECOVERY_NETWORK_ID, Name=POLICY.RECOVERY_NETWORK_NAME,
                          Options={"com.docker.network.bridge.name": "br-a2428c56b520"},
                          IPAM={"Config": [{"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"}]}),
            },
            POLICY.RECOVERY_NETWORK_ID,
            require_empty=True,
        )
        self.assertEqual((facts.bridge, facts.subnet, facts.gateway), ("br-a2428c56b520", "172.19.0.0/16", "172.19.0.1"))
        with self.assertRaisesRegex(POLICY.PolicyError, "endpoints"):
            POLICY.validate_network_payload(
                {**payload(Id=POLICY.RECOVERY_NETWORK_ID), "Containers": {"e" * 64: {}}},
                POLICY.RECOVERY_NETWORK_ID, require_empty=True,
            )
        with self.assertRaisesRegex(POLICY.PolicyError, "ipv4_subnet_unknown"):
            POLICY.validate_network_payload(
                {**payload(Id=POLICY.RECOVERY_NETWORK_ID), "IPAM": {"Config": [
                    {"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"},
                    {"Subnet": "2001:db8::/64", "Gateway": "2001:db8::1"},
                ]}},
                POLICY.RECOVERY_NETWORK_ID, require_empty=True,
            )

    def test_recovery_requires_exact_full_stopped_container_inventory(self):
        ids, rows = recovery_container_snapshots()
        POLICY.validate_recovery_container_snapshots(ids, rows, edge_image_id=RECOVERY_IMAGE_ID, backend_image_id=RECOVERY_OMNI_IMAGE_ID, expected_api_key_sha256=RECOVERY_API_KEY_SHA256)
        with self.assertRaisesRegex(POLICY.PolicyError, "configured_api_key_digest_mismatch"):
            POLICY.validate_recovery_container_snapshots(ids, rows, edge_image_id=RECOVERY_IMAGE_ID, backend_image_id=RECOVERY_OMNI_IMAGE_ID, expected_api_key_sha256="0" * 64)
        invalid_auth = dict(rows)
        auth_id = POLICY.RECOVERY_AUTH_BACKEND_ID
        auth_row = dict(rows[auth_id])
        auth_config = dict(auth_row["Config"])
        auth_config["Env"] = ["REQUIRE_API_KEY=false"]
        auth_row["Config"] = auth_config
        invalid_auth[auth_id] = auth_row
        with self.assertRaisesRegex(POLICY.PolicyError, "api_key_policy_mismatch"):
            POLICY.validate_recovery_container_snapshots(ids, invalid_auth, edge_image_id=RECOVERY_IMAGE_ID, backend_image_id=RECOVERY_OMNI_IMAGE_ID, expected_api_key_sha256=RECOVERY_API_KEY_SHA256)
        with self.assertRaisesRegex(POLICY.PolicyError, "inventory_mismatch"):
            POLICY.validate_recovery_container_snapshots(ids + ["c" * 64], rows, edge_image_id=RECOVERY_IMAGE_ID, backend_image_id=RECOVERY_OMNI_IMAGE_ID, expected_api_key_sha256=RECOVERY_API_KEY_SHA256)
        running_ids, running_rows = recovery_container_snapshots(running_id=POLICY.RECOVERY_AUTH_BACKEND_ID)
        with self.assertRaisesRegex(POLICY.PolicyError, "active_or_unknown"):
            POLICY.validate_recovery_container_snapshots(running_ids, running_rows, edge_image_id=RECOVERY_IMAGE_ID, backend_image_id=RECOVERY_OMNI_IMAGE_ID, expected_api_key_sha256=RECOVERY_API_KEY_SHA256)
        wrong_image = dict(rows)
        wrong_image[POLICY.RECOVERY_EDGE_ID] = {**rows[POLICY.RECOVERY_EDGE_ID], "Image": "sha256:" + "3" * 64}
        with self.assertRaisesRegex(POLICY.PolicyError, "container_image_id_mismatch"):
            POLICY.validate_recovery_container_snapshots(ids, wrong_image, edge_image_id=RECOVERY_IMAGE_ID, backend_image_id=RECOVERY_OMNI_IMAGE_ID, expected_api_key_sha256=RECOVERY_API_KEY_SHA256)
        with self.assertRaisesRegex(POLICY.PolicyError, "image_id_mismatch"):
            POLICY.validate_recovery_container_snapshots(ids, rows, edge_image_id=RECOVERY_OMNI_IMAGE_ID, backend_image_id=RECOVERY_OMNI_IMAGE_ID, expected_api_key_sha256=RECOVERY_API_KEY_SHA256)

    def test_recovery_classifies_total_absence_and_exact_current_policy_only(self):
        facts = recovery_facts()
        empty = dict(RECOVERY_PRESENT_KEYS)
        with patch.object(POLICY, "_verify_firewall", side_effect=POLICY.PolicyError("not installed")):
            self.assertEqual(POLICY.classify_recovery_policy_state(empty, network_id=POLICY.RECOVERY_NETWORK_ID, facts=facts, backend="iptables", active_iptables="iptables-nft"), "ABSENT")
        present = {**empty, "iptables-nft": True}
        with patch.object(POLICY, "_verify_firewall", return_value=None):
            self.assertEqual(POLICY.classify_recovery_policy_state(present, network_id=POLICY.RECOVERY_NETWORK_ID, facts=facts, backend="iptables", active_iptables="iptables-nft"), "VERIFIED")
        with patch.object(POLICY, "_verify_firewall", side_effect=[POLICY.PolicyError("current differs"), None]), self.assertRaisesRegex(POLICY.PolicyError, "explicit_migration"):
            POLICY.classify_recovery_policy_state(present, network_id=POLICY.RECOVERY_NETWORK_ID, facts=facts, backend="iptables", active_iptables="iptables-nft")
        with patch.object(POLICY, "_verify_firewall", side_effect=[POLICY.PolicyError("modified"), POLICY.PolicyError("modified")]), self.assertRaisesRegex(POLICY.PolicyError, "partial_or_modified"):
            POLICY.classify_recovery_policy_state(present, network_id=POLICY.RECOVERY_NETWORK_ID, facts=facts, backend="iptables", active_iptables="iptables-nft")
        duplicate = {**present, "nftables": True}
        with patch.object(POLICY, "_verify_firewall", return_value=None), self.assertRaisesRegex(POLICY.PolicyError, "duplicate_or_backend"):
            POLICY.classify_recovery_policy_state(duplicate, network_id=POLICY.RECOVERY_NETWORK_ID, facts=facts, backend="iptables", active_iptables="iptables-nft")
        modified_nft = json.dumps({"nftables": [{"table": {"family": "inet", "name": POLICY.policy_names(POLICY.RECOVERY_NETWORK_ID)["table"]}}]})
        self.assertTrue(POLICY._nft_ruleset_has_owned_state(modified_nft, POLICY.RECOVERY_NETWORK_ID))
        self.assertFalse(POLICY._nft_ruleset_has_owned_state('{"nftables": []}', POLICY.RECOVERY_NETWORK_ID))
        marker = f"phi-omni:{POLICY.RECOVERY_NETWORK_ID[:12]}:candidate_egress"
        iptables_nft_compat = json.dumps({"nftables": [
            {"table": {"family": "ip", "name": "filter"}},
            {"chain": {"family": "ip", "table": "filter", "name": POLICY.policy_names(POLICY.RECOVERY_NETWORK_ID)["main"]}},
            {"rule": {"family": "ip", "table": "filter", "comment": marker}},
        ]})
        self.assertFalse(POLICY._nft_ruleset_has_owned_state(iptables_nft_compat, POLICY.RECOVERY_NETWORK_ID))
        partial_inet = json.dumps({"nftables": [
            {"table": {"family": "inet", "name": "unexpected_table"}},
            {"rule": {"family": "inet", "table": "unexpected_table", "comment": marker}},
        ]})
        self.assertTrue(POLICY._nft_ruleset_has_owned_state(partial_inet, POLICY.RECOVERY_NETWORK_ID))
        wrong_family_dedicated = json.dumps({"nftables": [
            {"table": {"family": "ip", "name": POLICY.policy_names(POLICY.RECOVERY_NETWORK_ID)["table"]}},
        ]})
        self.assertTrue(POLICY._nft_ruleset_has_owned_state(wrong_family_dedicated, POLICY.RECOVERY_NETWORK_ID))
        with self.assertRaisesRegex(POLICY.PolicyError, "snapshot_invalid"):
            POLICY._nft_ruleset_has_owned_state("not-json", POLICY.RECOVERY_NETWORK_ID)

    def test_iptables_recovery_inventory_parses_markers_and_chain_names(self):
        owned = POLICY.policy_names(POLICY.RECOVERY_NETWORK_ID)["main"]
        marker = f"phi-omni:{POLICY.RECOVERY_NETWORK_ID[:12]}:candidate_egress"
        self.assertTrue(POLICY._iptables_save_has_owned_state(f":{owned} - [0:0]\n", POLICY.RECOVERY_NETWORK_ID))
        self.assertTrue(POLICY._iptables_save_has_owned_state(f'-A DOCKER-USER -s 172.19.0.0/16 -m comment --comment "{marker}" -j {owned}\n', POLICY.RECOVERY_NETWORK_ID))
        self.assertFalse(POLICY._iptables_save_has_owned_state(":DOCKER-USER - [0:0]\n-A DOCKER-USER -j RETURN\n", POLICY.RECOVERY_NETWORK_ID))
        with self.assertRaisesRegex(POLICY.PolicyError, "unparseable"):
            POLICY._iptables_save_has_owned_state('-A FILTER "unterminated\n', POLICY.RECOVERY_NETWORK_ID)

    def test_firewall_inventory_requires_both_iptables_sources_and_nft_json(self):
        available = {"iptables-nft-save", "iptables-legacy-save", "nft"}
        with patch.object(POLICY.shutil, "which", side_effect=lambda name: "/sbin/" + name if name in available else None), \
             patch.object(POLICY, "_run", side_effect=["", "", '{"nftables": []}']) as run:
            self.assertEqual(POLICY._firewall_owned_presence(POLICY.RECOVERY_NETWORK_ID), {
                "iptables-nft": False, "iptables-legacy": False, "nftables": False,
            })
        self.assertEqual(run.call_count, 3)
        with patch.object(POLICY.shutil, "which", return_value=None), self.assertRaisesRegex(POLICY.PolicyError, "inventory_unavailable:iptables-nft"):
            POLICY._firewall_owned_presence(POLICY.RECOVERY_NETWORK_ID)
        with patch.object(POLICY.shutil, "which", side_effect=lambda name: "/sbin/" + name if name == "iptables-nft-save" else None), \
             patch.object(POLICY, "_run", return_value=""), self.assertRaisesRegex(POLICY.PolicyError, "inventory_unavailable:iptables-legacy"):
            POLICY._firewall_owned_presence(POLICY.RECOVERY_NETWORK_ID)

    def test_recovery_preflight_fails_for_wrong_daemon_before_any_firewall_work(self):
        with patch.object(POLICY, "_docker_network_name") as network_name, patch.object(POLICY, "_firewall_owned_presence") as firewall:
            with self.assertRaisesRegex(POLICY.PolicyError, "scope_identity"):
                POLICY._recovery_preconditions(POLICY.RECOVERY_NETWORK_ID, DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID)
        network_name.assert_not_called()
        firewall.assert_not_called()

    def test_recovery_cli_binds_preflight_and_mutation_to_expected_api_key_digest(self):
        common = ["--network-id", POLICY.RECOVERY_NETWORK_ID, "--daemon-id", POLICY.RECOVERY_DAEMON_ID,
                  "--expect-empty", "--edge-container-id", POLICY.RECOVERY_EDGE_ID,
                  "--legacy-backend-container-id", POLICY.RECOVERY_LEGACY_BACKEND_ID,
                  "--auth-backend-container-id", POLICY.RECOVERY_AUTH_BACKEND_ID,
                  "--expected-edge-image-id", RECOVERY_IMAGE_ID, "--expected-backend-image-id", RECOVERY_OMNI_IMAGE_ID,
                  "--expected-api-key-sha256", RECOVERY_API_KEY_SHA256]
        output = io.StringIO()
        with patch.object(POLICY.os, "geteuid", return_value=0), \
             patch.object(POLICY, "_docker_facts", return_value=(POLICY.RECOVERY_DAEMON_ID, "29.8.1", "iptables")), \
             patch.object(POLICY, "_validate_recovery_cli"), \
             patch.object(POLICY, "_recovery_preconditions", return_value=(recovery_facts(), "iptables", "VERIFIED")) as preconditions, \
             contextlib.redirect_stdout(output):
            self.assertEqual(POLICY._main(["recovery-preflight", *common]), 0)
        self.assertEqual(preconditions.call_args.args, (
            POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID,
            RECOVERY_API_KEY_SHA256,
        ))
        self.assertIn("RECOVERY_VERIFIED", output.getvalue())

        with patch.object(POLICY.os, "geteuid", return_value=0), \
             patch.object(POLICY, "_docker_facts", return_value=(POLICY.RECOVERY_DAEMON_ID, "29.8.1", "iptables")), \
             patch.object(POLICY, "_validate_recovery_cli"), \
             patch.object(POLICY, "_recover_missing_policy", return_value=("RECOVERED", recovery_facts(), "iptables")) as recover, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(POLICY._main(["recover", *common]), 0)
        self.assertEqual(recover.call_args.args, (
            POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID,
            RECOVERY_API_KEY_SHA256,
        ))

    def test_recovery_preflight_requires_network_endpoints_and_stopped_containers(self):
        with patch.object(POLICY, "_docker_network_name", return_value=POLICY.RECOVERY_NETWORK_NAME), \
             patch.object(POLICY, "_recovery_container_snapshot"), \
             patch.object(POLICY, "_network_facts", side_effect=POLICY.PolicyError("docker_network_has_endpoints_before_policy")), \
             patch.object(POLICY, "_docker_facts", return_value=(POLICY.RECOVERY_DAEMON_ID, "29.8.1", "iptables")) as docker_facts, patch.object(POLICY, "_firewall_owned_presence") as firewall:
            with self.assertRaisesRegex(POLICY.PolicyError, "endpoints"):
                POLICY._recovery_preconditions(POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID)
        docker_facts.assert_called_once_with(POLICY.RECOVERY_DAEMON_ID)
        firewall.assert_not_called()
        with patch.object(POLICY, "_docker_network_name", return_value=POLICY.RECOVERY_NETWORK_NAME), \
             patch.object(POLICY, "_recovery_container_snapshot", side_effect=POLICY.PolicyError("recovery_candidate_container_active_or_unknown")), \
             patch.object(POLICY, "_docker_facts", return_value=(POLICY.RECOVERY_DAEMON_ID, "29.8.1", "iptables")), \
             patch.object(POLICY, "_network_facts") as network_facts:
            with self.assertRaisesRegex(POLICY.PolicyError, "active_or_unknown"):
                POLICY._recovery_preconditions(POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID)
        network_facts.assert_not_called()

    def test_recovery_apply_failure_preserves_partial_state_without_retry_or_cleanup(self):
        facts = recovery_facts()
        absent = (facts, "iptables", "ABSENT")
        with patch.object(POLICY, "_recovery_preconditions", side_effect=[absent, absent]) as preconditions, \
             patch.object(POLICY, "_iptables_apply", side_effect=POLICY.PolicyError("command_failed:iptables:1")) as apply, \
             patch.object(POLICY, "_nft_apply") as nft_apply:
            with self.assertRaisesRegex(POLICY.PolicyError, "apply_failed_state_preserved"):
                POLICY._recover_missing_policy(POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID, RECOVERY_API_KEY_SHA256)
        self.assertEqual(preconditions.call_count, 2)
        apply.assert_called_once_with(facts)
        nft_apply.assert_not_called()

    def test_recovery_success_is_verified_before_return_and_second_call_is_idempotent(self):
        facts = recovery_facts()
        absent = (facts, "iptables", "ABSENT")
        verified = (facts, "iptables", "VERIFIED")
        with patch.object(POLICY, "_recovery_preconditions", side_effect=[absent, absent, verified]), \
             patch.object(POLICY, "_iptables_apply") as apply:
            self.assertEqual(POLICY._recover_missing_policy(POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID, RECOVERY_API_KEY_SHA256), ("RECOVERED", facts, "iptables"))
        apply.assert_called_once_with(facts)
        with patch.object(POLICY, "_recovery_preconditions", return_value=verified) as preconditions, \
             patch.object(POLICY, "_iptables_apply", side_effect=AssertionError("must not duplicate")) as apply_again:
            self.assertEqual(POLICY._recover_missing_policy(POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID, RECOVERY_API_KEY_SHA256), ("ALREADY_VERIFIED", facts, "iptables"))
        preconditions.assert_called_once()
        apply_again.assert_not_called()

    def test_recovery_refuses_changed_policy_before_apply_and_preserves_postverify_failure(self):
        facts = recovery_facts()
        absent = (facts, "iptables", "ABSENT")
        verified = (facts, "iptables", "VERIFIED")
        with patch.object(POLICY, "_recovery_preconditions", side_effect=[absent, verified]), patch.object(POLICY, "_iptables_apply") as apply:
            with self.assertRaisesRegex(POLICY.PolicyError, "precondition_changed"):
                POLICY._recover_missing_policy(POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID, RECOVERY_API_KEY_SHA256)
        apply.assert_not_called()
        with patch.object(POLICY, "_recovery_preconditions", side_effect=[absent, absent, (facts, "iptables", "ABSENT")]), patch.object(POLICY, "_iptables_apply") as apply:
            with self.assertRaisesRegex(POLICY.PolicyError, "postverify_failed_state_preserved"):
                POLICY._recover_missing_policy(POLICY.RECOVERY_NETWORK_ID, POLICY.RECOVERY_DAEMON_ID, RECOVERY_IMAGE_ID, RECOVERY_OMNI_IMAGE_ID, RECOVERY_API_KEY_SHA256)
        apply.assert_called_once_with(facts)


class RuntimeFactTests(unittest.TestCase):
    def test_accepts_only_the_attested_server_and_reported_backends(self):
        for backend in ("iptables", "nftables"):
            POLICY.validate_runtime_facts("29.8.1", backend, DAEMON_ID, DAEMON_ID, "false")
        for version, backend, daemon in (
            ("29.8.0", "iptables", DAEMON_ID),
            ("29.8.1", "unknown", DAEMON_ID),
            ("29.8.1", "iptables", "b" * 64),
        ):
            with self.assertRaises(POLICY.PolicyError):
                POLICY.validate_runtime_facts(version, backend, daemon, DAEMON_ID)
        for live_restore in ("true", ""):
            with self.subTest(live_restore=live_restore), self.assertRaisesRegex(POLICY.PolicyError, "live_restore"):
                POLICY.validate_runtime_facts("29.8.1", "nftables", DAEMON_ID, DAEMON_ID, live_restore)

    def test_facts_action_reverifies_policy_and_returns_read_only_resume_metadata(self):
        edge_id = "c" * 64
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (edge_id,), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        output = io.StringIO()
        args = ["facts", "--network-id", NETWORK_ID, "--daemon-id", DAEMON_ID, "--expected-endpoint-id", edge_id]
        with patch.object(POLICY.os, "geteuid", return_value=0), patch.object(POLICY, "_docker_facts", return_value=(DAEMON_ID, "29.8.1", "iptables")), patch.object(POLICY, "_network_facts", return_value=facts), patch.object(POLICY, "_verify_iptables") as verify, patch.object(POLICY, "_iptables_apply", side_effect=AssertionError("facts must not mutate firewall")), contextlib.redirect_stdout(output):
            self.assertEqual(POLICY._main(args), 0)
        verify.assert_called_once_with(NETWORK_ID, facts)
        self.assertEqual(output.getvalue().strip(), f"OMNIROUTE_EGRESS_POLICY=VERIFIED backend=iptables network={NETWORK_ID[:12]} bridge={BRIDGE} subnet={SUBNET} gateway=172.29.88.1 egress={EGRESS_INTERFACE}")

        mismatch = ["facts", "--network-id", NETWORK_ID, "--daemon-id", DAEMON_ID, "--expected-endpoint-id", "b" * 64]
        with patch.object(POLICY.os, "geteuid", return_value=0), patch.object(POLICY, "_docker_facts", return_value=(DAEMON_ID, "29.8.1", "iptables")), patch.object(POLICY, "_network_facts", return_value=facts), self.assertRaisesRegex(POLICY.PolicyError, "endpoint_identity"):
            POLICY._main(mismatch)

    def test_network_identity_security_and_empty_first_endpoint_gate(self):
        facts = POLICY.validate_network_payload(payload(), NETWORK_ID, require_empty=True)
        self.assertEqual((facts.bridge, facts.subnet, facts.gateway, facts.containers), (BRIDGE, SUBNET, "172.29.88.1", ()))
        with self.assertRaisesRegex(POLICY.PolicyError, "identity"):
            POLICY.validate_network_payload(payload(Id="b" * 64), NETWORK_ID, require_empty=False)
        for change in ({"Internal": True}, {"Attachable": True}, {"EnableIPv6": True}, {"Labels": {}}, {"Driver": "host"}):
            with self.subTest(change=change), self.assertRaises(POLICY.PolicyError):
                POLICY.validate_network_payload(payload(**change), NETWORK_ID, require_empty=False)
        with self.assertRaisesRegex(POLICY.PolicyError, "endpoints"):
            POLICY.validate_network_payload(payload(Containers={"c" * 64: {}}), NETWORK_ID, require_empty=True)

    def test_network_route_overlap_fails_closed_but_candidate_route_is_ignored(self):
        POLICY.validate_route_payload([{"dst": SUBNET, "dev": BRIDGE}, {"dst": "default", "dev": "enp5s0"}], BRIDGE, SUBNET)
        route = {"dst": "172.29.0.0/16", "dev": "br-other"}
        with self.assertRaisesRegex(POLICY.PolicyError, "overlaps"):
            POLICY.validate_route_payload([route], BRIDGE, SUBNET)
        POLICY.validate_route_payload([{"dst": "192.168.0.0/16", "dev": "wlan0"}], BRIDGE, SUBNET)


class RulePlanTests(unittest.TestCase):
    def test_nft_policy_is_separate_candidate_scoped_default_deny(self):
        rendered = POLICY.render_nft_batch(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        self.assertIn("table inet phi_omni_", rendered)
        self.assertIn("hook forward priority -10; policy accept", rendered)
        self.assertIn(f'iifname "{BRIDGE}" ip saddr {SUBNET} ip daddr {{', rendered)
        self.assertIn(f'iifname "{BRIDGE}" ip saddr {SUBNET} oifname "{EGRESS_INTERFACE}"', rendered)
        self.assertIn(f'ip saddr {SUBNET} oifname "{EGRESS_INTERFACE}" meta nfproto ipv4 tcp dport 443', rendered)
        self.assertIn("ct original ip daddr { 127.0.0.1, 172.29.88.1, 198.51.100.27 }", rendered)
        self.assertIn("10.90.0.0/16", rendered)
        self.assertIn("203.0.113.0/24", rendered)
        self.assertIn("169.254.0.0/16", rendered)
        self.assertIn("168.63.129.16/32", rendered)
        self.assertIn("tcp dport 443", rendered)
        self.assertIn("meta nfproto ipv4 tcp dport 443", rendered)
        self.assertIn('counter drop comment "phi-omni:aaaaaaaaaaaa:blocked_all_other_egress"', rendered)
        self.assertIn("fib daddr type local", rendered)
        self.assertLess(rendered.index("blocked_special"), rendered.index("allowed_tcp443"))
        self.assertLess(rendered.index("allowed_tcp443"), rendered.index("blocked_all_other_egress"))
        self.assertLess(rendered.index("blocked_host_original"), rendered.index("allowed_tcp443"))
        self.assertNotIn("docker-bridges", rendered)

    def test_input_exception_is_only_candidate_tcp_established_reply_before_host_local_drop(self):
        names = POLICY.policy_names(NETWORK_ID)
        plan = POLICY.iptables_plan(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        reply = next(row for row in plan if row[0] == "iptables" and names["input"] in row and "--ctstate" in row)
        local_drop = next(row for row in plan if row[0] == "iptables" and names["input"] in row and names["HOSTLOCAL"] in row)
        self.assertLess(plan.index(reply), plan.index(local_drop))
        expected = POLICY._iptables_rule_semantics(reply[reply.index("-A"):], expected_chain=names["input"])
        pairs = dict(expected[1])
        self.assertEqual(pairs["-i"], BRIDGE)
        self.assertEqual(pairs["-s"], SUBNET)
        self.assertEqual(pairs["-p"], "tcp")
        self.assertEqual(pairs["--ctstate"], "ESTABLISHED")
        self.assertEqual(pairs["--ctdir"], "REPLY")
        self.assertEqual(pairs["--dst-type"], "LOCAL")
        self.assertEqual(pairs["-j"], "RETURN")
        self.assertNotIn("--ctorigdst", pairs)
        self.assertNotIn("--ctorigdstport", pairs)

        def matches_input_reply(*, bridge=BRIDGE, source=SUBNET, protocol="tcp", state="ESTABLISHED", direction="REPLY", destination_type="LOCAL", ipv6=False):
            return not ipv6 and (
                pairs.get("-i") == bridge
                and pairs.get("-s") == source
                and pairs.get("-p") == protocol
                and pairs.get("--ctstate") == state
                and pairs.get("--ctdir") == direction
                and pairs.get("--dst-type") == destination_type
            )

        self.assertTrue(matches_input_reply(), "the host-initiated TLS flow's candidate reply may return to ordinary INPUT rules")
        for scenario in (
            {"state": "NEW", "direction": "ORIGINAL"},  # gateway/local access initiated by candidate
            {"state": "NEW", "direction": "ORIGINAL", "destination_type": "UNICAST"},  # metadata destination
            {"state": "NEW", "direction": "ORIGINAL", "destination_type": "UNICAST"},  # private destination
            {"state": "INVALID", "direction": "ORIGINAL"},
            {"ipv6": True},
            {"bridge": "br-attacker"},
            {"source": "172.29.89.0/24"},
        ):
            with self.subTest(flow=scenario):
                self.assertFalse(matches_input_reply(**scenario))
        for option, wrong in (
            ("--ctstate", "NEW"), ("--ctstate", "INVALID"), ("--ctdir", "ORIGINAL"),
            ("-i", "br-attacker"), ("-s", "172.29.89.0/24"), ("-p", "udp"),
            ("--dst-type", "UNICAST"), ("-j", "ACCEPT"),
        ):
            mutated = list(reply[reply.index("-A"):])
            mutated[mutated.index(option) + 1] = wrong
            with self.subTest(option=option, wrong=wrong):
                self.assertNotEqual(POLICY._iptables_rule_semantics(mutated, expected_chain=names["input"]), expected)

        rendered = POLICY.render_nft_batch(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        nft_reply = next(line for line in rendered.splitlines() if "allowed_host_reply" in line)
        nft_drop = next(line for line in rendered.splitlines() if "blocked_host_input" in line)
        self.assertLess(rendered.index(nft_reply), rendered.index(nft_drop))
        for old, new in (
            ("ct state established", "ct state new"),
            ("ct state established", "ct state invalid"),
            ("ct direction reply", "ct direction original"),
            (f'iifname "{BRIDGE}"', 'iifname "br-attacker"'),
            ("ip saddr " + SUBNET, "ip saddr 172.29.89.0/24"),
            ("meta l4proto tcp", "meta l4proto udp"),
            ("fib daddr type local", "fib daddr type unicast"),
            ("return comment", "accept comment"),
            ("ip saddr " + SUBNET, "ip6 saddr 2001:db8::/64"),
        ):
            self.assertIn(old, nft_reply)
            mutated_reply = nft_reply.replace(old, new, 1)
            mutated = rendered.replace(nft_reply, mutated_reply, 1)
            with self.subTest(nft_old=old, nft_new=new), patch.object(POLICY, "_run", return_value=mutated), self.assertRaisesRegex(POLICY.PolicyError, "rule_semantics"):
                POLICY._verify_nft(NETWORK_ID, POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE))

        # Gateway traffic is host-local but NEW/ORIGINAL, so it cannot use
        # this exception. Metadata/private destinations remain in the existing
        # forward deny chain; IPv6 is disabled and is not matched by this rule.
        special_chain = POLICY.policy_names(NETWORK_ID)["SPECIAL"]
        self.assertTrue(any(row[0] == "iptables" and "-A" in row and special_chain in row and "-j" in row and row[-1] == "DROP" for row in plan))
        for protected in ("172.29.88.1", "169.254.169.254", "10.0.0.1", "192.168.1.1"):
            address = POLICY.ipaddress.ip_address(protected)
            protected_ranges = [cidr for cidr in (*POLICY.SPECIAL_V4, SUBNET, *DOCKER_SUBNETS) if address in POLICY.ipaddress.ip_network(cidr)]
            self.assertTrue(protected_ranges, protected)
            self.assertTrue(any(
                row[0] == "iptables" and "-d" in row and row[row.index("-d") + 1] in protected_ranges
                and "-j" in row and row[row.index("-j") + 1] == special_chain
                for row in plan
            ), protected)
        self.assertFalse(any(row[0] == "ip6tables" for row in plan))
        self.assertIn("ip saddr " + SUBNET, nft_reply)
        self.assertNotIn("ip6 saddr", nft_reply)

        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        names = POLICY.policy_names(NETWORK_ID)
        outputs = {
            "DOCKER-USER": ["-N DOCKER-USER", f'-A DOCKER-USER -i {BRIDGE} -s {SUBNET} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:candidate_egress" -j {names["main"]}'],
            "INPUT": ["-P INPUT ACCEPT", f'-A INPUT -i {BRIDGE} -s {SUBNET} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:blocked_host_input" -j {names["input"]}'],
        }
        created = [names[key] for key in POLICY.IPTABLES_TARGETS] + [names["main"], names["input"]]
        for chain in created:
            outputs[chain] = ["-N " + chain]
            outputs[chain].extend(shlex.join(command[command.index("-A"):]) for command in plan if "-A" in command and command[command.index("-A") + 1] == chain)

        def fake_run(argv, **_kwargs):
            if "-S" in argv and argv[-1] in outputs:
                return "\n".join(outputs[argv[-1]])
            raise AssertionError("unexpected command")

        input_chain = names["input"]
        original_input = list(outputs[input_chain])
        for option, wrong in (
            ("--ctstate", "NEW"), ("--ctstate", "INVALID"), ("--ctdir", "ORIGINAL"),
            ("-i", "br-attacker"), ("-s", "172.29.89.0/24"), ("-p", "udp"),
            ("--dst-type", "UNICAST"), ("-j", "ACCEPT"),
        ):
            tokens = shlex.split(original_input[1])
            tokens[tokens.index(option) + 1] = wrong
            outputs[input_chain][1] = shlex.join(tokens)
            with self.subTest(iptables_option=option, iptables_wrong=wrong), patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "custom_chain_mismatch"):
                POLICY._verify_iptables(NETWORK_ID, facts)
            outputs[input_chain] = list(original_input)

        outputs[input_chain] = [*original_input, original_input[1]]
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "custom_chain_mismatch"):
            POLICY._verify_iptables(NETWORK_ID, facts)
        outputs[input_chain] = list(original_input)

        outputs[input_chain][1], outputs[input_chain][2] = outputs[input_chain][2], outputs[input_chain][1]
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "custom_chain_mismatch"):
            POLICY._verify_iptables(NETWORK_ID, facts)

    def test_input_policy_migration_is_exact_idempotent_and_preserves_unrecognized_state(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", ("f" * 64,), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        state = {"migrated": False}
        verified = []

        def verify(_network_id, _facts, _backend, *, established_reply=True):
            verified.append(established_reply)
            if established_reply and not state["migrated"]:
                raise POLICY.PolicyError("legacy_policy")
            if not established_reply and state["migrated"]:
                raise POLICY.PolicyError("new_policy")

        def mutate(argv, **_kwargs):
            self.assertEqual(argv[0:6], ["iptables", "-w", "-t", "filter", "-I", POLICY.policy_names(NETWORK_ID)["input"]])
            self.assertEqual(argv[6], "1")
            self.assertEqual(argv.count("-I"), 1)
            self.assertIn("--ctstate", argv)
            self.assertIn("ESTABLISHED", argv)
            self.assertIn("--ctdir", argv)
            self.assertIn("REPLY", argv)
            self.assertIn("--dst-type", argv)
            self.assertIn("LOCAL", argv)
            state["migrated"] = True
            return ""

        with patch.object(POLICY, "_verify_firewall", side_effect=verify), patch.object(POLICY, "_run", side_effect=mutate) as run:
            self.assertEqual(POLICY._input_migration_preflight(NETWORK_ID, facts, "iptables"), "LEGACY_VERIFIED")
            self.assertTrue(POLICY._migrate_input_reply(NETWORK_ID, facts, "iptables"))
            POLICY._verify_firewall(NETWORK_ID, facts, "iptables")
            self.assertEqual(POLICY._input_migration_preflight(NETWORK_ID, facts, "iptables"), "VERIFIED")
            self.assertFalse(POLICY._migrate_input_reply(NETWORK_ID, facts, "iptables"))
        self.assertEqual(verified, [True, False, True, False, True, True, True, True])
        self.assertEqual(run.call_count, 1)

        with patch.object(POLICY, "_verify_firewall", side_effect=POLICY.PolicyError("unexpected firewall state")), patch.object(POLICY, "_run") as run:
            with self.assertRaisesRegex(POLICY.PolicyError, "precondition_unrecognized"):
                POLICY._migrate_input_reply(NETWORK_ID, facts, "iptables")
        run.assert_not_called()

    def test_input_policy_migration_failure_does_not_retry_or_cleanup(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", ("f" * 64,), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        verified = []

        def verify(_network_id, _facts, _backend, *, established_reply=True):
            verified.append(established_reply)
            if established_reply:
                raise POLICY.PolicyError("not_current_yet")
            if len(verified) > 2:
                raise POLICY.PolicyError("postverify_failed")

        with patch.object(POLICY, "_verify_firewall", side_effect=verify), patch.object(POLICY, "_run") as mutate:
            with self.assertRaisesRegex(POLICY.PolicyError, "postverify_failed_state_preserved"):
                POLICY._migrate_input_reply(NETWORK_ID, facts, "iptables")
        self.assertEqual(mutate.call_count, 1)
        self.assertEqual(verified, [True, False, True])

    def test_input_policy_migration_preflight_classifies_only_exact_old_or_new_policy(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        with patch.object(POLICY, "_verify_firewall") as verify:
            self.assertEqual(POLICY._input_migration_preflight(NETWORK_ID, facts, "iptables"), "VERIFIED")
            verify.assert_called_once_with(NETWORK_ID, facts, "iptables")
        with patch.object(POLICY, "_verify_firewall", side_effect=[POLICY.PolicyError("not_new"), None]) as verify:
            self.assertEqual(POLICY._input_migration_preflight(NETWORK_ID, facts, "iptables"), "LEGACY_VERIFIED")
            self.assertEqual(verify.call_count, 2)
        with patch.object(POLICY, "_verify_firewall", side_effect=POLICY.PolicyError("unexpected")), patch.object(POLICY, "_run") as mutate:
            with self.assertRaisesRegex(POLICY.PolicyError, "preflight_unrecognized"):
                POLICY._input_migration_preflight(NETWORK_ID, facts, "iptables")
            mutate.assert_not_called()

    def test_nft_input_policy_migration_and_rollback_are_single_rule_operations(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        state = {"migrated": False}

        def verify(_network_id, _facts, _backend, *, established_reply=True):
            if established_reply and not state["migrated"]:
                raise POLICY.PolicyError("legacy")
            if not established_reply and state["migrated"]:
                raise POLICY.PolicyError("current")

        def insert(argv, *, input_text=None, **_kwargs):
            self.assertEqual(argv, ["nft", "-f", "-"])
            self.assertIn("insert rule inet", input_text)
            self.assertIn("ct state established ct direction reply", input_text)
            self.assertIn(f'ip saddr {SUBNET}', input_text)
            self.assertIn("fib daddr type local meta l4proto tcp", input_text)
            self.assertIn("return", input_text)
            state["migrated"] = True
            return ""

        with patch.object(POLICY, "_verify_firewall", side_effect=verify), patch.object(POLICY, "_run", side_effect=insert) as mutate:
            self.assertTrue(POLICY._migrate_input_reply(NETWORK_ID, facts, "nftables"))
        mutate.assert_called_once()

        marker = f'comment "phi-omni:{NETWORK_ID[:12]}:allowed_host_reply"'
        with patch.object(POLICY, "_run", return_value=f"{POLICY._nft_input_reply_expression(NETWORK_ID, BRIDGE, SUBNET)} {marker} # handle 27\n"):
            self.assertEqual(POLICY._nft_input_reply_handle(NETWORK_ID), "27")
        with patch.object(POLICY, "_run", return_value=f"{marker} # handle 27\n{marker} # handle 28\n"), self.assertRaisesRegex(POLICY.PolicyError, "identity_mismatch"):
            POLICY._nft_input_reply_handle(NETWORK_ID)

    def test_iptables_input_policy_rollback_deletes_only_the_attested_exception(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        state = {"migrated": True}

        def verify(_network_id, _facts, _backend, *, established_reply=True):
            if established_reply and not state["migrated"]:
                raise POLICY.PolicyError("legacy")
            if not established_reply and state["migrated"]:
                raise POLICY.PolicyError("current")

        def delete(argv, **_kwargs):
            self.assertEqual(argv[4], "-D")
            self.assertEqual(argv[5], POLICY.policy_names(NETWORK_ID)["input"])
            self.assertIn("--ctstate", argv)
            self.assertIn("--ctdir", argv)
            self.assertIn("--dst-type", argv)
            state["migrated"] = False
            return ""

        with patch.object(POLICY, "_verify_firewall", side_effect=verify), patch.object(POLICY, "_run", side_effect=delete) as mutate:
            self.assertTrue(POLICY._rollback_input_reply(NETWORK_ID, facts, "iptables"))
        mutate.assert_called_once()
        with patch.object(POLICY, "_verify_firewall", return_value=None), patch.object(POLICY, "_run") as mutate:
            self.assertFalse(POLICY._rollback_input_reply(NETWORK_ID, facts, "iptables"))
        mutate.assert_not_called()

    def test_iptables_uses_only_separate_user_chains_and_supported_user_hook(self):
        plan = POLICY.iptables_plan(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        first_hook = next(i for i, row in enumerate(plan) if "-I" in row)
        self.assertTrue(all("-N" in row or "-A" in row for row in plan[:first_hook]))
        self.assertEqual(plan[first_hook], ["iptables", "-w", "-t", "filter", "-I", "DOCKER-USER", "1", "-i", BRIDGE, "-s", SUBNET, "-m", "comment", "--comment", f"phi-omni:{NETWORK_ID[:12]}:candidate_egress", "-j", POLICY.policy_names(NETWORK_ID)["main"]])
        self.assertIn(["iptables", "-w", "-t", "filter", "-A", POLICY.policy_names(NETWORK_ID)["main"], "-o", EGRESS_INTERFACE, "-p", "tcp", "--dport", "443", "-j", POLICY.policy_names(NETWORK_ID)["ALLOW443"]], plan)
        self.assertIn(["iptables", "-w", "-t", "filter", "-A", POLICY.policy_names(NETWORK_ID)["main"], "-m", "conntrack", "--ctorigdst", "198.51.100.27", "-j", POLICY.policy_names(NETWORK_ID)["HOST_ORIGINAL"]], plan)
        self.assertIn(["iptables", "-w", "-t", "filter", "-A", POLICY.policy_names(NETWORK_ID)["main"], "-d", "10.90.0.0/16", "-j", POLICY.policy_names(NETWORK_ID)["SPECIAL"]], plan)
        self.assertFalse(any(row[0] in {"iptables", "ip6tables"} and ("-F" in row or "-X" in row or "DOCKER" in row and ("-I" not in row or row[5] != "DOCKER-USER")) for row in plan))
        self.assertFalse(any(row[0] == "ip6tables" for row in plan), "IPv6 is disabled in the candidate namespace and Docker network; no host-wide IPv6 hook is installed")
        main = POLICY.policy_names(NETWORK_ID)["main"]
        special = next(i for i, row in enumerate(plan) if "-A" in row and main in row and "-d" in row)
        host_original = next(i for i, row in enumerate(plan) if "--ctorigdst" in row)
        allow = next(i for i, row in enumerate(plan) if main in row and "--dport" in row and "443" in row)
        self.assertLess(host_original, allow)
        self.assertLess(special, allow)

    def test_host_and_docker_network_snapshots_fail_closed_when_unusable(self):
        with self.assertRaisesRegex(POLICY.PolicyError, "snapshot_invalid"):
            POLICY._normalize_host_addresses(())
        with self.assertRaisesRegex(POLICY.PolicyError, "invalid"):
            POLICY._normalize_host_addresses(("not-an-address",))
        with self.assertRaisesRegex(POLICY.PolicyError, "snapshot_invalid"):
            POLICY._normalize_subnets(("10.0.0.0/8", "2001:db8::/32"))

    def test_effective_egress_interface_is_attested_and_docker_bridge_cannot_be_allowlisted(self):
        self.assertEqual(POLICY._effective_egress_interface('[{"dst":"1.1.1.1","dev":"enp5s0"}]', ("br-custom",)), EGRESS_INTERFACE)
        with self.assertRaisesRegex(POLICY.PolicyError, "docker_bridge"):
            POLICY._effective_egress_interface('[{"dst":"1.1.1.1","dev":"br-custom"}]', ("br-custom",))
        for raw in ('[]', '[{"dst":"1.1.1.1"}]', 'not-json'):
            with self.subTest(raw=raw), self.assertRaises(POLICY.PolicyError):
                POLICY._effective_egress_interface(raw, ())
        with self.assertRaisesRegex(POLICY.PolicyError, "interface_invalid"):
            POLICY._effective_egress_interface('[{"dev":"lo"}]', ())

    def test_nft_verifier_accepts_only_exact_candidate_rules(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        rendered = POLICY.render_nft_batch(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        actual = rendered.replace("priority -10", "priority filter - 10").replace("counter drop comment", "counter packets 0 bytes 0 drop comment").replace("counter accept comment", "counter packets 0 bytes 0 accept comment")
        with patch.object(POLICY, "_run", return_value=actual):
            POLICY._verify_nft(NETWORK_ID, facts)
        mutated = actual.replace(f'iifname "{BRIDGE}"', 'iifname "br-attacker"', 1)
        with patch.object(POLICY, "_run", return_value=mutated), self.assertRaisesRegex(POLICY.PolicyError, "rule_semantics"):
            POLICY._verify_nft(NETWORK_ID, facts)
        extra_chain = actual.replace(" chain input {", " chain extra {\n  type filter hook extra priority filter - 10; policy accept;\n }\n chain input {")
        with patch.object(POLICY, "_run", return_value=extra_chain), self.assertRaisesRegex(POLICY.PolicyError, "chain_set"):
            POLICY._verify_nft(NETWORK_ID, facts)

    def test_iptables_verifier_accepts_only_exact_hooks_and_owned_chains(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        plan = POLICY.iptables_plan(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        created = {POLICY.policy_names(NETWORK_ID)[key] for key in POLICY.IPTABLES_TARGETS} | {POLICY.policy_names(NETWORK_ID)["main"], POLICY.policy_names(NETWORK_ID)["input"]}
        outputs = {"DOCKER-USER": ["-N DOCKER-USER"], "INPUT": ["-P INPUT ACCEPT"]}
        outputs["DOCKER-USER"].append(f'-A DOCKER-USER -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:candidate_egress" -j {POLICY.policy_names(NETWORK_ID)["main"]}')
        outputs["INPUT"].append(f'-A INPUT -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:blocked_host_input" -j {POLICY.policy_names(NETWORK_ID)["input"]}')
        for chain in created:
            outputs[chain] = ["-N " + chain]
            outputs[chain].extend(shlex.join(command[command.index("-A"):]) for command in plan if "-A" in command and command[command.index("-A") + 1] == chain)

        def fake_run(argv, **_kwargs):
            if "-S" in argv and argv[-1] in outputs:
                return "\n".join(outputs[argv[-1]])
            raise AssertionError("unexpected command")

        with patch.object(POLICY, "_run", side_effect=fake_run):
            POLICY._verify_iptables(NETWORK_ID, facts)
        outputs["DOCKER-USER"][1] = outputs["DOCKER-USER"][1].replace(SUBNET, "172.30.0.0/24")
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "forward_hook"):
            POLICY._verify_iptables(NETWORK_ID, facts)

    def test_iptables_semantic_verification_rejects_missing_wrong_destination_and_reordered_rules(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        plan = POLICY.iptables_plan(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        names = POLICY.policy_names(NETWORK_ID)
        outputs = {
            "DOCKER-USER": ["-N DOCKER-USER", f'-A DOCKER-USER -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:candidate_egress" -j {names["main"]}'],
            "INPUT": ["-P INPUT ACCEPT", f'-A INPUT -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:blocked_host_input" -j {names["input"]}'],
        }
        created = {names[key] for key in POLICY.IPTABLES_TARGETS} | {names["main"], names["input"]}
        for chain in created:
            outputs[chain] = ["-N " + chain]
            outputs[chain].extend(shlex.join(command[command.index("-A"):]) for command in plan if "-A" in command and command[command.index("-A") + 1] == chain)

        def fake_run(argv, **_kwargs):
            if "-S" in argv and argv[-1] in outputs:
                return "\n".join(outputs[argv[-1]])
            raise AssertionError("unexpected command")

        with patch.object(POLICY, "_run", side_effect=fake_run):
            POLICY._verify_iptables(NETWORK_ID, facts)

        main = names["main"]
        original = list(outputs[main])
        outputs[main].pop()
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "custom_chain_mismatch"):
            POLICY._verify_iptables(NETWORK_ID, facts)
        outputs[main] = list(original)

        destination_rule = next(index for index, row in enumerate(outputs[main]) if "-d 10.0.0.0/8" in row)
        outputs[main][destination_rule] = outputs[main][destination_rule].replace("10.0.0.0/8", "10.1.0.0/16")
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "custom_chain_mismatch"):
            POLICY._verify_iptables(NETWORK_ID, facts)
        outputs[main] = list(original)

        outputs[main][1], outputs[main][2] = outputs[main][2], outputs[main][1]
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "custom_chain_mismatch"):
            POLICY._verify_iptables(NETWORK_ID, facts)

    def test_iptables_verifier_normalizes_xtables_protocol_modules_but_reports_real_rule_diff(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        plan = POLICY.iptables_plan(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        names = POLICY.policy_names(NETWORK_ID)
        outputs = {
            "DOCKER-USER": ["-N DOCKER-USER", f'-A DOCKER-USER -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:candidate_egress" -j {names["main"]}'],
            "INPUT": ["-P INPUT ACCEPT", f'-A INPUT -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:blocked_host_input" -j {names["input"]}'],
        }
        created = [names[key] for key in POLICY.IPTABLES_TARGETS] + [names["main"], names["input"]]
        for chain in created:
            outputs[chain] = ["-N " + chain]
            for command in plan:
                if "-A" not in command or command[command.index("-A") + 1] != chain:
                    continue
                tokens = command[command.index("-A"):]
                if "-p" in tokens and "--dport" in tokens:
                    protocol_index = tokens.index("-p")
                    protocol = tokens[protocol_index + 1]
                    if protocol in {"tcp", "udp"}:
                        tokens[protocol_index + 2:protocol_index + 2] = ["-m", protocol]
                outputs[chain].append(shlex.join(tokens))

        def fake_run(argv, **_kwargs):
            if "-S" in argv and argv[-1] in outputs:
                return "\n".join(outputs[argv[-1]])
            raise AssertionError("unexpected command")

        with patch.object(POLICY, "_run", side_effect=fake_run):
            POLICY._verify_iptables(NETWORK_ID, facts)

        main = names["main"]
        tcp_rule = next(index for index, row in enumerate(outputs[main]) if "--dport 443" in row and "-p tcp" in row)
        outputs[main][tcp_rule] = outputs[main][tcp_rule].replace("--dport 443", "--dport 8443")
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaises(POLICY.PolicyError) as raised:
            POLICY._verify_iptables(NETWORK_ID, facts)
        message = str(raised.exception)
        self.assertIn(f"chain={main}:rule={tcp_rule - 1}", message)
        self.assertIn("actual=", message)
        self.assertIn("wanted=", message)
        self.assertIn("8443", message)
        self.assertIn("443", message)

    def test_iptables_hook_verifier_rejects_missing_duplicate_and_mispositioned_rules(self):
        facts = POLICY.NetworkFacts(NETWORK_ID, BRIDGE, SUBNET, "172.29.88.1", (), HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        plan = POLICY.iptables_plan(NETWORK_ID, BRIDGE, SUBNET, HOST_ADDRESSES, DOCKER_SUBNETS, EGRESS_INTERFACE)
        names = POLICY.policy_names(NETWORK_ID)
        docker_rule = f'-A DOCKER-USER -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:candidate_egress" -j {names["main"]}'
        input_rule = f'-A INPUT -s {SUBNET} -i {BRIDGE} -m comment --comment "phi-omni:{NETWORK_ID[:12]}:blocked_host_input" -j {names["input"]}'
        outputs = {"DOCKER-USER": ["-N DOCKER-USER", docker_rule], "INPUT": ["-P INPUT ACCEPT", input_rule]}
        created = {names[key] for key in POLICY.IPTABLES_TARGETS} | {names["main"], names["input"]}
        for chain in created:
            outputs[chain] = ["-N " + chain]
            outputs[chain].extend(shlex.join(command[command.index("-A"):]) for command in plan if "-A" in command and command[command.index("-A") + 1] == chain)

        def fake_run(argv, **_kwargs):
            if "-S" in argv and argv[-1] in outputs:
                return "\n".join(outputs[argv[-1]])
            raise AssertionError("unexpected command")

        outputs["DOCKER-USER"].insert(1, "-A DOCKER-USER -j RETURN")
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "forward_hook"):
            POLICY._verify_iptables(NETWORK_ID, facts)
        outputs["DOCKER-USER"] = ["-N DOCKER-USER", docker_rule, docker_rule]
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "forward_hook"):
            POLICY._verify_iptables(NETWORK_ID, facts)
        outputs["DOCKER-USER"] = ["-N DOCKER-USER", docker_rule]
        outputs["INPUT"] = ["-P INPUT ACCEPT", input_rule.replace(SUBNET, "172.30.0.0/24")]
        with patch.object(POLICY, "_run", side_effect=fake_run), self.assertRaisesRegex(POLICY.PolicyError, "host_input_hook"):
            POLICY._verify_iptables(NETWORK_ID, facts)

    def test_docker_inventory_captures_public_cidr_bridges_and_rejects_replaced_ids(self):
        other_id = "b" * 64
        candidate = payload()
        other = {
            "Id": other_id,
            "Driver": "bridge",
            "Options": {"com.docker.network.bridge.name": "br-public"},
            "IPAM": {"Config": [{"Subnet": "198.51.100.0/24", "Gateway": "198.51.100.1"}]},
        }

        def fake_run(argv, **_kwargs):
            if argv[:4] == ["docker", "network", "ls", "--no-trunc"]:
                return NETWORK_ID + "\n" + other_id + "\n"
            if argv[:3] == ["docker", "network", "inspect"]:
                network_id = argv[-1]
                value = candidate if network_id == NETWORK_ID else other
                return __import__("json").dumps(value)
            raise AssertionError("unexpected command")

        with patch.object(POLICY, "_run", side_effect=fake_run):
            subnets, bridges = POLICY._docker_network_inventory(NETWORK_ID)
        self.assertIn("198.51.100.0/24", subnets)
        self.assertIn("br-public", bridges)
        with patch.object(POLICY, "_run", return_value=NETWORK_ID + "\n" + NETWORK_ID + "\n"), self.assertRaisesRegex(POLICY.PolicyError, "inventory_invalid"):
            POLICY._docker_network_inventory(NETWORK_ID)

    def test_policy_names_are_bound_to_network_identity_and_within_kernel_limits(self):
        names = POLICY.policy_names(NETWORK_ID)
        self.assertEqual(names, POLICY.policy_names(NETWORK_ID))
        self.assertNotEqual(names, POLICY.policy_names("b" * 64))
        self.assertTrue(all(len(name) <= 28 for name in names.values() if name.isupper()))


class EdgeAttestationTests(unittest.TestCase):
    edge_id = "f" * 64
    image_id = "sha256:" + "d" * 64
    network_id = "a" * 64
    endpoint_id = "e" * 64
    network_name = "phi-omniroute-egress-candidate-v1"
    edge_name = "phi-omniroute-egress-edge-v1"
    image_ref = "docker.io/library/caddy@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f"
    root = "/etc/phi-omniroute-candidate"

    def edge_snapshot(self, *, phase="pre-start"):
        running = phase == "post-start"
        network = {
            "NetworkID": self.network_id if running else "",
            "EndpointID": self.endpoint_id if running else "",
            "IPAddress": "172.29.88.2" if running else "",
            "GlobalIPv6Address": "",
        }
        return {
            "Id": self.edge_id,
            "Name": "/" + self.edge_name,
            "Image": self.image_id,
            "Config": {
                "Image": self.image_ref,
                "User": "0:0",
                "Entrypoint": ["caddy"],
                "Cmd": ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
                "Labels": {"phi.omniroute.candidate.egress": "v1"},
            },
            "State": {"Status": "running", "Running": True, "Pid": 23} if running else {"Status": "created", "Running": False, "Pid": 0},
            "HostConfig": {
                "NetworkMode": self.network_name,
                "Privileged": False,
                "ReadonlyRootfs": True,
                "CapDrop": ["ALL"],
                "CapAdd": ["NET_BIND_SERVICE"],
                "RestartPolicy": {"Name": "no"},
                "SecurityOpt": ["no-new-privileges:true"],
                "PidsLimit": 128,
                "PortBindings": {"8443/tcp": [{"HostIp": "127.0.0.1", "HostPort": "20129"}]},
                "Sysctls": {"net.ipv6.conf.all.disable_ipv6": "1", "net.ipv6.conf.default.disable_ipv6": "1"},
                "Tmpfs": {name: "rw,noexec,nosuid,size=16m" for name in ("/data", "/config", "/tmp")},
            },
            "Mounts": [
                {"Source": self.root + "/Caddyfile", "Destination": "/etc/caddy/Caddyfile", "Type": "bind", "RW": False, "Mode": "ro"},
                {"Source": self.root + "/ca.crt", "Destination": "/etc/caddy/tls.crt", "Type": "bind", "RW": False, "Mode": "ro"},
                {"Source": self.root + "/tls.key", "Destination": "/etc/caddy/tls.key", "Type": "bind", "RW": False, "Mode": "ro"},
            ],
            "NetworkSettings": {"Networks": {self.network_name: network}},
        }

    def attest(self, snapshot, phase):
        EDGE.attest_edge(
            snapshot,
            expected_id=self.edge_id,
            expected_image_id=self.image_id,
            expected_image_ref=self.image_ref,
            network_id=self.network_id,
            network_name=self.network_name,
            container_name=self.edge_name,
            root=self.root,
            label_key="phi.omniroute.candidate.egress",
            label_value="v1",
            host_port="20129",
            phase=phase,
        )

    def test_created_edge_without_endpoint_is_valid_prestart_resume_state(self):
        snapshot = self.edge_snapshot()
        self.assertEqual(snapshot["NetworkSettings"]["Networks"][self.network_name]["EndpointID"], "")
        self.attest(snapshot, "pre-start")
        snapshot["NetworkSettings"]["Networks"][self.network_name]["EndpointID"] = self.endpoint_id
        with self.assertRaisesRegex(EDGE.AttestationError, "endpoint_exists_before_start"):
            self.attest(snapshot, "pre-start")

    def test_stopped_existing_edge_can_resume_only_with_zero_pid(self):
        snapshot = self.edge_snapshot()
        snapshot["State"] = {"Status": "exited", "Running": False, "Pid": 0}
        self.attest(snapshot, "pre-start")
        snapshot["State"]["Pid"] = 71
        with self.assertRaisesRegex(EDGE.AttestationError, "stopped_state_invalid"):
            self.attest(snapshot, "pre-start")

    def test_started_edge_requires_endpoint_assigned_to_exact_network(self):
        self.attest(self.edge_snapshot(phase="post-start"), "post-start")
        missing = self.edge_snapshot(phase="post-start")
        missing["NetworkSettings"]["Networks"][self.network_name]["EndpointID"] = ""
        with self.assertRaisesRegex(EDGE.AttestationError, "endpoint_id"):
            self.attest(missing, "post-start")
        wrong_network = self.edge_snapshot(phase="post-start")
        wrong_network["NetworkSettings"]["Networks"][self.network_name]["NetworkID"] = "b" * 64
        with self.assertRaisesRegex(EDGE.AttestationError, "network_id_mismatch"):
            self.attest(wrong_network, "post-start")

    def test_final_edge_attestation_accepts_docker_capability_name_canonicalization(self):
        for phase in ("pre-start", "post-start"):
            with self.subTest(phase=phase):
                snapshot = self.edge_snapshot(phase=phase)
                snapshot["HostConfig"]["CapAdd"] = ["CAP_NET_BIND_SERVICE"]
                self.attest(snapshot, phase)

        widened = self.edge_snapshot(phase="post-start")
        widened["HostConfig"]["CapAdd"] = ["NET_ADMIN"]
        with self.assertRaisesRegex(EDGE.AttestationError, "cap_add_mismatch"):
            self.attest(widened, "post-start")

    def test_wrong_or_replaced_container_identity_fails_closed(self):
        replacement = self.edge_snapshot()
        replacement["Id"] = "b" * 64
        with self.assertRaisesRegex(EDGE.AttestationError, "identity_mismatch"):
            self.attest(replacement, "pre-start")
        with self.assertRaisesRegex(EDGE.AttestationError, "inspect_shape_invalid"):
            self.attest(None, "pre-start")
        disappeared = self.edge_snapshot()
        disappeared["State"] = {"Status": "removing", "Running": False, "Pid": 0}
        with self.assertRaisesRegex(EDGE.AttestationError, "not_stopped_for_resume"):
            self.attest(disappeared, "pre-start")

    def test_partial_resume_accepts_only_exact_created_edge_and_config(self):
        snapshot = self.edge_snapshot()
        self.attest(snapshot, "pre-start")
        snapshot["HostConfig"]["NetworkMode"] = "bridge"
        with self.assertRaisesRegex(EDGE.AttestationError, "network_mode_mismatch"):
            self.attest(snapshot, "pre-start")
        snapshot = self.edge_snapshot()
        snapshot["Config"]["Labels"]["phi.omniroute.candidate.egress"] = "other"
        with self.assertRaisesRegex(EDGE.AttestationError, "label_mismatch"):
            self.attest(snapshot, "pre-start")


class BackendResumeAttestationTests(unittest.TestCase):
    backend_id = "b" * 64
    edge_id = "f" * 64
    image_id = "sha256:" + "d" * 64
    image_ref = "diegosouzapw/omniroute@sha256:" + "8" * 64
    backend_name = "phi-omniroute-egress-backend-v1"

    def snapshot(self, *, phase="pre-start"):
        running = phase == "post-start"
        return {
            "Id": self.backend_id,
            "Name": "/" + self.backend_name,
            "Image": self.image_id,
            "Config": {"Image": self.image_ref, "Labels": {"phi.omniroute.candidate.egress": "v1"}},
            "State": {"Status": "running", "Running": True, "Pid": 234} if running else {"Status": "exited", "Running": False, "Pid": 0},
            "HostConfig": {
                "NetworkMode": "container:" + self.edge_id,
                "Privileged": False,
                "CapDrop": ["ALL"],
                "CapAdd": None,
                "RestartPolicy": {"Name": "no"},
                "SecurityOpt": ["no-new-privileges:true"],
                "PidsLimit": 256,
                "PortBindings": {},
                "Binds": None,
            },
            "Mounts": [],
        }

    def attest(self, snapshot, phase="pre-start", auth_mode=None, api_key_sha256=None):
        BACKEND.attest_backend(
            snapshot,
            expected_id=self.backend_id,
            expected_image_id=self.image_id,
            expected_image_ref=self.image_ref,
            edge_id=self.edge_id,
            container_name=self.backend_name,
            label_key="phi.omniroute.candidate.egress",
            label_value="v1",
            phase=phase,
            expected_auth_mode=auth_mode,
            expected_api_key_sha256=api_key_sha256,
        )

    def test_stopped_exact_backend_and_poststart_namespace_are_attested(self):
        self.attest(self.snapshot())
        self.attest(self.snapshot(phase="post-start"), "post-start")
        created = self.snapshot()
        created["State"] = {"Status": "created", "Running": False, "Pid": 0}
        self.attest(created)

    def test_replacement_between_id_lookup_and_final_attestation_fails_closed(self):
        name_lookup_id = self.backend_id
        self.assertEqual(name_lookup_id, self.backend_id)
        replacement = self.snapshot()
        replacement["Id"] = "c" * 64
        with self.assertRaisesRegex(BACKEND.AttestationError, "identity_mismatch"):
            self.attest(replacement)
        self.assertEqual(name_lookup_id, self.backend_id)

    def test_missing_original_id_and_security_or_namespace_mismatches_fail_closed(self):
        with self.assertRaisesRegex(BACKEND.AttestationError, "inspect_shape_invalid"):
            self.attest(None)
        for field, value, reason in (
            ("Image", "sha256:" + "e" * 64, "image_id_mismatch"),
            ("HostConfig", {"NetworkMode": "container:" + "a" * 64, "Privileged": False, "CapDrop": ["ALL"], "CapAdd": [], "RestartPolicy": {"Name": "no"}, "SecurityOpt": ["no-new-privileges"], "PidsLimit": 256, "PortBindings": {}, "Binds": []}, "namespace_target_mismatch"),
        ):
            snapshot = self.snapshot()
            snapshot[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(BACKEND.AttestationError, reason):
                self.attest(snapshot)
        for path, value, reason in (
            (("HostConfig", "Privileged"), True, "container_privileged"),
            (("HostConfig", "CapAdd"), ["NET_ADMIN"], "cap_add_mismatch"),
            (("HostConfig", "PidsLimit"), 0, "pids_limit_mismatch"),
            (("HostConfig", "PortBindings"), {"20128/tcp": []}, "port_binding_present"),
            (("HostConfig", "RestartPolicy"), {"Name": "always"}, "restart_policy_mismatch"),
            (("HostConfig", "SecurityOpt"), [], "no_new_privileges_missing"),
            (("HostConfig", "SecurityOpt"), [{}], "security_options_shape_invalid"),
        ):
            snapshot = self.snapshot()
            snapshot[path[0]][path[1]] = value
            with self.subTest(path=path), self.assertRaises(BACKEND.AttestationError):
                self.attest(snapshot)

    def test_legacy_and_enforced_api_auth_modes_are_attested_without_revealing_key(self):
        legacy = self.snapshot()
        legacy["Config"]["Env"] = ["REQUIRE_API_KEY=false"]
        self.attest(legacy, auth_mode="legacy")

        key = "fixture-only-api-key-" + "a" * 64
        digest = __import__("hashlib").sha256(key.encode()).hexdigest()
        enforced = self.snapshot()
        enforced["Config"]["Env"] = ["REQUIRE_API_KEY=true", f"OMNIROUTE_API_KEY={key}"]
        self.attest(enforced, auth_mode="enforced", api_key_sha256=digest)

        for env, reason in (
            (["REQUIRE_API_KEY=false"], "api_key_policy_not_enforced"),
            (["REQUIRE_API_KEY=true"], "configured_api_key_missing"),
            (["REQUIRE_API_KEY=true", f"OMNIROUTE_API_KEY={'b' * 64}"], "configured_api_key_digest_mismatch"),
            (["REQUIRE_API_KEY=true", f"OMNIROUTE_API_KEY={key}", "ROUTER_API_KEY=alternate"], "unexpected_alternate_api_key"),
        ):
            snapshot = self.snapshot()
            snapshot["Config"]["Env"] = env
            with self.subTest(reason=reason), self.assertRaisesRegex(BACKEND.AttestationError, reason):
                self.attest(snapshot, auth_mode="enforced", api_key_sha256=digest)

    def test_legacy_mode_rejects_configured_keys_and_malformed_env(self):
        for env in (["REQUIRE_API_KEY=false", "OMNIROUTE_API_KEY=unexpected"], ["REQUIRE_API_KEY=false", "REQUIRE_API_KEY=false"]):
            snapshot = self.snapshot()
            snapshot["Config"]["Env"] = env
            with self.assertRaises(BACKEND.AttestationError):
                self.attest(snapshot, auth_mode="legacy")


class CandidateGateIntegrationTests(unittest.TestCase):
    """Compose the candidate's real offline attestors and report gates."""

    def test_authenticated_catalog_completion_composes_probe_counters_attestors_and_tls_catalog(self):
        edge_factory = EdgeAttestationTests()
        edge_id = edge_factory.edge_id
        edge_snapshot = edge_factory.edge_snapshot(phase="post-start")
        # Docker inspect may canonicalize NET_BIND_SERVICE with a CAP_ prefix.
        edge_snapshot["HostConfig"]["CapAdd"] = ["CAP_NET_BIND_SERVICE"]

        backend_factory = BackendResumeAttestationTests()
        backend_id = "c" * 64
        api_key = "fixture-only-backend-key-" + "a" * 48
        api_key_digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
        backend_snapshot = backend_factory.snapshot(phase="post-start")
        backend_snapshot["Id"] = backend_id
        backend_snapshot["Name"] = "/phi-omniroute-egress-backend-auth-v1"
        backend_snapshot["Config"]["Labels"]["phi.omniroute.candidate.egress"] = "auth-v1"
        backend_snapshot["Config"]["Env"] = ["REQUIRE_API_KEY=true", f"OMNIROUTE_API_KEY={api_key}"]

        raw_probe_checks = {name: True for name in REPORT.CHECKS}
        probe_raw = json.dumps({"probeStatus": "PASS", "phase": "COMPLETE", "checks": raw_probe_checks}).encode()
        probe = REPORT.classify(probe_raw, 0)
        self.assertEqual(probe["status"], "PASS")
        counter_keys = {
            "blocked_host_original", "blocked_special", "blocked_host_local", "allowed_tcp443",
            "blocked_udp443", "blocked_tcp_other", "blocked_other", "blocked_host_input",
        }
        before = {name: 10 for name in counter_keys}
        after = {name: value + 1 for name, value in before.items()}
        counter_gate = REPORT.classify_counter_gate(
            json.dumps(before), json.dumps(after), 0,
            json.dumps({"status": probe["status"], "phase": probe["phase"], "checks": probe["checks"]}).encode(),
        )
        self.assertEqual(counter_gate, {"status": "PASS", "phase": "COMPLETE"})

        edge_factory.attest(edge_snapshot, "post-start")
        BACKEND.attest_backend(
            backend_snapshot,
            expected_id=backend_id,
            expected_image_id=backend_factory.image_id,
            expected_image_ref=backend_factory.image_ref,
            edge_id=edge_id,
            container_name="phi-omniroute-egress-backend-auth-v1",
            label_key="phi.omniroute.candidate.egress",
            label_value="auth-v1",
            phase="post-start",
            expected_auth_mode="enforced",
            expected_api_key_sha256=api_key_digest,
        )

        catalog = {"object": "list", "data": [{"id": f"fixture-model-{index}"} for index in range(492)]}
        with tempfile.TemporaryDirectory() as directory:
            body = pathlib.Path(directory) / "catalog.json"
            body.write_text(json.dumps(catalog), encoding="utf-8")
            receipt, catalog_ok = TLS_REPORT.models_response_report(0, "200|0.01|0.03|0.04|0.05", str(body))
            self.assertTrue(catalog_ok)
            self.assertIn("models=PRESENT count=492", receipt)

        # Negative composition checks prove that a changed security predicate,
        # API key, or unusable catalog cannot be reported as completion.
        bad_edge = json.loads(json.dumps(edge_snapshot))
        bad_edge["HostConfig"]["CapAdd"] = ["NET_ADMIN"]
        with self.assertRaisesRegex(EDGE.AttestationError, "cap_add_mismatch"):
            edge_factory.attest(bad_edge, "post-start")
        bad_backend = json.loads(json.dumps(backend_snapshot))
        bad_backend["Config"]["Env"] = ["REQUIRE_API_KEY=true", f"OMNIROUTE_API_KEY={'d' * 64}"]
        with self.assertRaisesRegex(BACKEND.AttestationError, "configured_api_key_digest_mismatch"):
            BACKEND.attest_backend(
                bad_backend,
                expected_id=backend_id,
                expected_image_id=backend_factory.image_id,
                expected_image_ref=backend_factory.image_ref,
                edge_id=edge_id,
                container_name="phi-omniroute-egress-backend-auth-v1",
                label_key="phi.omniroute.candidate.egress",
                label_value="auth-v1",
                phase="post-start",
                expected_auth_mode="enforced",
                expected_api_key_sha256=api_key_digest,
            )
        with tempfile.TemporaryDirectory() as directory:
            body = pathlib.Path(directory) / "catalog.json"
            body.write_text(json.dumps({"object": "list", "data": []}), encoding="utf-8")
            receipt, catalog_ok = TLS_REPORT.models_response_report(0, "200|0.01|0.03|0.04|0.05", str(body))
            self.assertFalse(catalog_ok)
            self.assertIn("models=EMPTY", receipt)


class ProbeReportTests(unittest.TestCase):
    def test_safe_success_and_internal_failure_phase_are_classified(self):
        checks = {name: True for name in REPORT.CHECKS}
        raw = __import__("json").dumps({"probeStatus": "PASS", "phase": "COMPLETE", "checks": checks}).encode()
        self.assertEqual(REPORT.classify(raw, 0), {"status": "PASS", "phase": "COMPLETE", "checks": checks})
        for phase in ("DNS_RESOLUTION", "SYSCTL_READ", "IPV6_PROBES"):
            raw = __import__("json").dumps({"probeStatus": "FAIL", "phase": phase}).encode()
            self.assertEqual(REPORT.classify(raw, 2), {"status": "FAIL", "phase": phase, "checks": {}})

    def test_missing_or_untrusted_json_reports_only_a_safe_failure_phase(self):
        for code, phase in ((125, "DOCKER_EXEC"), (126, "NODE_LAUNCH"), (127, "NODE_LAUNCH"), (1, "NODE_EXECUTION")):
            result = REPORT.classify(b"token=do-not-print 192.0.2.44", code)
            self.assertEqual(result, {"status": "FAIL", "phase": phase, "checks": {}})
            self.assertNotIn("do-not-print", __import__("json").dumps(result))
            self.assertNotIn("192.0.2.44", __import__("json").dumps(result))
        malicious = __import__("json").dumps({"probeStatus": "FAIL", "phase": "DNS_RESOLUTION", "hostIp": "192.0.2.44", "token": "secret"}).encode()
        result = REPORT.classify(malicious, 2)
        self.assertEqual(result, {"status": "FAIL", "phase": "PROBE_OUTPUT_VALIDATION", "checks": {}})
        self.assertNotIn("secret", __import__("json").dumps(result))

    def test_counter_gate_validates_every_json_input_and_command_status(self):
        import json

        checks = {name: True for name in REPORT.CHECKS}
        probe = json.dumps({"status": "PASS", "phase": "COMPLETE", "checks": checks}).encode()
        nft_before = {"blocked_host_original": 0, "blocked_special": 0, "blocked_host_local": 0, "allowed_tcp443": 0, "blocked_udp443": 0, "blocked_all_other_egress": 0, "blocked_host_input": 0}
        nft_after = {**nft_before, "blocked_special": 1, "allowed_tcp443": 1, "blocked_udp443": 1, "blocked_all_other_egress": 1, "blocked_host_input": 1}
        ipt_before = {"blocked_host_original": 0, "blocked_special": 0, "blocked_host_local": 0, "allowed_tcp443": 0, "blocked_udp443": 0, "blocked_tcp_other": 0, "blocked_other": 0, "blocked_host_input": 0}
        ipt_after = {**ipt_before, "blocked_special": 1, "allowed_tcp443": 1, "blocked_udp443": 1, "blocked_tcp_other": 1, "blocked_other": 1, "blocked_host_input": 1}

        for before, after in ((nft_before, nft_after), (ipt_before, ipt_after)):
            with self.subTest(backend="nftables" if len(before) == 7 else "iptables"):
                result = REPORT.classify_counter_gate(json.dumps(before), json.dumps(after), 0, probe)
                self.assertEqual(result, {"status": "PASS", "phase": "COMPLETE"})

        self.assertEqual(REPORT.classify_counter_gate("", json.dumps(nft_after), 0, probe)["phase"], "COUNTERS_BEFORE_JSON_INVALID")
        self.assertEqual(REPORT.classify_counter_gate("{", json.dumps(nft_after), 0, probe)["phase"], "COUNTERS_BEFORE_JSON_INVALID")
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(nft_before), "", 1, probe)["phase"], "COUNTERS_AFTER_COMMAND_FAILED")
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(nft_before), "", 0, probe)["phase"], "COUNTERS_AFTER_JSON_INVALID")
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(nft_before), "{", 0, probe)["phase"], "COUNTERS_AFTER_JSON_INVALID")
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(nft_before), json.dumps(nft_after), 0, b"")["phase"], "PROBE_REPORT_JSON_INVALID")
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(nft_before), json.dumps(nft_after), 0, b"{" )["phase"], "PROBE_REPORT_JSON_INVALID")
        self.assertNotIn("secret", json.dumps(REPORT.classify_counter_gate(json.dumps(nft_before), "secret", 1, probe)))

    def test_counter_gate_rejects_wrong_schema_and_missing_deltas(self):
        import json

        checks = {name: True for name in REPORT.CHECKS}
        probe = json.dumps({"status": "PASS", "phase": "COMPLETE", "checks": checks}).encode()
        before = {"blocked_host_original": 0, "blocked_special": 0, "blocked_host_local": 0, "allowed_tcp443": 0, "blocked_udp443": 0, "blocked_all_other_egress": 0, "blocked_host_input": 0}
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(before), json.dumps({**before, "extra": 0}), 0, probe)["phase"], "COUNTER_SCHEMA_INVALID")
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(before), json.dumps({**before, "allowed_tcp443": True}), 0, probe)["phase"], "COUNTER_SCHEMA_INVALID")
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(before), json.dumps(before), 0, probe)["phase"], "COUNTER_DELTAS_INSUFFICIENT")
        bad_probe = json.dumps({"status": "FAIL", "phase": "POLICY_CHECKS", "checks": checks}).encode()
        self.assertEqual(REPORT.classify_counter_gate(json.dumps(before), json.dumps(before), 0, bad_probe)["phase"], "PROBE_REPORT_NOT_PASS")

    def test_counter_gate_cli_reports_only_sanitized_phase_for_command_json_and_success(self):
        import json

        checks = {name: True for name in REPORT.CHECKS}
        probe = json.dumps({"status": "PASS", "phase": "COMPLETE", "checks": checks}).encode()
        before = {"blocked_host_original": 0, "blocked_special": 0, "blocked_host_local": 0, "allowed_tcp443": 0, "blocked_udp443": 0, "blocked_tcp_other": 0, "blocked_other": 0, "blocked_host_input": 0}
        after = {**before, "blocked_special": 1, "allowed_tcp443": 1, "blocked_udp443": 1, "blocked_tcp_other": 1, "blocked_other": 1, "blocked_host_input": 1}
        command = [sys.executable, str(ROOT / "scripts" / "omniroute-egress-probe-report.py"), "--counter-gate", "--before-json", json.dumps(before), "--after-json", "private-counter-secret", "--after-exit-code", "7"]
        failed_command = subprocess.run(command, input=probe, capture_output=True, check=False, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(failed_command.returncode, 0)
        self.assertEqual(failed_command.stdout.decode().strip(), "OMNIROUTE_EGRESS_COUNTERS=FAIL phase=COUNTERS_AFTER_COMMAND_FAILED")
        self.assertEqual(failed_command.stderr, b"")
        self.assertNotIn(b"private-counter-secret", failed_command.stdout + failed_command.stderr)

        invalid_json = subprocess.run([*command[:-4], "--after-json", "{", "--after-exit-code", "0"], input=probe, capture_output=True, check=False, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(invalid_json.returncode, 0)
        self.assertEqual(invalid_json.stdout.decode().strip(), "OMNIROUTE_EGRESS_COUNTERS=FAIL phase=COUNTERS_AFTER_JSON_INVALID")
        self.assertNotIn(b"private-counter-secret", invalid_json.stdout + invalid_json.stderr)

        valid = subprocess.run([sys.executable, str(ROOT / "scripts" / "omniroute-egress-probe-report.py"), "--counter-gate", "--before-json", json.dumps(before), "--after-json", json.dumps(after), "--after-exit-code", "0"], input=probe, capture_output=True, check=False, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(valid.returncode, 0)
        self.assertEqual(valid.stdout.decode().strip(), "OMNIROUTE_EGRESS_COUNTERS=PASS phase=COMPLETE")
        self.assertEqual(valid.stderr, b"")

    def test_false_policy_check_remains_failure_and_counter_gate_remains_in_candidate(self):
        checks = {name: True for name in REPORT.CHECKS}
        checks["ipv6EgressBlocked"] = False
        raw = __import__("json").dumps({"probeStatus": "PASS", "phase": "COMPLETE", "checks": checks}).encode()
        self.assertEqual(REPORT.classify(raw, 2)["phase"], "POLICY_CHECKS")
        source = (ROOT / "scripts" / "omniroute-docker-candidate.sh").read_text()
        report = (ROOT / "scripts" / "omniroute-egress-probe-report.py").read_text()
        self.assertIn('counters --network-id "$network_id"', source)
        self.assertIn('--counter-gate', source)
        self.assertIn('blocked_udp443', report)
        self.assertIn('blocked_host_input', report)

if __name__ == "__main__":
    unittest.main(verbosity=2)
