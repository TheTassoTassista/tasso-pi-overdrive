#!/usr/bin/env node
// Offline normal Pi tool entrypoint, deterministic local model transport only.
// On Windows this exercises the selected real bounded ordinary publication lane.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';
import { readEvidenceReceipt } from '../lib/workflow-evidence.mjs';
import { captureProcessIdentity, inspectProcessIdentity } from '../lib/process-identity.mjs';
import { createOwnedProcessGraphEvidence, fixedScopeBaselineEvidence } from '../lib/phi-certification-evidence.mjs';
import { runValidationCommand } from '../platform/windows/validation-process.mjs';
import { ownedWindowsHelper } from '../platform/windows/process.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = process.env.PHI_WORKER_TEST_PI_ROOT ?? discoverPiRuntime()?.root;
const subagentRoot = process.env.PHI_WORKER_TEST_SUBAGENT_ROOT ?? path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
if (!runtimeRoot || !fs.existsSync(path.join(subagentRoot, 'index.ts'))) throw new Error('PHI_BOUNDED_TEST_RUNTIME_MISSING');
const piManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
const subagentManifest = JSON.parse(fs.readFileSync(path.join(subagentRoot, 'package.json'), 'utf8'));
assert.equal(piManifest.version, '0.87.1');
assert.equal(subagentManifest.version, '0.66.0');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-bounded-normal-pi-'));
const project = path.join(temp, 'project');
const agentDir = path.join(temp, 'agent');
const auditFile = path.join(temp, 'provider-audit.jsonl');
const evidenceRoot = path.join(temp, 'evidence');
const fixtureProvider = path.join(sourceRoot, 'tests', 'fixtures', 'deterministic-phi-publication-provider.ts');
const e1 = process.argv[2] === '--e1';
const candidateSha = e1 ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, shell: false, encoding: 'utf8' }).stdout.trim() : null;
if (e1) assert.match(candidateSha, /^[0-9a-f]{40}$/u, 'E1 candidate SHA unavailable');
const operation = e1 ? 'MODIFY' : { '--modify': 'MODIFY', '--delete': 'DELETE', '--rename': 'RENAME' }[process.argv[2]] ?? 'CREATE';
if (process.argv.length > 3 || process.argv[2] && !['--modify', '--delete', '--rename', '--e1'].includes(process.argv[2])) throw new Error('PHI_BOUNDED_TEST_OPERATION_INVALID');
const task = e1 ? 'Modify file `calc.js` to contain a correct add implementation so the existing failing tests pass without changing them.' : { CREATE: 'Create file `created.txt` containing new-create-fixture',
  MODIFY: 'Modify file `input.txt` to contain new-modify-fixture', DELETE: 'Delete file `remove.txt`',
  RENAME: 'Rename file `move.txt` to `moved.txt`' }[operation];
const target = e1 ? 'calc.js' : { CREATE: 'created.txt', MODIFY: 'input.txt', DELETE: 'remove.txt', RENAME: 'moved.txt' }[operation];
const version = { CREATE: 6, MODIFY: 2, DELETE: 3, RENAME: 4 }[operation];
let report = { status: 'FAIL', platform: process.platform, normalTool: false, externalRequests: 0,
  ...(e1 ? { candidateSha, scenarioId: 'CAMPAIGN3_E1_SOURCE_REPAIR', modelBackend: 'DETERMINISTIC_LOCAL',
    productionEntrypoint: 'secure_coding_workflow' } : {}) };
