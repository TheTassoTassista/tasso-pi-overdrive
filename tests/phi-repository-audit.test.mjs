import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function audit(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-index-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(new URL('../scripts/phi-repository-audit.mjs', import.meta.url), path.join(root, 'scripts', 'phi-repository-audit.mjs'));
    const git = (args) => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
    git(['init', '--quiet']);
    for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content); git(['add', '--', name]); }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'phi-repository-audit.mjs')], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, report: JSON.parse(result.stdout) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('repository audit fails secrets/generated state without printing their values', () => {
  const secret = ['sk', 'z'.repeat(32)].join('-');
  const result = audit({ 'config/sample.json': JSON.stringify({ value: secret }), 'auth.json': '{}' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.ok(result.report.findings.some((row) => row.kind === 'secret-like-value'));
  assert.ok(result.report.findings.some((row) => row.kind === 'private-or-generated-artifact'));
});
test('repository audit cannot exempt extra secrets in a known deterministic fixture', () => {
  const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const footer = ['-----END', 'PRIVATE KEY-----'].join(' ');
  const fixture = `const privateKey = ${JSON.stringify([header, 'private-key-body', footer].join('\n'))};`;
  const safe = audit({ 'tests/artifact-store.test.mjs': fixture });
  assert.equal(safe.status, 0); assert.equal(safe.report.findings[0].kind, 'known-invalid-private-key-test-placeholder');
  const forged = audit({ 'tests/artifact-store.test.mjs': fixture + JSON.stringify(['sk', 'z'.repeat(32)].join('-')) });
  assert.equal(forged.status, 1);
});
test('repository audit distinguishes history/fixtures from production path dependencies', () => {
  const result = audit({ 'lib/entry.mjs': 'const root = "/home/developer/project";', 'docs/history.md': 'Old machine: /home/developer/project' });
  assert.equal(result.status, 1);
  assert.equal(result.report.findings.find((row) => row.file === 'lib/entry.mjs').status, 'FAIL');
  assert.equal(result.report.findings.find((row) => row.file === 'docs/history.md').status, 'WARN');
});
