import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyCommand, inspectWorkspaceConstraint, inspectWorkspacePath, isAlwaysProtectedWritePath, isInside, isSecretPath, validateAllocatedBrowserCall, validateSubagentCall } from '../lib/safety.mjs';

test('secret paths are recognized without opening them', () => {
  for (const value of ['.env', '.env.local', '/tmp/auth.json', '~/.ssh/id_ed25519', 'cert.pem']) assert.equal(isSecretPath(value), true, value);
  assert.equal(isSecretPath('src/environment.ts'), false);
});

test('protected writes cover secrets, git internals, and dependencies', () => {
  assert.equal(isAlwaysProtectedWritePath('.git/config'), true);
  assert.equal(isAlwaysProtectedWritePath('node_modules/pkg/index.js'), true);
  assert.equal(isAlwaysProtectedWritePath('src/index.ts'), false);
});

test('workspace boundary does not accept sibling prefixes', () => {
  assert.equal(isInside('/work/app', '/work/app/src/a.ts'), true);
  assert.equal(isInside('/work/app', '/work/application/a.ts'), false);
});

test('all unsandboxed free-form shell is denied without parsing strings', () => {
  for (const command of [
    'cat ~/.ssh/id_ed25519',
    'git reset --hard HEAD',
    'python3 -c "open(\'.env\').read()"',
    'printf x > ../outside.txt',
    'find target -delete',
    'rg TODO src',
  ]) assert.equal(classifyCommand(command)?.level, 'block', command);
});

test('canonical guard denies symlink reads and writes plus parent escapes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-safety-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  try {
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'link'));
    symlinkSync(outside, path.join(workspace, 'dir-link'));
    assert.equal(inspectWorkspacePath(workspace, 'link').allowed, false);
    assert.equal(inspectWorkspacePath(workspace, 'link', { forWrite: true }).allowed, false);
    assert.equal(inspectWorkspacePath(workspace, 'dir-link/new.txt', { mustExist: false, forWrite: true }).allowed, false);
    assert.equal(inspectWorkspacePath(workspace, '../outside/secret.txt').allowed, false);
    assert.equal(inspectWorkspacePath(workspace, 'new.txt', { mustExist: false, forWrite: true }).allowed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace root inspection returns directory metadata', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'pi-safety-root-'));
  try {
    const result = inspectWorkspacePath(workspace, '.', { mustExist: true });
    assert.equal(result.allowed, true);
    assert.equal(result.stat?.isDirectory(), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('canonical guard denies writes through multiply-linked files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-hardlink-'));
  const workspace = path.join(root, 'workspace');
  try {
    mkdirSync(workspace);
    writeFileSync(path.join(root, 'outside.txt'), 'protected');
    linkSync(path.join(root, 'outside.txt'), path.join(workspace, 'hardlink.txt'));
    assert.equal(inspectWorkspacePath(workspace, 'hardlink.txt', { forWrite: true }).allowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('FFF constraints remain useful but cannot select outside or symlink roots', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-constraint-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'pi-constraint-outside-'));
  try {
    mkdirSync(path.join(root, 'src'));
    symlinkSync(outside, path.join(root, 'escape'));
    assert.equal(inspectWorkspaceConstraint(root, 'src/**/*.ts').allowed, true);
    assert.equal(inspectWorkspaceConstraint(root, '*.ts').allowed, true);
    assert.equal(inspectWorkspaceConstraint(root, '../outside').allowed, false);
    assert.equal(inspectWorkspaceConstraint(root, path.join(outside, 'secret')).allowed, false);
    assert.equal(inspectWorkspaceConstraint(root, '~/.ssh/*').allowed, false);
    assert.equal(inspectWorkspaceConstraint(root, 'escape/*.txt').allowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('subagent callers cannot override concurrency, depth, raw scripts, or writer isolation', () => {
  assert.equal(validateSubagentCall({ tasks: [{}, {}, {}, {}] }).allowed, false);
  assert.equal(validateSubagentCall({ globalConcurrencyLimit: 4 }).allowed, false);
  assert.equal(validateSubagentCall({ options: { parallel: { concurrency: 4 } } }).allowed, false);
  assert.equal(validateSubagentCall({ maxSubagentDepth: 2 }).allowed, false);
  assert.equal(validateSubagentCall({ workflowScript: 'return runs.run()' }).allowed, false);
  assert.equal(validateSubagentCall({ agent: 'scout', model: 'other/model' }).allowed, false);
  assert.equal(validateSubagentCall({ action: 'reset', agent: 'worker' }).allowed, false);
  assert.equal(validateSubagentCall({ action: 'update', agent: 'worker', config: { description: 'bypass' } }).allowed, false);
  assert.equal(validateSubagentCall({ agent: 'worker', worktree: false }).allowed, false);
  assert.equal(validateSubagentCall({ agent: 'worker', worktree: true }).allowed, true);
});

test('allocated browser calls must use the unique assigned profile/session', () => {
  const allocation = { browserProfile: '/private/profile-1', browserSession: 'pi-session-1' };
  assert.equal(validateAllocatedBrowserCall({ args: ['open', 'https://example.com'] }, allocation).allowed, false);
  assert.equal(validateAllocatedBrowserCall({ args: ['--profile', '/private/profile-1', 'open', 'https://example.com'], sessionMode: 'fresh' }, allocation).allowed, false);
  assert.equal(validateAllocatedBrowserCall({ args: ['--session', 'pi-session-1', '--profile', '/private/profile-1', 'open', 'https://example.com'], sessionMode: 'fresh' }, allocation).allowed, true);
  assert.equal(validateAllocatedBrowserCall({ args: ['--session', 'pi-session-1', 'snapshot'] }, allocation).allowed, true);
  assert.equal(validateAllocatedBrowserCall({ args: ['--profile', '/other', 'open'], sessionMode: 'fresh' }, allocation).allowed, false);
});
