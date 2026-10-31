import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'setup-second-brain.mjs');

test('Second Brain --check never installs and rejects unsafe existing storage', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-memory-check-'));
  const memoryRoot = path.join(temp, 'memory');
  const environment = { ...process.env, PI_OVERDRIVE_MEMORY_ROOT: memoryRoot };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env: environment, encoding: 'utf8' });
  try {
    const absent = run('--check');
    assert.notEqual(absent.status, 0);
    assert.equal(fs.existsSync(memoryRoot), false, 'read-only check must not create the absent vault');
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
    const file = path.join(memoryRoot, 'vault', 'SecondBrain', '01 Projects', 'Pi Overdrive', 'Architecture.md');
    assert.ok(fs.existsSync(file));
    fs.chmodSync(file, 0o644);
    assert.notEqual(run('--check').status, 0, 'public vault file must fail closed');
    assert.notEqual(run('--unexpected').status, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
