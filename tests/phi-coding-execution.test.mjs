import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { requireBoundedWindowsPublication, requireCodingBackend, sandboxInvocation } from '../platform/shared/coding-execution.mjs';
import { windowsPlatform } from '../platform/windows/index.mjs';
import { boundedCreateTaskTarget } from '../lib/phi-worker-authority.mjs';
import { resolveTaskPolicy } from '../lib/task-governor.mjs';
import { EditEngine } from '../lib/edit-engine.mjs';
import { DapEngine } from '../lib/dap-engine.mjs';
import { PersistentEvalEngine, spawnPersistentEvalKernel } from '../lib/persistent-eval.mjs';
import { removeVerifiedWorkspaceFile } from '../lib/safety.mjs';
import { executeLsp, lspRuntimeStatus } from '../lib/lsp-manager.mjs';

const operations = ['workflow', 'verification', 'safe-exec', 'lsp', 'debug', 'eval', 'edit-engine', 'safe-remove'];
const linux = process.platform === 'linux';
const denied = /PHI_CODING_BACKEND_UNAVAILABLE/u;

test('production capability dispatch uses the actual host and never treats fixed LPAC probes as readiness', () => {
  for (const operation of operations) {
    if (!linux) assert.throws(() => requireCodingBackend(operation), denied);
    else {
      const result = requireCodingBackend(operation);
      assert.equal(result.platform, process.platform);
      assert.equal(result.backend, 'bubblewrap');
      assert.equal(result.operation, operation);
      assert.equal(Object.isFrozen(result), true);
    }
  }
});

test('bounded CREATE admission never promotes the Windows full backend or other operations', () => {
  assert.equal(windowsPlatform.sandbox.implemented, false);
  assert.equal(windowsPlatform.sandbox.autonomousReady, false);
  assert.deepEqual(Object.keys(windowsPlatform.boundedPublication), ['CREATE']);
  for (const operation of ['MODIFY', 'DELETE', 'RENAME']) assert.throws(() => requireBoundedWindowsPublication(operation), /PHI_PUBLICATION_CAPABILITY_UNAVAILABLE/u);
  for (const operation of ['workflow', '__proto__', undefined]) assert.throws(() => requireBoundedWindowsPublication(operation), /PHI_PUBLICATION_OPERATION_INVALID/u);
  if (process.platform === 'win32') {
    assert.equal(requireBoundedWindowsPublication('CREATE').operation, 'CREATE');
    assert.throws(() => requireCodingBackend('workflow'), denied);
  } else assert.throws(() => requireBoundedWindowsPublication('CREATE'), /PHI_PUBLICATION_CAPABILITY_UNAVAILABLE/u);
});

test('bounded CREATE target is anchored to exact direct-user task and mutating policy', () => {
  const task = 'Create file `src/new.js` containing export const answer = 42;';
  const policy = resolveTaskPolicy({ task });
  assert.equal(boundedCreateTaskTarget(task, task, policy), 'src/new.js');
  for (const other of [null, task + ' ', 'Create file `src/other.js` containing export const answer = 42;'])
    assert.throws(() => boundedCreateTaskTarget(task, other, policy), /PUBLICATION_ENVELOPE_DENIED/u);
  for (const target of ['.env', 'src/.env', '../outside.js', 'src/../outside.js', 'src\\new.js', 'src/file.js:ads']) {
    const request = `Create file \`${target}\` containing safe text`;
    assert.throws(() => boundedCreateTaskTarget(request, request, resolveTaskPolicy({ task: request })), /PUBLICATION_ENVELOPE_DENIED/u);
  }
  const readOnly = resolveTaskPolicy({ task: 'Inspect `src/new.js` without changing it' });
  assert.throws(() => boundedCreateTaskTarget(task, task, readOnly), /PUBLICATION_ENVELOPE_DENIED/u);
});

test('unknown or inherited operation names cannot select a coding capability', () => {
  for (const operation of ['constructor', '__proto__', 'toString', 'trusted-job', 'confinement-probe', null, {}, 1]) {
    assert.throws(() => requireCodingBackend(operation), /PHI_CODING_OPERATION_INVALID/u);
  }
});