let child;
let childClosed;
let childExitStatus = null;
let childIdentity = null;
let stdoutDrained = false;
let stderrDrained = false;
let receiptReadback = null;
let ownedGraph = null;
let ownedScopeBaseline = null;
try {
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(agentDir, 'extensions', 'subagent'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}', { mode: 0o600 });
  fs.copyFileSync(path.join(sourceRoot, 'config', 'subagents.json'), path.join(agentDir, 'extensions', 'subagent', 'config.json'));
  const childExtensions = [fixtureProvider, 'safety.ts', 'windows-worker.ts', 'safe-exec.ts', 'lsp.ts', 'verification-gate.ts']
    .map((entry, index) => index === 0 ? entry : path.join(sourceRoot, 'extensions', entry))
    .map(file => file.replaceAll('\\', '/'));
  const workerDefinition = [
    '---', 'name: worker', 'description: Offline bounded-publication Worker fixture.',
    'tools: read, safe_exec, semantic_nav, verification_gate',
    'mutationTools: safe_exec',
    `subagentOnlyExtensions: ${childExtensions.join(', ')}`,
    'defaultContext: fresh', 'acceptanceRole: writer', 'permission:', '  edit: allow', '  write: allow',
    'inheritGlobalContext: false', 'inheritProjectContext: false', 'inheritSkills: false',
    'async: false', '---', 'Use only the offered tools for the exact assigned fixture. Never edit the host project directly.', '',
  ].join('\n');
  fs.writeFileSync(path.join(agentDir, 'agents', 'worker.md'), workerDefinition, { mode: 0o600 });
  const scoutDefinition = [
    '---', 'name: scout', 'description: Read-only offline bounded-publication Scout fixture.',
    'tools: read, grep, find, ls', `subagentOnlyExtensions: ${fixtureProvider.replaceAll('\\', '/')}`,
    'defaultContext: fresh', 'acceptanceRole: read-only', 'permission:', '  edit: deny', '  write: deny',
    'inheritGlobalContext: false', 'inheritProjectContext: false', 'inheritSkills: false',
    'async: false', '---', 'Inspect only the assigned fixture; never mutate it.', '',
  ].join('\n');
  fs.writeFileSync(path.join(agentDir, 'agents', 'scout.md'), scoutDefinition, { mode: 0o600 });
  if (!e1) fs.writeFileSync(path.join(project, 'config.json'), '{}');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node test.cjs' } }));
  if (e1) {
    fs.writeFileSync(path.join(project, 'calc.js'), 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n');
    fs.writeFileSync(path.join(project, 'edit.cjs'), [
      "const fs = require('node:fs');",
      "const [file, oldText, newText] = process.argv.slice(2);",
      "if (!file || !oldText || newText === undefined || oldText === newText) throw new Error('EDIT_INPUT_INVALID');",
      "const before = fs.readFileSync(file, 'utf8');",
      "if (before.split(oldText).length !== 2) throw new Error('EDIT_NOT_UNIQUE');",
      "fs.writeFileSync(file, before.replace(oldText, newText));",
      "console.log('one-exact-replacement-in-private-draft');",
    ].join('\n'));
    fs.writeFileSync(path.join(project, 'test.cjs'), [
      "const assert = require('node:assert/strict');",
      "const { add } = require('./calc.js');",
      "assert.equal(add(2, 3), 5);",
      "assert.equal(add(-2, 3), 1);",
      "console.log('verified');",
    ].join('\n'));
    const failing = spawnSync(process.execPath, ['test.cjs'], { cwd: project, shell: false, windowsHide: true, encoding: 'utf8' });
    assert.notEqual(failing.status, 0, 'E1 fixture test must fail before autonomous work');
    report.e1InitialTest = 'FAIL_EXPECTED';
  } else {
    if (operation === 'MODIFY') fs.writeFileSync(path.join(project, 'input.txt'), 'old-modify-fixture');
    if (operation === 'DELETE') fs.writeFileSync(path.join(project, 'remove.txt'), 'old-delete-fixture');
    if (operation === 'RENAME') fs.writeFileSync(path.join(project, 'move.txt'), 'old-rename-fixture');
    fs.writeFileSync(path.join(project, 'edit.cjs'), {
      CREATE: "require('node:fs').writeFileSync('created.txt','new-create-fixture',{flag:'wx'});console.log('created-in-private-draft')",
      MODIFY: "require('node:fs').writeFileSync('input.txt','new-modify-fixture');console.log('modified-in-private-draft')",
      DELETE: "require('node:fs').unlinkSync('remove.txt');console.log('removed-in-private-draft')",
      RENAME: "const f=require('node:fs');f.writeFileSync('moved.txt',f.readFileSync('move.txt'),{flag:'wx'});f.unlinkSync('move.txt');console.log('renamed-in-private-draft')",
    }[operation]);
    fs.writeFileSync(path.join(project, 'test.cjs'), {
      CREATE: "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('created.txt','utf8'),'new-create-fixture');console.log('verified')",
      MODIFY: "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('input.txt','utf8'),'new-modify-fixture');console.log('verified')",
      DELETE: "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.existsSync('remove.txt'),false);console.log('verified')",
      RENAME: "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.existsSync('move.txt'),false);a.equal(f.readFileSync('moved.txt','utf8'),'old-rename-fixture');console.log('verified')",
    }[operation]);
  }
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'baseline']]) {
    const run = spawnSync('git', args, { cwd: project, shell: false, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  }
  const piEntry = path.join(runtimeRoot, piManifest.bin.pi);
  const args = [piEntry, '-ne', '--offline', '--approve', '--no-session', '--mode', 'rpc',
    '--extension', fixtureProvider, '--extension', path.join(subagentRoot, 'index.ts'),
    '--extension', path.join(sourceRoot, 'extensions', 'secure-workflow.ts'),
    '--provider', 'openai-codex', '--model', 'gpt-6-luna', '--api-key', 'offline-fixture-not-a-credential',
    '--tools', 'secure_coding_workflow'];
  child = spawn(process.execPath, args, { cwd: project, shell: false, windowsHide: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PHI_BOUNDED_TEST_KEY: 'offline-fixture-not-a-credential',
      PHI_BOUNDED_TEST_AUDIT: auditFile, ...(e1 ? { PHI_CAMPAIGN3_E1: '1' } : {}), PI_OVERDRIVE_EVIDENCE_ROOT: evidenceRoot,
      PI_OVERDRIVE_RUNTIME_ROOT: path.join(temp, 'runtime'), PI_OVERDRIVE_WORKTREE_ROOT: path.join(temp, 'worktrees'),
      PI_OVERDRIVE_MEMORY_ROOT: path.join(temp, 'memory'), PI_OVERDRIVE_CLEANUP_WORKFLOW: '1',
      XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_STATE_HOME: path.join(temp, 'state'),
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  childClosed = new Promise(resolve => child.once('close', code => resolve(code)));
  const events = [];
  let stdoutBuffer = '', stderr = '';
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString('utf8');
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { events.push({ type: 'invalid_json' }); }
    }
  });
  child.stdout.once('end', () => { stdoutDrained = true; });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
  child.stderr.once('end', () => { stderrDrained = true; });
  childIdentity = captureProcessIdentity(child.pid);
  child.stdin.write(`${JSON.stringify({ id: 'bounded', type: 'prompt', message: task })}\n`);
  const started = Date.now();
  while (!events.some(event => event.type === 'agent_settled') && child.exitCode === null && Date.now() - started < 10 * 60 * 1000)
    await new Promise(resolve => setTimeout(resolve, 50));
  if (!events.some(event => event.type === 'agent_settled')) throw new Error(e1 ? 'PHI_BOUNDED_TEST_NOT_SETTLED' : `PHI_BOUNDED_TEST_NOT_SETTLED:${stderr}`);
  child.stdin.end();
  const exit = await Promise.race([childClosed, new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 10000))]);
  childExitStatus = exit;
  if (exit === 'TIMEOUT') { child.kill(); throw new Error('PHI_BOUNDED_TEST_CHILD_SHUTDOWN_TIMEOUT'); }
  const tool = events.findLast(event => event.type === 'tool_execution_end' && event.toolName === 'secure_coding_workflow');
  const details = tool?.result?.details;
  let durable;
  let durableError = null;
  if (!details?.evidence && tool) {
    try {
      const failure = JSON.parse(tool.result?.content?.find(part => part.type === 'text')?.text ?? '{}');
      if (failure.runId) durable = readEvidenceReceipt({ root: evidenceRoot, runId: failure.runId });
    } catch (error) { durableError = error instanceof Error ? error.message : String(error); }
  }
  const auditRows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const turns = auditRows.filter(row => row.kind === 'local_model_turn');
  const stages = auditRows.filter(row => row.kind === 'create_stage');
  const ownedExecutions = auditRows.filter(row => row.kind === 'owned_execution');
  const userShape = auditRows.find(row => row.kind === 'controller_user_shape');
  const publications = details?.evidence?.publications ?? [];
  const expectedPublished = process.platform === 'win32';
  const cleanup = details?.cleanup;
  report.diagnostics = { toolError: tool?.isError ?? null, workflowStatus: details?.status ?? durable?.receipt?.status ?? null,
    durableError, evidenceRuns: fs.existsSync(evidenceRoot) ? fs.readdirSync(evidenceRoot).length : 0,
    toolText: e1 ? null : tool?.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 1200) ?? null,
    failure: e1 ? (details?.failure?.category ?? durable?.execution?.failure?.category ?? null) : details?.failure ?? durable?.execution?.failure ?? null,
    attempts: (details?.delegationAttempts ?? durable?.execution?.delegationAttempts ?? []).map(({ agent, status, failureCategory, failureReason, errorDigest, exitCode, launchStatus, modelCalls }) => ({ agent, status, failureCategory, failureReason: e1 ? null : failureReason, errorDigest, exitCode, launchStatus, modelCalls })),
    lastTransition: e1 ? null : durable?.execution?.evidence?.transitions?.at(-1) ?? null,
    turns, stages, userShape, eventTypes: events.map(event => event.type).slice(-12),
    stderr: e1 ? { present: stderr.length > 0, sha256: stderr ? createHash('sha256').update(stderr).digest('hex') : null } : stderr };
  assert.ok(tool, e1 ? 'normal secure_coding_workflow did not run' : `normal secure_coding_workflow did not run: ${stderr}`);
  assert.equal(tool.isError, false, 'normal workflow tool failed');
  assert.equal(details.status, 'PASS');
  assert.equal(cleanup?.status, 'PASS');
  assert.equal(cleanup?.resourcesAbsent, true, 'disposable worktree/runtime resources remain');
  assert.equal(childExitStatus, 0, 'Pi RPC child did not exit successfully');
  assert.equal(stdoutDrained && stderrDrained, true, 'Pi RPC pipes did not drain');
  assert.equal(inspectProcessIdentity(childIdentity).alive, false, 'Pi RPC child remains alive');
  const finalEvidence = readEvidenceReceipt({ root: evidenceRoot, runId: details.runId, taskDigest: details.taskDigest });
  assert.equal(finalEvidence.receipt.status, 'PASS');
  assert.equal(finalEvidence.receipt.runId, details.runId);
  assert.equal(finalEvidence.receipt.taskDigest, details.taskDigest);
  assert.equal(finalEvidence.execution.runId, details.runId);
  assert.equal(finalEvidence.execution.taskDigest, details.taskDigest);
  assert.equal(finalEvidence.execution.status, 'PASS');
  assert.equal(finalEvidence.receipt.executionStatus, 'PASS');
  assert.equal(finalEvidence.receipt.cleanupStatus, 'PASS');
  assert.equal(finalEvidence.receipt.evidenceStatus, 'PASS');
  assert.equal(finalEvidence.receipt.finalVerdict?.run_id, details.runId);
  assert.equal(finalEvidence.receipt.finalVerdict?.task_id, details.taskDigest);
  assert.equal(finalEvidence.receipt.finalVerdict?.status, 'PASS');
  assert.equal(finalEvidence.receipt.finalVerdict?.cleanup_status, 'PASS');
  assert.deepEqual(finalEvidence.receipt.evidence?.publications, finalEvidence.execution.evidence?.publications);
  assert.deepEqual(finalEvidence.receipt.evidence?.publications, publications);
  if (process.platform === 'win32') {
    assert.equal(finalEvidence.receipt.evidence.publications.length, 1);
    assert.match(finalEvidence.receipt.evidence.publications[0].transactionId, /^[0-9a-f]{32}$/u);
  }
  receiptReadback = { schema: 'PASS', protectedAcl: 'PASS', terminal: 'PASS', binding: 'PASS' };
  report.receiptReadback = receiptReadback;
  assert.equal(turns.every(turn => turn.provider === 'openai-codex'), true);
  assert.deepEqual({ branchArray: userShape?.branchArray, singleText: userShape?.singleText, exactTaskMatch: userShape?.exactTaskMatch },
    { branchArray: true, singleText: true, exactTaskMatch: true });
  if (e1) {
    const decision = auditRows.find(row => row.kind === 'e1_repair_decision');
    assert.deepEqual({ assertions: decision?.assertionCount, source: decision?.sourceObserved, test: decision?.testObserved },
      { assertions: 2, source: true, test: true }, 'Worker did not derive its repair from observed source and tests');
    assert.deepEqual(details.repositoryEvidence?.changedFiles?.map(row => row.path), ['calc.js'], 'E1 must change only source, never the test or editor');
    assert.equal(details.evidence?.verifications?.at(-1)?.status, 'PASS', 'production verification did not pass');
    assert.equal(details.evidence?.roles?.some(row => row.agent === 'worker' && row.status === 'completed'), true);
    assert.equal(details.evidence?.verifications?.length > 0, true);
    report.e1 = { initialTest: 'FAIL_EXPECTED', sourceCorrection: 'DERIVED_FROM_OBSERVED_ASSERTIONS',
      sourceOnlyChange: true, finalProductionVerification: 'PASS', testUnchanged: true };
  }
  assert.ok(turns.some(turn => turn.lane === 'controller'));
  assert.ok(turns.some(turn => turn.lane === 'worker'));
  assert.equal(publications.length, expectedPublished ? 1 : 0);
  if (expectedPublished) {
    assert.equal(publications[0].operation, operation);
    assert.equal(publications[0].journalVersion, version);
    assert.match(publications[0].intentDigest, /^[0-9a-f]{64}$/u);
    const names = stages.map(row => row.stage);
    const required = ['WORKFLOW_ADMITTED', 'EVIDENCE_RUN_CREATED', 'JOURNAL_CREATED', 'RUNTIME_ALLOCATED',
      'ENVELOPE_ESTABLISHED', 'WORKER_RESERVED', 'WORKER_RESULT', 'WORKER_REVOKED',
      'CONTROLLER_VALIDATION_START', operation === 'CREATE' ? 'CREATE_INTENT_AND_V6_READY' : 'OPERATION_INTENT_READY', 'NATIVE_PUBLICATION_CALL_ENTERED',
      'NATIVE_RESULT_OBSERVED', 'PHYSICAL_POSTVERIFY_COMPLETE', 'PRE_CLEANUP_PHYSICAL_SNAPSHOT',
      'FINAL_RECEIPT_WRITTEN', 'TERMINAL_STATUS_COMMITTED'];
    let previous = -1;
    for (const name of required) {
      const index = names.indexOf(name, previous + 1);
      assert.ok(index > previous, `required ${operation} stage missing or unordered: ${name}`);
      previous = index;
    }
    const physical = stages.findLast(row => row.stage === 'PRE_CLEANUP_PHYSICAL_SNAPSHOT');
    const ready = stages.findLast(row => row.stage === (operation === 'CREATE' ? 'CREATE_INTENT_AND_V6_READY' : 'OPERATION_INTENT_READY'));
    const nativeResult = stages.findLast(row => row.stage === 'NATIVE_RESULT_OBSERVED');
    const postverify = stages.findLast(row => row.stage === 'PHYSICAL_POSTVERIFY_COMPLETE');
    assert.deepEqual({ targetState: physical.targetState, digestMatch: physical.digestMatch,
      identityMatch: physical.identityMatch, v6Phase: physical.v6Phase,
      v6Observed: physical.v6Observed, transactionEstablished: ready.transactionEstablished,
      grantIssued: ready.grantIssued, published: nativeResult.published,
      grantConsumed: postverify.grantConsumed },
    { targetState: operation === 'DELETE' ? 'ABSENT' : 'PRESENT', digestMatch: operation === 'DELETE' ? null : true,
      identityMatch: operation === 'DELETE' ? null : true, v6Phase: 'CLEANED',
      v6Observed: { CREATE: 'NEW_COMPLETE_OBSERVED', MODIFY: 'NEW_COMPLETE_OBSERVED',
        DELETE: 'DELETE_COMMITTED_CLEANUP_OBSERVED', RENAME: 'RENAME_COMMITTED_DESTINATION_RETAINED' }[operation],
      transactionEstablished: true,
      grantIssued: true, published: true, grantConsumed: true });
  }
  assert.equal(operation === 'CREATE' || operation === 'RENAME' ? fs.existsSync(path.join(project, target)) === false :
    fs.readFileSync(path.join(project, target), 'utf8') === (e1 ? 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n' : operation === 'DELETE' ? 'old-delete-fixture' : 'old-modify-fixture'),
  true, 'original Git project must remain untouched');
  if (operation === 'RENAME') assert.equal(fs.readFileSync(path.join(project, 'move.txt'), 'utf8'), 'old-rename-fixture');
  if (process.platform === 'win32') {
    let baseline = { status: 'UNKNOWN' };
    try {
      const observed = await runValidationCommand(ownedWindowsHelper(), ['--scope-recovery-status'], { cwd: sourceRoot });
      baseline = fixedScopeBaselineEvidence(observed);
    } catch { /* The graph reports BASELINE_MISMATCH; no recovery action is taken. */ }
    ownedScopeBaseline = baseline;
    report.ownedScopeBaseline = baseline;
    ownedGraph = createOwnedProcessGraphEvidence({ childIdentity, childExitStatus, childAlive: inspectProcessIdentity(childIdentity).alive,
      stdoutDrained, stderrDrained, executions: ownedExecutions, stages, baseline });
    report.ownedExecution = { count: ownedExecutions.length, ...ownedGraph };
    assert.equal(ownedGraph.status, 'PASS', `Phi-owned process graph cleanup is unverified: ${ownedGraph.reason}`);
  }
  report = { status: 'PASS', platform: process.platform, normalTool: true, workflowStatus: details.status,
    workerCalls: turns.filter(turn => turn.lane === 'worker').length, controllerCalls: turns.filter(turn => turn.lane === 'controller').length,
    publicationCount: publications.length, publicationOperation: publications[0]?.operation ?? null,
    journalVersion: publications[0]?.journalVersion ?? null, cleanup: cleanup?.status, externalRequests: 0 };
  if (e1) report.e1 = { initialTest: 'FAIL_EXPECTED', sourceCorrection: 'DERIVED_FROM_OBSERVED_ASSERTIONS',
    sourceOnlyChange: true, finalProductionVerification: 'PASS', testUnchanged: true,
    candidateSha, scenarioId: 'CAMPAIGN3_E1_SOURCE_REPAIR', taskId: details.taskDigest,
    productionEntrypoint: 'secure_coding_workflow', modelBackend: 'DETERMINISTIC_LOCAL',
    selectedRoutes: details.evidence.roles.filter(row => row.status === 'completed').map(({ agent, provider, model, thinking }) => ({ agent, provider, model, thinking })),
    externalProviderRequests: 0,
    roleLifecycle: details.evidence.roles.map(({ agent, status }) => ({ agent, status })),
    workerAuthority: { started: stages.some(row => row.stage === 'WORKER_RESERVED'),
      revokedBeforePublication: stages.findIndex(row => row.stage === 'WORKER_REVOKED') < stages.findIndex(row => row.stage === 'NATIVE_PUBLICATION_CALL_ENTERED') },
    transactionId: publications[0]?.transactionId ?? null,
    physicalMutation: publications.length === 1 ? { operation: publications[0].operation,
      targetState: stages.findLast(row => row.stage === 'PRE_CLEANUP_PHYSICAL_SNAPSHOT')?.targetState ?? null,
      digestMatch: stages.findLast(row => row.stage === 'PRE_CLEANUP_PHYSICAL_SNAPSHOT')?.digestMatch ?? null } : null,
    receiptStatus: finalEvidence.receipt.status };
  report.receiptReadback = receiptReadback;
  report.ownedScopeBaseline = ownedScopeBaseline;
  report.ownedExecution = process.platform === 'win32' ? { count: ownedExecutions.length, profiles: [...new Set(ownedExecutions.map(row => row.profile))].sort(),
    ...ownedGraph } : { status: 'NOT_NATIVE_WINDOWS' };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report.failure = e1 ? { category: /^PHI_[A-Z_]+/u.exec(message)?.[0] ?? 'E1_ASSERTION_OR_RUNTIME_FAILURE',
    digest: createHash('sha256').update(message).digest('hex') } : message;
} finally {
  try {
    if (child && child.exitCode === null) child.kill();
    if (childClosed) childExitStatus ??= await Promise.race([childClosed, new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 5000))]);
  } catch { report.status = 'FAIL'; }
  try {
    const diagnosticRows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }) : [];
    const runIds = fs.existsSync(evidenceRoot) ? fs.readdirSync(evidenceRoot).filter(name => /^[0-9a-f-]{36}$/u.test(name)) : [];
    const runDirectory = runIds.length === 1 ? path.join(evidenceRoot, runIds[0]) : null;
    const category = value => typeof value === 'string' && /^[A-Z_]{3,40}$/u.test(value) ? value : null;
    let journal = null;
    const stateFile = runDirectory ? path.join(runDirectory, process.platform === 'win32' ? 'state.win-v1.json' : 'state.json') : null;
    if (stateFile && fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        journal = { status: category(state.status), phase: category(state.current_phase), workflowStatus: category(state.workflow_status),
          workerStatus: category(state.worker_status), evidenceStatus: category(state.evidence_status), cleanupStatus: category(state.cleanup_status) };
      } catch { journal = { status: 'UNREADABLE' }; }
    }
    const childAlive = childIdentity ? inspectProcessIdentity(childIdentity).alive : null;
    report.preFixtureCleanup = { childClosed: childExitStatus !== 'TIMEOUT' && childExitStatus !== null, childExitStatus,
      childAlive, piPipesDrained: stdoutDrained && stderrDrained, receiptReadback,
      originalTargetExists: fs.existsSync(path.join(project, target)),
      evidenceRunCount: runIds.length, journal, executionExists: Boolean(runDirectory && fs.existsSync(path.join(runDirectory, 'execution.json'))),
      receiptExists: Boolean(runDirectory && fs.existsSync(path.join(runDirectory, 'receipt.json'))),
      stages: diagnosticRows.filter(row => row.kind === 'create_stage').slice(-64),
      runtimeRootExists: fs.existsSync(path.join(temp, 'runtime')), worktreeRootExists: fs.existsSync(path.join(temp, 'worktrees')),
      trackedResidualProcesses: ownedGraph?.ownedResidualProcesses ?? null,
      ownedResidualProcesses: ownedGraph?.ownedResidualProcesses ?? null,
      jobEmptyVerified: report.ownedExecution?.jobsEmpty ?? null, pipesDrained: stdoutDrained && stderrDrained };
    if (childAlive !== false || !stdoutDrained || !stderrDrained ||
      process.platform === 'win32' && report.preFixtureCleanup.ownedResidualProcesses !== 0)
      report.status = 'FAIL';
  } catch { report.status = 'FAIL'; report.preFixtureCleanup = { status: 'UNKNOWN', childClosed: childExitStatus !== 'TIMEOUT' && childExitStatus !== null }; }
  try { fs.rmSync(temp, { recursive: true, force: true }); }
  catch { report.status = 'FAIL'; report.fixtureRemoval = 'FAIL'; }
  report.temporaryRemoved = !fs.existsSync(temp);
  if (!report.temporaryRemoved) report.status = 'FAIL';
}
console.log(JSON.stringify(report));
process.exitCode = report.status === 'PASS' ? 0 : 1;
