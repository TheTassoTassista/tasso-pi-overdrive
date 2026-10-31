"""Execute the candidate's Bash control flow with isolated host-command fakes.

Only the root guard, protected-config reader, and /run scratch paths are
replaced in the temporary test copy. The original candidate, its strict Bash
options, recovery ordering, resume path, and completion gates execute intact.
The real protected-config and firewall helpers have separate focused tests.
"""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "scripts/omniroute-docker-candidate.sh").read_text()
NETWORK = "a2428c56b520dabc38140474ff2559bcfc50a84587ab4953460b1fd80445ae0f"
EDGE = "f31a9d41602d7321cf080974bf00ca550551528d620453346ee0186d8f18f83e"
LEGACY = "b5c5de6334a53acb5f4a127f5d60734ca61890b6a684271d0df288444294b74d"
AUTH = "b225f9f2456449c7f6287713baa67f1de203f63ec864fd165f468468851c0f02"
LOOPBACK = "d" * 64
ARGS = ["--resume-existing", "--egress-candidate", "--recover-missing-egress-policy",
        "--resume-egress-network-id", NETWORK, "--resume-edge-container-id", EDGE,
        "--resume-backend-container-id", LEGACY,
        "--resume-auth-backend-container-id", AUTH]

FAKE = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
a=sys.argv[1:]; cmd=Path(sys.argv[0]).name
state=Path(os.environ['PHI_FAKE_STATE']); network=os.environ['PHI_NETWORK']; edge=os.environ['PHI_EDGE']; legacy=os.environ['PHI_LEGACY']; auth=os.environ['PHI_AUTH']; loopback=os.environ['PHI_LOOPBACK']
def record(s):
    with (state/'calls').open('a') as f: f.write(s+'\n')
def fail(): sys.exit(1)
def present(name): return (state/name).exists()
if cmd=='ss': sys.exit(0)
if cmd=='ip': print('[{"addr_info":[{"family":"inet","local":"198.51.100.8"}]}]'); sys.exit(0)
if cmd=='curl':
    record('curl '+('direct-backend' if any(x.startswith('http://172.19.0.2:20128/') for x in a) else 'edge-https'))
    if any(x.startswith('http://172.19.0.2:20128/') for x in a):
        if present('direct_reachable'): sys.exit(0)
        fail()
    if '--output' in a:
        out=a[a.index('--output')+1]
        if out!='/dev/null': Path(out).write_text('{"data":[{"id":"fixture"}]}')
    if '--write-out' in a:
        fmt=a[a.index('--write-out')+1]
        if '%{time_connect}' in fmt: print('200|0.001|0.002|0.003|0.004',end='')
        else: print('401' if not any(x.startswith('Authorization: Bearer fixture-token') for x in a) else '200',end='')
    sys.exit(0)
