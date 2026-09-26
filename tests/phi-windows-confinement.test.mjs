import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { ownedWindowsHelper } from '../platform/windows/process.mjs';
import { requireAutonomousBackend } from '../platform/index.mjs';
import { validationFailureEvidence } from '../lib/phi-validation-evidence.mjs';

function probeMetadata(stdout, stderr, status) {
  const fields = ['allPackagesReadControl', 'workspaceRead', 'hostReadDenied', 'hostWriteDenied', 'runtimeWriteDenied', 'allPackagesReadDenied', 'registryReadAvailable', 'privateRegistryDenied', 'journalRegistryDenied', 'hostHandleDuplicationDenied', 'protectedDaclChangeDenied', 'runtimeDaclChangeDenied', 'extendedPathReadDenied', 'alternateStreamReadDenied', 'readOnlyAssetWriteDenied', 'runtimeRenameDenied', 'existingJunctionReadDenied', 'existingPrivateHardlinkReadDenied', 'existingReadOnlyHardlinkReadable', 'existingReadOnlyHardlinkWriteDenied', 'junctionEscapeDenied', 'privateHardlinkEscapeDenied', 'readOnlyHardlinkWriteDenied', 'cleanEnvironment', 'scratchWrite', 'networkDenied', 'workspaceWrite', 'workspaceWriteDenied', 'tokenVerified'];
  fields.push('nestedHostReadDenied', 'nestedAllPackagesDenied', 'nestedWorkspaceWrite', 'nestedWorkspaceWriteDenied', 'nestedNetworkDenied');
  const receipts = stdout.trim().split(/\r?\n/u).slice(0, 8).flatMap((line) => {
    try { const row = JSON.parse(line); return [Object.fromEntries(fields.filter((key) => typeof row[key] === 'boolean').map((key) => [key, row[key]]))]; }
    catch { return []; }
  });
  return JSON.stringify({ ...validationFailureEvidence('foundation-tests', { status, stderr }), receipts });
}

test('native probe failure details contain only whitelisted boolean metadata', () => {
  const result = probeMetadata('{"hostReadDenied":false,"secret":"DO_NOT_ECHO","path":"PRIVATE_PATH"}', 'PHI_APPCONTAINER_PROBE_FAILED secret=DO_NOT_ECHO', 70);
  assert.doesNotMatch(result, /DO_NOT_ECHO|PRIVATE_PATH/u);
  assert.deepEqual(JSON.parse(result).receipts, [{ hostReadDenied: false }]);
});

