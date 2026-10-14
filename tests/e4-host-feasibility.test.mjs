import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = readFileSync(new URL('../scripts/e4-host-feasibility.sh', import.meta.url), 'utf8');
const probe = readFileSync(new URL('../certification/e4-host-probe.sh', import.meta.url), 'utf8');
const profile = readFileSync(new URL('../certification/apparmor/phi-e4-bwrap.profile', import.meta.url), 'utf8');

test('host feasibility scripts parse and use a fixed narrowly targeted AppArmor source', () => {
  for (const source of [new URL('../scripts/e4-host-feasibility.sh', import.meta.url), new URL('../certification/e4-host-probe.sh', import.meta.url)]) {
    const result = spawnSync('bash', ['-n', source.pathname], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(profile, /profile phi-e4-bwrap \/home\/runner\/work\/_temp\/phi-e4-tools\/usr\/bin\/bwrap flags=\(unconfined\) \{\n  userns,\n\}/u);
  assert.doesNotMatch(profile, /capability|mount,|network,|\/\*\*|flags=\(complain\)/u);
  assert.match(script, /expected_version=0\.9\.0-1ubuntu0\.3/u);
  assert.match(script, /apparmor_parser -Q -K "\$profile_source"/u);
  assert.match(script, /sudo -n apparmor_parser -r "\$profile_source"/u);
  assert.match(script, /sudo -n apparmor_parser -R "\$profile_source"/u);
  assert.doesNotMatch(script, /sudo (?:-n )?"?\$?expected_bwrap|sudo (?:-n )?bwrap|sysctl -w|--privileged|seccomp=unconfined/u);
});

test('rootfs materialization is pinned and Docker never enters the payload', () => {
  assert.match(script, /expected_image='docker\.io\/library\/archlinux:base@sha256:[0-9a-f]{64}'/u);
  assert.match(script, /docker image inspect "\$image"[\s\S]*OCI_DIGEST_MISMATCH/u);
  assert.match(script, /docker export "\$container_id"/u);
  assert.match(script, /--ro-bind "\$stage\/rootfs" \/[\s\S]*--proc \/proc --dev \/dev/u);
  assert.match(script, /--dir \/phi --bind "\$stage\/fixture" \/phi\/fixture --bind "\$stage\/evidence" \/phi\/evidence/u);
  assert.match(script, /--unshare-all --unshare-user --disable-userns --clearenv --die-with-parent --new-session/u);
  assert.doesNotMatch(script, /--bind \/ \/|--bind \/var\/run|--bind \/run|--share-net|--pidns/u);
});

test('all 15 feasibility assertions and cleanup remain fail-closed', () => {
  for (const number of [4, 5, 6, 7, 8, 9, 10, 11, 13]) assert.match(probe, new RegExp(`assert ${number} `, 'u'));
  for (const number of [1, 2, 3, 12, 14, 15]) assert.match(script, new RegExp(`E4_ASSERT_${number}=PASS`, 'u'));
  assert.match(probe, /CapEff:/u);
  assert.match(probe, /unshare --user --map-root-user/u);
  assert.match(probe, /mount -t tmpfs/u);
  assert.match(script, /owned_alive && fail OWNED_CHILD_SURVIVED/u);
  assert.match(script, /E4_CLEANUP=%s/u);
  assert.match(script, /E4_HOST_FEASIBILITY=FAIL/u);
  assert.match(script, /proof_passed=1/u);
});