if cmd=='docker':
    record('docker '+ ' '.join(a[:3]))
    if a[:2]==['context','show']: print('default'); sys.exit(0)
    if a[:2]==['context','inspect']: print('unix:///var/run/docker.sock'); sys.exit(0)
    if a[0]=='info': print('b64b0d52-95ab-4b1a-a971-5f09a4d6e36d'); sys.exit(0)
    if a[:2]==['image','inspect']:
        target=a[2]; fmt=a[a.index('--format')+1] if '--format' in a else ''
        if 'RepoDigests' in fmt: print('["diegosouzapw/omniroute@sha256:085c57adf499a8aaa9f35ccde95c0df9c11bd9ecd18d6c9edbf3b68b8079ba9d"]')
        elif fmt: print('sha256:'+('c'*64 if 'caddy' in target else 'a'*64))
        sys.exit(0)
    if a[:2]==['container','inspect']:
        target=a[-1]
        if 'edge' in target: print(edge)
        elif 'backend-loopback' in target:
            if not present('created'): fail()
            print(loopback)
        elif 'backend-auth' in target: print(auth)
        elif 'backend' in target: print(legacy)
        else: fail()
        sys.exit(0)
    if a[:2]==['network','inspect']:
        fmt=a[a.index('--format')+1] if '--format' in a else ''
        if 'IPAM.Config' in fmt: print(network+'|[{"Subnet":"172.19.0.0/16","Gateway":"172.19.0.1"}]')
        else: print(network)
        sys.exit(0)
    if a[0]=='inspect':
        target=a[-1]; fmt=a[a.index('--format')+1] if '--format' in a else ''
        if 'PortBindings}}|{{json .NetworkSettings.Ports' in fmt:
            print('{"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"20129"}]}|{"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"20129"}]}')
        elif 'NetworkSettings.Networks}}' in fmt and 'Id}}|' in fmt: print(edge+'|{"phi-omniroute-egress-candidate-v1":{"IPAddress":"172.19.0.2"}}')
        elif 'NetworkSettings.Networks' in fmt: print('{"phi-omniroute-egress-candidate-v1":{}}')
        elif 'HostConfig.NetworkMode' in fmt:
            if target==edge: print(edge+'|sha256:'+ 'c'*64 +'|running|phi-omniroute-egress-candidate-v1|{"8443/tcp":[{"HostIp":"127.0.0.1","HostPort":"20129"}]}|no')
            else: print((loopback if target==loopback else auth)+'|sha256:'+ 'a'*64 +'|running|container:'+edge+'|{}|no')
        else: print('{}')
        sys.exit(0)
    if a[0]=='run': sys.exit(0)
    if a[0]=='create':
        if a[a.index('--name')+1]!='phi-omniroute-egress-backend-loopback-v1' or a[a.index('--env')+1]!='OMNIROUTE_HOSTNAME=127.0.0.1': fail()
        (state/'created').touch(); record('create '+loopback); print(loopback); sys.exit(0)
    if a[0]=='start': record('start '+a[1]); print(a[1]); sys.exit(0)
    if a[0]=='stop': record('stop '+a[-1]); print(a[-1]); sys.exit(0)
    if a[0]=='exec':
        code=a[a.index('-e')+1] if '-e' in a else ''
        if 'ipv4Default' in code: print('{"ipv4Default":true,"ipv6Default":false}')
        elif 'listeners' in code: print('{"listeners":[{"local":"0100007F:4EA0"}],"owner":{"pid":1,"uid":1000,"exe":"node"}}')
        elif 'probeStatus' in code: print('{"probeStatus":"PASS"}')
        else: print('{}')
        sys.exit(0)
    fail()
