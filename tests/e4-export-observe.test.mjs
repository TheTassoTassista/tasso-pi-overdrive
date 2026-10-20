import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildArguments, classifyBuildExit, resourceSnapshot } from '../scripts/e4-export-observe.mjs';

const script = new URL('../scripts/e4-export-observe.mjs', import.meta.url).pathname;
const candidateFixture = 'a'.repeat(40);

test('Buildx keeps frozen Dockerfile, signed contexts, --load and exact tag', () => {
  const args = buildArguments({ context: '/frozen/product', candidate: candidateFixture,
    runnerTemp: '/runner/_temp', evidenceDir: '/runner/_temp/phi-e4-export-evidence' });
  assert.deepEqual(args.slice(0, 4), ['buildx', 'build', '--file', '/frozen/product/certification/Dockerfile.e4']);
  assert.ok(args.includes(`PRODUCT_CANDIDATE_SHA=${candidateFixture}`));
  assert.ok(args.includes('seeds=/runner/_temp/phi-e4-seeds'));
  assert.ok(args.includes('lsp=/runner/_temp/phi-e4-lsp/managed'));
  assert.ok(args.includes('--progress=plain'));
  assert.ok(args.includes('--metadata-file'));
  assert.ok(args.includes('--load'));
  assert.ok(args.includes(`ghcr.io/thetassotassista/tasso-pi-overdrive-e4:${candidateFixture}`));
  assert.equal(args.at(-1), '/frozen/product');
});

test('numeric exit 143 does not invent SIGTERM actor; actual signal remains distinct', () => {
  assert.deepEqual(classifyBuildExit({ code: 143, signal: null, spawnError: null, observedSignal: null }),
    { kind: 'EXITED_NONZERO', code: 143, signal: null, actor: 'UNKNOWN' });
  assert.deepEqual(classifyBuildExit({ code: null, signal: 'SIGTERM', spawnError: null, observedSignal: null }),
    { kind: 'SIGNALLED', code: null, signal: 'SIGTERM', actor: 'UNKNOWN' });
  assert.equal(classifyBuildExit({ code: null, signal: null, spawnError: 'ENOENT' }).kind, 'SPAWN_ERROR');
});

test('resource telemetry preserves unavailable measurements as UNKNOWN/null', () => {
  const snapshot = resourceSnapshot('/nonexistent-phi-e4-telemetry-root', 'fixture');
  assert.equal(snapshot.filesystem, null);
  assert.equal(snapshot.dockerStorage, null);
  assert.match(snapshot.at, /^\d{4}-\d\d-\d\dT/u);
});

