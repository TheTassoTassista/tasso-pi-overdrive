#!/usr/bin/env node
// Bounded, offline initialize/shutdown probe for pinned JS LSP entrypoints.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const argsById = Object.freeze({
  vtsls: ['--stdio'], 'pyright-langserver': ['--stdio'],
  'vscode-html-language-server': ['--stdio'],
  'vscode-css-language-server': ['--stdio'],
  'vscode-json-language-server': ['--stdio'],
  'yaml-language-server': ['--stdio'],
  'bash-language-server': ['start'],
});
export async function lspStartupSmoke(id, binary) {
assert.ok(Object.hasOwn(argsById, id));
assert.equal(path.basename(binary), id);
const child = spawn(binary, argsById[id], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', NODE_OPTIONS: '' },
});
let output = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
let offset = 0;
let initialized = false;
let shutdown = false;
const MAX_BYTES = 64 * 1024;
const send = (message) => {
  const json = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
};
const processFrames = () => {
  while (true) {
    const headerEnd = output.indexOf('\r\n\r\n', offset);
    if (headerEnd < 0) return;
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const length = /^Content-Length: (\d+)$/imu.exec(header)?.[1];
    if (!length || Number(length) > MAX_BYTES) throw new Error('INVALID_LSP_FRAME');
    const end = headerEnd + 4 + Number(length);
    if (output.length < end) return;
    const frame = JSON.parse(output.subarray(headerEnd + 4, end).toString('utf8'));
    offset = end;
    if (frame.id === 1) {
      if (frame.error || !frame.result?.capabilities) throw new Error('LSP_INITIALIZE_REJECTED');
      initialized = true;
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null });
    } else if (frame.id === 2) {
      if (frame.error) throw new Error('LSP_SHUTDOWN_REJECTED');
      shutdown = true;
      send({ jsonrpc: '2.0', method: 'exit' });
      child.stdin.end();
    }
  }
};
const result = await new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    resolve({ ...value, stdout: output.toString('utf8'), stderr: stderr.toString('utf8'),
      stdoutBytes: output.length, stderrBytes: stderr.length,
      outputComplete: output.length <= MAX_BYTES && stderr.length <= MAX_BYTES });
  };
  const timer = setTimeout(() => finish({ ok: false, reason: 'LSP_STARTUP_TIMEOUT' }), 7000);
  child.stdout.on('data', (chunk) => {
    output = Buffer.concat([output, chunk]);
    if (output.length > MAX_BYTES) { finish({ ok: false, reason: 'LSP_OUTPUT_OVERFLOW' }); return; }
    try { processFrames(); } catch (error) { finish({ ok: false, reason: error.message }); }
  });
  child.stderr.on('data', (chunk) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > MAX_BYTES) finish({ ok: false, reason: 'LSP_STDERR_OVERFLOW' });
  });
  child.stdin.on('error', (error) => finish({ ok: false, reason: `LSP_STDIN_${error.code ?? 'UNKNOWN'}` }));
  child.on('error', (error) => finish({ ok: false, reason: `SPAWN_FAILURE_${error.code ?? 'UNKNOWN'}` }));
  child.on('exit', (code, signal) => finish({ ok: initialized && shutdown && code === 0 && !signal,
    reason: initialized && shutdown && code === 0 && !signal ? null : `LSP_EXIT_${code ?? signal}` }));
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    processId: null, rootUri: null, capabilities: {}, workspaceFolders: null,
  } });
});
return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [id, binary] = process.argv.slice(2);
  assert.match(binary ?? '', /^\/opt\/phi\/runtime\/lsp\/node_modules\/\.bin\/[a-z-]+$/u);
  const result = await lspStartupSmoke(id, binary);
  // No workspace content is sent: rootUri is null. Retain the complete bounded
  // protocol and stderr evidence so a server failure is diagnosable in one run.
  console.log(`E4_LSP_STREAMS=${JSON.stringify({ stdout: result.stdout, stderr: result.stderr,
    stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
    outputComplete: result.outputComplete })}`);
  if (result.ok) console.log(`E4_LSP_STARTUP=PASS id=${id}`);
  else { console.error(`E4_LSP_STARTUP=FAIL id=${id} reason=${result.reason}`); process.exitCode = 1; }
}
