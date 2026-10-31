import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const manager = path.resolve(import.meta.dirname, '..', 'scripts', 'pi-overdrive-memory-services.sh');

test('real Second Brain manager script reuses health, starts and stops only fixture units', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-memory-manager-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  const state = path.join(root, 'state');
  const log = path.join(root, 'calls');
  fs.writeFileSync(state, 'inactive');
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$PHI_FIXTURE_LOG"\ncase "$2" in start) printf active > "$PHI_FIXTURE_STATE";; stop) printf inactive > "$PHI_FIXTURE_STATE";; is-active) test "$(cat "$PHI_FIXTURE_STATE")" = active;; *) exit 2;; esac\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\ntest "$(cat "$PHI_FIXTURE_STATE")" = active\n', { mode: 0o700 });
  const env = { ...process.env, PI_OVERDRIVE_MEMORY_TEST_MODE: '1', PI_OVERDRIVE_MEMORY_TEST_BIN_DIR: bin,
    PI_OVERDRIVE_MEMORY_WAIT_ATTEMPTS: '1', PI_OVERDRIVE_MEMORY_WAIT_INTERVAL: '0.01', PHI_FIXTURE_STATE: state, PHI_FIXTURE_LOG: log };
  const run = (action) => spawnSync('bash', [manager, action], { env, encoding: 'utf8', timeout: 3000 });
  try {
    assert.notEqual(run('status').status, 0);
    assert.equal(run('start').status, 0);
    assert.equal(run('status').status, 0);
    assert.equal(run('start').status, 0, 'repeated start remains healthy');
    assert.equal(run('stop').status, 0);
    assert.notEqual(run('status').status, 0);
    assert.equal(fs.readFileSync(state, 'utf8'), 'inactive');
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['--user', '--user', '--user', '--user', '--user', '--user']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
