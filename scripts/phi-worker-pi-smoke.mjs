#!/usr/bin/env node
// Real Pi/default foreground child factory, offline deterministic provider only.
// Runtime paths select test dependencies, never a platform/security override.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';
import { resolveTaskPolicy } from '../lib/task-governor.mjs';
import { reserveWindowsWorker, registerWindowsWorkerBoundary, windowsWorkerAuthority } from '../lib/phi-worker-authority.mjs';

const root = path.resolve(import.meta.dirname, '..');
if (process.argv.slice(2).some(argument => argument !== '--revocation')) throw new Error('PHI_WORKER_TEST_USAGE');
const revokedControl = process.argv.includes('--revocation');
const runtimeRoot = process.env.PHI_WORKER_TEST_PI_ROOT ?? discoverPiRuntime()?.root;
const subagentRoot = process.env.PHI_WORKER_TEST_SUBAGENT_ROOT ?? path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
if (!runtimeRoot) throw new Error('PHI_WORKER_TEST_PI_REQUIRED');
assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'))).version, '0.87.1');
assert.equal(JSON.parse(fs.readFileSync(path.join(subagentRoot, 'package.json'))).version, '0.66.0');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-worker-real-pi-'));
const project = path.join(temporary, 'project'), agentDir = path.join(temporary, 'agent');
const savedAgentDir = process.env.PI_CODING_AGENT_DIR, savedFetch = globalThis.fetch;
let externalRequests = 0, factory, child, reservation, sessionId;
let report = { status: 'FAIL', platform: process.platform, externalProviderCalls: 0 };
try {
  fs.mkdirSync(project); fs.mkdirSync(agentDir, { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(project, 'input.txt'), 'source');
  fs.writeFileSync(path.join(project, 'run.cjs'), "const f=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');f.writeFileSync('input.txt','snapshot-edit');a.equal(f.readFileSync('input.txt','utf8'),'snapshot-edit');a.throws(()=>f.readFileSync(p.join(p.dirname(process.cwd()),'private','control.txt')),e=>['EACCES','EPERM'].includes(e.code));console.log(JSON.stringify({edited:true,denied:true,pid:process.pid}));");
  assert.equal(spawnSync('git', ['init', '--quiet', project], { shell: false }).status, 0);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.fetch = async () => { externalRequests++; throw new Error('PHI_WORKER_TEST_EXTERNAL_REQUEST_DENIED'); };
  const pi = await import(pathToFileURL(path.join(runtimeRoot, 'dist', 'index.js')).href);
  const require = createRequire(path.join(subagentRoot, 'package.json'));
  const { createJiti } = await import(pathToFileURL(require.resolve('jiti')).href);
  const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'));
  const runtimeModule = name => {
    const directory = runtimeRequire.resolve.paths(name).map(base => path.join(base, name)).find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
    assert.ok(directory, 'Required installed Pi module missing');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    assert.equal(metadata.version, '0.87.1');
    return path.join(directory, metadata.main);
  };
  const aliases = Object.fromEntries(['pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-tui'].map(name => {
    const specifier = '@earendil-works/' + name;
    return [specifier, name === 'pi-coding-agent' ? path.join(runtimeRoot, 'dist/index.js') : runtimeModule(specifier)];
  }));
  const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-ai/compat': path.join(path.dirname(aliases['@earendil-works/pi-ai']), 'compat.js'),
    '@earendil-works/pi-ai/oauth': path.join(path.dirname(aliases['@earendil-works/pi-ai']), 'oauth.js'),
    '@earendil-works/pi-ai/providers/all': path.join(path.dirname(aliases['@earendil-works/pi-ai']), 'providers/all.js'),
    '@earendil-works/pi-agent-core/node': path.join(path.dirname(aliases['@earendil-works/pi-agent-core']), 'node.js'),
    ...aliases,
  } });
  const { createDefaultChildSessionFactory } = await jiti.import(path.join(subagentRoot, 'src', 'runs', 'shared', 'child-session.ts'));
  const { runSync } = await jiti.import(path.join(subagentRoot, 'src', 'runs', 'foreground', 'execution.ts'));
  const ai = await import(pathToFileURL(runtimeModule('@earendil-works/pi-ai')).href);
  const errors = [], receipts = [];
  let turns = 0, boundEvents = 0;
  const task = 'Run run.cjs in the approved snapshot only and report its result; do not modify or publish host files';
  const parentSessionId = randomUUID(), executionId = randomUUID();
  reservation = reserveWindowsWorker({ executionId, parentSessionId, cwd: project, task,
    taskPolicy: resolveTaskPolicy({ task: 'Fix and test a bounded function in module.cjs' }) });
  factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...pi,
    // Same real Pi runtime, isolated empty auth/catalog and no network refresh.
    ModelRuntime: { create: () => pi.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(agentDir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false }) },
  }) });
  const localProvider = { name: 'phi-worker-local-provider', factory: (api) => {
    if (process.platform !== 'win32') registerWindowsWorkerBoundary(api); // Linux proves binding only, never Windows execution.
    api.on('before_agent_start', (_event, ctx) => {
      assert.ok(windowsWorkerAuthority(ctx.sessionManager.getSessionId())); boundEvents++;
    });
    api.events.on('pi-overdrive:execution-metadata', row => receipts.push(row));
    api.registerProvider('phi-worker-local', { api: 'phi-worker-local-api', baseUrl: 'http://127.0.0.1.invalid',
      apiKey: 'offline-fixture-not-a-credential', models: [{ id: 'worker', name: 'Offline Worker fixture', reasoning: false,
        input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: (model, context) => {
        if (!revokedControl) assert.ok(windowsWorkerAuthority(sessionId));
        else if (turns === 0) reservation.revoke();
        turns++;
        const stream = ai.createAssistantMessageEventStream();
        const result = context.messages.find(message => message.role === 'toolResult');
        const nativeTool = process.platform === 'win32' && !result && !revokedControl;
        const revokedWrite = revokedControl && !result;
        const message = { role: 'assistant', content: revokedWrite ? [{ type: 'toolCall', id: 'revoked-host-write', name: 'write', arguments: { path: 'input.txt', content: 'unauthorized-host-edit' } }]
          : nativeTool ? [{ type: 'toolCall', id: 'worker-native-tool', name: 'safe_exec', arguments: { program: 'node', args: ['run.cjs'] } }]
          : [{ type: 'text', text: 'SNAPSHOT_ONLY_NO_PROJECT_PUBLICATION' }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: nativeTool || revokedWrite ? 'toolUse' : 'stop', timestamp: Date.now() };
        queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
        return stream;
      },
    });
  } };
  // Real production foreground orchestration creates the exact task envelope,
  // depth/tool-budget hooks and session. Only model output is deterministic.
  const worker = { name: 'worker', description: 'Bounded Worker transport', source: 'runtime', filePath: path.join(root, 'agents/worker.md'),
    acceptanceRole: 'writer', completionGuard: true, systemPromptMode: 'replace', inheritGlobalContext: false,
    inheritProjectContext: false, inheritSkills: false, allowNestedSubagents: false, tools: revokedControl ? ['write'] : process.platform === 'win32' ? ['safe_exec'] : [],
    model: 'phi-worker-local/worker', thinking: 'off', systemPrompt: 'Deterministic Worker transport validation. Snapshot only.',
    subagentOnlyExtensions: process.platform === 'win32' ? [path.join(root, 'extensions/windows-worker.ts'), path.join(root, 'extensions/safe-exec.ts')] : [],
  };
  const deterministicFactory = { create: async launch => {
    assert.equal(launch.ambientExtensions, false);
    child = await factory.create({ ...launch, hooks: [...launch.hooks, localProvider], onExtensionError: error => {
      launch.onExtensionError?.(error);
      errors.push({ event: error.event, code: typeof error.error?.message === 'string' ? error.error.message : 'UNKNOWN' });
    } });
    sessionId = child.sessionId; return child;
  }, dispose: () => factory.dispose() };
  const foregroundResult = await runSync(project, [worker], 'worker', task, { runId: executionId, parentSessionId,
    childSessionFactory: deterministicFactory, cwd: project, context: 'fresh', maxSubagentDepth: 1,
    timeoutMs: 30000, toolBudget: { soft: 2, hard: 3, block: ['bash', 'subagent'] }, artifactConfig: { enabled: false },
    share: false, modelOverride: worker.model, thinkingOverride: 'off' });
  assert.ok(sessionId); assert.notEqual(sessionId, parentSessionId);
  assert.equal(foregroundResult.exitCode, 0, foregroundResult.error);
  assert.deepEqual(errors, []); assert.equal(boundEvents, 1);
  assert.equal(turns, revokedControl || process.platform === 'win32' ? 2 : 1);
  assert.equal(child.messages.at(-1).stopReason, 'stop');
  if (revokedControl) {
    const result = child.messages.find(message => message.role === 'toolResult');
    assert.equal(result.isError, true, 'revoked Worker must not run a host write even when its tool is present');
    assert.match(result.content[0].text, /PHI_WORKER_TOOL_DENIED|PHI_WORKER_AUTHORITY_UNAVAILABLE/u);
    assert.deepEqual(receipts, []);
  } else if (process.platform === 'win32') {
    assert.equal(receipts.length, 1);
    const receipt = receipts[0], result = child.messages.find(message => message.role === 'toolResult');
    assert.equal(result.isError, false);
    assert.equal(receipt.role, 'worker'); assert.equal(receipt.profile, 'EDIT');
    assert.equal(receipt.backend, 'windows-lpac-broker'); assert.equal(receipt.tokenVerified, true);
    assert.equal(receipt.jobAttested, true); assert.equal(receipt.cleanup, 'PASS'); assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.workerAuthority.executionId, executionId);
    const output = JSON.parse(result.content[0].text); assert.equal(output.edited, true); assert.equal(output.denied, true);
    assert.throws(() => process.kill(output.pid, 0), error => error.code === 'ESRCH');
  }
  assert.equal(fs.readFileSync(path.join(project, 'input.txt'), 'utf8'), 'source');
  await child.dispose(); child = undefined; await factory.dispose(); factory = undefined;
  assert.throws(() => windowsWorkerAuthority(sessionId), /AUTHORITY_UNAVAILABLE/u);
  assert.equal(externalRequests, 0);
  report = { status: 'PASS', platform: process.platform, piVersion: '0.87.1', subagentsVersion: '0.66.0',
    proof: revokedControl ? 'REAL_FOREGROUND_PI_REVOKED_HOST_WRITE_DENIED' : process.platform === 'win32' ? 'REAL_FOREGROUND_WORKER_PI_FACTORY_TO_LPAC_JOB' : 'REAL_FOREGROUND_PI_CHILD_BINDING_ONLY_NOT_WINDOWS_SECURITY',
    foregroundExitCode: foregroundResult.exitCode,
    boundEvents, localDeterministicTurns: turns, externalProviderCalls: 0, sourceUnchanged: true, receipts };
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'UNKNOWN';
} finally {
  try { await child?.dispose(); await factory?.dispose(); } catch { report.status = 'FAIL'; report.dispose = 'FAIL'; }
  reservation?.revoke(); globalThis.fetch = savedFetch;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  fs.rmSync(temporary, { recursive: true, force: true });
  report.cleanup = { temporaryRemoved: !fs.existsSync(temporary), authorityRevoked: sessionId ? (() => { try { windowsWorkerAuthority(sessionId); return false; } catch { return true; } })() : null };
  report.externalRequests = externalRequests;
  if (!report.cleanup.temporaryRemoved || externalRequests) report.status = 'FAIL';
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'PASS' ? 0 : 1;
