#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(tmpdir(), 'pi-overdrive-smoke-'));
const repo = path.join(root, 'repo');
const worktree = path.join(root, 'worktree');
const results = [];
const run = (name, command, args, cwd = repo) => {
  try {
    const output = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    results.push({ name, status: 'PASS', output: output.slice(0, 300) });
  } catch (error) {
    results.push({ name, status: 'FAIL', output: String(error.stderr || error.message).slice(0, 500) });
  }
};
const check = (name, condition, output) => results.push({ name, status: condition ? 'PASS' : 'FAIL', output });

try {
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  writeFileSync(path.join(repo, 'README.md'), '# smoke\n');
  run('git-init', 'git', ['init', '-q'], repo);
  run('git-identity-name', 'git', ['config', 'user.name', 'Pi Smoke'], repo);
  run('git-identity-email', 'git', ['config', 'user.email', 'pi-smoke@invalid'], repo);
  run('git-commit', 'git', ['add', '.'], repo);
  run('git-commit-create', 'git', ['commit', '-qm', 'fixture'], repo);
  run('rg-search', 'rg', ['-n', 'function add', 'src'], repo);
  run('fd-search', 'fd', '--type f math'.split(' '), repo);
  run('ast-search', 'ast-grep', ['--pattern', 'function $F($$$A) { $$$B }', '--lang', 'typescript', 'src/math.ts'], repo);
  run('worktree-create', 'git', ['worktree', 'add', '-q', '-b', 'smoke-isolated', worktree], repo);
  run('worktree-list', 'git', ['worktree', 'list', '--porcelain'], repo);
  run('worktree-remove', 'git', ['worktree', 'remove', worktree], repo);
  writeFileSync(path.join(repo, 'AGENTS.md'), 'existing project rules\n');
  run('project-template-init', path.join(packageRoot, 'scripts', 'project-init.sh'), [repo], repo);
  check('project-template-preserves-files', readFileSync(path.join(repo, 'AGENTS.md'), 'utf8') === 'existing project rules\n', 'existing AGENTS.md retained');
  check('project-template-directories', ['product', 'architecture', 'api', 'workflows', 'security', 'testing', 'reliability', 'references', 'plans/active', 'plans/completed'].every((item) => existsSync(path.join(repo, 'docs', item))), 'recommended documentation map created');
} finally {
  rmSync(root, { recursive: true, force: true });
}

const status = results.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
process.stdout.write(`${JSON.stringify({ status, tempRepoRemoved: true, results }, null, 2)}\n`);
process.exit(status === 'PASS' ? 0 : 1);
