import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ownedWindowsHelper } from '../platform/windows/process.mjs';
import { requireAutonomousBackend } from '../platform/index.mjs';
import { validationFailureEvidence } from '../lib/phi-validation-evidence.mjs';

function probeMetadata(stdout, stderr, status) {
  const fields = ['allPackagesReadControl', 'workspaceRead', 'hostReadDenied', 'hostWriteDenied', 'runtimeWriteDenied', 'allPackagesReadDenied', 'registryReadAvailable', 'privateRegistryDenied', 'cleanEnvironment', 'scratchWrite', 'networkDenied', 'workspaceWrite', 'workspaceWriteDenied', 'tokenVerified'];
  const receipts = stdout.trim().split(/\r?\n/u).slice(0, 4).flatMap((line) => {
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
  assert.doesNotMatch(source, /ALL_APPLICATION_PACKAGES.*Allow/u);
});
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
      const [control, receipt, cleanup] = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      assert.deepEqual(control, { allPackagesReadControl: true });
      assert.equal(receipt.role, role);
      for (const key of ['workspaceRead', 'hostReadDenied', 'hostWriteDenied', 'runtimeWriteDenied', 'allPackagesReadDenied', 'registryReadAvailable', 'privateRegistryDenied', 'cleanEnvironment', 'scratchWrite', 'networkDenied']) assert.equal(receipt[key], true, key);
      assert.equal(receipt.workspaceWrite, role === 'worker');
      assert.deepEqual(cleanup, { tokenVerified: true, cleanup: 'PASS', scope: 'FIXED_SYNTHETIC_PROBE_ONLY' });
    } finally { child?.kill('SIGKILL'); await new Promise((resolve) => server.close(resolve)); }
  });
}
