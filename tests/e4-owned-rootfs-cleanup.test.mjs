import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = new URL('../certification/e4-owned-rootfs-cleanup.sh', import.meta.url).pathname;
const make = () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-cleanup-test-'));
  const stage = path.join(temp, 'phi-e4-preflight.ABCDEF12');
  fs.mkdirSync(stage, { mode: 0o700 });
  return { temp, stage };
};
const clean = (stage, temp, env = process.env) => spawnSync('bash', [helper, stage, temp], { env, encoding: 'utf8' });

test('owned CA-layout rootfs with read-only files is removed without touching a symlink target', () => {
  const { temp, stage } = make();
  const outside = path.join(temp, 'unrelated');
  const cadir = path.join(stage, 'rootfs/etc/ca-certificates/extracted/cadir');
  fs.mkdirSync(cadir, { recursive: true });
  fs.writeFileSync(path.join(cadir, 'root.pem'), 'read-only fixture');
  fs.chmodSync(path.join(cadir, 'root.pem'), 0o444);
  fs.writeFileSync(outside, 'preserve');
  fs.symlinkSync(outside, path.join(stage, 'rootfs/outside-link'));
  fs.chmodSync(cadir, 0o555);
  try {
    const ordinary = spawnSync('rm', ['-rf', '--', stage], { encoding: 'utf8' });
    assert.equal(ordinary.status, 1, 'reproduces the original permission denial');
    assert.match(ordinary.stderr, /Permission denied/u);
    const repaired = clean(stage, temp);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /E4_OWNED_ROOTFS_CLEANUP=PASS/u);
    assert.equal(fs.existsSync(stage), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('real tar --no-same-owner extraction retains non-writable CA directory mode and cleanup restores deletability', () => {
  const { temp, stage } = make();
  const source = path.join(temp, 'source');
  const cadir = path.join(source, 'etc/ca-certificates/extracted/cadir');
  const archive = path.join(temp, 'rootfs.tar');
  fs.mkdirSync(cadir, { recursive: true });
  fs.writeFileSync(path.join(cadir, 'root.pem'), 'fixture');
  fs.chmodSync(cadir, 0o555);
  fs.mkdirSync(path.join(stage, 'rootfs'));
  try {
    const packed = spawnSync('tar', ['-cf', archive, '-C', source, '.'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const extracted = spawnSync('tar', ['--no-same-owner', '-xf', archive, '-C', path.join(stage, 'rootfs')], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    const destination = path.join(stage, 'rootfs/etc/ca-certificates/extracted/cadir');
    assert.equal(fs.statSync(destination).uid, process.getuid());
    assert.equal(fs.statSync(destination).mode & 0o777, 0o555);
    const removed = spawnSync('rm', ['-rf', '--', stage], { encoding: 'utf8' });
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /Permission denied/u);
    assert.equal(clean(stage, temp).status, 0);
    assert.equal(fs.existsSync(stage), false);
  } finally {
    fs.chmodSync(cadir, 0o755);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('owned unreadable systemd directory is diagnosed before owner-only repair and complete removal', () => {
  const { temp, stage } = make();
  const outside = path.join(temp, 'unrelated');
  const dissect = path.join(stage, 'rootfs/run/systemd/dissect-root');
  fs.mkdirSync(dissect, { recursive: true });
  fs.writeFileSync(path.join(dissect, 'owned'), 'fixture');
  fs.writeFileSync(outside, 'preserve');
  fs.chmodSync(dissect, 0o000);
  try {
    const original = spawnSync('find', ['-P', stage, '-xdev', '-type', 'd'], { encoding: 'utf8' });
    assert.notEqual(original.status, 0, 'the historical census cannot traverse an unreadable directory');
    assert.match(original.stderr, /Permission denied/u);
    const repaired = clean(stage, temp);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, new RegExp(`E4_OWNED_ROOTFS_DISSECT_BEFORE=uid:${process.getuid()} gid:.* mode:0 type:directory`, 'u'));
    assert.equal(fs.existsSync(stage), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
    const again = clean(stage, temp);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already_absent=1/u);
  } finally {
    if (fs.existsSync(dissect)) fs.chmodSync(dissect, 0o700);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('absent rootfs is safe but a symlinked rootfs or foreign stage shape fails closed', () => {
  const first = make();
  const second = make();
  try {
    assert.equal(clean(first.stage, first.temp).status, 0);
    fs.symlinkSync(first.temp, path.join(second.stage, 'rootfs'));
    const linked = clean(second.stage, second.temp);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /ROOTFS_SYMLINK/u);
    assert.equal(fs.existsSync(second.stage), true);
    const wrong = clean(second.temp, second.temp);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /STAGE_SHAPE/u);
  } finally {
    fs.rmSync(first.temp, { recursive: true, force: true });
    fs.rmSync(second.temp, { recursive: true, force: true });
  }
});

test('active mount and unavailable mount census both fail before changing owned stage', () => {
  const { temp, stage } = make();
  fs.mkdirSync(path.join(stage, 'rootfs'));
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  const fake = path.join(bin, 'findmnt');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  try {
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${stage}/rootfs'\n`);
    fs.chmodSync(fake, 0o755);
    const mounted = clean(stage, temp, env);
    assert.notEqual(mounted.status, 0);
    assert.match(mounted.stderr, /ACTIVE_MOUNT/u);
    assert.equal(fs.existsSync(stage), true);
    fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n');
    const unknown = clean(stage, temp, env);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /MOUNT_CENSUS/u);
    assert.equal(fs.existsSync(stage), true);
    assert.equal(clean(stage, temp).status, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('foreign directory metadata and failed removal both fail closed without deleting unrelated state', () => {
  const { temp, stage } = make();
  const foreign = path.join(stage, 'rootfs/foreign');
  const unrelated = path.join(temp, 'unrelated');
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(foreign, { recursive: true });
  fs.chmodSync(foreign, 0o000);
  fs.mkdirSync(bin);
  fs.writeFileSync(unrelated, 'preserve');
  const stat = path.join(bin, 'stat');
  const rm = path.join(bin, 'rm');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PHI_TEST_FOREIGN: foreign };
  try {
    fs.writeFileSync(stat, '#!/bin/sh\nif [ "$1" = "-c" ] && [ "$2" = "%u" ] && [ "$4" = "$PHI_TEST_FOREIGN" ]; then printf "999999\\n"; else exec /usr/bin/stat "$@"; fi\n');
    fs.chmodSync(stat, 0o755);
    const denied = clean(stage, temp, env);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /FOREIGN_DIRECTORY/u);
    assert.equal(fs.statSync(foreign).mode & 0o777, 0o000, 'foreign directory mode is not modified');
    fs.rmSync(stat);
    fs.chmodSync(foreign, 0o755);
    fs.writeFileSync(rm, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(rm, 0o755);
    const partial = clean(stage, temp, env);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /E4_OWNED_ROOTFS_CLEANUP_FAIL=REMOVE/u);
    assert.equal(fs.existsSync(stage), true);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve');
    assert.equal(clean(stage, temp).status, 0);
  } finally {
    if (fs.existsSync(foreign)) fs.chmodSync(foreign, 0o755);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
