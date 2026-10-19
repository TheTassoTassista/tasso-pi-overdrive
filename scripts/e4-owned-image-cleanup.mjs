#!/usr/bin/env node
// Removes only this job's fixed staging/evidence directories and counts exact image entrypoints.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function cleanupOwnedImageStages(runnerTemp) {
  assert.equal(path.isAbsolute(runnerTemp), true, 'RUNNER_TEMP must be absolute');
  assert.equal(path.basename(runnerTemp), '_temp', 'unexpected runner temporary root');
  assert.equal(fs.realpathSync(runnerTemp), runnerTemp, 'runner temporary root is aliased');
  assert.equal(fs.statSync(runnerTemp).uid, process.getuid(), 'runner temporary root is foreign-owned');
  for (const name of ['phi-e4-seeds', 'phi-e4-lsp', 'phi-e4-linker-evidence', 'phi-e4-executable-inventory', 'phi-e4-execve-evidence', 'phi-e4-tier-evidence']) {
    const target = path.join(runnerTemp, name);
    try {
      const stat = fs.lstatSync(target);
      assert.equal(stat.isDirectory(), true, `${name} is not a directory`);
      assert.equal(stat.uid, process.getuid(), `${name} is foreign-owned`);
      fs.rmSync(target, { recursive: true, force: false });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.equal(fs.existsSync(target), false, `${name} remained after cleanup`);
  }
}

export function ownedImageEntrypointPids() {
  const markers = ['/opt/phi/e4-image-selfcheck.mjs', '/opt/phi/e4-rust-diagnostic.mjs',
    '/opt/phi/e4-rust-linker-diagnostic.mjs'];
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const args = fs.readFileSync(`/proc/${name}/cmdline`).toString('utf8').split('\0');
      if (args.some((arg) => markers.includes(arg))) found.push(Number(name));
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    cleanupOwnedImageStages(process.env.RUNNER_TEMP ?? '');
    const pids = ownedImageEntrypointPids();
    assert.equal(pids.length, 0, 'Phi image entrypoint process remained');
    console.log('E4_TEMP_SEED_STAGING_STATE=REMOVED');
    console.log('E4_TEMP_LSP_STAGING_STATE=REMOVED');
    console.log('E4_TEMP_LINKER_EVIDENCE_STATE=REMOVED');
    console.log('E4_TEMP_EXECUTABLE_INVENTORY_STATE=REMOVED');
    console.log('E4_TEMP_EXECVE_EVIDENCE_STATE=REMOVED');
    console.log('E4_TEMP_TIER_EVIDENCE_STATE=REMOVED');
    console.log('E4_TEMP_ROOTFS_STATE=NOT_CREATED_BY_IMAGE_ONLY_JOB');
    console.log(`E4_IMAGE_OWNED_PROCESSES_FINAL=${pids.length}`);
  } catch (error) {
    console.error(`E4_IMAGE_OWNED_CLEANUP=FAIL reason=${String(error.message).slice(0, 180)}`);
    process.exitCode = 1;
  }
}
