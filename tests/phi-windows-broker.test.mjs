import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { validateWindowsBrokerRequest, validateWindowsBrokerReceipt, runWindowsSecureBroker, windowsNodeToolArguments, WINDOWS_CAPABILITY_PROFILES } from '../platform/windows/secure-broker.mjs';
import { ownedWindowsHelper } from '../platform/windows/process.mjs';
import { requireAutonomousBackend } from '../platform/index.mjs';

const native = { skip: process.platform !== 'win32', timeout: 30000 };
const sessionId = '123456789012345678901234567890ab';
let executable;
function request(role = 'tester', script = 'process.exit(0)', options = {}) {
  executable ??= process.platform === 'win32' ? { path: process.execPath, sha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') } : { path: 'C:\\tools\\node.exe', sha256: 'a'.repeat(64) };
  return {
    version: 1, executable, argv: [...windowsNodeToolArguments('task.cjs')], cwd: '.', environment: { CI: '1', NO_COLOR: '1' },
    profile: { worker: 'EDIT', tester: 'TEST', reviewer: 'READ_ONLY', scout: 'READ_ONLY' }[role], grants: { workspace: { 'task.cjs': script, 'input.txt': 'input' }, assets: {} },
    network: 'DENY', timeoutMs: 8000, guardianPid: process.pid, context: { sessionId, operation: role === 'tester' ? 'verification' : 'safe-exec', role }, ...options,
  };
}
test('broker registered profiles are least privilege and cannot promote Windows autonomy', () => {
  assert.deepEqual(Object.keys(WINDOWS_CAPABILITY_PROFILES), ['READ_ONLY', 'EDIT', 'TEST', 'LSP_READ_ONLY']);
  assert.equal(WINDOWS_CAPABILITY_PROFILES.TEST.workspace, 'READ_ONLY');
  assert.equal(WINDOWS_CAPABILITY_PROFILES.READ_ONLY.workspace, 'READ_ONLY');
  assert.equal(WINDOWS_CAPABILITY_PROFILES.EDIT.workspace, 'READ_WRITE');
  for (const profile of Object.values(WINDOWS_CAPABILITY_PROFILES)) {
    assert.equal(profile.network, 'DENY'); assert.equal(profile.registry, 'registryRead'); assert.ok(Object.isFrozen(profile));
  }
  assert.throws(() => requireAutonomousBackend('win32'), /SANDBOX_UNAVAILABLE/u);
});
test('structured broker rejects unknown profiles, escalation, unsafe environment, grants and cwd', () => {
  const valid = request(); assert.deepEqual(validateWindowsBrokerRequest(valid), valid);
  const bad = [
    { profile: 'UNKNOWN' }, { profile: 'EDIT' }, { network: 'ALLOW' }, { shell: true }, { timeoutMs: 120001 },
    { environment: { PATH: 'C:\\host' } }, { environment: { NODE_OPTIONS: '--require=evil' } }, { environment: { OPENAI_API_KEY: 'NEVER_EMIT_PRIVATE_SENTINEL' } },
    { cwd: '../escape' }, { cwd: 'C:/host' }, { cwd: '//host' },
    ...['.env', 'src/../escape', 'src/CON.txt', 'src/a:stream', 'src/a.', 'src/a\\b', '.ssh/key'].map((file) => ({ grants: { workspace: { [file]: 'x' }, assets: {} } })),
    { grants: { workspace: { 'File.txt': 'x', 'file.txt': 'y' }, assets: {} } },
    { executable: { path: 'C:\\Windows\\System32\\cmd.exe', sha256: 'a'.repeat(64) } },
    { executable: { path: '\\\\host\\node.exe', sha256: 'a'.repeat(64) } },
  ];
  for (const patch of bad) assert.throws(() => validateWindowsBrokerRequest({ ...valid, ...patch }), /PHI_WINDOWS_BROKER_/u);
  const argv = ['', 'space argument', 'Φ-日本語', 'quote"slash\\', 'trailing\\', '%PATH% & | > ;'];
  assert.deepEqual(validateWindowsBrokerRequest({ ...valid, argv }).argv, argv);
});
test('broker receipts strictly whitelist metadata and reject fabricated successful security claims', () => {
  const valid = { version: 1, platform: 'win32', backend: 'windows-lpac-broker', profile: 'TEST', role: 'tester', operation: 'verification', sessionId, scopeId: sessionId, tokenVerified: true, jobAttested: true, targetStarted: true, exitCode: 0, timedOut: false, cleanup: 'PASS', securityFailure: null };
  assert.deepEqual(validateWindowsBrokerReceipt(valid), valid);
  for (const patch of [{ env: 'NEVER_EMIT_PRIVATE_SENTINEL' }, { tokenVerified: false }, { jobAttested: false }, { targetStarted: false }, { cleanup: 'FAIL' }, { securityFailure: 'LAUNCH' }, { profile: 'EDIT' }, { timedOut: true }]) assert.throws(() => validateWindowsBrokerReceipt({ ...valid, ...patch }), /BROKER_/u);
});
test('Windows Node file launcher preserves scoped paths without changing permissions or hiding failures', () => {
  assert.deepEqual(windowsNodeToolArguments('task.cjs', ['a']), ['--no-addons', '--no-global-search-paths', '--preserve-symlinks-main', '--preserve-symlinks', 'task.cjs', 'a']);
  assert.throws(() => windowsNodeToolArguments('--eval'), /BROKER_/u);
  assert.throws(() => windowsNodeToolArguments('../outside.cjs'), /BROKER_/u);
});
test('Linux cannot execute the Windows broker or substitute it for Bubblewrap', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(runWindowsSecureBroker(request()), /PLATFORM_UNSUPPORTED/u);
});
function direct(input) {
  return spawnSync(ownedWindowsHelper(), ['--lpac-broker'], { shell: false, input: `${JSON.stringify(input)}\n`, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 20000 });
}
function diagnostic(result) {
  const known = ['EPERM', 'EACCES', 'ENOENT', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_ACCESS_DENIED', 'ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_INVALID_ARG_VALUE'];
  const codes = known.filter((code) => new RegExp('\\b' + code + '\\b', 'u').test(result.stderr ?? ''));
  const operations = ['lstat', 'realpath', 'open', 'read'].filter((op) => new RegExp('\\b' + op + '\\b', 'u').test(result.stderr ?? ''));
  let task = null;
  try {
    const match = /PHI_BROKER_TASK_DIAGNOSTIC:(\{[^\r\n]+\})/u.exec(result.stderr ?? '');
    const value = match ? JSON.parse(match[1]) : null;
    if (value && Object.keys(value).length === 4 && ['INPUT', 'STDIN', 'DENIALS', 'SCRATCH', 'NETWORK', 'MARKER'].includes(value.phase) && [null, 'ENOENT', 'EPERM', 'EACCES'].includes(value.errorCode) && typeof value.tempMatches === 'boolean' && typeof value.cwdMatches === 'boolean') task = value;
  } catch {}
  return JSON.stringify({ receipt: result.receipt, codes, operations, task });
}
test('native broker independently rejects invalid requests before any target starts', native, () => {
  for (const patch of [{ profile: 'EDIT' }, { environment: { NODE_OPTIONS: 'NEVER_EMIT_PRIVATE_SENTINEL' } }, { cwd: '../escape' }, { profile: 'NEVER_EMIT_PRIVATE_SENTINEL' }, { context: { role: 'NEVER_EMIT_PRIVATE_SENTINEL', sessionId, operation: 'safe-exec' } }]) {
    const result = direct({ ...request(), ...patch });
    assert.equal(result.status, 70);
    const record = JSON.parse(result.stdout); assert.equal(record.kind, 'result');
    assert.equal(record.receipt.targetStarted, false); assert.equal(record.receipt.scopeId, null);
    assert.equal(record.receipt.securityFailure, 'REQUEST');
    assert.doesNotMatch(result.stdout, /NEVER_EMIT_PRIVATE_SENTINEL/u);
  }
});
test('native hash/grant setup failure is fail closed with owned cleanup', native, async () => {
  for (const patch of [{ executable: { ...request().executable, sha256: 'b'.repeat(64) } }, { cwd: 'missing' }]) {
    const result = await runWindowsSecureBroker(request('tester', 'process.exit(99)', patch));
    assert.equal(result.code, 70); assert.equal(result.receipt.targetStarted, false);
    assert.equal(result.receipt.tokenVerified, false); assert.equal(result.receipt.cleanup, 'PASS');
    assert.ok(['RUNTIME', 'GRANTS'].includes(result.receipt.securityFailure));
  }
});
test('native runtime junction/hardlink substitution is rejected before target launch', native, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-broker-source-'));
  try {
    const directory = path.join(temporary, 'runtime'); fs.mkdirSync(directory);
    const binary = path.join(directory, 'node.exe'); fs.copyFileSync(process.execPath, binary);
    const alias = path.join(temporary, 'alias.exe'); fs.linkSync(binary, alias);
    const junction = path.join(temporary, 'junction'); fs.symlinkSync(directory, junction, 'junction');
    // Positive controls: the exact alias sources exist and hash to Node, not
    // absent-path denials. Rejection is through native no-follow/nlink checks.
    for (const source of [alias, path.join(junction, 'node.exe')]) {
      assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), request().executable.sha256);
      const result = await runWindowsSecureBroker(request('tester', 'process.exit(99)', { executable: { path: source, sha256: request().executable.sha256 } }));
      assert.equal(result.code, 70); assert.equal(result.receipt.securityFailure, 'RUNTIME'); assert.equal(result.receipt.targetStarted, false); assert.equal(result.receipt.cleanup, 'PASS');
    }
    assert.equal(fs.statSync(binary).nlink, 2);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
for (const role of ['reviewer', 'worker', 'tester']) {
  test(`native generic broker ${role}: actual role writes/private/network denials, argv and stdio`, native, async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const args = ['', 'Φ 日本語', 'quote"slash\\', '%PATH% & | > ;'];
    const script = `const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
let phase='INPUT';process.on('uncaughtException',e=>{console.error('PHI_BROKER_TASK_DIAGNOSTIC:'+JSON.stringify({phase,errorCode:['ENOENT','EPERM','EACCES'].includes(e.code)?e.code:null,tempMatches:process.env.TEMP===path.join(path.dirname(path.dirname(process.execPath)),'scratch'),cwdMatches:path.basename(process.cwd())==='workspace'}));process.exit(1);});
const checks={read:fs.readFileSync('input.txt','utf8')==='input',args:process.argv.slice(2),cleanEnv:!Object.keys(process.env).some(k=>/TOKEN|SECRET|AUTH|API_KEY|NODE_OPTIONS/i.test(k))};
phase='STDIN';checks.input=fs.readFileSync(0,'utf8')==='';phase='DENIALS';
function deny(k,fn){try{fn();checks[k]=false;}catch(e){checks[k]=['EACCES','EPERM'].includes(e.code);}}
const root=path.dirname(process.cwd());
deny('privateRead',()=>fs.readFileSync(path.join(root,'private','control.txt')));
deny('privateWrite',()=>fs.writeFileSync(path.join(root,'private','escape.txt'),'x'));
deny('runtimeWrite',()=>fs.writeFileSync(process.execPath,'x'));
deny('aapRead',()=>fs.readFileSync(path.join(root,'runtime','all-packages.txt')));
deny('extendedRead',()=>fs.readFileSync(path.toNamespacedPath(path.join(root,'private','control.txt'))));
try{fs.writeFileSync('edit.txt','changed');checks.write=true;}catch(e){checks.write=false;checks.writeDenied=['EACCES','EPERM'].includes(e.code);}
phase='SCRATCH';checks.tempScoped=process.env.TEMP.toLowerCase()===path.join(root,'scratch','Packages','Phi.Probe.'+path.basename(root),'AC','Temp').toLowerCase();checks.tmpScoped=process.env.TMP===process.env.TEMP;fs.writeFileSync(path.join(process.env.TEMP,'temp.txt'),'allowed');checks.tempWrite=true;phase='NETWORK';
console.error('ERROR required diagnostic');const socket=net.connect({host:'127.0.0.1',port:${server.address().port}});socket.setTimeout(1500);
let done=false;function finish(denied){if(done)return;done=true;checks.networkDenied=denied;socket.destroy();console.log(JSON.stringify(checks));process.exit(0);}
socket.on('connect',()=>finish(false));socket.on('error',e=>finish(['EACCES','EPERM'].includes(e.code)));socket.on('timeout',()=>finish(false));`;
    try {
      const result = await runWindowsSecureBroker({ ...request(role, script), argv: [...windowsNodeToolArguments('task.cjs', args)] });
      assert.equal(result.code, 0, diagnostic(result));
      const row = JSON.parse(result.stdout); assert.deepEqual(row.args, args);
      for (const key of ['read', 'input', 'cleanEnv', 'privateRead', 'privateWrite', 'runtimeWrite', 'aapRead', 'extendedRead', 'tempScoped', 'tmpScoped', 'tempWrite', 'networkDenied']) assert.equal(row[key], true, key);
      assert.equal(row.write, role === 'worker'); if (role !== 'worker') assert.equal(row.writeDenied, true);
      assert.equal(result.stderr.trim(), 'ERROR required diagnostic');
      assert.equal(result.receipt.tokenVerified, true); assert.equal(result.receipt.jobAttested, true); assert.equal(result.receipt.cleanup, 'PASS');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
}
test('native tool output cannot forge a broker receipt; real nonzero exit remains nonzero', native, async () => {
  const result = await runWindowsSecureBroker(request('tester', `console.log(JSON.stringify({kind:'result',receipt:{exitCode:0,cleanup:'PASS'}}));console.error('FATAL required');process.exit(73)`));
  assert.equal(result.code, 73, diagnostic(result)); assert.equal(result.receipt.exitCode, 73); assert.equal(result.receipt.cleanup, 'PASS');
  assert.equal(JSON.parse(result.stdout).receipt.exitCode, 0); assert.match(result.stderr, /FATAL/u);
  assert.doesNotMatch(JSON.stringify(result.receipt), /FATAL|stdout|stderr|environment|argv/u);
});
test('native Node realpath failure control and real file/module execution share identical LPAC authority', native, async () => {
  const script = "console.log(require('./helper.cjs'));process.exit(0);";
  const input = request('tester', script); input.grants.workspace['helper.cjs'] = "module.exports='scoped-module';";
  const rejected = await runWindowsSecureBroker({ ...input, argv: ['--no-addons', 'task.cjs'] });
  assert.equal(rejected.code, 1, diagnostic(rejected)); assert.match(rejected.stderr, /EPERM/u); assert.match(rejected.stderr, /lstat/u);
  assert.equal(rejected.receipt.cleanup, 'PASS'); assert.equal(rejected.receipt.tokenVerified, true);
  const result = await runWindowsSecureBroker(input); assert.equal(result.code, 0, diagnostic(result));
  assert.equal(result.stdout.trim(), 'scoped-module'); assert.equal(result.receipt.cleanup, 'PASS');
});
test('native inherited LPAC child cannot use junction/hardlink aliases to mutate protected assets', native, async () => {
  const script = `const{spawn}=require('node:child_process');const body="const fs=require('node:fs'),path=require('node:path');const row={};function denied(k,fn){try{fn();row[k]=false;}catch(e){row[k]=['EACCES','EPERM'].includes(e.code);}}const privateDir=path.join(path.dirname(process.cwd()),'private');denied('privateRead',()=>fs.readFileSync(path.join(privateDir,'control.txt')));denied('privateWrite',()=>fs.writeFileSync(path.join(privateDir,'escape.txt'),'x'));try{fs.symlinkSync(privateDir,process.env.TEMP+'/alias','junction');denied('junctionDenied',()=>fs.readFileSync(process.env.TEMP+'/alias/control.txt'));}catch(e){row.junctionDenied=['EACCES','EPERM'].includes(e.code);}try{fs.linkSync(process.env.PHI_TOOL_ASSETS+'/input.txt',process.env.TEMP+'/hardlink');denied('hardlinkDenied',()=>fs.appendFileSync(process.env.TEMP+'/hardlink','mutation'));}catch(e){row.hardlinkDenied=['EACCES','EPERM'].includes(e.code);}denied('workspaceWrite',()=>fs.writeFileSync('child-edit.txt','x'));console.log(JSON.stringify(row));process.exit(Object.values(row).every(v=>v===true)?0:92);";const c=spawn(process.execPath,['--no-addons','-e',body],{stdio:'inherit'});c.on('error',()=>process.exit(93));c.on('exit',code=>process.exit(code));`;
  const input = request('tester', script); input.grants.assets['input.txt'] = 'readonly';
  const result = await runWindowsSecureBroker(input); assert.equal(result.code, 0, diagnostic(result));
  assert.deepEqual(JSON.parse(result.stdout), { privateRead: true, privateWrite: true, junctionDenied: true, hardlinkDenied: true, workspaceWrite: true });
  assert.equal(result.receipt.cleanup, 'PASS');
});
test('native broker output overflow terminates the target instead of accepting successful output', native, async () => {
  const result = await runWindowsSecureBroker(request('worker', `process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000);`));
  assert.equal(result.code, 70); assert.equal(result.receipt.securityFailure, 'EXECUTION'); assert.equal(result.receipt.cleanup, 'PASS');
});
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function gone(pids) { const end = Date.now() + 5000; while (pids.some(alive) && Date.now() < end) await delay(20); assert.deepEqual(pids.filter(alive), []); }
function treeScript(exit) {
  return `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');process.on('uncaughtException',e=>{console.error('PHI_BROKER_TASK_DIAGNOSTIC:'+JSON.stringify({phase:'MARKER',errorCode:['ENOENT','EPERM','EACCES'].includes(e.code)?e.code:null,tempMatches:process.env.TEMP===path.join(path.dirname(path.dirname(process.execPath)),'scratch'),cwdMatches:path.basename(process.cwd())==='workspace'}));process.exit(1);});const child=spawn(process.execPath,['--no-addons','-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:true});child.on('error',()=>process.exit(91));const pids=[process.pid,child.pid];fs.writeFileSync(process.env.TEMP+'/pids.json',JSON.stringify(pids));console.log(JSON.stringify(pids));${exit ? 'setTimeout(()=>process.exit(7),200);' : 'setInterval(()=>{},1000);'}`;
}
test('native generic broker normal completion and timeout kill inherited-token descendants', native, async () => {
  for (const exit of [true, false]) {
    let scope;
    const result = await runWindowsSecureBroker(request('worker', treeScript(exit), { timeoutMs: exit ? 8000 : 2500 }), { onAdmission: (value) => { scope = value.scopeId; } });
    assert.equal(result.code, exit ? 7 : 124, diagnostic(result)); assert.equal(result.receipt.cleanup, 'PASS'); assert.equal(result.receipt.timedOut, !exit);
    await gone(JSON.parse(result.stdout));
    // Capture the actual tree inside stdout before termination; no PID guesses.
    assert.ok(scope);
    assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Phi', 'NativeScopesV1', scope)), false);
  }
});
test('native generic broker cancellation reuses scope recovery and removes observed process tree', native, async () => {
  const abort = new AbortController(); let scope;
  const running = runWindowsSecureBroker(request('worker', treeScript(false)), { signal: abort.signal, onAdmission: (value) => { scope = value.scopeId; } });
  let pids; const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { if (scope) pids = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'Phi', 'NativeScopesV1', scope, 'scratch', 'Packages', 'Phi.Probe.' + scope, 'AC', 'Temp', 'pids.json'), 'utf8')); } catch {}
    if (pids?.length === 2 && pids.every(alive)) break; await delay(20);
  }
  try { assert.ok(pids?.length === 2 && pids.every(alive)); }
  finally { abort.abort(); }
  const result = await running; assert.equal(result.code, 125); assert.equal(result.receipt.securityFailure, 'CANCELLED'); assert.equal(result.receipt.cleanup, 'PASS');
  await gone(pids); assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Phi', 'NativeScopesV1', scope)), false);
});
test('native generic broker supervisor crash preserves journal and recovers only its observed scope', native, async () => {
  const child = spawn(ownedWindowsHelper(), ['--lpac-broker'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.resume();
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request('worker', treeScript(false))) + '\n');
  const closed = new Promise((resolve) => child.once('close', resolve));
  let scope, pids; const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      if (!scope && output.includes('\n')) scope = JSON.parse(output.slice(0, output.indexOf('\n'))).scopeId;
      if (scope) pids = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'Phi', 'NativeScopesV1', scope, 'scratch', 'Packages', 'Phi.Probe.' + scope, 'AC', 'Temp', 'pids.json'), 'utf8'));
    } catch {}
    if (pids?.length === 2 && pids.every(alive)) break; await delay(20);
  }
  child.kill('SIGKILL'); await closed;
  try {
    assert.ok(pids?.length === 2); await gone(pids);
  } finally {
    if (scope) {
      const result = spawnSync(ownedWindowsHelper(), ['--recover-scope', scope], { shell: false, encoding: 'utf8', timeout: 20000, maxBuffer: 8192 });
      assert.equal(result.status, 0); const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.recovered, 1); assert.equal(receipt.processKills, 0); assert.equal(receipt.quarantined, 0);
      assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Phi', 'NativeScopesV1', scope)), false);
    }
  }
});
