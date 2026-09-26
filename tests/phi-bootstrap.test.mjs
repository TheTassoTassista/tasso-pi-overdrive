import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { bootstrapFoundation, wrapperContent } from '../bootstrap/core.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-bootstrap-'));
  const dirs = Object.fromEntries(['bin', 'config', 'state', 'agent', 'legacyConfig'].map((key) => [key, path.join(root, key)]));
  return { root, dirs };
}
test('bootstrap plan performs no writes or provider calls', async () => {
  const setup = fixture();
  try {
    const before = fs.readdirSync(setup.root);
    const result = await bootstrapFoundation({ plan: true, dirs: setup.dirs });
    assert.equal(result.writes, 0); assert.equal(result.modelCalls, 0); assert.equal(result.status, 'PLAN');
    assert.deepEqual(fs.readdirSync(setup.root), before);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});
test('foundation install is idempotent and does not write Pi settings or authentication', async () => {
  const setup = fixture();
  try {
    fs.mkdirSync(setup.dirs.agent, { mode: 0o700 });
    fs.writeFileSync(path.join(setup.dirs.agent, 'auth.json'), 'AUTH_SENTINEL');
    const result = await bootstrapFoundation({ dirs: setup.dirs });
    const first = fs.readFileSync(result.launcher, 'utf8');
    const repeated = await bootstrapFoundation({ dirs: setup.dirs });
    assert.equal(repeated.modelCalls, 0); assert.equal(fs.readFileSync(result.launcher, 'utf8'), first);
    assert.equal(fs.readFileSync(path.join(setup.dirs.agent, 'auth.json'), 'utf8'), 'AUTH_SENTINEL');
    assert.equal(fs.existsSync(path.join(setup.dirs.agent, 'settings.json')), false);
    const args = process.platform === 'win32' ? ['/d', '/c', result.launcher, '--version'] : ['--version'];
    const launched = spawnSync(process.platform === 'win32' ? process.env.ComSpec : result.launcher, args, { encoding: 'utf8', shell: false });
    assert.equal(launched.status, 0, launched.stderr); assert.match(launched.stdout, /Phi 1\.0\.0/u);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});
test('bootstrap refuses an unrelated phi command before creating configuration', async () => {
  const setup = fixture();
  try {
    fs.mkdirSync(setup.dirs.bin, { mode: 0o700 });
    const file = path.join(setup.dirs.bin, process.platform === 'win32' ? 'phi.cmd' : 'phi');
    fs.writeFileSync(file, 'UNRELATED');
    await assert.rejects(() => bootstrapFoundation({ dirs: setup.dirs }), /CONFLICT/u);
    assert.equal(fs.readFileSync(file, 'utf8'), 'UNRELATED'); assert.equal(fs.existsSync(setup.dirs.config), false);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});
test('thin wrapper quoting supports spaces and rejects unsafe Windows expansion', () => {
  assert.match(wrapperContent('linux', "/users/a'b/node", '/projects/space dir/phi.mjs'), /'\\''/u);
  assert.match(wrapperContent('win32', 'C:\\Program Files\\node.exe', 'D:\\Phi Folder\\bin\\phi.mjs'), /"C:\\Program Files/u);
  for (const unsafe of ['x%PATH%', 'x!foo!', 'x&run', 'x\nrun']) assert.throws(() => wrapperContent('win32', unsafe, 'C:\\phi.mjs'));
});
