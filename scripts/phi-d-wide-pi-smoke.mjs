#!/usr/bin/env node
// Native Windows Campaign-2 fixture: four *normal* secure_coding_workflow calls.
// This script has no publication/recovery grant. Git commits only record an
// already-verified disposable worktree state as the next task's fixture base.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDPrefix, D_OPERATIONS, runDSequence } from './phi-d-prefix.mjs';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';
import { readEvidenceReceipt } from '../lib/workflow-evidence.mjs';
import { captureProcessIdentity, inspectProcessIdentity } from '../lib/process-identity.mjs';
import { createOwnedProcessGraphEvidence, fixedScopeBaselineEvidence } from '../lib/phi-certification-evidence.mjs';
import { discoverWindowsTransactions } from '../platform/windows/publication.mjs';
import { assertUniqueManagedWorktreeRecord, listRuntimeAllocations } from '../lib/runtime-isolation.mjs';
import { runValidationCommand } from '../platform/windows/validation-process.mjs';
import { ownedWindowsHelper } from '../platform/windows/process.mjs';

if (process.platform !== 'win32') throw new Error('PHI_D_WIDE_REQUIRES_NATIVE_WINDOWS');
if (process.argv.length !== 2) throw new Error('PHI_D_WIDE_USAGE');
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.PHI_WORKER_TEST_PI_ROOT ?? discoverPiRuntime()?.root;
const subagentRoot = process.env.PHI_WORKER_TEST_SUBAGENT_ROOT ?? path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
if (!piRoot || !fs.existsSync(path.join(subagentRoot, 'index.ts'))) throw new Error('PHI_D_WIDE_RUNTIME_MISSING');
const piManifest = JSON.parse(fs.readFileSync(path.join(piRoot, 'package.json'), 'utf8'));
const subagentManifest = JSON.parse(fs.readFileSync(path.join(subagentRoot, 'package.json'), 'utf8'));
assert.equal(piManifest.version, '0.87.1');
assert.equal(subagentManifest.version, '0.66.0');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-d-wide-'));
const project = path.join(temp, 'project');
const agentDir = path.join(temp, 'agent');
const fixtureProvider = path.join(sourceRoot, 'tests', 'fixtures', 'deterministic-phi-publication-provider.ts');
const tasks = [
  'Create file `a.txt` containing created-state',
  'Modify file `a.txt` to contain modified-state',
  'Rename file `a.txt` to `b.txt`',
  'Delete file `b.txt`',
];
const expectedStatus = [
  ['?? a.txt'], [' M a.txt'], [' D a.txt', '?? b.txt'], [' D b.txt'],
];
const retained = [];
const summary = { status: 'FAIL', runKind: 'D_WIDE_NORMAL_WORKFLOW', operations: [], externalRequests: 0,
  prefix: 'PREFIX_0', inFlight: null, cleanup: 'UNKNOWN', residualOwnedProcesses: null };
let current = project;
let child = null;
let childClosed = null;
let childIdentity = null;
let activeStepIndex = -1;
let initialHead = null;

