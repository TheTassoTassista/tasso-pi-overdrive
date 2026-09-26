import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsProcessRequest, WINDOWS_PROCESS_LIMITS, runOwnedEngine, parseWindowsRecoveryStatus } from '../platform/windows/process.mjs';
import { requireAutonomousBackend } from '../platform/index.mjs';
import { windowsBuildEnvironment } from '../platform/windows/toolchain.mjs';
import { buildWindowsProcess } from '../platform/windows/build-process.mjs';

const native = { skip: process.platform !== 'win32', timeout: 20000 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const moduleUrl = new URL('../platform/windows/process.mjs', import.meta.url).href;
function run(program, args = [], options = {}) {
  const request = windowsProcessRequest(process.execPath, ['-e', program, ...args], { timeoutMs: 8000, ...options });
  return spawnSync(ownedWindowsHelper(), [], { shell: false, encoding: 'utf8', input: `${JSON.stringify(request)}\n${options.input ?? ''}`, timeout: 16000, maxBuffer: 4 * 1024 * 1024 });
}
async function receipt(file) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    await delay(20);
  }
  throw new Error('Fixture did not produce a process receipt');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function gone(pids) {
  const deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await delay(20);
  assert.deepEqual(pids.filter(alive), [], 'Owned generation still running');
}
function tree(file, exitParent) {
  const descendant = `const{spawn}=require('node:child_process');const fs=require('node:fs');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,g.pid]));setInterval(()=>{},1000);`;
  return `const{spawn}=require('node:child_process');const fs=require('node:fs');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:true}).unref();setInterval(()=>{${exitParent ? `if(fs.existsSync(${JSON.stringify(file)}))process.exit(7);` : ''}},10);`;
}

