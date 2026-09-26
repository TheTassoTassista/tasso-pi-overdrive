#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validationFailureEvidence } from '../lib/phi-validation-evidence.mjs';
import { windowsBuildEnvironment } from '../platform/windows/toolchain.mjs';

const source = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-clean-room-'));
const clone = path.join(temp, 'source');
let stage = 'git-source';
function run(command, args, cwd = source, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    const error = new Error('PHI_CLEAN_ROOM_COMMAND_FAILED');
    error.evidence = { ...validationFailureEvidence(stage, result), ...(stage === 'windows-process-build' ? { shellIdentity: windowsBuildEnvironment(), outputShape: { stdoutChars: result.stdout?.length ?? 0, stderrChars: result.stderr?.length ?? 0, nulInterleaved: /\0/u.test(`${result.stdout ?? ''}${result.stderr ?? ''}`) } } : {}) };
    throw error;
  }
  return result.stdout;
}
let report;
try {
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error('PHI_CLEAN_ROOM_GIT_STATE_INVALID');
  // Actions normally checks out detached HEAD. Clone exact Git source without
  // requiring a branch name, then select only the proven source commit.
  run('git', ['clone', '--quiet', '--no-local', '--no-hardlinks', source, clone]);
  run('git', ['checkout', '--quiet', '--detach', head], clone);
  if (run('git', ['rev-parse', 'HEAD'], clone).trim() !== head) throw new Error('PHI_CLEAN_ROOM_HEAD_MISMATCH');
  // The source-only foundation must not depend on ignored development runtimes.
  if (fs.existsSync(path.join(clone, 'runtime', 'lsp', 'node_modules')) || fs.existsSync(path.join(clone, 'runtime', 'dap', 'python'))) throw new Error('PHI_CLEAN_ROOM_UNTRACKED_RUNTIME_COPIED');
  const npm = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
  stage = 'source-dependencies';
  run(process.execPath, [npm, 'ci', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], clone);
  stage = 'windows-process-build';
  if (process.platform === 'win32') run(process.execPath, [path.join(clone, 'scripts', 'build-windows-process.mjs')], clone);
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
  stage = 'foundation-tests';
  const tests = run(process.execPath, [path.join(clone, 'scripts', 'phi-check.mjs')], clone, env);
  if (!/^# fail 0$/mu.test(tests)) throw new Error('PHI_CLEAN_ROOM_TEST_FAILURE');
  const testCount = Number(/^# tests (\d+)$/mu.exec(tests)?.[1]);
  const passed = Number(/^# pass (\d+)$/mu.exec(tests)?.[1]);
  const skipped = Number(/^# skipped (\d+)$/mu.exec(tests)?.[1]);
  stage = 'brand-smoke';
  const version = run(process.execPath, [path.join(clone, 'bin', 'phi.mjs'), '--version'], clone, env).trim();
  if (!version.startsWith('Phi ')) throw new Error('PHI_CLEAN_ROOM_BRAND_FAILURE');
  report = { version: 1, status: 'PASS_FOUNDATION_ONLY', head, platform: process.platform, tests: { total: testCount, passed, failed: 0, skipped }, bootstrap: 'PASS_FOUNDATION_ONLY', doctor: doctor.status, fullEngine: 'BLOCKED_NOT_INSTALLED', modelCalls: 0, authCopied: false, ignoredRuntimesCopied: false, limitation: 'Not full fresh-machine product acceptance; native isolation/runtime reconstruction still pending' };
} catch (error) {
  report = { version: 1, status: 'FAIL', modelCalls: 0, cause: 'local clone/bootstrap/foundation invariant failed; no raw command output or private values printed', ...(error.evidence ?? validationFailureEvidence(stage)) };
  process.exitCode = 1;
} finally {
  // Only this newly-created directory is removed; never a source/worktree root.
  fs.rmSync(temp, { recursive: true, force: true });
  if (report) report.cleanup = fs.existsSync(temp) ? 'FAIL' : 'PASS';
}
console.log(JSON.stringify(report, null, 2));
