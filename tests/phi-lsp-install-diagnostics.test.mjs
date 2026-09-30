import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactInstallText, installFileInventory, installDiagnostic } from '../lib/phi-lsp-install-diagnostics.mjs';

test('Windows clean clone uses runner temp while Linux keeps its original clone path', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const linux = workflow.split('      - name: Clean Git-source clone (foundation only, engine must be unavailable)\n')[1]?.split('      - name: ')[0];
  const windows = workflow.split('      - name: Clean Git-source clone on runner temporary volume (foundation only)\n')[1]?.split('      - name: ')[0];
  assert.ok(linux && windows, 'both independent-clone steps must remain registered');
  assert.match(linux, /if: runner\.os != 'Windows'\n\s+run: node scripts\/phi-clean-room\.mjs/u);
  assert.match(windows, /if: runner\.os == 'Windows'\n\s+env:\n\s+TMP: \$\{\{ runner\.temp \}\}\n\s+TEMP: \$\{\{ runner\.temp \}\}\n\s+run: node scripts\/phi-clean-room\.mjs/u);
});

test('trusted install diagnostics redact known environment secrets and credentials without dumping env', () => {
  const text = 'known-credential https://user:password@registry.example/p?token=unknown-token&x=1 Authorization: Bearer abc.123 _authToken=another-secret';
  const result = redactInstallText(text, { ACTIONS_RUNTIME_TOKEN: 'known-credential', PUBLIC_LABEL: 'must-not-be-redacted' });
  assert.doesNotMatch(result, /known-credential|user:password|unknown-token|abc.123|another-secret/u);
  assert.equal(redactInstallText('must-not-be-redacted', { PUBLIC_LABEL: 'must-not-be-redacted' }), 'must-not-be-redacted');
});
test('clone inventory observes fixed metadata only and does not follow symlinks or read file contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-install-observation-'));
  try {
    fs.mkdirSync(path.join(root, 'runtime/lsp/node_modules/typescript'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime/lsp/node_modules/typescript/package.json'), 'PRIVATE_CONTENT');
    const row = installFileInventory(root);
    assert.equal(row.packageManifests.find(item => item.relative.endsWith('/typescript/package.json')).exists, true);
    assert.equal(row.fixed.find(item => item.relative.endsWith('/.package-lock.json')).exists, false);
    assert.equal(row.fileContentsRead, false); assert.match(row.lockOwnership, /^UNKNOWN/u);
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE_CONTENT/u);
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'runtime/lsp/node_modules/pyright'), 'junction');
    assert.equal(installFileInventory(root).packageManifests.find(item => item.relative.endsWith('/pyright/package.json')).error, 'ANCESTOR_LINK_NOT_INSPECTED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('diagnostic retains actual fixed cwd/argv/output and distinguishes synthetic124 without changing the receipt', () => {
  const root = os.tmpdir(), receipt = { timedOut: true, resultExitCode: 124, jobEmptyVerified: true };
  const native = { version: 1, scope: 'FIXED_TRUSTED_LSP_INSTALL_OBSERVATION_NOT_SANDBOX', phases: [], snapshots: [], observedProcesses: [], observerStopped: true };
  const row = installDiagnostic({ command: 'node.exe', args: ['npm-cli.js', 'ci'], cwd: root, env: { AUTH_TOKEN: 'secret-value' }, startedUtc: '2026-09-29T00:00:00.000Z', endedUtc: '2026-09-29T00:02:00.000Z', elapsedMs: 120000,
    result: { status: 124, receipt, error: { code: 'ETIMEDOUT' }, stdout: 'progress secret-value', stderr: `npm silly reify moves\nPHI_LSP_INSTALL_DIAGNOSTIC:${JSON.stringify(native)}` } });
  assert.equal(row.timeoutMs, 120000); assert.equal(row.syntheticTimeoutExit, true); assert.equal(row.observationStatus, 'CAPTURED');
  assert.equal(row.cwd, root); assert.deepEqual(row.argv, ['npm-cli.js', 'ci']); assert.deepEqual(row.receipt, receipt);
  assert.equal(row.stderr, 'npm silly reify moves'); assert.doesNotMatch(JSON.stringify(row), /secret-value|AUTH_TOKEN/u);
  assert.doesNotMatch(row.interpretation, /root cause.*proved/u);
  const escaped = installDiagnostic({ command: 'node.exe', args: [], cwd: root, env: { SECRET: 'secret"with\\escape' }, result: { stdout: 'secret"with\\escape', stderr: '_authToken=private-at-end' } });
  assert.equal(escaped.stdout, '[REDACTED]'); assert.equal(escaped.stderr, '_authToken=[REDACTED]');
});
test('missing/malformed/duplicate/incomplete observation cannot be mistaken for complete runtime evidence', () => {
  for (const [stderr, status] of [['npm progress', 'MISSING'], ['PHI_LSP_INSTALL_DIAGNOSTIC:{}', 'INVALID'], ['PHI_LSP_INSTALL_DIAGNOSTIC:{}\nPHI_LSP_INSTALL_DIAGNOSTIC:{}', 'MISSING']]) {
    const row = installDiagnostic({ command: 'node.exe', args: [], cwd: os.tmpdir(), env: {}, result: { status: 124, stderr } });
    assert.equal(row.observationStatus, status); assert.equal(row.native, null);
  }
});
