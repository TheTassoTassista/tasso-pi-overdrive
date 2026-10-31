import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { versionedWrapperContent } from '../bootstrap/core.mjs';

const source = path.resolve(import.meta.dirname, '..');

test('isolated Linux Phi runtime launches without the source checkout mounted', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-runtime-isolated-'));
  const prefix = path.join(root, 'managed');
  const home = path.join(root, 'home');
  const nodeRoot = path.resolve(path.dirname(process.execPath), '..');
  try {
    fs.mkdirSync(home, { mode: 0o700 });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
    assert.equal(head.status, 0, head.stderr);
    const releaseId = head.stdout.trim();
    const installed = spawnSync('python3', [path.join(source, 'bootstrap', 'versioned-runtime.py'), 'install',
      '--prefix', prefix, '--repository', source, '--release-id', releaseId], {
      encoding: 'utf8', timeout: 90_000, env: { ...process.env, npm_config_offline: 'true' },
    });
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    assert.equal(JSON.parse(installed.stdout).active, releaseId);
    const launcher = path.join(home, 'phi');
    const unsafe = path.join(root, 'unsafe');
    fs.symlinkSync('outside', unsafe);
    assert.throws(() => versionedWrapperContent('linux', process.execPath, unsafe));
    fs.writeFileSync(launcher, versionedWrapperContent('linux', process.execPath, prefix)
      .replaceAll(prefix, '/managed'), { mode: 0o700 });
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['/managed/active'],
      defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'medium' }), { mode: 0o600 });
    const isolation = ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64', '--dir', '/home', '--dir', '/home/tasso', '--dir', '/home/tasso/.local',
      '--dir', '/home/tasso/.local/share', '--dir', '/home/tasso/.local/share/pi-node',
      '--ro-bind', nodeRoot, nodeRoot, '--ro-bind', prefix, '/managed', '--bind', home, '/home/phi',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--unshare-net'];
    const environment = { ...process.env, HOME: '/home/phi', XDG_CONFIG_HOME: '/home/phi/.config',
      XDG_STATE_HOME: '/home/phi/.local/state', PI_CODING_AGENT_DIR: '/home/phi/.pi/agent', PHI_BUG_FIXTURE_KEY: 'fixture-only' };
    const run = (args, input) => spawnSync('bwrap', [...isolation, '/home/phi/phi', ...args], {
      env: environment, encoding: 'utf8', timeout: 20_000, maxBuffer: 128_000, input,
    });
    const sourceAbsent = spawnSync('bwrap', [...isolation, '/usr/bin/test', '!', '-e', source], { env: environment });
    assert.equal(sourceAbsent.status, 0, 'the checkout must be absent from the isolated runtime');
    const version = run(['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /Phi 1\.0\.0 \(Pi 0\.87\.1\)/u);
    const doctor = run(['doctor', '--json']);
    assert.equal(doctor.status, 0, doctor.stderr);
    const checks = JSON.parse(doctor.stdout).checks;
    assert.equal(checks.find((row) => row.capability === 'Package configuration')?.status, 'PASS');
    assert.equal(checks.find((row) => row.capability === 'Pi runtime')?.status, 'PASS');
    assert.equal(checks.find((row) => row.capability === 'Phi source')?.detail, '/managed/releases/' + releaseId);
    const rpc = run(['--offline', '--no-session', '--no-context-files', '--no-tools', '--mode', 'rpc'],
      `${JSON.stringify({ id: 'models', type: 'get_available_models' })}\n`);
    assert.equal(rpc.status, 0, rpc.stderr);
    const events = rpc.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.find((event) => event.type === 'response' && event.id === 'models')?.success, true);
    const result = run(['--offline', '--no-session', '--no-context-files', '--no-tools', '--no-extensions',
      '--no-skills', '--no-themes', '--prompt-template', '/managed/active/prompts/phi-bug-report.md',
      '--extension', '/managed/active/tests/fixtures/phi-bug-report-provider.ts', '--provider', 'phi-bug-fixture',
      '--model', 'report', '--print', '--', '/phi-bug-report controlled-fixture-failure']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Symptom: controlled fixture failure\./u);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-only/u);
    assert.equal(fs.existsSync(source), true, 'host checkout must remain untouched');
  } finally {
    const cleanup = 'import os,shutil,sys;root=sys.argv[1];[(os.chmod(base,0o700),[os.chmod(os.path.join(base,d),0o700) for d in dirs if not os.path.islink(os.path.join(base,d))]) for base,dirs,_ in os.walk(root)];shutil.rmtree(root)';
    const removed = spawnSync('python3', ['-c', cleanup, root], { encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stderr);
  }
});
