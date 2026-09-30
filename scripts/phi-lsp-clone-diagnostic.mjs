#!/usr/bin/env node
// Trusted CI experiment only: stop at the same independent-clone LSP install.
// This is not a product bootstrap or a foundation acceptance result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneIdentity, cleanupClone } from '../lib/phi-clone-cleanup.mjs';
import { installDiagnostic } from '../lib/phi-lsp-install-diagnostics.mjs';
import { runValidationCommand, validationCommandTimeout } from '../platform/windows/validation-process.mjs';

if (process.platform !== 'win32') throw new Error('PHI_LSP_DIAGNOSTIC_WINDOWS_ONLY');
const source = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-clean-room-'));
const clone = path.join(temp, 'source with spaces');
const identity = cloneIdentity(temp), receipts = [];
let stage = 'git-source', primary = { status: 'FAIL', stage };

async function run(command, args, cwd = source) {
  const startedUtc = new Date().toISOString(), started = performance.now();
  const result = await runValidationCommand(command, args, {
    cwd, env: process.env, timeoutMs: validationCommandTimeout(command, args, cwd),
  });
  if (result.receipt) receipts.push(result.receipt);
  if (stage === 'pinned-lsp-runtime') {
    console.log(JSON.stringify(installDiagnostic({
      command, args, cwd, env: process.env, startedUtc,
      endedUtc: new Date().toISOString(), elapsedMs: Math.ceil(performance.now() - started), result,
    })));
  }
  if (result.status !== 0 || result.error || !result.receipt?.jobEmptyVerified || !result.receipt?.pipesDrained) {
    primary = { status: result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'FAIL', stage,
      exitCode: result.status ?? null, timedOut: result.error?.code === 'ETIMEDOUT',
      jobEmptyVerified: result.receipt?.jobEmptyVerified ?? false,
      residualOwnedProcesses: result.receipt?.residualOwnedProcesses ?? null };
    throw new Error('PHI_LSP_DIAGNOSTIC_COMMAND_FAILED');
  }
  return result.stdout;
}

try {
  const head = (await run('git', ['rev-parse', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error('PHI_LSP_DIAGNOSTIC_GIT_STATE_INVALID');
  await run('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', source, clone]);
  await run('git', ['checkout', '--quiet', '--detach', head], clone);
  if ((await run('git', ['rev-parse', 'HEAD'], clone)).trim() !== head ||
      fs.existsSync(path.join(clone, 'runtime', 'lsp', 'node_modules'))) throw new Error('PHI_LSP_DIAGNOSTIC_CLONE_INVALID');
  const npm = path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  stage = 'source-dependencies';
  await run(process.execPath, [npm, 'ci', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], clone);
  stage = 'pinned-lsp-runtime';
  await run(process.execPath, [npm, 'ci', '--prefix', 'runtime/lsp', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=silly', '--logs-max=0'], clone);
  primary = { status: 'PASS_INSTALL_ONLY', stage, head };
} catch (error) {
  if (primary.stage !== stage) primary = { status: 'FAIL', stage, code: error.message === 'PHI_LSP_DIAGNOSTIC_COMMAND_FAILED' ? 'COMMAND' : 'INVARIANT' };
} finally {
  const cleanup = await cleanupClone(temp, identity, { safeCwd: source, receipts });
  const status = primary.status === 'PASS_INSTALL_ONLY' && cleanup.status === 'PASS' ? 'PASS_INSTALL_ONLY' : 'FAIL';
  console.log(JSON.stringify({ version: 1, kind: 'PHI_LSP_CLONE_DIAGNOSTIC_ONLY', status,
    tempVolume: path.parse(temp).root, sourceVolume: path.parse(source).root,
    primary, cleanup, modelCalls: 0 }, null, 2));
  if (status !== 'PASS_INSTALL_ONLY') process.exitCode = 1;
}
