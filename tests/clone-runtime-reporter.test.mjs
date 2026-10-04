import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeObservations } from '../lib/phi-validation-evidence.mjs';

test('diagnostic TAP preserves pass/fail and emits only safe, ordered timing metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-reporter-'));
  try {
    const fixture = path.join(directory, 'fixture.mjs');
    fs.writeFileSync(fixture, `import test from 'node:test';
test('private-one', async () => { await new Promise(r => setTimeout(r, 35)); });
test('private-two', () => { throw new Error('private-error'); });
`);
    const reporter = path.resolve('scripts/phi-runtime-reporter.mjs');
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const ordinary = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { env, encoding: 'utf8', timeout: 10000 });
    const observed = spawnSync(process.execPath, ['--test', '--test-reporter', reporter, fixture], { env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(ordinary.error); assert.ifError(observed.error);
    assert.equal(ordinary.status, 1); assert.equal(observed.status, ordinary.status);
    for (const output of [ordinary.stdout, observed.stdout]) {
      assert.match(output, /^# tests 2$/m); assert.match(output, /^# pass 1$/m); assert.match(output, /^# fail 1$/m);
    }
    const evidence = runtimeObservations(observed.stdout);
    assert.equal(evidence.completed, 2); assert.equal(evidence.contiguous, true);
    assert.equal(evidence.rows[0].kind, 'start'); assert.equal(evidence.rows.at(-1).kind, 'end');
    assert.equal(evidence.rows.find(row => row.ordinal === 2).failed, true);
    assert.ok(evidence.longestTests.some(row => row.durationMs >= 30));
    assert.ok(evidence.longestObservedCompletionGap.elapsedMs >= 30);
    assert.doesNotMatch(JSON.stringify(evidence), /private-|fixture\.mjs/);
    assert.throws(() => runtimeObservations('# PHI_RUNTIME {"kind":"completion"}'), /PHI_RUNTIME_DIAGNOSTIC_INVALID/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
