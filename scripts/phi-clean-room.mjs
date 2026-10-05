#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validationFailureEvidence, validationExceptionEvidence, tapRuntimeEvidence, runtimeObservations, cloneFoundationGate } from '../lib/phi-validation-evidence.mjs';
import { windowsBuildEnvironment } from '../platform/windows/toolchain.mjs';
import { runValidationCommand, validationCommandTimeout } from '../platform/windows/validation-process.mjs';
import { cloneIdentity, cleanupClone, combineValidationResults } from '../lib/phi-clone-cleanup.mjs';
import { installDiagnostic } from '../lib/phi-lsp-install-diagnostics.mjs';

if (process.argv.length > 3 || process.argv.length === 3 && process.argv[2] !== '--runtime-diagnostic-only') throw new Error('PHI_CLEAN_ROOM_USAGE');
const diagnosticOnly = process.argv[2] === '--runtime-diagnostic-only';
const source = path.resolve(import.meta.dirname, '..');
const runStarted = performance.now();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-clean-room-'));
const clone = path.join(temp, 'source with spaces');
const identity = cloneIdentity(temp), commandReceipts = [];
const commands = [];
let foundationGate = null;
let stage = 'git-source';
async function run(command, args, cwd = source, env = process.env) {
  // Aggregate suite budget only. Ordinary/LPAC commands keep their 120s cap;
  // the fixed serial validation entry is owned by a real native Job throughout.
  let result;
  const startedUtc = new Date().toISOString(), started = performance.now();
  const extended = diagnosticOnly && stage === 'foundation-tests';
  const observedSuite = stage === 'foundation-tests' && process.platform === 'win32';
  const commandEnv = extended ? { ...env, PHI_CLONE_RUNTIME_DIAGNOSTIC: '1' } : observedSuite ? { ...env, PHI_CLONE_RUNTIME_OBSERVATION: '1' } : env;
  try { result = await runValidationCommand(command, args, { cwd, env: commandEnv, diagnosticOnly: extended, timeoutMs: validationCommandTimeout(command, args, cwd, { diagnosticOnly: extended }) }); }
  catch (cause) {
    commandReceipts.push({ scope: 'OWNERSHIP_UNVERIFIED' });
    const evidence = { ...validationFailureEvidence(stage), controllerException: validationExceptionEvidence(cause) };
    commands.push({ stage, status: 'FAIL', ...evidence });
    const error = new Error('PHI_CLEAN_ROOM_OWNER_FAILED'); error.evidence = evidence; throw error;
  }
  if (result.receipt) commandReceipts.push(result.receipt);
  if (observedSuite && !diagnosticOnly) foundationGate = cloneFoundationGate(result, { native: true });
  if (stage === 'pinned-lsp-runtime') console.log(JSON.stringify(installDiagnostic({ command, args, cwd, env, startedUtc, endedUtc: new Date().toISOString(), elapsedMs: Math.ceil(performance.now() - started), result })));
  commands.push({ stage, status: result.status === 0 && !result.error ? 'PASS' : result.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'FAIL',
    ...validationFailureEvidence(stage, result), startedUtc, endedUtc: new Date().toISOString(), elapsedMs: Math.ceil(performance.now() - started),
    ...(extended ? { runtime: runtimeObservations(result.stdout ?? '') } : {}), ...(foundationGate ? { foundationGate } : {}), ...(result.receipt ? { processReceipt: result.receipt } : {}) });
  if (result.status !== 0 || result.error || process.platform === 'win32' && (!result.receipt.jobEmptyVerified || !result.receipt.pipesDrained)) {
    const error = new Error('PHI_CLEAN_ROOM_COMMAND_FAILED');
    error.evidence = { ...validationFailureEvidence(stage, result), ...(foundationGate ? { foundationGate } : {}), ...(result.receipt ? { processReceipt: result.receipt } : {}), ...(stage === 'windows-process-build' ? { shellIdentity: windowsBuildEnvironment(), outputShape: { stdoutChars: result.stdout?.length ?? 0, stderrChars: result.stderr?.length ?? 0, nulInterleaved: /\0/u.test(`${result.stdout ?? ''}${result.stderr ?? ''}`) } } : {}) };
    throw error;
  }
  return result.stdout;
}
let report;
try {
  const head = (await run('git', ['rev-parse', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error('PHI_CLEAN_ROOM_GIT_STATE_INVALID');
  // Actions normally checks out detached HEAD. Clone exact Git source without
  // requiring a branch name, then select only the proven source commit.
  await run('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', source, clone]);
  await run('git', ['checkout', '--quiet', '--detach', head], clone);
  if ((await run('git', ['rev-parse', 'HEAD'], clone)).trim() !== head) throw new Error('PHI_CLEAN_ROOM_HEAD_MISMATCH');
  // The source-only foundation must not depend on ignored development runtimes.
  if (fs.existsSync(path.join(clone, 'runtime', 'lsp', 'node_modules')) || fs.existsSync(path.join(clone, 'runtime', 'dap', 'python'))) throw new Error('PHI_CLEAN_ROOM_UNTRACKED_RUNTIME_COPIED');
  const npm = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
  stage = 'source-dependencies';
  await run(process.execPath, [npm, 'ci', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], clone);
  if (process.platform === 'win32') {
    stage = 'pinned-lsp-runtime';
    // Diagnose the reproduced owned-install timeout without publishing raw npm
    // output or writing verbose log files. Pins/integrity, lifecycle denial,
    // online behavior, retries and the ordinary 120s deadline are unchanged.
    await run(process.execPath, [npm, 'ci', '--prefix', 'runtime/lsp', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=silly', '--logs-max=0'], clone);
  }
  stage = 'windows-process-build';
  if (process.platform === 'win32') await run(process.execPath, [path.join(clone, 'scripts', 'build-windows-process.mjs')], clone);
  const dirs = Object.fromEntries(['bin', 'config', 'state', 'agent', 'legacyConfig'].map((key) => [key, path.join(temp, 'machine', key)]));
  const env = { ...process.env, PHI_PI_ROOT: path.join(temp, 'not-installed-pi'), PI_CODING_AGENT_DIR: dirs.agent, XDG_CONFIG_HOME: path.join(temp, 'xdg-config'), XDG_STATE_HOME: path.join(temp, 'xdg-state') };
  const { bootstrapFoundation } = await import(pathToFileURL(path.join(clone, 'bootstrap', 'core.mjs')).href);
  stage = 'foundation-bootstrap';
  const plan = await bootstrapFoundation({ plan: true, root: clone, dirs, env });
  const installed = await bootstrapFoundation({ root: clone, dirs, env });
  const { phiDoctor } = await import(pathToFileURL(path.join(clone, 'lib', 'phi-doctor.mjs')).href);
  stage = 'doctor';
  const doctor = await phiDoctor({ source: clone, dirs, env, probeServices: false });
  if (plan.writes !== 0 || installed.engineReady !== false || !doctor.checks.some((row) => row.capability === 'Pi runtime' && row.status === 'FAIL')) throw new Error('PHI_CLEAN_ROOM_FALSE_ENGINE_READINESS');
  const recovery = process.platform === 'win32' ? doctor.checks.find((row) => row.capability === 'Windows scope recovery') : null;
  if (process.platform === 'win32' && recovery?.status !== 'PASS') throw new Error('PHI_CLEAN_ROOM_UNHEALTHY_SCOPE_RECOVERY');
  stage = 'foundation-tests';
  const tests = await run(process.execPath, [path.join(clone, 'scripts', 'phi-check.mjs'), '--owned-validation'], clone, env);
  if (!/^# fail 0$/mu.test(tests)) throw new Error('PHI_CLEAN_ROOM_TEST_FAILURE');
  const testCount = Number(/^# tests (\d+)$/mu.exec(tests)?.[1]);
  const passed = Number(/^# pass (\d+)$/mu.exec(tests)?.[1]);
  const skipped = Number(/^# skipped (\d+)$/mu.exec(tests)?.[1]);
  // a22bcd1 added one metadata-only regression to the 490-case source corpus.
  // Keep the diagnostic pinned to the now-observed 491-case version; a future
  // corpus edit requires an explicit baseline update, never silent acceptance.
  if (diagnosticOnly && (testCount !== 491 || passed !== 479 || skipped !== 12)) throw new Error('PHI_CLEAN_ROOM_DIAGNOSTIC_CORPUS_MISMATCH');
  if (process.platform === 'win32' && !diagnosticOnly && foundationGate?.classification !== 'SUCCESS') throw new Error('PHI_CLEAN_ROOM_FOUNDATION_GATE_FAILED');
  const tapRuntime = diagnosticOnly ? tapRuntimeEvidence(tests) : null;
  if (diagnosticOnly && (tapRuntime.completed !== 491 || !tapRuntime.contiguous)) throw new Error('PHI_CLEAN_ROOM_DIAGNOSTIC_PROGRESS_INVALID');
  if (diagnosticOnly && (commands.at(-1).runtime.completed !== 491 || !commands.at(-1).runtime.contiguous || commands.at(-1).runtime.rows.at(-1)?.kind !== 'end')) throw new Error('PHI_CLEAN_ROOM_DIAGNOSTIC_TIMING_INCOMPLETE');
  let recoveryAfterTests = 'NOT_NATIVE_WINDOWS';
  if (process.platform === 'win32') {
    stage = 'post-test-recovery';
    const { ownedWindowsHelper } = await import('../platform/windows/process.mjs');
    const status = JSON.parse(await run(ownedWindowsHelper(), ['--scope-recovery-status'], source, env));
    if (status.scope !== 'FIXED_NATIVE_SCOPES_ONLY' || status.status !== 'PASS' || ['scanned', 'active', 'stale', 'quarantined', 'processKills'].some(key => status[key] !== 0) || status.cleanupPerformed !== false) throw new Error('PHI_CLEAN_ROOM_RESIDUAL_SCOPE');
    recoveryAfterTests = { status: 'PASS', active: 0, stale: 0, quarantined: 0, processKills: 0, cleanupPerformed: false };
  }
  if (!diagnosticOnly) {
    stage = 'brand-smoke';
    const version = (await run(process.execPath, [path.join(clone, 'bin', 'phi.mjs'), '--version'], clone, env)).trim();
    if (!version.startsWith('Phi ')) throw new Error('PHI_CLEAN_ROOM_BRAND_FAILURE');
  }
  report = { version: 1, status: 'PASS_FOUNDATION_ONLY', head, platform: process.platform, tests: { total: testCount, passed, failed: 0, skipped }, ...(foundationGate ? { foundationGate } : {}), ...(tapRuntime ? { tapRuntime } : {}), bootstrap: 'PASS_FOUNDATION_ONLY', doctor: doctor.status, fixedScopeRecovery: recovery?.status ?? 'NOT_NATIVE_WINDOWS', recoveryAfterTests, ownedCommands: commandReceipts.length, fullEngine: 'BLOCKED_NOT_INSTALLED', modelCalls: 0, authCopied: false, ignoredRuntimesCopied: false, limitation: 'Not full fresh-machine product acceptance; native isolation/runtime reconstruction still pending' };
} catch (error) {
  report = { version: 1, status: foundationGate?.classification && foundationGate.classification !== 'SUCCESS' ? foundationGate.classification : error.evidence?.timedOut ? 'TIMEOUT' : 'FAIL', modelCalls: 0, cause: 'local clone/bootstrap/foundation invariant failed; no raw command output or private values printed', ...(foundationGate ? { foundationGate } : {}), ...(error.evidence ?? validationFailureEvidence(stage)) };
  process.exitCode = 1;
} finally {
  report.commands = commands;
  const cleanupStarted = performance.now();
  const cleanup = await cleanupClone(temp, identity, { safeCwd: source, receipts: commandReceipts });
  if (diagnosticOnly) report.cleanupElapsedMs = Math.ceil(performance.now() - cleanupStarted);
  report = combineValidationResults(report, cleanup);
  if (diagnosticOnly && report.status === 'PASS_FOUNDATION_ONLY') { report.status = 'DIAGNOSTIC_COMPLETE_NON_CERTIFYING'; report.primary.status = 'DIAGNOSTIC_COMPLETE_NON_CERTIFYING'; }
  if (report.status === 'FAIL') process.exitCode = 1;
  report.totalElapsedMs = Math.ceil(performance.now() - runStarted);
}
console.log(JSON.stringify(report, null, 2));