if cmd=='python3':
    if not a: fail()
    name=Path(a[0]).name
    if name=='omniroute-egress-policy.py':
        action=a[1]; record('policy '+action)
        if action=='preflight': print('OMNIROUTE_EGRESS_POLICY=READY backend=iptables host_ipv4_count=1 egress=eth0')
        elif action=='recovery-preflight': print('OMNIROUTE_EGRESS_POLICY='+('RECOVERY_VERIFIED' if present('recovered') else 'RECOVERY_ABSENT')+' backend=iptables network='+network[:12])
        elif action=='preflight-input': print('OMNIROUTE_EGRESS_POLICY=VERIFIED backend=iptables network='+network[:12]+' input_migration=ready')
        elif action=='migrate-input': print('OMNIROUTE_EGRESS_POLICY=ALREADY_VERIFIED backend=iptables network='+network[:12]+' rule=host_reply_only')
        elif action=='recover':
            if present('force_fail'): fail()
            (state/'recovered').touch(); print('OMNIROUTE_EGRESS_POLICY=RECOVERY_RECOVERED backend=iptables network='+network[:12])
        elif action=='verify': print('OMNIROUTE_EGRESS_POLICY=VERIFIED backend=iptables network='+network[:12])
        elif action=='facts': print('OMNIROUTE_EGRESS_POLICY=VERIFIED backend=iptables network='+network[:12]+' bridge=br-phi subnet=172.19.0.0/16 gateway=172.19.0.1 egress=eth0')
        elif action=='counters': print('{"fixture":1}')
        else: fail()
    elif name=='omniroute-backend-auth-config.py': print('a'*64)
    elif name in ('omniroute-edge-attest.py','omniroute-backend-attest.py'):
        sys.stdin.read()
        if name=='omniroute-backend-attest.py' and 'phi-omniroute-egress-backend-loopback-v1' in a and '--expected-loopback-bind' not in a: fail()
        record('attest '+name+' '+(a[a.index('--phase')+1] if '--phase' in a else 'none'))
    elif name=='omniroute-egress-probe-report.py':
        if '--counter-gate' in a: print('OMNIROUTE_EGRESS_COUNTERS=PASS phase=COMPLETE')
        else: print('{"status":"PASS","phase":"COMPLETE"}')
    elif name=='omniroute-tls-health-report.py':
        if a[1]=='edge-ip': print('172.19.0.2')
        elif a[1]=='ports': print('OMNIROUTE_TLS_PORTS=PASS config=EXPECTED runtime=ACTIVE')
        elif a[1]=='models': print('OMNIROUTE_MODELS=PASS count=1')
        else: fail()
    elif a[0]=='-c':
        code=a[1]
        sys.stdin.read()
        if 'IPv4Address' in code: print('["198.51.100.8"]')
        elif '["status"]' in code: print('PASS')
        else: pass
    elif a[0]=='-':
        if len(a)>1 and 'ca.crt' in a[1]: print('{"ca":"fixture"}')
    else: fail()
    sys.exit(0)
