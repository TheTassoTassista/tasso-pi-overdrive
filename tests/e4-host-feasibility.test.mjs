import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = readFileSync(new URL('../scripts/e4-host-feasibility.sh', import.meta.url), 'utf8');
const probe = readFileSync(new URL('../certification/e4-host-probe.sh', import.meta.url), 'utf8');
const profile = readFileSync(new URL('../certification/apparmor/phi-e4-bwrap.profile', import.meta.url), 'utf8');
const layoutUrl = new URL('../certification/e4-rootfs-layout.sh', import.meta.url);
const layout = readFileSync(layoutUrl, 'utf8');
const probeUrl = new URL('../certification/e4-host-probe.sh', import.meta.url);

test('host feasibility scripts parse and use a fixed narrowly targeted AppArmor source', () => {
  for (const source of [new URL('../scripts/e4-host-feasibility.sh', import.meta.url), probeUrl, layoutUrl]) {
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
  assert.match(script, /bash "\$layout_source" prepare "\$stage\/rootfs" "\$probe_source"/u);
  assert.match(script, /bash "\$layout_source" validate "\$stage\/rootfs" "\$probe_source"/u);
  assert.match(script, /--ro-bind "\$stage\/rootfs" \/[\s\S]*--proc \/proc --dev \/dev/u);
  assert.match(script, /--bind "\$stage\/fixture" \/phi --bind "\$stage\/evidence" \/evidence/u);
  assert.match(script, /--unshare-all --unshare-user --disable-userns --clearenv --die-with-parent --new-session/u);
  assert.doesNotMatch(script, /--bind \/ \/|--bind \/var\/run|--bind \/run|--share-net|--pidns|--dir \/phi/u);
  const argv = script.match(/bwrap_args=\(\n([\s\S]*?)\n\)/u)?.[1];
  assert.ok(argv, 'one explicit Bubblewrap argv block');
  assert.equal((argv.match(/--(?:ro-bind|bind|proc|dev|tmpfs)\b/gu) ?? []).length, 7, 'exactly seven static mount operations');
  for (const expected of [
    '--ro-bind "$stage/rootfs" /', '--proc /proc', '--dev /dev', '--tmpfs /tmp', '--tmpfs /run',
    '--bind "$stage/fixture" /phi', '--bind "$stage/evidence" /evidence',
  ]) assert.ok(argv.includes(expected), `classified mount ${expected}`);
  assert.doesNotMatch(argv, /--(?:bind|ro-bind) \/(?:home|var|run)(?:\/|\s)/u);
});

test('rootfs schema prepares only live static destinations and rejects omissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-e4-layout-'));
  try {
    const prepare = spawnSync('bash', [layoutUrl.pathname, 'prepare', root, probeUrl.pathname], { encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.match(prepare.stdout, /E4_ROOTFS_SCHEMA=phi-e4-host-v1/u);
    assert.deepEqual(readdirSync(join(root, 'phi')), []);
    for (const destination of ['phi', 'evidence', 'proc', 'dev', 'tmp', 'run', 'usr/local/bin']) assert.equal(existsSync(join(root, destination)), true, destination);
    assert.equal(existsSync(join(root, 'usr/local/bin/phi-e4-probe')), true);
    const valid = spawnSync('bash', [layoutUrl.pathname, 'validate', root, probeUrl.pathname], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    rmSync(join(root, 'phi'), { recursive: true });
    const missing = spawnSync('bash', [layoutUrl.pathname, 'validate', root, probeUrl.pathname], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /E4_HOST_FAIL=ROOTFS_MOUNTPOINT_MISSING:phi/u);
    mkdirSync(join(root, 'phi'));
    rmSync(join(root, 'run'), { recursive: true });
    const missingSynthetic = spawnSync('bash', [layoutUrl.pathname, 'validate', root, probeUrl.pathname], { encoding: 'utf8' });
    assert.notEqual(missingSynthetic.status, 0);
    assert.match(missingSynthetic.stderr, /E4_HOST_FAIL=ROOTFS_MOUNTPOINT_MISSING:run/u);
    mkdirSync(join(root, 'run'));
    rmSync(join(root, 'phi'), { recursive: true });
    symlinkSync(tmpdir(), join(root, 'phi'));
    const escaped = spawnSync('bash', [layoutUrl.pathname, 'validate', root, probeUrl.pathname], { encoding: 'utf8' });
    assert.notEqual(escaped.status, 0);
    assert.match(escaped.stderr, /E4_HOST_FAIL=ROOTFS_MOUNTPOINT_MISSING:phi/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(layout, /for destination in phi evidence proc dev tmp run usr usr\/local usr\/local\/bin/u);
});

test('complete 24-assertion feasibility and cleanup remain fail-closed', () => {
  for (const number of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20]) assert.match(probe, new RegExp(`assert ${number} `, 'u'));
  for (const number of [1, 2, 19, 21, 22, 23, 24]) assert.match(script, new RegExp(`E4_ASSERT_${number}=PASS`, 'u'));
  assert.match(probe, /CapEff:/u);
  assert.match(probe, /unshare --user --map-root-user/u);
  assert.match(probe, /mount -t tmpfs/u);
  assert.match(script, /owned_alive && fail OWNED_CHILD_SURVIVED/u);
  assert.match(script, /E4_CLEANUP=%s/u);
  assert.match(script, /E4_HOST_FEASIBILITY=FAIL/u);
  assert.match(script, /proof_passed=1/u);
  assert.match(script, /grep -Fxq 'E4_PROBE_COMPLETE=1'/u);
});
