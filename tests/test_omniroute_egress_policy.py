import importlib.util
import pathlib
import shlex
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("omniroute_egress_policy", ROOT / "scripts" / "omniroute-egress-policy.py")
POLICY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = POLICY
SPEC.loader.exec_module(POLICY)

NETWORK_ID = "a" * 64
DAEMON_ID = "01234567-89ab-cdef-0123-456789abcdef"
BRIDGE = "br-aaaaaaaaaaaa"
SUBNET = "172.29.88.0/24"
DOCKER_SUBNETS = ("172.29.88.0/24", "10.90.0.0/16", "203.0.113.0/24")
HOST_ADDRESSES = ("127.0.0.1", "172.29.88.1", "198.51.100.27")
EGRESS_INTERFACE = "enp5s0"


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