function git(cwd, args) {
  const run = spawnSync('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 8192 });
  assert.equal(run.status, 0, `D_WIDE_GIT_${args[0]}_FAILED`);
  return run.stdout;
}
function underOwnedTemp(candidate) {
  let relative;
  try { relative = path.relative(fs.realpathSync(temp), fs.realpathSync(candidate)); }
  catch { return false; }
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function setupFixture() {
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(agentDir, 'extensions', 'subagent'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}', { mode: 0o600 });
  fs.copyFileSync(path.join(sourceRoot, 'config', 'subagents.json'), path.join(agentDir, 'extensions', 'subagent', 'config.json'));
  const childExtensions = [fixtureProvider, 'safety.ts', 'windows-worker.ts', 'safe-exec.ts', 'lsp.ts', 'verification-gate.ts']
    .map((entry, index) => index === 0 ? entry : path.join(sourceRoot, 'extensions', entry)).map(file => file.replaceAll('\\', '/'));
  fs.writeFileSync(path.join(agentDir, 'agents', 'worker.md'), [
    '---', 'name: worker', 'description: Offline bounded D-wide Worker fixture.',
    'tools: read, safe_exec, semantic_nav, verification_gate', 'mutationTools: safe_exec',
    `subagentOnlyExtensions: ${childExtensions.join(', ')}`, 'defaultContext: fresh',
    'acceptanceRole: writer', 'permission:', '  edit: allow', '  write: allow',
    'inheritGlobalContext: false', 'inheritProjectContext: false', 'inheritSkills: false',
    'async: false', '---', 'Use only offered tools for the exact fixture task.', '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, 'agents', 'scout.md'), [
    '---', 'name: scout', 'description: Read-only offline D-wide Scout fixture.',
    'tools: read, grep, find, ls', `subagentOnlyExtensions: ${fixtureProvider.replaceAll('\\', '/')}`,
    'defaultContext: fresh', 'acceptanceRole: read-only', 'permission:', '  edit: deny', '  write: deny',
    'inheritGlobalContext: false', 'inheritProjectContext: false', 'inheritSkills: false',
    'async: false', '---', 'Inspect only the fixture.', '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(project, 'config.json'), '{}');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node test.cjs' } }));
  fs.writeFileSync(path.join(project, 'edit.cjs'), [
    "const f=require('node:fs'),a=f.existsSync('a.txt'),b=f.existsSync('b.txt');",
    "if(!a&&!b)f.writeFileSync('a.txt','created-state',{flag:'wx'});",
    "else if(a&&!b&&f.readFileSync('a.txt','utf8')==='created-state')f.writeFileSync('a.txt','modified-state');",
    "else if(a&&!b&&f.readFileSync('a.txt','utf8')==='modified-state'){f.writeFileSync('b.txt',f.readFileSync('a.txt'),{flag:'wx'});f.unlinkSync('a.txt');}",
    "else if(!a&&b&&f.readFileSync('b.txt','utf8')==='modified-state')f.unlinkSync('b.txt');",
    "else throw Error('PHI_D_FIXTURE_UNEXPECTED_PRESTATE');",
  ].join('\n'));
  fs.writeFileSync(path.join(project, 'test.cjs'), [
    "const f=require('node:fs'),a=require('node:assert/strict');",
    "const aa=f.existsSync('a.txt'),bb=f.existsSync('b.txt');a.equal(aa&&bb,false);",
    "if(aa)a.ok(['created-state','modified-state'].includes(f.readFileSync('a.txt','utf8')));",
    "if(bb)a.equal(f.readFileSync('b.txt','utf8'),'modified-state');",
  ].join('\n'));
  for (const file of ['edit.cjs', 'test.cjs']) {
    const checked = spawnSync(process.execPath, ['--check', path.join(project, file)], { shell: false, windowsHide: true });
    assert.equal(checked.status, 0, `D_WIDE_${file}_SYNTAX_INVALID`);
  }
  git(project, ['init', '-q']);
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  initialHead = git(project, ['rev-parse', 'HEAD']).trim();
}