test('model-shaped platform, sandbox, network and role overrides cannot alter dispatch', () => {
  for (const options of [{ platform: 'linux' }, { autonomousReady: true }, { network: true }, { role: 'worker' }, { backend: 'windows-job-object' }]) {
    assert.throws(() => sandboxInvocation('safe-exec', ['workspace', '--', 'node'], options), linux ? /PHI_CODING_OPTIONS_INVALID/u : denied);
  }
});

test('Linux command vectors remain exact and shell-free; Windows cannot return an invocation', () => {
  const args = ['--workspace-read-only', 'workspace with spaces', '--', 'node', 'source.js', 'a;$(never-execute)', '"quoted"'];
  if (!linux) { assert.throws(() => sandboxInvocation('lsp', args), denied); return; }
  const result = sandboxInvocation('lsp', args);
  assert.equal(result.command, fileURLToPath(new URL('../scripts/sandbox-run.sh', import.meta.url)));
  assert.deepEqual(result.args, args);
  assert.equal(result.shell, false);
  assert.equal(Object.isFrozen(result.args), true);
  args.push('later mutation');
  assert.equal(result.args.includes('later mutation'), false);
  assert.throws(() => sandboxInvocation('safe-exec', ['bad\0arg']), /ARGUMENTS_INVALID/u);
});

test('controller-only LSP failure runner cannot bypass the native platform gate', () => {
  const options = { runner: process.execPath };
  if (!linux) { assert.throws(() => sandboxInvocation('lsp', [], options), denied); return; }
  assert.equal(sandboxInvocation('lsp', [], options).command, process.execPath);
  assert.throws(() => sandboxInvocation('safe-exec', [], options), /OPTIONS_INVALID/u);
  assert.throws(() => sandboxInvocation('lsp', [], { runner: 'relative-runner' }), /RUNNER_INVALID/u);
});

test('actual production safe_exec, LSP, DAP, eval and mutation entry points are wired to the shared boundary', () => {
  for (const [file, pattern] of [
    ['extensions/safe-exec.ts', /sandboxInvocation\("safe-exec"/u],
    ['lib/lsp-manager.mjs', /sandboxInvocation\("lsp"/u],
    ['lib/dap-engine.mjs', /sandboxInvocation\("debug"/u],
    ['lib/persistent-eval.mjs', /sandboxInvocation\("eval"/u],
    ['lib/edit-engine.mjs', /requireCodingBackend\("edit-engine"\)/u],
    ['lib/safety.mjs', /requireCodingBackend\("safe-remove"\)/u],
    ['extensions/secure-workflow.ts', /requireCodingBackend\("workflow"\)/u],
    ['extensions/verification-gate.ts', /requireCodingBackend\("verification"\)/u],
    ['scripts/verify-project.mjs', /sandboxInvocation\("verification"/u],
    ['scripts/typecheck.mjs', /'themes', 'platform'/u],
  ]) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), pattern);
});

test('native Windows production constructors and removal deny before reading caller paths or spawn overrides', { skip: process.platform !== 'win32' }, () => {
  const options = new Proxy({}, { get() { assert.fail('caller options reached before secure backend admission'); } });
  for (const Engine of [EditEngine, DapEngine, PersistentEvalEngine]) assert.throws(() => new Engine(options), denied);
  assert.throws(() => removeVerifiedWorkspaceFile(options, options, options), denied);
  assert.throws(() => spawnPersistentEvalKernel({ language: 'python', policy: options }), denied);
});

test('native Windows real LSP entry denies before fixture IO or controller runner override and starts no server', { skip: process.platform !== 'win32' }, async () => {
  const unreadable = new Proxy({}, { get() { assert.fail('LSP input reached before secure backend admission'); } });
  const before = lspRuntimeStatus().activeServers;
  const result = await executeLsp(unreadable, unreadable, { sandboxRunner: process.execPath });
  assert.deepEqual(result, { status: 'FAIL', error: 'PHI_CODING_BACKEND_UNAVAILABLE', entries: [] });
  assert.equal(lspRuntimeStatus().activeServers, before);
});

test('native Windows direct verification CLI denies before project checks even with enable-looking environment flags', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../scripts/verify-project.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--json', '--cwd', 'Z:\\not-a-project'], {
    shell: false, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PHI_WINDOWS_AUTONOMY: 'VERIFIED', PHI_PLATFORM: 'linux' },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'FAIL', error: 'PHI_PROJECT_SNAPSHOT_REJECTED', results: [] });
  assert.equal(result.stderr, '');
});
