import importlib.util
import contextlib
import io
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

    def attest(self, snapshot, phase="pre-start"):
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

    def test_false_policy_check_remains_failure_and_counter_gate_remains_in_candidate(self):
        checks = {name: True for name in REPORT.CHECKS}
        checks["ipv6EgressBlocked"] = False
        raw = __import__("json").dumps({"probeStatus": "PASS", "phase": "COMPLETE", "checks": checks}).encode()
        self.assertEqual(REPORT.classify(raw, 2)["phase"], "POLICY_CHECKS")
        source = (ROOT / "scripts" / "omniroute-docker-candidate.sh").read_text()
        self.assertIn('counters --network-id "$network_id"', source)
        self.assertIn('blocked_udp443', source)
        self.assertIn('blocked_host_input', source)

if __name__ == "__main__":
    unittest.main(verbosity=2)
