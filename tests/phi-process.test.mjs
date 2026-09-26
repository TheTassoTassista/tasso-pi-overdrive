import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runOwnedEngine, processBackendStatus } from '../platform/shared/process.mjs';

test('process presence metadata does not claim sandbox or live cleanup attestation', async () => {
  const status = await processBackendStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.match(status.scope, /trusted/iu);
  assert.match(status.evidence, /not|only|build required/iu);
  assert.doesNotMatch(status.id, /appcontainer|sandbox/iu);
});

test('Linux owned local verification terminates a descendant after parent exit', { skip: process.platform !== 'linux' }, async () => {
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
test('Linux interactive engine exec preserves PID/arguments/environment/exit without a wrapper child', { skip: process.platform !== 'linux' }, () => {
  const module = new URL('../platform/shared/process.mjs', import.meta.url).href;
  const engine = "console.log(JSON.stringify({samePid:process.pid===Number(process.env.PHI_EXPECT_PID),argument:process.argv[1],environment:process.env.PHI_MARKER}));process.exit(7);";
  const script = `import {launchEngine} from ${JSON.stringify(module)}; await launchEngine(process.execPath, ['-e',${JSON.stringify(engine)},'fixture argument'], {...process.env,PHI_EXPECT_PID:String(process.pid),PHI_MARKER:'preserved'});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { samePid: true, argument: 'fixture argument', environment: 'preserved' });
});
test('Linux owned process timeout is bounded and propagates failure', { skip: process.platform !== 'linux' }, async () => {
  assert.equal(await runOwnedEngine(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', timeoutMs: 60 }), 124);
  assert.equal(await runOwnedEngine(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' }), 7);
});
