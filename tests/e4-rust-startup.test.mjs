import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyRustStartup, containingMount, rustSmokeExecEvidence, rustStartupEvidence } from '../scripts/e4-rust-startup.mjs';

test('bounded Rust startup diagnostics classify the exact missing SONAME', () => {
  assert.deepEqual(classifyRustStartup(
    '/usr/bin/rustc: error while loading shared libraries: libLLVM.so.22.1: cannot open shared object file: No such file or directory', true),
  { category: 'MISSING_SHARED_LIBRARY', missingLibraries: ['libLLVM.so.22.1'] });
  assert.deepEqual(classifyRustStartup('', false), { category: 'MISSING_ELF_INTERPRETER', missingLibraries: [] });
  assert.deepEqual(classifyRustStartup('unclassified status 127', true), { category: 'UNKNOWN', missingLibraries: [] });
});

test('Rust startup probe retains bounded executable identity and actual nonzero exit', () => {
  const binary = fs.realpathSync('/usr/bin/false');
  const sha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const result = rustStartupEvidence(binary, sha256);
  assert.equal(result.pass, false);
  assert.equal(result.evidence.path, binary);
  assert.equal(result.evidence.realpath, binary);
  assert.equal(result.evidence.sha256, sha256);
  assert.equal(result.evidence.exitCode, 1);
  assert.equal(result.evidence.interpreterExists, true);
  assert.equal(result.evidence.category, 'UNKNOWN');
  assert.ok(result.evidence.stderr.length <= 320);
});

test('Rust smoke exec evidence identifies the containing mount, modes and a real missing execute bit',
  { skip: process.platform !== 'linux' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-exec-evidence-'));
  try {
    const binary = path.join(directory, 'smoke');
    fs.copyFileSync('/usr/bin/true', binary);
    fs.chmodSync(binary, 0o755);
    const executableAttempt = spawnSync(binary, []);
    const executableEvidence = rustSmokeExecEvidence(binary, executableAttempt);
    assert.equal(executableEvidence.file.mode, '0755');
    if (executableEvidence.mountExec === 'NOEXEC') assert.equal(executableAttempt.error?.code, 'EACCES');
    else {
      assert.equal(executableEvidence.mountExec, 'EXEC');
      assert.equal(executableAttempt.status, 0);
    }
    fs.chmodSync(binary, 0o644);
    const denial = spawnSync(binary, []);
    assert.equal(denial.error?.code, 'EACCES');
    const evidence = rustSmokeExecEvidence(binary, denial);
    assert.equal(evidence.file.path, binary);
    assert.equal(evidence.file.realpath, binary);
    assert.equal(evidence.file.mode, '0644');
    assert.equal(evidence.file.uid, process.getuid());
    assert.equal(evidence.file.gid, process.getgid());
    assert.equal(evidence.directories[0].path, directory);
    assert.equal(evidence.directories[0].mode, (fs.statSync(directory).mode & 0o7777).toString(8).padStart(4, '0'));
    assert.equal(evidence.executingUid, process.getuid());
    assert.equal(evidence.errorCode, 'EACCES');
    assert.equal(evidence.exitCode, null);
    assert.equal(evidence.elfInterpreter.exists, true);
    assert.ok(['EXEC', 'DYN'].includes(evidence.elfInterpreter.elfType));
    assert.equal(typeof evidence.mount.target, 'string');
    assert.ok(evidence.mount.flags.includes('rw'));
    assert.equal(evidence.mountExec, executableEvidence.mountExec);
    assert.equal(evidence.lsmDenial, 'LSM_EVIDENCE_UNAVAILABLE');
    assert.ok(JSON.stringify(evidence).length < 4096);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(fs.existsSync(directory), false);
  }
});

test('mount evidence selects the deepest real mount and preserves noexec when directly observed', () => {
  const mountinfo = '1 0 8:1 / / rw - ext4 /dev/sda rw\n2 1 0:3 / /tmp rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n';
  assert.deepEqual(containingMount('/tmp/phi-e4-rust-x/smoke', mountinfo),
    { id: 2, root: '/', target: '/tmp', filesystem: 'tmpfs', flags: ['rw', 'nosuid', 'nodev', 'noexec'],
      superFlags: ['rw'], overlappingAncestors: 1 });
  assert.deepEqual(containingMount('/tmpish/smoke', mountinfo),
    { id: 1, root: '/', target: '/', filesystem: 'ext4', flags: ['rw'], superFlags: ['rw'], overlappingAncestors: 0 });
  assert.equal(containingMount('/tmp/smoke', 'unavailable'), 'UNKNOWN');
  assert.equal(containingMount('/tmp/smoke', `${mountinfo}3 2 0:4 / /tmp rw - tmpfs tmpfs rw\n`), 'UNKNOWN');
});

test('unavailable Rust smoke diagnostics remain explicitly UNKNOWN', () => {
  const unavailable = () => { throw new Error('not available'); };
  const evidence = rustSmokeExecEvidence('/tmp/phi-e4-rust-x/smoke', { error: { code: 'EACCES' }, status: null },
    { stat: unavailable, realpath: unavailable, readFile: unavailable, spawn: unavailable });
  assert.equal(evidence.file, 'UNKNOWN');
  assert.equal(evidence.mount, 'UNKNOWN');
  assert.equal(evidence.mountExec, 'UNKNOWN');
  assert.equal(evidence.elfInterpreter, 'UNKNOWN');
  assert.equal(evidence.lsm, 'UNKNOWN');
  assert.ok(evidence.directories.every((directory) => directory === 'UNKNOWN'));
  assert.equal(evidence.errorCode, 'EACCES');
});