function runFixture(buildExit, { preexisting = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-export-observe-'));
  try {
    const context = path.join(parent, 'product');
    const runnerTemp = path.join(parent, '_temp');
    const bin = path.join(parent, 'bin');
    fs.mkdirSync(context);
    fs.mkdirSync(runnerTemp);
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(runnerTemp, 'phi-e4-seeds'));
    fs.mkdirSync(path.join(runnerTemp, 'phi-e4-lsp'));
    fs.writeFileSync(path.join(runnerTemp, 'foreign-user-state'), 'preserve');
    assert.equal(spawnSync('git', ['-C', context, 'init', '-q']).status, 0);
    assert.equal(spawnSync('git', ['-C', context, 'config', 'user.name', 'Fixture']).status, 0);
    assert.equal(spawnSync('git', ['-C', context, 'config', 'user.email', 'fixture@example.invalid']).status, 0);
    fs.writeFileSync(path.join(context, 'fixture'), 'frozen');
    assert.equal(spawnSync('git', ['-C', context, 'add', 'fixture']).status, 0);
    assert.equal(spawnSync('git', ['-C', context, 'commit', '-qm', 'frozen']).status, 0);
    const candidate = spawnSync('git', ['-C', context, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = process.env.PHI_FAKE_IMAGE_STATE;
if (args[0] === 'buildx' && args[1] === 'version') { console.log('buildx fixture v1'); process.exit(0); }
if (args[0] === 'version') { console.log('docker fixture v1'); process.exit(0); }
if (args[0] === 'system' && args[1] === 'df') { console.log('{"Type":"Images","Size":"1B"}'); process.exit(0); }
if (args[0] === 'image' && args[1] === 'inspect') {
  if (!fs.existsSync(state)) { console.error('Error: No such image'); process.exit(1); }
  const format = args.at(-1);
  console.log(format.includes('.Id') ? 'sha256:' + 'b'.repeat(64) + ' ' + process.env.PHI_FAKE_CANDIDATE : process.env.PHI_FAKE_CANDIDATE);
  process.exit(0);
}
if (args[0] === 'buildx' && args[1] === 'build') {
  console.log('#46 DONE'); console.log('#47 exporting layers'); console.error('token=fixture-secret-value');
  if (process.env.PHI_FAKE_BUILD_EXIT !== '0') process.exit(Number(process.env.PHI_FAKE_BUILD_EXIT));
  fs.writeFileSync(state, 'owned'); process.exit(0);
}
if (args[0] === 'image' && args[1] === 'rm') { fs.unlinkSync(state); process.exit(0); }
process.exit(7);
`;
    fs.writeFileSync(path.join(bin, 'docker'), fake, { mode: 0o755 });
    const state = path.join(parent, 'image-state');
    if (preexisting) fs.writeFileSync(state, 'foreign');
    const result = spawnSync(process.execPath,
      [script, '--candidate', candidate, '--context', context, '--mode', 'diagnostic'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: '123456', PHI_FAKE_IMAGE_STATE: state,
        PHI_FAKE_CANDIDATE: candidate, PHI_FAKE_BUILD_EXIT: String(buildExit) } });
    const evidence = path.join(runnerTemp, 'phi-e4-export-evidence');
    if (preexisting) {
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(state, 'utf8'), 'foreign');
      assert.equal(fs.readFileSync(path.join(runnerTemp, 'foreign-user-state'), 'utf8'), 'preserve');
      assert.equal(fs.existsSync(path.join(evidence, 'ownership.json')), false);
      return { result, receipt: null };
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence, 'export-receipt.json'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(runnerTemp, 'foreign-user-state'), 'utf8'), 'preserve');
    assert.equal(fs.existsSync(path.join(runnerTemp, 'phi-e4-seeds')), false);
    assert.equal(fs.existsSync(path.join(runnerTemp, 'phi-e4-lsp')), false);
    assert.equal(fs.existsSync(state), false);
    assert.equal(receipt.cleanup, 'PASS');
    assert.equal(receipt.candidate, candidate);
    assert.equal(receipt.mode, 'diagnostic');
    assert.equal(fs.existsSync(path.join(evidence, 'ownership.json')), true);
    assert.doesNotMatch(result.stdout, /fixture-secret-value/u);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-secret-value/u);
    return { result, receipt };
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test('failure preserves exact numeric exit, bounded receipt and owned-only cleanup', () => {
  const { result, receipt } = runFixture(143);
  assert.equal(result.status, 1);
  assert.equal(receipt.build.kind, 'EXITED_NONZERO');
  assert.equal(receipt.build.code, 143);
  assert.equal(receipt.build.signal, null);
  assert.equal(receipt.outputIdentity, null);
  assert.match(result.stdout, /E4_EXPORT_RESULT=FAIL/u);
});

test('export-only success records image identity then removes its owned local tag', () => {
  const { result, receipt } = runFixture(0);
  assert.equal(result.status, 0);
  assert.equal(receipt.build.kind, 'EXITED_ZERO');
  assert.equal(receipt.outputIdentity, `sha256:${'b'.repeat(64)}`);
  assert.match(result.stdout, /E4_EXPORT_RESULT=PASS/u);
});

test('a pre-existing tag fails before build and is never deleted as if owned', () => {
  const { result } = runFixture(0, { preexisting: true });
  assert.match(result.stderr, /cannot establish absent pre-build image tag/u);
});
