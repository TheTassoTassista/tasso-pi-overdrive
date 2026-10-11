#!/usr/bin/env node
// Native Windows Campaign-2 fixture: four *normal* secure_coding_workflow calls.
// This script has no publication/recovery grant. Git commits only record an
// already-verified disposable worktree state as the next task's fixture base.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canReclaimDWorktreeJournal, classifyDPrefix, D_OPERATIONS, runDSequence, verifyDPrefixBridge, verifyDNextBase } from './phi-d-prefix.mjs';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';
import { readEvidenceReceipt } from '../lib/workflow-evidence.mjs';
import { captureProcessIdentity, inspectProcessIdentity } from '../lib/process-identity.mjs';
import { createOwnedProcessGraphEvidence, fixedScopeBaselineEvidence } from '../lib/phi-certification-evidence.mjs';
import { discoverWindowsTransactions } from '../platform/windows/publication.mjs';
import { assertUniqueManagedWorktreeRecord, listRuntimeAllocations } from '../lib/runtime-isolation.mjs';
import { runValidationCommand } from '../platform/windows/validation-process.mjs';
import { ownedWindowsHelper } from '../platform/windows/process.mjs';

if (process.platform !== 'win32') throw new Error('PHI_D_WIDE_REQUIRES_NATIVE_WINDOWS');
const restartMode = process.argv.length === 3 && process.argv[2] === '--restart-v2';
if (!restartMode && process.argv.length !== 2) throw new Error('PHI_D_WIDE_USAGE');
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const piRoot = process.env.PHI_WORKER_TEST_PI_ROOT ?? discoverPiRuntime()?.root;
const subagentRoot = process.env.PHI_WORKER_TEST_SUBAGENT_ROOT ?? path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
if (!piRoot || !fs.existsSync(path.join(subagentRoot, 'index.ts'))) throw new Error('PHI_D_WIDE_RUNTIME_MISSING');
const piManifest = JSON.parse(fs.readFileSync(path.join(piRoot, 'package.json'), 'utf8'));
const subagentManifest = JSON.parse(fs.readFileSync(path.join(subagentRoot, 'package.json'), 'utf8'));
assert.equal(piManifest.version, '0.87.1');
assert.equal(subagentManifest.version, '0.66.0');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), restartMode ? 'phi-d-restart-' : 'phi-d-wide-'));
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
const summary = { status: 'FAIL', runKind: restartMode ? 'D13_NORMAL_WORKFLOW_RESTART' : 'D_WIDE_NORMAL_WORKFLOW', operations: [], externalRequests: 0,
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

function piArgs() {
  return [path.join(piRoot, piManifest.bin.pi), '-ne', '--offline', '--approve', '--no-session', '--mode', 'rpc',
    '--extension', fixtureProvider, '--extension', path.join(subagentRoot, 'index.ts'),
    '--extension', path.join(sourceRoot, 'extensions', 'secure-workflow.ts'),
    '--provider', 'openai-codex', '--model', 'gpt-6-luna', '--api-key', 'offline-fixture-not-a-credential',
    '--tools', 'secure_coding_workflow'];
}
function piEnvironment(stepRoot, evidenceRoot, auditFile, extra = {}) {
  return { ...process.env, PI_CODING_AGENT_DIR: agentDir, PHI_BOUNDED_TEST_KEY: 'offline-fixture-not-a-credential',
    PHI_BOUNDED_TEST_AUDIT: auditFile, PI_OVERDRIVE_EVIDENCE_ROOT: evidenceRoot,
    PI_OVERDRIVE_RUNTIME_ROOT: path.join(stepRoot, 'runtime'), PI_OVERDRIVE_WORKTREE_ROOT: path.join(stepRoot, 'worktrees'),
    PI_OVERDRIVE_MEMORY_ROOT: path.join(stepRoot, 'memory'), PI_OVERDRIVE_CLEANUP_WORKFLOW: '0',
    XDG_CONFIG_HOME: path.join(stepRoot, 'config'), XDG_STATE_HOME: path.join(stepRoot, 'state'),
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', ...extra };
}

async function runNormalStep(step, index, completedReceipts) {
  activeStepIndex = index;
  summary.inFlight = step.operation;
  const priorHead = git(current, ['rev-parse', 'HEAD']).trim();
  const stepRoot = path.join(temp, `step-${index + 1}`);
  fs.mkdirSync(stepRoot);
  const evidenceRoot = path.join(stepRoot, 'evidence');
  const auditFile = path.join(stepRoot, 'provider-audit.jsonl');
  child = spawn(process.execPath, piArgs(), { cwd: current, shell: false, windowsHide: true,
    env: piEnvironment(stepRoot, evidenceRoot, auditFile), stdio: ['pipe', 'pipe', 'pipe'] });
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
  const candidateReceipts = [...completedReceipts, receipt];
  const uncommittedBridge = verifyDPrefixBridge({ sourceRoot: current, candidateRoot: allocation.worktree,
    priorHead, prefix: index + 1, receipts: candidateReceipts, created: 'created-state', modified: 'modified-state' });
  const expected = expectedStatus[index].slice().sort();
  const actual = git(allocation.worktree, ['status', '--porcelain']).trimEnd().split('\n').filter(Boolean).sort();
  assert.deepEqual(actual, expected, 'D_WIDE_UNEXPECTED_WORKTREE_DELTA');
  // The real controller publication and physical verification have already
  // completed. This commit only gives the next independent task a clean,
  // content-identical base; it is never credited as Phi publication.
  git(allocation.worktree, ['add', '-A']);
  git(allocation.worktree, ['-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', `accepted fixture prefix ${index + 1}`]);
  const committedBridge = verifyDPrefixBridge({ sourceRoot: current, candidateRoot: allocation.worktree,
    priorHead, prefix: index + 1, receipts: candidateReceipts, created: 'created-state', modified: 'modified-state', committed: true });
  current = allocation.worktree;
  summary.operations.push({ operation: step.operation, journalVersion: step.journalVersion,
    transactionId: receipt.transactionId, taskDigest: details.taskDigest, normalTool: true,
    trustedUserShape: 'PASS', freshPrestate: `PREFIX_${index}`, poststate: `PREFIX_${index + 1}`,
    workerRevokedBeforePublication: true, grantConsumed: true,
    localModelTurns: turns.length, fixtureModels: [...new Set(turns.map(row => row.model))].sort(),
    receiptReadback: 'PASS', physicalPostverify: 'PASS',
    bridgePrecommit: uncommittedBridge.status, bridgeCommitted: committedBridge.status,
    logicalLineage: committedBridge.lineage, unrelatedBridgeDelta: committedBridge.unrelatedDelta,
    graph: graph.status, ownedResidualProcesses: 0 });
  summary.prefix = `PREFIX_${index + 1}`;
  summary.inFlight = null;
  return { status: 'PASS', receipt };
}

async function runInterruptedModify(completedReceipts) {
  assert.equal(completedReceipts.length, 1, 'D13_CREATE_PREFIX_NOT_ACCEPTED');
  assert.equal(classifyDPrefix({ projectRoot: current, created: 'created-state', modified: 'modified-state',
    receipts: completedReceipts }).status, 'PREFIX_1');
  activeStepIndex = 1;
  summary.inFlight = 'MODIFY';
  const priorHead = git(current, ['rev-parse', 'HEAD']).trim();
  const stepRoot = path.join(temp, 'step-2');
  fs.mkdirSync(stepRoot);
  const evidenceRoot = path.join(stepRoot, 'evidence');
  const auditFile = path.join(stepRoot, 'provider-audit.jsonl');
  child = spawn(process.execPath, piArgs(), { cwd: current, shell: false, windowsHide: true,
    env: piEnvironment(stepRoot, evidenceRoot, auditFile, { PHI_D13_V2_TEMP_FAILPOINT: '1' }),
    stdio: ['pipe', 'pipe', 'pipe'] });
  childClosed = new Promise(resolve => child.once('close', code => resolve(code)));
  childIdentity = captureProcessIdentity(child.pid);
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
  child.stderr.on('data', () => {});
  child.stderr.once('end', () => { stderrDrained = true; });
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({ id: 'd13-modify', type: 'prompt', message: tasks[1] })}\n`);
  const started = Date.now();
  while (!events.some(event => event.type === 'agent_settled') && child.exitCode === null && Date.now() - started < 10 * 60 * 1000)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(events.some(event => event.type === 'agent_settled'), 'D13_PI_NOT_SETTLED');
  child.stdin.end();
  const exit = await Promise.race([childClosed, new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 10000))]);
  assert.equal(exit, 0, 'D13_PI_EXIT_OR_SHUTDOWN_FAILED');
  assert.equal(stdoutDrained && stderrDrained, true, 'D13_PI_PIPES_NOT_DRAINED');
  assert.equal(inspectProcessIdentity(childIdentity).alive, false, 'D13_PI_CHILD_REMAINS_ALIVE');
  const tool = events.findLast(event => event.type === 'tool_execution_end' && event.toolName === 'secure_coding_workflow');
  assert.ok(tool && tool.isError === true, 'D13_INTERRUPTED_WORKFLOW_DID_NOT_FAIL');
  const roots = { shareRoot: path.join(stepRoot, 'worktrees'), stateRoot: path.join(stepRoot, 'runtime') };
  const allocations = listRuntimeAllocations(roots);
  assert.equal(allocations.length, 1, 'D13_ALLOCATION_UNKNOWN');
  const allocation = allocations[0];
  assert.ok(allocation.status === 'released' && underOwnedTemp(allocation.worktree) &&
    fs.realpathSync(allocation.worktree) === allocation.worktree && !fs.existsSync(allocation.portReservation),
  'D13_ALLOCATION_NOT_SAFELY_RELEASED');
  retained.push({ allocation, source: current, stepRoot });
  const base = verifyDNextBase({ sourceRoot: current, candidateRoot: allocation.worktree, priorHead,
    prefix: 1, receipts: completedReceipts, created: 'created-state', modified: 'modified-state' });
  const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const stages = audit.filter(row => row.kind === 'create_stage');
  const names = stages.map(row => row.stage);
  const required = ['WORKFLOW_ADMITTED', 'ENVELOPE_ESTABLISHED', 'WORKER_RESULT', 'WORKER_REVOKED',
    'CONTROLLER_VALIDATION_START', 'OPERATION_INTENT_READY', 'NATIVE_PUBLICATION_CALL_ENTERED',
    'EXECUTION_THROWN', 'RUNTIME_CLEANUP_COMPLETE', 'FINAL_RECEIPT_WRITTEN', 'TERMINAL_STATUS_COMMITTED'];
  let prior = -1;
  for (const stage of required) {
    const found = names.indexOf(stage, prior + 1);
    assert.ok(found > prior, `D13_REQUIRED_STAGE_${stage}_MISSING`);
    prior = found;
  }
  assert.equal(names.includes('NATIVE_RESULT_OBSERVED') || names.includes('PHYSICAL_POSTVERIFY_COMPLETE'), false,
    'D13_INTERRUPTED_MODIFY_WAS_MISCLASSIFIED_AS_PUBLISHED');
  const ready = stages.findLast(row => row.stage === 'OPERATION_INTENT_READY');
  assert.equal(ready.transactionEstablished && ready.grantIssued, true);
  assert.equal(stages.findLast(row => row.stage === 'RUNTIME_CLEANUP_COMPLETE')?.cleanupStatus, 'RELEASED');
  assert.equal(stages.findLast(row => row.stage === 'TERMINAL_STATUS_COMMITTED')?.workflowStatus, 'FAIL');
  const evidenceRuns = fs.readdirSync(evidenceRoot);
  assert.equal(evidenceRuns.length, 1, 'D13_EVIDENCE_RUN_NOT_UNIQUE');
  const failedEvidence = readEvidenceReceipt({ root: evidenceRoot, runId: evidenceRuns[0] });
  assert.equal(failedEvidence.receipt.status, 'FAIL');
  assert.equal(failedEvidence.receipt.cleanupStatus, 'RELEASED');
  assert.equal(failedEvidence.receipt.finalVerdict?.status, 'FAIL');
  assert.deepEqual(failedEvidence.receipt.evidence?.publications ?? [], [], 'D13_FALSE_PUBLICATION_RECEIPT');
  const before = discoverWindowsTransactions({ cwd: allocation.worktree });
  assert.equal(before.entries.length, 1, 'D13_V2_JOURNAL_NOT_UNIQUE');
  const inFlight = before.entries[0];
  assert.equal(inFlight.journalVersion, 2);
  assert.equal(inFlight.phase, 'TEMP_CREATED', 'D13_FAILPOINT_NOT_DURABLE_V2_TEMP');
  assert.equal(inFlight.observedStatus, 'OLD_COMPLETE_OBSERVED');
  assert.equal(inFlight.classification, 'RECOVERY_REQUIRED');
  assert.equal(classifyDPrefix({ projectRoot: allocation.worktree, created: 'created-state',
    modified: 'modified-state', receipts: completedReceipts }).status, 'PREFIX_1');
  const restartModule = pathToFileURL(path.join(sourceRoot, 'platform', 'windows', 'startup-recovery.mjs')).href;
  const restartCode = `import { runWindowsStartupRecovery } from ${JSON.stringify(restartModule)}; console.log(JSON.stringify(runWindowsStartupRecovery({ cwd: process.cwd() })));`;
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', restartCode], {
    cwd: allocation.worktree, shell: false, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 8192 });
  assert.equal(restarted.status, 0, 'D13_FRESH_RECOVERY_PROCESS_FAILED');
  const recovery = JSON.parse(restarted.stdout);
  assert.deepEqual({ status: recovery.status, reason: recovery.reason, journalVersion: recovery.journalVersion,
    transactionId: recovery.transactionId, projectMutations: recovery.projectMutations, projectPublished: recovery.projectPublished,
    externalRequests: recovery.externalRequests },
  { status: 'PASS_RECOVERED', reason: 'ROLLBACK', journalVersion: 2, transactionId: inFlight.transactionId,
    projectMutations: 0, projectPublished: false, externalRequests: 0 });
  const after = discoverWindowsTransactions({ cwd: allocation.worktree });
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].transactionId, inFlight.transactionId);
  assert.equal(after.entries[0].phase, 'ROLLED_BACK');
  assert.equal(after.entries[0].classification, 'TERMINAL_RETAINED');
  assert.equal(classifyDPrefix({ projectRoot: allocation.worktree, created: 'created-state',
    modified: 'modified-state', receipts: completedReceipts }).status, 'PREFIX_1');
  assert.equal(fs.existsSync(path.join(allocation.worktree, 'b.txt')), false, 'D13_SUFFIX_MUTATED_B');
  assert.equal(git(allocation.worktree, ['status', '--porcelain']).trim(), '', 'D13_MODIFY_OR_SUFFIX_GIT_DELTA');
  const owned = audit.filter(row => row.kind === 'owned_execution');
  const expectedOwned = [['EDIT', 'safe-exec', 'worker'], ['LSP_READ_ONLY', 'lsp', 'worker'], ['TEST', 'verification', 'tester']];
  assert.equal(owned.length, expectedOwned.length, 'D13_OWNED_BROKER_COUNT_UNKNOWN');
  const scopes = new Set();
  for (const [profile, operation, role] of expectedOwned) {
    const matching = owned.filter(row => row.profile === profile && row.operation === operation && row.role === role);
    assert.equal(matching.length, 1, 'D13_OWNED_BROKER_ROLE_UNKNOWN');
    const row = matching[0];
    assert.ok(/^[0-9a-f]{64}$/u.test(row.scopeDigest) && !scopes.has(row.scopeDigest) && row.targetStarted === true &&
      row.jobAttested === true && row.jobEmptyVerified === true && row.brokerHelperClosed === true &&
      row.brokerPipesDrained === true && row.cleanup === 'PASS' && row.exitCode === 0 &&
      row.securityFailure === null && row.timedOut === false, 'D13_OWNED_BROKER_NOT_CLOSED');
    scopes.add(row.scopeDigest);
  }
  const baseline = fixedScopeBaselineEvidence(await runValidationCommand(ownedWindowsHelper(), ['--scope-recovery-status'], { cwd: sourceRoot }));
  assert.equal(baseline.status, 'PASS', 'D13_OWNED_BASELINE_NOT_PASS');
  assert.equal(baseline.owner?.residualOwnedProcesses, 0);
  summary.restart = { status: 'PASS', createPrefix: 'PREFIX_1', exactNextBase: base.status,
    interruptedOperation: 'MODIFY', journalVersion: 2, transactionId: inFlight.transactionId,
    failpoint: 'V2_TEMP_CREATED', phaseBefore: inFlight.phase, phaseAfter: after.entries[0].phase,
    recovery: recovery.reason, recoveryStatus: recovery.status, recoveryProjectMutations: 0,
    prefixAfter: 'PREFIX_1', suffixStarted: false, piRootClosed: true, piPipesDrained: true,
    ownedBrokersClosed: 3, ownedBaseline: baseline.status, ownedResidualProcesses: 0 };
  summary.inFlight = null;
}

try {
  setupFixture();
  const receipts = [];
  if (restartMode) {
    const create = await runNormalStep(D_OPERATIONS[0], 0, receipts);
    receipts.push(create.receipt);
    await runInterruptedModify(receipts);
    assert.equal(summary.operations.length, 1);
    assert.equal(summary.prefix, 'PREFIX_1');
  } else {
    const result = await runDSequence({ inspect: async completed => classifyDPrefix({ projectRoot: current,
      created: 'created-state', modified: 'modified-state', receipts: completed }),
    invoke: async (step, index) => {
      const output = await runNormalStep(step, index, receipts);
      if (output.status === 'PASS') receipts.push(output.receipt);
      return output;
    } });
    assert.equal(result.status, 'PASS', `D_WIDE_SEQUENCE_${result.reason ?? 'FAILED'}`);
    assert.equal(receipts.length, 4);
    assert.equal(summary.operations.length, 4);
    assert.equal(summary.prefix, 'PREFIX_4');
  }
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
      // An unresolved journal is evidence, not disposable fixture scratch.
      // Never force-remove its worktree just to make a failed gate look clean.
      const journal = discoverWindowsTransactions({ cwd: allocation.worktree });
      assert.ok(canReclaimDWorktreeJournal(journal), 'D_WIDE_UNRESOLVED_JOURNAL_RETAINED');
      assertUniqueManagedWorktreeRecord(git(source, ['worktree', 'list', '--porcelain', '-z']),
        allocation.worktree, allocation.branch);
      git(source, ['worktree', 'remove', '--force', allocation.worktree]);
      git(source, ['branch', '-D', allocation.branch]);
      assert.equal(fs.existsSync(allocation.worktree), false);
    } catch { cleanup = 'FAIL'; summary.retainedEvidenceRoot = temp; }
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
    summary.operations.length === (restartMode ? 1 : 4) && summary.operations.every(row => row.ownedResidualProcesses === 0) &&
    (!restartMode || summary.restart?.ownedResidualProcesses === 0) ? 0 : null;
}
console.log(JSON.stringify(summary));
process.exitCode = summary.status === 'PASS' ? 0 : 1;
