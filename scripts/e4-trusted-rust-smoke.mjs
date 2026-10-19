import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { attestE4InventorySandbox } from './e4-executable-inventory.mjs';
import { E4_SCRATCH, verifyE4NestedUsernsDenied, verifyE4TierMount } from './e4-tier-contract.mjs';
import { RUST_SMOKE_SOURCE, RUST_SMOKE_SOURCE_SHA256, rustSmokeExecEvidence,
  rustStartupEvidence } from './e4-rust-startup.mjs';

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bounded = (value) => {
  const bytes = Buffer.byteLength(value ?? '');
  assert.ok(bytes <= 32 * 1024, 'RUST_OUTPUT_TRUNCATED');
  return { text: value ?? '', bytes, complete: true };
};

export function runE4TrustedRustSmoke(options = {}) {
  const sandbox = (options.attestSandbox ?? attestE4InventorySandbox)();
  assert.equal(sandbox.status, 'PASS', 'TRUSTED_SANDBOX_FAILED');
  const mount = (options.verifyMount ?? verifyE4TierMount)('B');
  assert.equal(mount.tier, 'B', 'TRUSTED_SCRATCH_NOT_VERIFIED');
  (options.verifyUserns ?? verifyE4NestedUsernsDenied)();
  const manifest = JSON.parse(fs.readFileSync('/opt/phi/config/e4-toolchain-seeds.json', 'utf8'));
  const rustSeed = manifest.assets.find((asset) => asset.logicalName === 'rust-1.98.1-toolchain');
  assert.ok(rustSeed, 'RUST_SEED_MISSING');
  const rustcSha256 = rustSeed.extracted[0].sha256;
  const startup = rustStartupEvidence('/usr/bin/rustc', rustcSha256);
  assert.equal(startup.pass, true, `RUST_STARTUP_${startup.evidence.category}`);
  assert.equal(RUST_SMOKE_SOURCE_SHA256, 'eb4f840f763c216de8760bd7992845d3996689721dc73808a489214f064ce51f',
    'RUST_SOURCE_NOT_FROZEN');
  const workspace = fs.mkdtempSync(`${E4_SCRATCH}/phi-e4-rust-`);
  let cleanup = 'NOT_EXECUTED';
  let receipt;
  try {
    const executable = path.join(workspace, 'smoke');
    const compile = spawnSync('/usr/bin/rustc', ['--edition=2021', '-', '-o', executable], {
      input: RUST_SMOKE_SOURCE, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      cwd: workspace, env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    });
    const compileOutput = { exitCode: compile.status, errorCode: compile.error?.code ?? null,
      signal: compile.signal ?? null, stdout: bounded(compile.stdout), stderr: bounded(compile.stderr) };
    if (compile.error || compile.status !== 0) {
      const error = new Error(`RUST_COMPILE_${compile.error?.code ?? compile.status}`);
      error.evidence = { compile: compileOutput };
      throw error;
    }
    const before = rustSmokeExecEvidence(executable, null);
    assert.equal(before.file.realpath, executable, 'RUST_EXEC_PATH_ALIAS');
    assert.equal(before.file.type, 'FILE', 'RUST_EXEC_NOT_FILE');
    assert.equal(before.file.mode, '0755', 'RUST_EXEC_MODE');
    assert.equal(before.file.uid, 1001, 'RUST_EXEC_UID');
    assert.equal(before.file.gid, 1001, 'RUST_EXEC_GID');
    assert.equal(before.mount.target, E4_SCRATCH, 'RUST_EXEC_OUTSIDE_SCRATCH');
    assert.equal(before.mountExec, 'EXEC', 'RUST_EXEC_NOEXEC');
    assert.equal(before.file.effectiveXAccess.allowed, true, 'RUST_EXEC_ACCESS');
    const smoke = spawnSync(executable, [], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: '/opt/phi/runtime/dap/python' } });
    const execution = rustSmokeExecEvidence(executable, smoke);
    const executionOutput = { exitCode: smoke.status, errorCode: smoke.error?.code ?? null,
      signal: smoke.signal ?? null, stdout: bounded(smoke.stdout), stderr: bounded(smoke.stderr),
      dependencyResolution: execution.elfInterpreter?.dependencyResolution ?? 'UNKNOWN' };
    if (smoke.error || smoke.status !== 0) {
      const error = new Error(`RUST_EXEC_${smoke.error?.code ?? smoke.status}`);
      error.evidence = executionOutput;
      throw error;
    }
    assert.equal(smoke.signal, null, 'RUST_EXEC_SIGNAL');
    assert.equal(smoke.stdout, 'E4_RUST_SYSROOT_READY\n', 'RUST_EXEC_OUTPUT');
    assert.equal(smoke.stderr, '', 'RUST_EXEC_STDERR');
    assert.equal(execution.file.sha256, before.file.sha256, 'RUST_EXEC_IDENTITY_CHANGED');
    receipt = { status: 'PASS', rustcSha256, sourceSha256: RUST_SMOKE_SOURCE_SHA256,
      sandbox: { rootReadonly: sandbox.rootReadonly, uid: sandbox.uid, gid: sandbox.gid,
        effectiveCapabilities: sandbox.effectiveCapabilities,
        noNewPrivileges: sandbox.noNewPrivileges, networkInterfaces: sandbox.networkInterfaces },
      scratch: mount.scratch,
      executable: { path: executable, realpath: before.file.realpath, sha256: before.file.sha256,
        mode: before.file.mode, uid: before.file.uid, gid: before.file.gid },
      mount: { target: before.mount.target, id: before.mount.id, filesystem: before.mount.filesystem,
        exec: before.mountExec, nosuid: before.mount.flags.includes('nosuid'),
        nodev: before.mount.flags.includes('nodev') },
      compile: compileOutput,
      execution: { ...executionOutput, childPid: execution.childPid },
      cleanup: 'PENDING' };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: false });
    assert.equal(fs.existsSync(workspace), false, 'RUST_SCRATCH_RESIDUAL');
    cleanup = 'PASS';
    process.stdout.write(`E4_RUST_SMOKE_WORKSPACE_CLEANUP=${cleanup}\n`);
  }
  receipt.cleanup = cleanup;
  return receipt;
}
