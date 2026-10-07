#!/usr/bin/env node
// Offline normal Pi tool entrypoint, deterministic local model transport only.
// On Windows this must exercise the real bounded Worker/V6 publication lane.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';
import { readEvidenceReceipt } from '../lib/workflow-evidence.mjs';

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
const task = 'Create file `created.txt` containing new-create-fixture';
let report = { status: 'FAIL', platform: process.platform, normalTool: false, externalRequests: 0 };
let child;
let childClosed;
let childExitStatus = null;
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
    'async: false', '---', 'Use only the offered tools for the exact assigned CREATE fixture. Never edit the host project directly.', '',
  ].join('\n');
  fs.writeFileSync(path.join(agentDir, 'agents', 'worker.md'), workerDefinition, { mode: 0o600 });
  fs.writeFileSync(path.join(project, 'config.json'), '{}');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node test.cjs' } }));
  fs.writeFileSync(path.join(project, 'edit.cjs'), "require('node:fs').writeFileSync('created.txt','new-create-fixture',{flag:'wx'});console.log('created-in-private-draft')");
  fs.writeFileSync(path.join(project, 'test.cjs'), "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.readFileSync('created.txt','utf8'),'new-create-fixture');console.log('verified')");
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
      PHI_BOUNDED_TEST_AUDIT: auditFile, PI_OVERDRIVE_EVIDENCE_ROOT: evidenceRoot,
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
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
  child.stdin.write(`${JSON.stringify({ id: 'bounded', type: 'prompt', message: task })}\n`);
  const started = Date.now();
  while (!events.some(event => event.type === 'agent_settled') && child.exitCode === null && Date.now() - started < 10 * 60 * 1000)
    await new Promise(resolve => setTimeout(resolve, 50));
  if (!events.some(event => event.type === 'agent_settled')) throw new Error(`PHI_BOUNDED_TEST_NOT_SETTLED:${stderr}`);
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
  const userShape = auditRows.find(row => row.kind === 'controller_user_shape');
  const publications = details?.evidence?.publications ?? [];
  const expectedPublished = process.platform === 'win32';
  const cleanup = details?.cleanup;
  report.diagnostics = { toolError: tool?.isError ?? null, workflowStatus: details?.status ?? durable?.receipt?.status ?? null,
    durableError, evidenceRuns: fs.existsSync(evidenceRoot) ? fs.readdirSync(evidenceRoot).length : 0,
    toolText: tool?.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 1200) ?? null,
    failure: details?.failure ?? durable?.execution?.failure ?? null,
    attempts: (details?.delegationAttempts ?? durable?.execution?.delegationAttempts ?? []).map(({ agent, status, failureCategory, failureReason, errorDigest, exitCode, launchStatus, modelCalls }) => ({ agent, status, failureCategory, failureReason, errorDigest, exitCode, launchStatus, modelCalls })),
    lastTransition: durable?.execution?.evidence?.transitions?.at(-1) ?? null,
    turns, stages, userShape, eventTypes: events.map(event => event.type).slice(-12), stderr };
  assert.ok(tool, `normal secure_coding_workflow did not run: ${stderr}`);
  assert.equal(tool.isError, false, 'normal workflow tool failed');
  assert.equal(details.status, 'PASS');
  assert.equal(cleanup?.status, 'PASS');
  assert.equal(turns.every(turn => turn.provider === 'openai-codex'), true);
  assert.deepEqual({ branchArray: userShape?.branchArray, singleText: userShape?.singleText, exactTaskMatch: userShape?.exactTaskMatch },
    { branchArray: true, singleText: true, exactTaskMatch: true });
  assert.ok(turns.some(turn => turn.lane === 'controller'));
  assert.ok(turns.some(turn => turn.lane === 'worker'));
  assert.equal(publications.length, expectedPublished ? 1 : 0);
  if (expectedPublished) {
    assert.equal(publications[0].operation, 'CREATE');
    assert.equal(publications[0].journalVersion, 6);
    assert.match(publications[0].intentDigest, /^[0-9a-f]{64}$/u);
  }
  assert.equal(fs.existsSync(path.join(project, 'created.txt')), false, 'original Git project must remain untouched');
  report = { status: 'PASS', platform: process.platform, normalTool: true, workflowStatus: details.status,
    workerCalls: turns.filter(turn => turn.lane === 'worker').length, controllerCalls: turns.filter(turn => turn.lane === 'controller').length,
    publicationCount: publications.length, publicationOperation: publications[0]?.operation ?? null,
    journalVersion: publications[0]?.journalVersion ?? null, cleanup: cleanup?.status, externalRequests: 0 };
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
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
    report.preFixtureCleanup = { childClosed: childExitStatus !== 'TIMEOUT' && childExitStatus !== null, childExitStatus,
      originalTargetExists: fs.existsSync(path.join(project, 'created.txt')),
      evidenceRunCount: runIds.length, journal, executionExists: Boolean(runDirectory && fs.existsSync(path.join(runDirectory, 'execution.json'))),
      receiptExists: Boolean(runDirectory && fs.existsSync(path.join(runDirectory, 'receipt.json'))),
      stages: diagnosticRows.filter(row => row.kind === 'create_stage').slice(-64),
      runtimeRootExists: fs.existsSync(path.join(temp, 'runtime')), worktreeRootExists: fs.existsSync(path.join(temp, 'worktrees')),
      ownedResidualProcesses: null, jobEmptyVerified: null, pipesDrained: null };
  } catch { report.preFixtureCleanup = { status: 'UNKNOWN', childClosed: childExitStatus !== 'TIMEOUT' && childExitStatus !== null }; }
  fs.rmSync(temp, { recursive: true, force: true });
  report.temporaryRemoved = !fs.existsSync(temp);
  if (!report.temporaryRemoved) report.status = 'FAIL';
}
console.log(JSON.stringify(report));
process.exitCode = report.status === 'PASS' ? 0 : 1;