async function runNormalStep(step, index) {
  activeStepIndex = index;
  summary.inFlight = step.operation;
  const stepRoot = path.join(temp, `step-${index + 1}`);
  fs.mkdirSync(stepRoot);
  const evidenceRoot = path.join(stepRoot, 'evidence');
  const auditFile = path.join(stepRoot, 'provider-audit.jsonl');
  const args = [path.join(piRoot, piManifest.bin.pi), '-ne', '--offline', '--approve', '--no-session', '--mode', 'rpc',
    '--extension', fixtureProvider, '--extension', path.join(subagentRoot, 'index.ts'),
    '--extension', path.join(sourceRoot, 'extensions', 'secure-workflow.ts'),
    '--provider', 'openai-codex', '--model', 'gpt-6-luna', '--api-key', 'offline-fixture-not-a-credential',
    '--tools', 'secure_coding_workflow'];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PHI_BOUNDED_TEST_KEY: 'offline-fixture-not-a-credential',
    PHI_BOUNDED_TEST_AUDIT: auditFile, PI_OVERDRIVE_EVIDENCE_ROOT: evidenceRoot,
    PI_OVERDRIVE_RUNTIME_ROOT: path.join(stepRoot, 'runtime'), PI_OVERDRIVE_WORKTREE_ROOT: path.join(stepRoot, 'worktrees'),
    PI_OVERDRIVE_MEMORY_ROOT: path.join(stepRoot, 'memory'), PI_OVERDRIVE_CLEANUP_WORKFLOW: '0',
    XDG_CONFIG_HOME: path.join(stepRoot, 'config'),
    XDG_STATE_HOME: path.join(stepRoot, 'state'), HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' };
  child = spawn(process.execPath, args, { cwd: current, shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
  childClosed = new Promise(resolve => child.once('close', code => resolve(code)));
  const identity = captureProcessIdentity(child.pid);
  childIdentity = identity;
  const events = [];
  let buffer = '', stdoutDrained = false, stderrDrained = false;
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end).replace(/\r$/u, '');
      buffer = buffer.slice(end + 1);
      if (line) try { events.push(JSON.parse(line)); } catch { events.push({ type: 'invalid_json' }); }
    }
  });
  child.stdout.once('end', () => { stdoutDrained = true; });
  child.stderr.on('data', () => {}); // Drain without publishing raw data.
  child.stderr.once('end', () => { stderrDrained = true; });
  child.stdin.on('error', () => {}); // A failed child is reported by exit/settlement checks.
  child.stdin.write(`${JSON.stringify({ id: `d-${index}`, type: 'prompt', message: tasks[index] })}\n`);
  const started = Date.now();
  while (!events.some(event => event.type === 'agent_settled') && child.exitCode === null && Date.now() - started < 10 * 60 * 1000)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(events.some(event => event.type === 'agent_settled'), 'D_WIDE_PI_NOT_SETTLED');
  child.stdin.end();
  const exit = await Promise.race([childClosed, new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 10000))]);
  assert.notEqual(exit, 'TIMEOUT', 'D_WIDE_PI_SHUTDOWN_TIMEOUT');
  assert.equal(exit, 0, 'D_WIDE_PI_EXIT_NONZERO');
  assert.equal(stdoutDrained && stderrDrained, true, 'D_WIDE_PI_PIPES_NOT_DRAINED');
  assert.equal(inspectProcessIdentity(identity).alive, false, 'D_WIDE_PI_CHILD_REMAINS_ALIVE');
  const tool = events.findLast(event => event.type === 'tool_execution_end' && event.toolName === 'secure_coding_workflow');
  assert.ok(tool && tool.isError === false, 'D_WIDE_NORMAL_WORKFLOW_FAILED');
  const details = tool.result?.details;
  assert.equal(details?.status, 'PASS');
  assert.equal(details?.cleanup?.status, 'RELEASED');
  const allocation = details?.allocation;
  assert.ok(allocation && underOwnedTemp(allocation.worktree) && fs.realpathSync(allocation.worktree) === allocation.worktree,
    'D_WIDE_ALLOCATION_NOT_OWNED');
  retained.push({ allocation, source: current, stepRoot });
  const finalEvidence = readEvidenceReceipt({ root: evidenceRoot, runId: details.runId, taskDigest: details.taskDigest });
  assert.equal(finalEvidence.receipt.status, 'PASS');
  assert.equal(finalEvidence.receipt.cleanupStatus, 'RELEASED');
  assert.equal(finalEvidence.receipt.finalVerdict?.status, 'PASS');
  assert.equal(finalEvidence.receipt.finalVerdict?.task_id, details.taskDigest);
  assert.deepEqual(finalEvidence.receipt.evidence?.publications, finalEvidence.execution.evidence?.publications);
  const publication = finalEvidence.receipt.evidence.publications;
  assert.equal(publication.length, 1);
  assert.equal(publication[0].operation, step.operation);
  assert.equal(publication[0].journalVersion, step.journalVersion);
  assert.match(publication[0].intentDigest, /^[0-9a-f]{64}$/u);
  const discovered = discoverWindowsTransactions({ cwd: allocation.worktree });
  const journal = discovered.entries.find(entry => entry.transactionId === publication[0].transactionId);
  assert.equal(journal?.journalVersion, step.journalVersion);
  assert.equal(journal?.phase, 'CLEANED');
  assert.equal(journal?.classification, 'TERMINAL_RETAINED');
  const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const turns = audit.filter(row => row.kind === 'local_model_turn');
  assert.ok(turns.some(row => row.lane === 'controller') && turns.some(row => row.lane === 'worker'));
  const allowedFixtureModels = new Set(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.equal(turns.every(row => row.provider === 'openai-codex' && allowedFixtureModels.has(row.model)), true);
  const userShape = audit.find(row => row.kind === 'controller_user_shape');
  assert.deepEqual({ branchArray: userShape?.branchArray, singleText: userShape?.singleText,
    exactTaskMatch: userShape?.exactTaskMatch }, { branchArray: true, singleText: true, exactTaskMatch: true });
  const stages = audit.filter(row => row.kind === 'create_stage');
  const names = stages.map(row => row.stage);
  const expectedStages = ['WORKFLOW_ADMITTED', 'ENVELOPE_ESTABLISHED', 'WORKER_RESULT', 'WORKER_REVOKED',
    'CONTROLLER_VALIDATION_START', index === 0 ? 'CREATE_INTENT_AND_V6_READY' : 'OPERATION_INTENT_READY',
    'NATIVE_PUBLICATION_CALL_ENTERED', 'NATIVE_RESULT_OBSERVED', 'PHYSICAL_POSTVERIFY_COMPLETE'];
  let prior = -1;
  for (const stage of expectedStages) {
    const found = names.indexOf(stage, prior + 1);
    assert.ok(found > prior, `D_WIDE_REQUIRED_STAGE_${stage}_MISSING`);
    prior = found;
  }
  const ready = stages.findLast(row => row.stage === expectedStages[5]);
  const nativeResult = stages.findLast(row => row.stage === 'NATIVE_RESULT_OBSERVED');
  const postverify = stages.findLast(row => row.stage === 'PHYSICAL_POSTVERIFY_COMPLETE');
  assert.equal(ready.transactionEstablished && ready.grantIssued && nativeResult.published && postverify.grantConsumed,
    true, 'D_WIDE_GRANT_OR_POSTVERIFY_UNPROVEN');
  const owned = audit.filter(row => row.kind === 'owned_execution');
  const baseline = fixedScopeBaselineEvidence(await runValidationCommand(ownedWindowsHelper(), ['--scope-recovery-status'], { cwd: sourceRoot }));
  const graph = createOwnedProcessGraphEvidence({ childIdentity: identity, childExitStatus: exit, childAlive: false,
    stdoutDrained, stderrDrained, executions: owned, stages, baseline });
  assert.equal(graph.status, 'PASS', 'D_WIDE_OWNED_GRAPH_UNVERIFIED');
  assert.equal(graph.ownedResidualProcesses, 0);
  const receipt = { operation: step.operation, journalVersion: step.journalVersion,
    transactionId: publication[0].transactionId, status: 'PASS', readback: 'PASS', journalPhase: journal.phase };
  const expected = expectedStatus[index].slice().sort();
  const actual = git(allocation.worktree, ['status', '--porcelain']).trimEnd().split('\n').filter(Boolean).sort();
  assert.deepEqual(actual, expected, 'D_WIDE_UNEXPECTED_WORKTREE_DELTA');
  // The real controller publication and physical verification have already
  // completed. This commit only gives the next independent task a clean,
  // content-identical base; it is never credited as Phi publication.
  git(allocation.worktree, ['add', '-A']);
  git(allocation.worktree, ['-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', `accepted fixture prefix ${index + 1}`]);
  assert.equal(git(allocation.worktree, ['status', '--porcelain']).trim(), '');
  current = allocation.worktree;
  summary.operations.push({ operation: step.operation, journalVersion: step.journalVersion,
    transactionId: receipt.transactionId, taskDigest: details.taskDigest, normalTool: true,
    trustedUserShape: 'PASS', freshPrestate: `PREFIX_${index}`, poststate: `PREFIX_${index + 1}`,
    workerRevokedBeforePublication: true, grantConsumed: true,
    localModelTurns: turns.length, fixtureModels: [...new Set(turns.map(row => row.model))].sort(),
    receiptReadback: 'PASS', physicalPostverify: 'PASS',
    graph: graph.status, ownedResidualProcesses: 0 });
  summary.prefix = `PREFIX_${index + 1}`;
  summary.inFlight = null;
  return { status: 'PASS', receipt };
}

