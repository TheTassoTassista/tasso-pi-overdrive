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
  const release = path.join(prefix, 'releases', 'a'.repeat(40));
  const home = path.join(root, 'home');
  const nodeRoot = path.resolve(path.dirname(process.execPath), '..');
  try {
    fs.mkdirSync(release, { recursive: true, mode: 0o700 });
    fs.mkdirSync(home, { mode: 0o700 });
    fs.symlinkSync(`releases/${'a'.repeat(40)}`, path.join(prefix, 'active'));
    const launcher = path.join(home, 'phi');
    const unsafe = path.join(root, 'unsafe');
    fs.symlinkSync('outside', unsafe);
    assert.throws(() => versionedWrapperContent('linux', process.execPath, unsafe));
    fs.writeFileSync(launcher, versionedWrapperContent('linux', process.execPath, prefix)
      .replaceAll(prefix, '/managed'), { mode: 0o700 });
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true, mode: 0o700 });
    const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: source, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(archive.status, 0, archive.stderr?.toString());
    const extracted = spawnSync('tar', ['-xf', '-', '-C', release], { input: archive.stdout, encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    const pinnedMcp = spawnSync('npm', ['ls', '--prefix', path.join(source, 'runtime', 'mcp'), '--depth=0',
      'pi-mcp-adapter@2.32.1', '@modelcontextprotocol/sdk@1.30.0'], { encoding: 'utf8' });
    assert.equal(pinnedMcp.status, 0, pinnedMcp.stderr);
    fs.cpSync(path.join(source, 'runtime', 'mcp', 'node_modules'), path.join(release, 'runtime', 'mcp', 'node_modules'),
      { recursive: true, dereference: false });
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
    assert.equal(checks.find((row) => row.capability === 'Phi source')?.detail, '/managed/releases/' + 'a'.repeat(40));
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
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
