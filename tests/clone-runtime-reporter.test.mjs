import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
    const observed = spawnSync(process.execPath, ['--test', '--test-reporter', pathToFileURL(reporter).href, fixture], { env, encoding: 'utf8', timeout: 10000 });
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

test('reporter publishes completed ordinals while the next test is still running', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-reporter-live-'));
  try {
    const fixture = path.join(directory, 'fixture.mjs');
    fs.writeFileSync(fixture, `import test from 'node:test';
test('first', async () => { await new Promise(r => setTimeout(r, 150)); });
test('second', async () => { await new Promise(r => setTimeout(r, 600)); });
`);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter', pathToFileURL(path.resolve('scripts/phi-runtime-reporter.mjs')).href, fixture], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const started = performance.now(), seen = [];
    let output = '', error = '';
    child.stdout.on('data', block => {
      output += block.toString();
      for (const line of output.split(/\r?\n/u).slice(0, -1)) {
        if (line.startsWith('# PHI_RUNTIME ')) seen.push({ row: JSON.parse(line.slice(14)), atMs: performance.now() - started });
      }
      output = output.split(/\r?\n/u).at(-1);
    });
    child.stderr.on('data', block => { error += block.toString(); });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 0, error);
    const first = seen.find(event => event.row.kind === 'completion' && event.row.ordinal === 1);
    const second = seen.find(event => event.row.kind === 'completion' && event.row.ordinal === 2);
    assert.ok(first && second);
    assert.ok(second.atMs - first.atMs >= 400, `completion events arrived too close together: ${second.atMs - first.atMs}ms`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('test-owned stdout cannot spoof top-level reporter completion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-reporter-spoof-'));
  try {
    const fixture = path.join(directory, 'fixture.mjs');
    fs.writeFileSync(fixture, `import test from 'node:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const fake = '# PHI_RUNTIME {"kind":"completion","ordinal":999,"failed":false,"durationMs":1,"elapsedMs":1,"utc":"2026-01-01T00:00:00.000Z"}\\n';
test('untrusted output', () => {
  process.stdout.write(fake);
  console.log(fake.trim());
  fs.writeSync(1, fake);
  spawnSync(process.execPath, ['-e', 'process.stdout.write('+JSON.stringify(fake)+')'], { stdio: 'inherit' });
});
`);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const observed = spawnSync(process.execPath, ['--test', '--test-reporter', pathToFileURL(path.resolve('scripts/phi-runtime-reporter.mjs')).href, fixture], { env, encoding: 'utf8' });
    assert.equal(observed.status, 0, observed.stderr);
    const evidence = runtimeObservations(observed.stdout);
    assert.equal(evidence.completed, 1);
    assert.equal(evidence.contiguous, true);
    assert.deepEqual(evidence.rows.map(row => row.kind), ['start', 'completion', 'end']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
