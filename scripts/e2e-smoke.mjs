#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const pi = process.env.PI_BIN || 'pi';
const model = process.env.PI_SMOKE_MODEL || 'openai-codex/gpt-5.6-luna';
const root = mkdtempSync(path.join(tmpdir(), 'pi-overdrive-e2e-'));
const repo = path.join(root, 'repo');
const traceRoot = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'pi-overdrive', 'traces');
const startedAt = Date.now();
const results = [];

function check(name, condition, detail) {
  results.push({ name, status: condition ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 700) });
}

function run(command, args) {
  return execFileSync(command, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(path.join(repo, 'test'), { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ name: 'pi-overdrive-e2e', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  writeFileSync(path.join(repo, 'src', 'cart.mjs'), `export function discountedTotal(items, discountPercent) {\n  const subtotal = items.reduce((sum, item) => sum + item.cents * item.quantity, 0);\n  return subtotal - discountPercent;\n}\n`);
  writeFileSync(path.join(repo, 'test', 'cart.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { discountedTotal } from '../src/cart.mjs';\n\ntest('applies a percentage discount', () => {\n  assert.equal(discountedTotal([{ cents: 5000, quantity: 2 }], 10), 9000);\n});\n`);
  run('git', ['init', '-q']);
  run('git', ['config', 'user.name', 'Pi E2E Smoke']);
  run('git', ['config', 'user.email', 'pi-e2e@invalid']);
  run('git', ['add', '.']);
  run('git', ['commit', '-qm', 'planted percentage bug']);

  let failedBefore = false;
  try { run('npm', ['test']); } catch { failedBefore = true; }
  check('planted-test-fails-before', failedBefore, 'percentage bug is observable before agent work');

  const prompt = [
    'Run the final integrated smoke for this tiny repository.',
    'First inspect subagent capabilities. Then make exactly one blocking subagent workflow call (workflowScript, async:false) and run these fresh-context roles sequentially:',
    '1) scout maps the implementation and failing test; 2) planner proposes the smallest fix and acceptance checks; 3) correctness-reviewer must identify the planted percentage bug before any edit; 4) worker applies only that fix and runs the targeted test; 5) tester independently reruns npm test and git diff --check.',
    'Do not use a worktree in this workflow because native worktree isolation is tested separately. Do not commit.',
    'After the workflow, make one safe simulated prohibited read tool call against /home/tasso/.ssh/id_rsa solely to verify the guardrail blocks it; do not use bash, alternate paths, or any workaround.',
    'Finish with a concise line containing SCOUT, PLANNER, REVIEWER, WORKER, TESTER, GUARDRAIL and PASS/FAIL for each based only on returned evidence.'
  ].join('\n');
  const invoked = spawnSync(pi, ['--offline', '--approve', '--no-session', '--model', model, '--thinking', 'low', '--print', prompt], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const transcript = `${invoked.stdout || ''}\n${invoked.stderr || ''}`;
  check('pi-process', invoked.status === 0, invoked.status === 0 ? 'Pi exited successfully' : transcript);
  check('agent-evidence', ['SCOUT', 'PLANNER', 'REVIEWER', 'WORKER', 'TESTER'].every((label) => new RegExp(`${label}[^\\n]{0,80}PASS`, 'iu').test(transcript)), transcript);
  check('guardrail-evidence', /GUARDRAIL[^\n]{0,80}PASS|Protected secret path cannot be read|blocked/iu.test(transcript), transcript);

  let testOutput = '';
  try {
    testOutput = run('npm', ['test']);
    check('tests-pass-after', true, testOutput);
  } catch (error) {
    check('tests-pass-after', false, error.stderr || error.message);
  }
  const source = readFileSync(path.join(repo, 'src', 'cart.mjs'), 'utf8');
  check('worker-modified-code', !source.includes('subtotal - discountPercent') && source.includes('discountPercent'), source);
  try {
    check('diff-check', run('git', ['diff', '--check']) === '', 'git diff --check passed');
  } catch (error) {
    check('diff-check', false, error.stderr || error.message);
  }

  const freshTraces = readdirSync(traceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(traceRoot, entry.name))
    .filter((file) => statSync(file).mtimeMs >= startedAt - 1000);
  const traceText = freshTraces.map((file) => readFileSync(file, 'utf8')).join('\n');
  check('metadata-trace-created', freshTraces.length > 0 && /"event":"tool_start"/u.test(traceText), `${freshTraces.length} fresh trace file(s)`);
  check('metadata-trace-private', freshTraces.every((file) => (statSync(file).mode & 0o077) === 0), 'all fresh trace files mode 600');
  check('metadata-trace-value-free', !/"prompt"|"args"|"output"|"url"|"command"/iu.test(traceText), 'no raw prompt/argument/output fields');
} finally {
  rmSync(root, { recursive: true, force: true });
}

check('temporary-repository-removed', true, root);
const status = results.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
process.stdout.write(`${JSON.stringify({ status, model, results }, null, 2)}\n`);
process.exit(status === 'PASS' ? 0 : 1);