fail()
'''


class CandidateExecution(unittest.TestCase):
    def run_candidate(self, fail_recovery=False, already_recovered=False, direct_reachable=False, already_created=False, args=ARGS):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            (base / "state").mkdir()
            (base / "bin").mkdir()
            (base / "protected").mkdir()
            if fail_recovery:
                (base / "state/force_fail").touch()
            if already_recovered:
                (base / "state/recovered").touch()
            if direct_reachable:
                (base / "state/direct_reachable").touch()
            if already_created:
                (base / "state/created").touch()
            fake = base / "fake.py"
            fake.write_text(FAKE)
            fake.chmod(0o755)
            for name in ("docker", "python3", "curl", "ss", "ip"):
                (base / "bin" / name).symlink_to(fake)
            source = SOURCE
            guard = "[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'run_from_authorized_host_terminal_with_sudo'"
            self.assertEqual(source.count(guard), 1)
            source = source.replace(guard, ": # root guard exercised only on host")
            source = source.replace("readonly ROOT='/etc/phi-omniroute-candidate'", f"readonly ROOT='{base / 'protected'}'")
            begin = source.index("prepare_protected_config() {")
            end = source.index("\nprepare_protected_config\n", begin)
            source = source[:begin] + "prepare_protected_config() { proxy_token=fixture-token; backend_auth_mode=enforced; }\n" + source[end:]
            source = source.replace("/run/phi-omniroute-", str(base / "scratch-"))
            script = base / "omniroute-docker-candidate.sh"
            script.write_text(source)
            for helper in ("omniroute-egress-policy.py", "omniroute-egress-probe.cjs",
                           "omniroute-egress-probe-report.py", "omniroute-tls-health-report.py",
                           "omniroute-edge-attest.py", "omniroute-backend-attest.py",
                           "omniroute-backend-auth-config.py"):
                (base / helper).symlink_to(ROOT / "scripts" / helper)
            env = dict(os.environ, PATH=f"{base / 'bin'}:{os.environ['PATH']}",
                       PHI_FAKE_STATE=str(base / "state"), PHI_NETWORK=NETWORK,
                       PHI_EDGE=EDGE, PHI_LEGACY=LEGACY, PHI_AUTH=AUTH, PHI_LOOPBACK=LOOPBACK)
            result = subprocess.run(["bash", str(script), *args], capture_output=True,
                                    text=True, timeout=20, env=env)
            calls = (base / "state/calls").read_text() if (base / "state/calls").exists() else ""
            return result, calls

    def test_full_bash_recovery_and_resume(self):
        result, calls = self.run_candidate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OMNIROUTE_CANDIDATE=CREATED_RUNNING_HEALTHY", result.stdout)
        self.assertLess(calls.index("policy recover"), calls.index("start " + EDGE))
        self.assertLess(calls.index("start " + EDGE), calls.index("start " + AUTH))
        self.assertIn("attest omniroute-edge-attest.py post-start", calls)
        self.assertIn("attest omniroute-backend-attest.py post-start", calls)
        self.assertNotIn("docker create", calls)
        self.assertNotIn("stop ", calls)

    def test_recovery_failure_preserves_objects_and_never_starts(self):
        result, calls = self.run_candidate(fail_recovery=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("egress_policy_recovery_failed_state_preserved", result.stderr)
        self.assertNotIn("unbound variable", result.stderr)
        self.assertNotIn("start ", calls)
        self.assertNotIn("docker create", calls)
        self.assertNotIn("stop ", calls)

    def test_already_recovered_resume_and_invalid_id_fail_closed(self):
        result, calls = self.run_candidate(already_recovered=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OMNIROUTE_EGRESS_POLICY=RECOVERY_VERIFIED", result.stdout)
        bad = [*ARGS]
        bad[bad.index(EDGE)] = "0" * 64
        result, calls = self.run_candidate(args=bad)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("egress_policy_recovery_scope_identity_mismatch", result.stderr)
        self.assertNotIn("policy recover", calls)
        self.assertNotIn("start ", calls)

    def test_loopback_replacement_completes_without_starting_old_backends(self):
        args = [item for item in ARGS if item != "--recover-missing-egress-policy"] + ["--loopback-backend-upgrade"]
        result, calls = self.run_candidate(already_recovered=True, args=args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OMNIROUTE_CANDIDATE=CREATED_RUNNING_HEALTHY", result.stdout)
        self.assertEqual(calls.count("create " + LOOPBACK), 1)
        self.assertIn("start " + LOOPBACK, calls)
        self.assertNotIn("start " + AUTH, calls)
        self.assertNotIn("start " + LEGACY, calls)
        self.assertIn("attest omniroute-backend-attest.py post-start", calls)
        self.assertLess(calls.index('curl direct-backend'), calls.index('policy counters'))
        self.assertIn('curl edge-https', calls)

    def test_direct_backend_reachability_fails_and_stops_exact_candidates(self):
        args = [item for item in ARGS if item != "--recover-missing-egress-policy"] + ["--loopback-backend-upgrade"]
        result, calls = self.run_candidate(already_recovered=True, direct_reachable=True, args=args)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backend_reachable_directly_from_host", result.stderr)
        self.assertIn("stop " + LOOPBACK, calls)
        self.assertIn("stop " + EDGE, calls)
        self.assertNotIn("stop " + AUTH, calls)
        self.assertNotIn("stop " + LEGACY, calls)
        self.assertNotIn('policy counters', calls)
        self.assertNotIn('curl edge-https', calls)

    def test_exact_loopback_resume_creates_nothing_and_still_completes(self):
        args = [item for item in ARGS if item != "--recover-missing-egress-policy"] + ["--resume-loopback-backend-container-id", LOOPBACK]
        result, calls = self.run_candidate(already_recovered=True, already_created=True, args=args)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OMNIROUTE_CANDIDATE=CREATED_RUNNING_HEALTHY", result.stdout)
        self.assertNotIn("create ", calls)
        self.assertIn("start " + LOOPBACK, calls)
        wrong = [*args]
        wrong[-1] = "e" * 64
        result, calls = self.run_candidate(already_recovered=True, already_created=True, args=wrong)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("resume_loopback_backend_identity_mismatch_preserved", result.stderr)
        self.assertNotIn("start ", calls)


if __name__ == "__main__":
    unittest.main()
