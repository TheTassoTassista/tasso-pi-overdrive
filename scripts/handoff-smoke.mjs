#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pi = process.env.PI_BIN || 'pi';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providerExtension = path.join(root, 'tests', 'fixtures', 'deterministic-handoff-provider.ts');
const model = 'pi-overdrive-handoff-audit/handoff-driver';
const marker = 'HANDOFF_MARKER_927';
const child = spawn(pi, ['--offline', '--approve', '--no-session', '--mode', 'rpc', '--extension', providerExtension, '--provider', 'pi-overdrive-handoff-audit', '--model', 'handoff-driver', '--api-key', 'audit-only', '--tools', 'task_notebook'], {
  cwd: process.cwd(),
  env: { ...process.env, PI_OVERDRIVE_HANDOFF_AUDIT_KEY: 'audit-only', PI_OVERDRIVE_HANDOFF_MARKER: marker },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const events = [];
const waiters = new Set();
let stdoutBuffer = '';
let stderr = '';

function receive(event) {
  events.push(event);
  for (const waiter of [...waiters]) {
    if (events.length > waiter.startAt && waiter.predicate(event)) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  }
}

child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString('utf8');
  for (;;) {
    const newline = stdoutBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    try { receive(JSON.parse(line)); }
    catch { receive({ type: 'invalid_json', line: line.slice(0, 300) }); }
  }
});
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitFor(predicate, startAt, label, timeoutMs = 120000) {
  for (let index = startAt; index < events.length; index += 1) {
    if (predicate(events[index])) return Promise.resolve(events[index]);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      startAt,
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}. stderr: ${stderr}`));
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, status: condition ? 'PASS' : 'FAIL', detail });
}

try {
  let cursor = events.length;
  send({ id: 'seed', type: 'prompt', message: `Record this verified task state in the canonical notebook: ${marker}.` });
  const accepted = await waitFor((event) => event.type === 'response' && event.id === 'seed', cursor, 'seed acceptance');
  check('seed-accepted', accepted.success === true, 'initial RPC prompt accepted');
  await waitFor((event) => event.type === 'agent_settled', cursor, 'seed agent settlement', 180000);
  const notebookEnd = events.slice(cursor).find((event) => event.type === 'tool_execution_end' && event.toolName === 'task_notebook');
  check('notebook-tool-executed', notebookEnd?.isError === false, notebookEnd?.result?.details);
  check('notebook-state-recorded', notebookEnd?.result?.details?.state?.goal === marker, notebookEnd?.result?.details?.state);

  cursor = events.length;
  send({ id: 'handoff', type: 'prompt', message: `/handoff Continue by verifying ${marker} in a clean session` });
  const editor = await waitFor((event) => event.type === 'extension_ui_request' && event.method === 'editor', cursor, 'handoff editor', 180000);
  check('handoff-distilled', typeof editor.prefill === 'string' && editor.prefill.includes(marker), 'generated handoff preserved the verified marker');
  send({ type: 'extension_ui_response', id: editor.id, value: editor.prefill });

  const newEditor = await waitFor((event) => event.type === 'extension_ui_request' && event.method === 'set_editor_text', cursor, 'new-session editor text');
  check('handoff-prefilled-new-session', typeof newEditor.text === 'string' && newEditor.text.includes(marker), 'clean session received the editable handoff');
  const handoffResponse = await waitFor((event) => event.type === 'response' && event.id === 'handoff', cursor, 'handoff command response');
  check('handoff-command', handoffResponse.success === true, 'handoff command completed');

  cursor = events.length;
  send({ id: 'state', type: 'get_state' });
  const state = await waitFor((event) => event.type === 'response' && event.id === 'state', cursor, 'new session state');
  check('clean-session', state.success === true && state.data?.messageCount === 0, `new session message count: ${state.data?.messageCount}`);
} catch (error) {
  check('rpc-handoff-runtime', false, error.message);
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 3000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

const status = results.length >= 7 && results.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
process.stdout.write(`${JSON.stringify({ status, model, results }, null, 2)}\n`);
process.exit(status === 'PASS' ? 0 : 1);
