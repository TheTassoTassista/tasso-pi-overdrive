#!/usr/bin/env node
// Bounded, offline protocol smoke for the exact clangd executable under test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const binary = process.argv[2];
assert.equal(path.isAbsolute(binary ?? ''), true, 'absolute clangd path required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-e4-clangd-'));
const source = path.join(root, 'main.cpp');
const uri = pathToFileURL(source).href;
const text = 'int twice(int value) { return value * 2; }\nint main() { return twice(2); }\n';
fs.writeFileSync(source, text);
const child = spawn(binary, ['--background-index=false', '--clang-tidy=false', '--log=error'], {
  cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root }, stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = Buffer.alloc(0);
const replies = new Map();
const waiting = new Map();
const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function response(id) {
  if (replies.has(id)) return Promise.resolve(replies.get(id));
  return new Promise((resolve) => waiting.set(id, resolve));
}
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) break;
    const match = /^Content-Length: (\d+)$/imu.exec(buffer.subarray(0, end).toString());
    assert.ok(match, 'clangd emitted a malformed LSP frame');
    const length = Number(match[1]);
    assert.ok(length > 0 && length < 1024 * 1024, 'clangd LSP frame unbounded');
    if (buffer.length < end + 4 + length) break;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (Number.isInteger(message.id)) {
      const waiter = waiting.get(message.id);
      if (waiter) { waiting.delete(message.id); waiter(message); }
      else replies.set(message.id, message);
    }
  }
});
const closed = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolve(code));
});
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    processId: null, rootUri: pathToFileURL(root).href,
    capabilities: { textDocument: { definition: { linkSupport: false } } },
  } });
  const init = await Promise.race([response(1), closed.then(() => { throw new Error('clangd exited before initialize'); })]);
  assert.ok(init.result?.capabilities?.definitionProvider, 'clangd initialize lacks definition support');
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
    textDocument: { uri, languageId: 'cpp', version: 1, text },
  } });
  send({ jsonrpc: '2.0', id: 2, method: 'textDocument/definition', params: {
    textDocument: { uri }, position: { line: 1, character: text.split('\n')[1].indexOf('twice') + 1 },
  } });
  const definition = await Promise.race([response(2), closed.then(() => { throw new Error('clangd exited before definition'); })]);
  const locations = Array.isArray(definition.result) ? definition.result : [definition.result];
  assert.ok(locations.some((item) => item?.uri === uri && item?.range?.start?.line === 0), 'clangd definition failed');
  send({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: null });
  const shutdown = await Promise.race([response(3), closed.then(() => { throw new Error('clangd exited before shutdown'); })]);
  assert.equal(shutdown.result, null);
  send({ jsonrpc: '2.0', method: 'exit', params: null });
  child.stdin.end();
  assert.equal(await closed, 0, 'clangd did not exit cleanly');
  process.stdout.write('E4_CPP_LSP_SMOKE=PASS\n');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
}