test('experimental LPAC primitive is separate from autonomous authority', () => {
  assert.throws(() => requireAutonomousBackend('win32'), /SANDBOX_UNAVAILABLE/u);
  const source = fs.readFileSync(new URL('../platform/windows/native/AppContainerScope.cs', import.meta.url), 'utf8');
  assert.match(source, /new IntPtr\(0x20009\)/u);
  assert.match(source, /new IntPtr\(0x2000f\)/u);
  assert.match(source, /TokenBuffer\(token, 30/u);
  assert.match(source, /EqualSid\(Marshal\.ReadIntPtr\(buffer\), sid\)/u);
  assert.match(source, /returned < IntPtr\.Size \|\| returned > 256/u);
  assert.doesNotMatch(source, /returned != IntPtr\.Size/u);
  assert.match(source, /allPackagesReadDenied/u);
  assert.match(source, /DeriveCapabilitySidsFromName\("registryRead"/u);
  assert.match(source, /Marshal\.ReadInt32\(buffer\) != 1/u);
  assert.doesNotMatch(source, /DeriveCapabilitySidsFromName\("(?:internetClient|privateNetworkClientServer|enterpriseAuthentication)"/u);
  assert.match(source, /"S-1-3-4"/u);
  assert.match(source, /WriteAlternateStream\(Path\.Combine\(secret, "\.env"\)\)/u);
  assert.match(source, /ReadFile\(handle, actual/u);
  assert.doesNotMatch(source, /File\.WriteAllText\([^\n]*\.env:fixture/u);
  assert.match(source, /CreateOwnedJunction\(junction, secret\)/u);
  assert.match(source, /CreateHardLinkW\(privateLink/u);
  assert.match(source, /File\.ReadAllText\(Path\.Combine\(junction, "\.env"\)\)/u);
  assert.match(source, /RemoveDirectoryW\(ownedJunction\)/u);
  assert.ok(source.indexOf('RemoveDirectoryW(ownedJunction)') < source.indexOf('scope.recovery.CleanupFiles()'));
  assert.doesNotMatch(source, /Directory\.Delete\(root, true\)/u);
  assert.doesNotMatch(source, /ALL_APPLICATION_PACKAGES.*Allow/u);
  assert.match(source, /RecoveryFilesystem\.WithDirectoryAuthority/u);
  assert.match(source, /SetSecurityInfo\(handle, 1, 0x80000004/u);
  assert.doesNotMatch(source, /SetNamedSecurityInfo|Directory\.SetAccessControl/u);
});
const completedScopes = new Set();
for (const role of ['worker', 'tester', 'reviewer']) {
  test(`native LPAC ${role}: real token, file permissions, live network denial and cleanup`, { skip: process.platform !== 'win32', timeout: 25000 }, async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    let child;
    try {
      child = spawn(ownedWindowsHelper(), ['--confinement-probe', process.execPath, role, String(server.address().port)], { shell: false, windowsHide: true, env: { ...process.env, PHI_PROBE_GUARDIAN: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (value) => { stdout += value; if (stdout.length > 65536) child.kill('SIGKILL'); });
      child.stderr.on('data', (value) => { stderr += value; if (stderr.length > 65536) child.kill('SIGKILL'); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 16000);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      clearTimeout(timer);
      assert.equal(code, 0, probeMetadata(stdout, stderr, code));
      const [control, nativeRights, receipt, cleanup] = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      assert.deepEqual(control, { allPackagesReadControl: true });
      assert.deepEqual(nativeRights, { registryReadAvailable: true, privateRegistryDenied: true, journalRegistryDenied: true, hostHandleDuplicationDenied: true, protectedDaclChangeDenied: true, runtimeDaclChangeDenied: true });
      assert.equal(receipt.role, role);
      for (const key of ['workspaceRead', 'hostReadDenied', 'hostWriteDenied', 'runtimeWriteDenied', 'allPackagesReadDenied', 'extendedPathReadDenied', 'alternateStreamReadDenied', 'readOnlyAssetWriteDenied', 'runtimeRenameDenied', 'existingJunctionReadDenied', 'existingPrivateHardlinkReadDenied', 'existingReadOnlyHardlinkReadable', 'existingReadOnlyHardlinkWriteDenied', 'junctionEscapeDenied', 'privateHardlinkEscapeDenied', 'readOnlyHardlinkWriteDenied', 'cleanEnvironment', 'scratchWrite', 'networkDenied']) assert.equal(receipt[key], true, key);
      assert.equal(receipt.workspaceWrite, role === 'worker');
      const { scopeId, ...result } = cleanup;
      assert.deepEqual(result, { tokenVerified: true, cleanup: 'PASS', scope: 'FIXED_SYNTHETIC_PROBE_ONLY' });
      assert.match(scopeId, /^[0-9a-f]{32}$/u);
      assert.equal(completedScopes.has(scopeId), false, 'profile reused across roles');
      completedScopes.add(scopeId);
    } finally { child?.kill('SIGKILL'); await new Promise((resolve) => server.close(resolve)); }
  });
}

test('scope recovery uses bounded durable receipts, generation checks and opened-object deletion', () => {
  const recovery = fs.readFileSync(new URL('../platform/windows/native/ScopeRecovery.cs', import.meta.url), 'utf8');
  const filesystem = fs.readFileSync(new URL('../platform/windows/native/RecoveryFilesystem.cs', import.meta.url), 'utf8');
  assert.match(recovery, /MaxScopes = 64/u);
  assert.match(recovery, /RegFlushKey/u);
  assert.match(recovery, /generation == \(string\)value\["created"\]/u);
  assert.match(recovery, /processKills = 0/u);
  assert.match(recovery, /size > 4096/u);
  assert.match(recovery, /deadline.ElapsedMilliseconds >= 10000/u);
  assert.match(recovery, /PHI_RECOVERY_STARTUP/u);
  assert.match(recovery, /rule\.FileSystemRights & ~FileSystemRights\.Synchronize\) == FileSystemRights\.ReadPermissions/u);
  assert.doesNotMatch(recovery, /TerminateProcess|\.Kill\(|Directory\.Delete/u);
  assert.match(filesystem, /GetFileInformationByHandleEx\(handle, 18/u);
  assert.match(filesystem, /HandleIdentity\(handle\) != expected/u);
  assert.match(filesystem, /SetFileInformationByHandle\(handle, 4/u);
  assert.match(filesystem, /depth > 16/u);
  assert.match(filesystem, /deadline.ElapsedMilliseconds >= 5000/u);
  assert.doesNotMatch(recovery + filesystem, /DateTime\.UtcNow/u);
  assert.doesNotMatch(filesystem, /Directory\.Delete|File\.Delete|Directory\.EnumerateFileSystemEntries/u);
  assert.match(filesystem, /QueryDirectory\(directory, restart \? 15 : 14/u);
  assert.match(filesystem, /OpenRelative\(directory, name,/u);
  assert.throws(() => requireAutonomousBackend('win32'), /SANDBOX_UNAVAILABLE/u);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function terminateProbe(child) {
  // Signal exit leaves exitCode null. Do not wait for an already-fired close.
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned probe termination timed out')), 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGKILL');
  });
}
test('probe termination is bounded and idempotent after signal exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', shell: false });
  await terminateProbe(child);
  assert.equal(child.signalCode, 'SIGKILL');
  await terminateProbe(child);
});
function recover(id) {
  const result = spawnSync(ownedWindowsHelper(), id ? ['--recover-scope', id] : ['--recover-scopes'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 16000, maxBuffer: 8192 });
  assert.equal(result.status, 0, JSON.stringify(validationFailureEvidence('foundation-tests', result)));
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.processKills, 0);
  assert.equal(receipt.quarantined, 0);
  return receipt;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function gone(pid) {
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await delay(20);
  assert.equal(alive(pid), false, 'Owned LPAC generation remains active after supervisor death');
}
for (const role of ['worker', 'tester', 'reviewer']) {
  test(`native LPAC ${role} supervisor death: kernel process cleanup and durable scope recovery`, { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    let child, scopeId;
    try {
      child = spawn(ownedWindowsHelper(), ['--confinement-failure-probe', process.execPath, role, String(server.address().port), 'hold-child'], { shell: false, windowsHide: true, env: { ...process.env, PHI_PROBE_GUARDIAN: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (value) => { stdout += value; if (stdout.length > 65536) child.kill('SIGKILL'); });
      child.stderr.on('data', (value) => { stderr += value; if (stderr.length > 65536) child.kill('SIGKILL'); });
      const deadline = Date.now() + 8000; let running;
      while (!running && Date.now() < deadline && child.exitCode === null) {
        for (const line of stdout.split(/\r?\n/u)) { try { const row = JSON.parse(line); if (Number.isInteger(row.ownedPid) && row.ownedPid > 0) running = row; } catch {} }
        if (!running) await delay(20);
      }
      assert.ok(running, probeMetadata(stdout, stderr, child.exitCode));
      scopeId = running.scopeId;
      assert.match(scopeId, /^[0-9a-f]{32}$/u);
      assert.equal(running.workspaceWrite, role === 'worker');
      assert.equal(running.networkDenied, true);
      assert.equal(alive(running.ownedPid), true);
      const active = recover(scopeId);
      assert.equal(active.active, 1);
      assert.equal(active.recovered, 0);
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGKILL'); await closed;
      await gone(running.ownedPid);
      const recovered = recover(scopeId);
      assert.equal(recovered.recovered, 1);
      assert.equal(recovered.active, 0);
      assert.equal(recover(scopeId).recovered, 0, 'recovery must be idempotent');
    } finally {
      await terminateProbe(child);
      if (scopeId) recover(scopeId);
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
for (const failure of ['before-cleanup', 'cleanup-exception']) {
  test(`native LPAC ${failure}: failure stays failure and recorded resources recover safely`, { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const result = spawnSync(ownedWindowsHelper(), ['--confinement-failure-probe', process.execPath, 'worker', String(server.address().port), failure], { shell: false, encoding: 'utf8', windowsHide: true, env: { ...process.env, PHI_PROBE_GUARDIAN: String(process.pid) }, timeout: 16000, maxBuffer: 65536 });
      assert.equal(result.status, 70, probeMetadata(result.stdout, result.stderr, result.status));
      const cleanup = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
      assert.equal(cleanup.tokenVerified, true);
      assert.equal(cleanup.cleanup, failure === 'cleanup-exception' ? 'FAIL' : 'PASS');
      assert.match(cleanup.scopeId, /^[0-9a-f]{32}$/u);
      const receipt = recover(cleanup.scopeId);
      assert.equal(receipt.recovered, failure === 'cleanup-exception' ? 1 : 0);
      assert.equal(recover(cleanup.scopeId).recovered, 0);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
}
for (const [role, failure] of [['worker', 'supervisor'], ['tester', 'supervisor'], ['reviewer', 'supervisor'], ['worker', 'parent'], ['worker', 'guardian'], ['worker', 'role'], ['tester', 'role'], ['worker', 'tool'], ['tester', 'tool'], ['worker', 'timeout']]) test(`native LPAC ${role} ${failure} failure with nested tree: inherited denial and complete cleanup`, { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let child, scopeId;
  try {
    const helper = ownedWindowsHelper();
    const args = ['--confinement-failure-probe', process.execPath, role, String(server.address().port), failure === 'timeout' ? 'timeout-tree' : 'hold-tree'];
    if (failure === 'parent' || failure === 'guardian') {
      // Ordinary libuv children die with their parent's Job. Separately prove
      // the native guardian wait by detaching ONLY this trusted supervisor;
      // its untrusted LPAC descendants still use our non-breakaway kill Job.
      const wrapper = `const{spawn}=require('node:child_process');const h=spawn(${JSON.stringify(helper)},${JSON.stringify(args)},{shell:false,detached:${failure === 'guardian'},stdio:'inherit',env:{...process.env,PHI_PROBE_GUARDIAN:String(process.pid)}});console.log(JSON.stringify({supervisorPid:h.pid}));setInterval(()=>{},1000);`;
      child = spawn(process.execPath, ['-e', wrapper], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } else child = spawn(helper, args, { shell: false, windowsHide: true, env: { ...process.env, PHI_PROBE_GUARDIAN: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    let stdout = '', stderr = '';
    child.stdout.on('data', (value) => { stdout += value; if (stdout.length > 65536) child.kill('SIGKILL'); });
    child.stderr.on('data', (value) => { stderr += value; if (stderr.length > 65536) child.kill('SIGKILL'); });
    const deadline = Date.now() + 8000; const row = {};
    while (!row.leafPid && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      for (const line of stdout.split(/\r?\n/u)) { try { const value = JSON.parse(line); if (typeof value.scopeId === 'string' || Number.isInteger(value.supervisorPid)) Object.assign(row, value); } catch {} }
      if (!row.leafPid) await delay(20);
    }
    assert.ok(row.leafPid, probeMetadata(stdout, stderr, child.exitCode));
    scopeId = row.scopeId;
    assert.match(scopeId, /^[0-9a-f]{32}$/u);
    assert.equal(row.nestedHostReadDenied, true, 'actual nested token cannot read private fixture');
    assert.equal(row.nestedAllPackagesDenied, true, 'LPAC ALL_APPLICATION_PACKAGES opt-out must survive actual child creation');
    assert.equal(row.workspaceWrite, role === 'worker');
    assert.equal(row.nestedWorkspaceWrite, role === 'worker');
    if (role !== 'worker') assert.equal(row.nestedWorkspaceWriteDenied, true);
    assert.equal(row.nestedNetworkDenied, true);
    assert.equal(row.networkDenied, true);
    const pids = [row.ownedPid, row.middlePid, row.leafPid];
    assert.equal(new Set(pids).size, 3);
    for (const pid of pids) { assert.ok(Number.isInteger(pid) && pid > 0); assert.equal(alive(pid), true); }
    if (failure === 'role') process.kill(row.ownedPid, 'SIGKILL');
    else if (failure === 'tool') process.kill(row.leafPid, 'SIGKILL');
    else if (failure !== 'timeout') await terminateProbe(child);
    const code = await closed;
    for (const pid of pids) await gone(pid);
    if (failure === 'parent' || failure === 'guardian') { assert.ok(Number.isInteger(row.supervisorPid)); await gone(row.supervisorPid); }
    if (failure === 'timeout' || failure === 'role' || failure === 'tool') {
      assert.notEqual(code, 0, 'forced failure must not be reported successful');
      if (failure === 'timeout') assert.equal(code, 124, probeMetadata(stdout, stderr, code));
      if (failure === 'tool') assert.equal(code, 73, probeMetadata(stdout, stderr, code));
      const cleanup = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
      assert.equal(cleanup.tokenVerified, true); assert.equal(cleanup.cleanup, 'PASS', probeMetadata(stdout, stderr, code));
    }
    if (failure === 'guardian') {
      const cleanup = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
      assert.equal(cleanup.tokenVerified, true); assert.equal(cleanup.cleanup, 'PASS', probeMetadata(stdout, stderr, code));
    }
    // Killing an ordinary Node parent also forcibly kills its non-detached
    // supervisor. The flushed receipt is required, not a cleanup defect:
    // startup recovery must reclaim its positively owned security resources.
    assert.equal(recover(scopeId).recovered, failure === 'supervisor' || failure === 'parent' ? 1 : 0);
    assert.equal(recover(scopeId).recovered, 0);
  } finally {
    try { await terminateProbe(child); if (scopeId) recover(scopeId); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  }
});
for (const name of ['clean', 'pid-reuse', 'corrupt', 'unknown-field', 'oversized', 'missing', 'root-swap', 'hardlink', 'junction', 'root-swap-security', 'partially-missing-security', 'status-stale', 'status-corrupt', 'nested-entries', 'mapped-file', 'mapped-file-stuck', 'readonly-file', 'depth-limit', 'creation-exception', 'open-sharing-control', 'delete-pending-control']) {
  test(`native recovery ${name}: actual ownership and unrelated-resource preservation`, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const result = spawnSync(ownedWindowsHelper(), ['--recovery-selftest', name], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 16000, maxBuffer: 8192 });
    assert.equal(result.status, 0, JSON.stringify(validationFailureEvidence('foundation-tests', result)));
    assert.deepEqual(JSON.parse(result.stdout), { caseName: name, passed: true, fixtureCleanup: true, processKills: 0 });
    if (name === 'open-sharing-control' || name === 'delete-pending-control') {
      const [failure] = validationFailureEvidence('foundation-tests', result).filesystemFailures ?? [];
      assert.equal(failure?.operation, 'NT_OPEN');
      assert.equal(failure?.access, name === 'open-sharing-control' ? '00110080' : '00110081');
      assert.equal(failure?.share, 1);
      assert.equal(failure?.nativeStatus, name === 'open-sharing-control' ? 'c0000043' : 'c0000056');
      assert.equal(failure?.nativeError, name === 'open-sharing-control' ? 32 : 5);
      console.log(`PHI_FILESYSTEM_FAILURE:${JSON.stringify(failure)}`);
    }
    assert.equal(recover().quarantined, 0);
  });
}
test('native recovery status is read-only and reports actual clean journal metadata', { skip: process.platform !== 'win32', timeout: 20000 }, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--scope-recovery-status'], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 16000, maxBuffer: 8192 });
  assert.equal(result.status, 0, JSON.stringify(validationFailureEvidence('foundation-tests', result)));
  assert.deepEqual(JSON.parse(result.stdout), { scope: 'FIXED_NATIVE_SCOPES_ONLY', scanned: 0, active: 0, stale: 0, quarantined: 0, processKills: 0, cleanupPerformed: false, status: 'PASS' });
});
test('anchored mutation writes through the verified exclusive handle, not a reopened pathname', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/AnchoredFile.cs', import.meta.url), 'utf8').split('internal static int SelfTest')[0];
  assert.match(source, /info\.Links != 1/u);
  assert.match(source, /Identity != expectedIdentity \|\| Digest != expectedDigest/u);
  assert.match(source, /WriteFile\(handle, value/u);
  assert.match(source, /FlushFileBuffers\(handle\)/u);
  assert.match(source, /rootPins = new RecoveryFilesystem\(root\)/u);
  assert.match(source, /parentPins = new RecoveryFilesystem/u);
  assert.doesNotMatch(source, /File\.WriteAll|File\.Open|File\.Move|File\.Delete/u);
  const filesystem = fs.readFileSync(new URL('../platform/windows/native/RecoveryFilesystem.cs', import.meta.url), 'utf8');
  assert.match(filesystem, /OpenRelative\(parents\[parents.Count - 1\], leaf, 0x12019f, 0/u);
  assert.match(filesystem, /attributes.Root = parent/u);
  assert.match(filesystem, /attributes.Attributes = unlinkReparse \? 0x40U : 0x1040U/u);
  assert.match(filesystem, /bool unlinkReparse = false/u);
  assert.match(filesystem, /PinRelativeParent\(part\)/u);
  assert.throws(() => requireAutonomousBackend('win32'), /SANDBOX_UNAVAILABLE/u);
});
for (const name of ['write', 'replace-before-open', 'rename-while-open', 'delete-while-open', 'directory-swap', 'hardlink', 'junction', 'case-alias', 'ads', 'protected', 'changed-content', 'parent-reparse-while-pinned', 'create-through-junction']) {
  test(`native anchored mutation ${name}: actual handle identity and swap protection`, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const result = spawnSync(ownedWindowsHelper(), ['--anchored-file-selftest', name], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 16000, maxBuffer: 8192 });
    assert.equal(result.status, 0, JSON.stringify(validationFailureEvidence('foundation-tests', result)));
    assert.deepEqual(JSON.parse(result.stdout), { caseName: name, passed: true, fixtureCleanup: true, scope: 'HANDLE_MUTATION_PRIMITIVE_NOT_TRANSACTIONAL_ENGINE' });
    assert.equal(recover().quarantined, 0);
  });
}