try {
  setupFixture();
  const receipts = [];
  const result = await runDSequence({ inspect: async completed => classifyDPrefix({ projectRoot: current,
    created: 'created-state', modified: 'modified-state', receipts: completed }),
  invoke: async (step, index) => {
    const output = await runNormalStep(step, index);
    if (output.status === 'PASS') receipts.push(output.receipt);
    return output;
  } });
  assert.equal(result.status, 'PASS', `D_WIDE_SEQUENCE_${result.reason ?? 'FAILED'}`);
  assert.equal(receipts.length, 4);
  assert.equal(summary.operations.length, 4);
  assert.equal(summary.prefix, 'PREFIX_4');
  summary.status = 'PASS';
} catch (error) {
  summary.failure = error instanceof Error ? error.message.slice(0, 160) : 'UNKNOWN';
} finally {
  if (child?.exitCode === null) {
    child.kill();
    if (childClosed) await Promise.race([childClosed, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  let cleanup = 'PASS';
  if (childIdentity && inspectProcessIdentity(childIdentity).alive !== false) cleanup = 'FAIL';
  for (let index = 0; index < 4; index++) {
    const stepRoot = path.join(temp, `step-${index + 1}`);
    const roots = { shareRoot: path.join(stepRoot, 'worktrees'), stateRoot: path.join(stepRoot, 'runtime') };
    if (!fs.existsSync(roots.stateRoot)) continue;
    try {
      for (const allocation of listRuntimeAllocations(roots))
        if (!retained.some(entry => entry.allocation.allocationId === allocation.allocationId))
          retained.push({ allocation, source: allocation.repo, stepRoot });
    } catch { cleanup = 'FAIL'; }
  }
  if (summary.status === 'FAIL' && activeStepIndex >= 0) {
    const stepRoot = path.join(temp, `step-${activeStepIndex + 1}`);
    const auditFile = path.join(stepRoot, 'provider-audit.jsonl');
    let lastStage = 'UNKNOWN';
    try {
      const rows = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      lastStage = rows.filter(row => row.kind === 'create_stage').at(-1)?.stage ?? 'UNKNOWN';
    } catch { /* No stage evidence is not a passing stage. */ }
    const active = retained.find(entry => entry.stepRoot === stepRoot);
    let physical = 'UNKNOWN', journal = 'UNKNOWN';
    if (active && fs.existsSync(active.allocation.worktree)) {
      const root = active.allocation.worktree;
      const observe = name => {
        try {
          const file = path.join(root, name), stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink()) return 'INVALID';
          const value = fs.readFileSync(file, 'utf8');
          return value === 'created-state' ? 'CREATED' : value === 'modified-state' ? 'MODIFIED' : 'OTHER';
        } catch (error) { return error?.code === 'ENOENT' ? 'ABSENT' : 'UNKNOWN'; }
      };
      physical = { a: observe('a.txt'), b: observe('b.txt') };
      try {
        const discovery = discoverWindowsTransactions({ cwd: root });
        journal = discovery.entries.map(entry => ({ version: entry.journalVersion, phase: entry.phase,
          classification: entry.classification }));
      } catch { /* Unknown journal is never accepted. */ }
    }
    summary.failureEvidence = { lastStage, physical, journal, receipt: summary.operations.length === activeStepIndex ? 'NOT_PROVEN' : 'UNKNOWN' };
  }
  for (const entry of retained.reverse()) {
    try {
      const { allocation, source } = entry;
      assert.ok(underOwnedTemp(allocation.worktree) && underOwnedTemp(source) &&
        /^pi-overdrive\/auto-[0-9a-f]{12}$/u.test(allocation.branch), 'D_WIDE_CLEANUP_OWNERSHIP_UNKNOWN');
      assertUniqueManagedWorktreeRecord(git(source, ['worktree', 'list', '--porcelain', '-z']),
        allocation.worktree, allocation.branch);
      git(source, ['worktree', 'remove', '--force', allocation.worktree]);
      git(source, ['branch', '-D', allocation.branch]);
      assert.equal(fs.existsSync(allocation.worktree), false);
    } catch { cleanup = 'FAIL'; }
  }
  if (cleanup === 'PASS') {
    try {
      assert.equal(git(project, ['worktree', 'list', '--porcelain']).includes('auto-'), false);
      assert.equal(git(project, ['rev-parse', 'HEAD']).trim(), initialHead);
      assert.equal(git(project, ['status', '--porcelain']).trim(), '');
    }
    catch { cleanup = 'FAIL'; }
  }
  try {
    const observed = await runValidationCommand(ownedWindowsHelper(), ['--scope-recovery-status'], { cwd: sourceRoot });
    const baseline = fixedScopeBaselineEvidence(observed);
    if (baseline.status !== 'PASS' || baseline.owner?.residualOwnedProcesses !== 0) cleanup = 'FAIL';
  } catch { cleanup = 'FAIL'; }
  if (childIdentity && inspectProcessIdentity(childIdentity).alive !== false) cleanup = 'FAIL';
  if (cleanup === 'PASS') {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { cleanup = 'FAIL'; }
    if (fs.existsSync(temp)) cleanup = 'FAIL';
  }
  summary.cleanup = cleanup;
  if (cleanup !== 'PASS') summary.status = 'FAIL';
  summary.residualOwnedProcesses = cleanup === 'PASS' && summary.status === 'PASS' &&
    summary.operations.length === 4 && summary.operations.every(row => row.ownedResidualProcesses === 0) ? 0 : null;
}
console.log(JSON.stringify(summary));
process.exitCode = summary.status === 'PASS' ? 0 : 1;
