import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOwnedEngine } from '../platform/shared/process.mjs';

test('Linux owned launcher reaps a descendant after parent exit', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-process-'));
  const pidFile = path.join(root, 'child.pid');
  try {
    const program = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));child.unref();`;
    assert.equal(await runOwnedEngine(process.execPath, ['-e', program, pidFile], { stdio: 'ignore' }), 0);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Linux owned process timeout is bounded and propagates failure', { skip: process.platform !== 'linux' }, async () => {
  assert.equal(await runOwnedEngine(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', timeoutMs: 60 }), 124);
  assert.equal(await runOwnedEngine(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' }), 7);
});