test('Windows process ownership is never advertised as autonomous sandbox authority', () => {
  assert.equal(WINDOWS_PROCESS_LIMITS.processes, 32);
  assert.equal(WINDOWS_PROCESS_LIMITS.lifetimeMs, 120000);
  assert.throws(() => requireAutonomousBackend('win32'), /SANDBOX_UNAVAILABLE/u);
  const source = fs.readFileSync(new URL('../platform/windows/native/OwnedProcess.cs', import.meta.url), 'utf8');
  assert.match(source, /JobListAttribute = 0x2000d/u);
  assert.match(source, /HandleListAttribute = 0x20002/u);
  assert.doesNotMatch(source, /AssignProcessToJobObject\(/u);
  assert.match(source, /limits\.Basic\.ActiveProcessLimit = 32/u);
});
test('Doctor native recovery metadata requires actual matching exit status and never emits extra private fields', () => {
  const row = { scope: 'FIXED_NATIVE_SCOPES_ONLY', scanned: 0, active: 0, stale: 0, quarantined: 0, processKills: 0, cleanupPerformed: false, status: 'PASS' };
  const parse = (value, status = 0) => parseWindowsRecoveryStatus({ stdout: JSON.stringify(value), status });
  assert.equal(parse(row).status, 'PASS');
  assert.equal(parse({ ...row, scanned: 1, active: 1 }).status, 'PASS');
  assert.equal(parse({ ...row, scanned: 1, stale: 1, status: 'FAIL' }, 70).status, 'FAIL');
  for (const value of [{ ...row, extra: 'NEVER_EMIT_PRIVATE_SENTINEL' }, { ...row, processKills: 1 }, { ...row, cleanupPerformed: true }, { ...row, stale: 1 }, { ...row, scanned: 1 }, { ...row, scanned: 66 }, { ...row, status: 'NEVER_EMIT_PRIVATE_SENTINEL' }, null]) {
    const result = parse(value);
    assert.equal(result.status, 'FAIL'); assert.doesNotMatch(JSON.stringify(result), /NEVER_EMIT_PRIVATE_SENTINEL/u);
  }
  assert.equal(parse(row, 70).status, 'FAIL');
  assert.equal(parseWindowsRecoveryStatus({ status: 0, stdout: JSON.stringify(row), error: { code: 'ETIMEDOUT' } }).status, 'FAIL');
});
test('non-native process execution fails closed instead of using a mock backend', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => ownedWindowsHelper(), /PLATFORM_UNSUPPORTED/u);
  assert.throws(() => windowsProcessRequest(process.execPath, []), /PLATFORM_UNSUPPORTED/u);
  assert.deepEqual(windowsBuildEnvironment(), { status: 'NOT_NATIVE_WINDOWS' });
  assert.throws(() => buildWindowsProcess(), /PLATFORM_UNSUPPORTED/u);
});
test('native Windows tracked-source process build is idempotent with matching hashes', native, () => {
  assert.deepEqual(buildWindowsProcess(), { status: 'ALREADY_BUILT', abi: 1, scope: 'TRUSTED_PROCESS_OWNERSHIP_NOT_SANDBOX' });
});
test('native Windows stdio, cwd, Unicode environment and CRT argv roundtrip', native, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-win-process-'));
  try {
    const args = ['', 'space argument', 'Φ-日本語', 'quote"slash\\', 'trailing\\', '%PATH% & | > ;'];
    const result = run(`const fs=require('node:fs');console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.PHI_PROCESS_MARKER,input:fs.readFileSync(0,'utf8')}));console.error('fixture-stderr');process.exit(7);`, args, { cwd: root, env: { ...process.env, PHI_PROCESS_MARKER: 'Φ preserved' }, input: 'fixture input\n' });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: root, env: 'Φ preserved', input: 'fixture input\n' });
    assert.match(result.stderr, /fixture-stderr/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('native Windows normal parent exit kills detached descendants and grandchildren', native, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-win-process-'));
  try {
    const file = path.join(root, 'pids.json');
    const result = run(tree(file, true));
    assert.equal(result.status, 7, result.stderr);
    await gone(await receipt(file));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('native Windows timeout propagates 124 and kills the complete owned tree', native, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-win-process-'));
  try {
    const file = path.join(root, 'pids.json');
    const result = run(tree(file, false), [], { timeoutMs: 1500 });
    assert.equal(result.status, 124, result.stderr);
    await gone(await receipt(file));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('native Windows force-killed supervisor closes the non-inherited Job handle', native, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-win-process-'));
  let child;
  try {
    const file = path.join(root, 'pids.json');
    child = spawn(ownedWindowsHelper(), [], { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(windowsProcessRequest(process.execPath, ['-e', tree(file, false)], { timeoutMs: 8000 }))}\n`);
    const pids = await receipt(file);
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL'); await closed;
    await gone(pids);
  } finally { child?.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); }
});
test('native Windows Node caller death also terminates the supervisor and tree', native, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-win-process-'));
  let caller;
  try {
    const file = path.join(root, 'pids.json'), helperFile = path.join(root, 'helper.json');
    const wrapper = `import{spawn}from'node:child_process';import fs from'node:fs';import{ownedWindowsHelper,windowsProcessRequest}from${JSON.stringify(moduleUrl)};const h=spawn(ownedWindowsHelper(),[],{shell:false,stdio:['pipe','ignore','ignore']});fs.writeFileSync(${JSON.stringify(helperFile)},JSON.stringify([h.pid]));h.stdin.end(JSON.stringify(windowsProcessRequest(process.execPath,['-e',${JSON.stringify(tree(file, false))}],{timeoutMs:8000}))+'\\n');setInterval(()=>{},1000);`;
    caller = spawn(process.execPath, ['--input-type=module', '-e', wrapper], { shell: false, stdio: 'ignore' });
    const pids = [...await receipt(file), ...await receipt(helperFile)];
    const closed = new Promise((resolve) => caller.once('close', resolve));
    caller.kill('SIGKILL'); await closed;
    await gone(pids);
  } finally { caller?.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); }
});
test('native Windows cancellation is not converted to success', native, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-win-process-'));
  const controller = new AbortController();
  const file = path.join(root, 'pids.json');
  const running = runOwnedEngine(process.execPath, ['-e', tree(file, false)], { stdio: 'ignore', signal: controller.signal, timeoutMs: 8000 });
  // Install rejection observation before aborting; prove active descendants,
  // not an abort before CreateProcess that never exercised native cleanup.
  const rejected = assert.rejects(running, /CANCELLED/u);
  try { const pids = await receipt(file); controller.abort(); await rejected; await gone(pids); }
  finally { controller.abort(); await rejected.catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
test('native Windows output flood fails closed with bounded buffering', native, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-win-process-'));
  try {
    const file = path.join(root, 'pids.json');
    const program = `require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid]));process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000);`;
    await assert.rejects(runOwnedEngine(process.execPath, ['-e', program], { stdio: 'ignore' }), /OUTPUT_LIMIT/u);
    await gone(await receipt(file));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('native Windows direct spawn failure and malformed requests preserve failure', native, () => {
  const request = windowsProcessRequest(path.join(os.tmpdir(), 'phi-nonexistent-fixture.exe'), [], { timeoutMs: 1000 });
  const failed = spawnSync(ownedWindowsHelper(), [], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 8000 });
  assert.equal(failed.status, 70); assert.match(failed.stderr, /PHI_NATIVE_PROCESS_FAILED/u);
  const invalid = spawnSync(ownedWindowsHelper(), [], { input: '{"secret-fixture":"DO_NOT_ECHO_THIS"}\n', encoding: 'utf8', timeout: 8000 });
  assert.equal(invalid.status, 70); assert.doesNotMatch(invalid.stderr, /DO_NOT_ECHO_THIS/u);
  assert.throws(() => windowsProcessRequest('C:\\Windows\\fixture.cmd', []), /PATH_INVALID/u);
  assert.throws(() => windowsProcessRequest(process.execPath, [], { timeoutMs: 120001 }), /LIMIT_INVALID/u);
  assert.throws(() => windowsProcessRequest(process.execPath, [], { env: { PATH: 'a', Path: 'b' } }), /ENV_INVALID/u);
});
