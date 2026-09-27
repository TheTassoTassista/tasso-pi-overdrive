import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeCodingTool, verifyCodingProject, requireCodingBackend } from '../platform/shared/coding-execution.mjs';
import { executeBrokeredSafeExec } from '../platform/shared/safe-exec-handler.mjs';
import { windowsCodingIntent, windowsVerificationCommands, readWindowsProjectSnapshot, codingFailureReason } from '../platform/windows/coding-tools.mjs';
import { windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { requireAutonomousBackend } from '../platform/index.mjs';

const native = { skip: process.platform !== 'win32', timeout: 30000 };
const sessionId = '11111111-2222-3333-4444-555555555555';
const ctx = (cwd) => ({ cwd, sessionManager: { getSessionId: () => sessionId } });
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-production-tools-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  for (const [name, text] of Object.entries(files)) { const file = path.join(project, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
  const git = spawnSync('git', ['init', '--quiet', project], { shell: false, encoding: 'utf8', timeout: 10000 });
  assert.equal(git.status, 0);
  return { root, project, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function attest(receipt, profile, productionPath) {
  assert.equal(receipt.platform, 'win32'); assert.equal(receipt.backend, 'windows-lpac-broker');
  assert.equal(receipt.profile, profile); assert.equal(receipt.productionPath, productionPath);
  assert.equal(receipt.tokenVerified, true); assert.equal(receipt.jobAttested, true); assert.equal(receipt.targetStarted, true);
  assert.equal(receipt.cleanup, 'PASS'); assert.equal(receipt.projectPublished, false);
  assert.match(receipt.snapshotDigest, /^[0-9a-f]{64}$/u);
}
test('production intents derive bounded profiles and reject shell/runner/options authority', () => {
  assert.equal(windowsCodingIntent('node', ['--check', 'src/input.cjs'], 'safe-exec').profile, 'READ_ONLY');
  assert.equal(windowsCodingIntent('node', ['test.cjs'], 'safe-exec').profile, 'TEST');
  assert.equal(windowsCodingIntent('node', ['--check', 'input.cjs'], 'verification').profile, 'TEST');
  for (const program of ['cmd', 'powershell', 'npm', 'git', 'node.exe']) assert.throws(() => windowsCodingIntent(program, ['input.cjs'], 'safe-exec'), /UNREGISTERED/u);
  for (const args of [['--eval', '1'], ['--require', 'input.cjs'], ['../input.cjs'], ['C:/input.cjs'], ['--check', 'input.cjs', '--inspect'], ['--test', 'input.cjs']]) assert.throws(() => windowsCodingIntent('node', args, 'safe-exec'), /UNREGISTERED/u);
});
test('verification registration never executes package shell text or omits an unsupported selected check', () => {
  const make = (scripts) => ({ files: { 'package.json': JSON.stringify({ scripts }) } });
  for (const manifest of ['null', '[]', '{"scripts":[]}', '{"scripts":null}']) assert.throws(() => windowsVerificationCommands({ files: { 'package.json': manifest } }), /MANIFEST_INVALID/u);
  assert.deepEqual(windowsVerificationCommands(make({ lint: 'node --check source.cjs', test: 'node test.cjs' })).map((row) => row.args), [['--check', 'source.cjs'], ['test.cjs']]);
  for (const command of ['node test.cjs && echo PASS', 'node test.cjs;exit 0', 'npm test', 'node --eval 1', 'node ../outside.cjs', 'node test.cjs > output', 'node --test test.cjs']) assert.throws(() => windowsVerificationCommands(make({ test: command })), /UNREGISTERED/u);
});
test('structured failure classification preserves cleanup/security/nonzero/timeout/cancellation', () => {
  const base = { cleanup: 'PASS', exitCode: 0, timedOut: false, securityFailure: null };
  assert.equal(codingFailureReason(base), null);
  assert.equal(codingFailureReason({ ...base, exitCode: 73 }), 'PROCESS_EXITED_NONZERO');
  assert.equal(codingFailureReason({ ...base, exitCode: 124, timedOut: true }), 'TIMEOUT');
  assert.equal(codingFailureReason({ ...base, securityFailure: 'LAUNCH', exitCode: 70 }), 'SECURITY_SETUP_FAILED');
  assert.equal(codingFailureReason({ ...base, securityFailure: 'CANCELLED', exitCode: 125 }), 'CANCELLED');
  assert.equal(codingFailureReason({ ...base, cleanup: 'FAIL' }), 'RECOVERY_FAILED');
});
test('registered production paths use shared broker dispatch without Windows pi.exec or direct target spawn', () => {
  const extension = fs.readFileSync(new URL('../extensions/safe-exec.ts', import.meta.url), 'utf8');
  assert.match(extension, /return executeBrokeredSafeExec\(params, ctx, signal/u);
  const windowsBranch = extension.slice(extension.indexOf('if (process.platform === "win32")'), extension.indexOf('requireCodingBackend("safe-exec")'));
  assert.doesNotMatch(windowsBranch, /pi\.exec|spawn|runOwnedEngine|sandboxInvocation/u);
  for (const file of ['extensions/verification-gate.ts', 'scripts/verify-project.mjs']) assert.match(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /verifyCodingProject/u);
  const source = fs.readFileSync(new URL('../platform/windows/coding-tools.mjs', import.meta.url), 'utf8');
  assert.match(source, /await runWindowsSecureBroker\(request/u);
  assert.doesNotMatch(source, /runOwnedEngine|shell: true|spawnSync\(['"](?:node|cmd|powershell|git|npm)/u);
});
test('B1 platform transport cannot replace Linux Bubblewrap', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(executeCodingTool({}, {}), /BACKEND_UNAVAILABLE/u);
  await assert.rejects(verifyCodingProject({}), /BACKEND_UNAVAILABLE/u);
});
test('native real production safe_exec handler: syntax and TEST source/temp access, LPAC denial and metadata', native, async () => {
  const script = "const fs=require('node:fs'),p=require('node:path');const assert=require('node:assert/strict');assert.equal(fs.readFileSync('input.txt','utf8'),'source');assert.throws(()=>fs.writeFileSync('input.txt','changed'),e=>['EPERM','EACCES'].includes(e.code));assert.throws(()=>fs.readFileSync(p.join(p.dirname(process.cwd()),'private','control.txt')),e=>['EPERM','EACCES'].includes(e.code));fs.writeFileSync(p.join(process.env.TEMP,'result.txt'),'temporary');console.log('REAL_PRODUCTION_TEST');";
  const item = fixture({ 'run.cjs': script, 'input.txt': 'source', '.env': 'NEVER_EMIT_PRIVATE_SENTINEL' });
  try {
    for (const [args, profile] of [[['--check', 'run.cjs'], 'READ_ONLY'], [['run.cjs'], 'TEST']]) {
      const events = [];
      const result = await executeBrokeredSafeExec({ program: 'node', args }, ctx(item.project), undefined, (row) => events.push(row));
      attest(result.details.receipt, profile, 'safe_exec');
      assert.equal(events.length, 1); assert.deepEqual(events[0], result.details.receipt);
      assert.equal(result.details.receipt.sessionId, sessionId.replaceAll('-', ''));
      assert.equal(result.details.receipt.publicationState, 'VERIFIED');
      assert.doesNotMatch(JSON.stringify(events), /NEVER_EMIT_PRIVATE_SENTINEL|run\.cjs|input\.txt|stdout|environment|argv/u);
      if (profile === 'TEST') assert.match(result.content[0].text, /REAL_PRODUCTION_TEST/u);
    }
    assert.equal(fs.readFileSync(path.join(item.project, 'input.txt'), 'utf8'), 'source');
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { item.cleanup(); }
});
test('native production safe_exec forbidden mutation propagates actual nonzero receipt; no project publication', native, async () => {
  const item = fixture({ 'run.cjs': "require('node:fs').writeFileSync('input.txt','attack')", 'input.txt': 'source' });
  try {
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'] }, ctx(item.project)), (error) => {
      attest(error.receipt, 'TEST', 'safe_exec');
      assert.equal(error.code, 'PROCESS_EXITED_NONZERO'); assert.equal(error.receipt.exitCode, 1);
      assert.equal(error.receipt.publicationState, 'ROLLED_BACK'); return true;
    });
    assert.equal(fs.readFileSync(path.join(item.project, 'input.txt'), 'utf8'), 'source');
  } finally { item.cleanup(); }
});
test('native anchored project extraction rejects real junction/hardlink and preserves source/alias targets', native, () => {
  const item = fixture({ 'run.cjs': "console.log('source')", '.env': 'NEVER_EMIT_PRIVATE_SENTINEL' });
  try {
    const snapshot = readWindowsProjectSnapshot(item.project);
    assert.equal(snapshot.files['run.cjs'], "console.log('source')");
    assert.equal(Object.hasOwn(snapshot.files, '.env'), false);
    fs.linkSync(path.join(item.project, 'run.cjs'), path.join(item.project, 'alias.cjs'));
    assert.throws(() => readWindowsProjectSnapshot(item.project), /SNAPSHOT_REJECTED/u);
    fs.unlinkSync(path.join(item.project, 'alias.cjs'));
    const outside = path.join(item.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel.cjs'), 'PRIVATE_CONTROL');
    const alias = path.join(item.project, 'alias'); fs.symlinkSync(outside, alias, 'junction');
    assert.equal(fs.readFileSync(path.join(alias, 'sentinel.cjs'), 'utf8'), 'PRIVATE_CONTROL');
    assert.throws(() => readWindowsProjectSnapshot(item.project), /SNAPSHOT_REJECTED/u);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.cjs'), 'utf8'), 'PRIVATE_CONTROL');
  } finally { item.cleanup(); }
});
test('native production verification actual Git fixture, Node unit test, syntax, exit and CLI evidence', native, async () => {
  const item = fixture({ 'package.json': JSON.stringify({ scripts: { lint: 'node --check source.cjs', test: 'node test.cjs' } }),
    'source.cjs': 'module.exports=42;', 'test.cjs': "require('node:test')('real unit',()=>require('node:assert/strict').equal(require('./source.cjs'),42));" });
  try {
    const summary = await verifyCodingProject({ cwd: item.project });
    assert.equal(summary.status, 'PASS', JSON.stringify(summary.results.map((row) => row.receipt)));
    assert.equal(summary.results.length, 2);
    for (const row of summary.results) attest(row.receipt, 'TEST', 'verification');
    assert.match(summary.results[1].output, /real unit/u);
    fs.writeFileSync(path.join(item.project, 'test.cjs'), "console.error('FATAL actual failure');process.exit(73)");
    const failed = await verifyCodingProject({ cwd: item.project });
    assert.equal(failed.status, 'FAIL'); assert.equal(failed.results.at(-1).exitCode, 73);
    assert.equal(failed.results.at(-1).receipt.failureReason, 'PROCESS_EXITED_NONZERO');
    assert.match(failed.results.at(-1).output, /FATAL actual failure/u);
    const script = fileURLToPath(new URL('../scripts/verify-project.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, '--json', '--cwd', item.project], { shell: false, encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).results.at(-1).exitCode, 73);
  } finally { item.cleanup(); }
});
test('native verification timeout/crash propagate and cleanup never become PASS', native, async () => {
  const item = fixture({ 'package.json': JSON.stringify({ scripts: { test: 'node test.cjs' } }), 'test.cjs': 'setInterval(()=>{},1000);' });
  try {
    const timed = await verifyCodingProject({ cwd: item.project, timeoutMs: 250 });
    assert.equal(timed.status, 'FAIL'); assert.equal(timed.results[0].exitCode, 124);
    assert.equal(timed.results[0].receipt.failureReason, 'TIMEOUT'); assert.equal(timed.results[0].receipt.cleanup, 'PASS');
    fs.writeFileSync(path.join(item.project, 'test.cjs'), 'process.abort();');
    const crashed = await verifyCodingProject({ cwd: item.project });
    assert.equal(crashed.status, 'FAIL'); assert.notEqual(crashed.results[0].exitCode, 0);
    assert.equal(crashed.results[0].receipt.cleanup, 'PASS');
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { item.cleanup(); }
});
test('native model-shaped authority and unavailable helper fail without weaker target execution', native, async () => {
  const item = fixture({ 'run.cjs': 'process.exit(99);' });
  try {
    for (const field of ['profile', 'role', 'executable', 'grants', 'platform', 'shell', 'runner']) await assert.rejects(
      executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'], [field]: 'EDIT' }, ctx(item.project)), /REQUEST_INVALID/u);
    // Independent real source copy, without cache: do not temporarily remove
    // the shared helper while other native test files execute concurrently.
    const copy = path.join(item.root, 'isolated-source');
    fs.cpSync(fileURLToPath(new URL('../platform', import.meta.url)), path.join(copy, 'platform'), { recursive: true });
    const isolated = await import(pathToFileURL(path.join(copy, 'platform/shared/safe-exec-handler.mjs')).href);
    await assert.rejects(isolated.executeBrokeredSafeExec({ program: 'node', args: ['run.cjs'] }, ctx(item.project)), /BUILD_REQUIRED/u);
    assert.throws(() => requireCodingBackend('workflow'), /BACKEND_UNAVAILABLE/u);
    assert.throws(() => requireAutonomousBackend('win32'), /SANDBOX_UNAVAILABLE/u);
  } finally { item.cleanup(); }
});
