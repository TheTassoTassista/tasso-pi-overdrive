import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

test('Phi CLI expands the bug-report prompt and returns a bounded offline report', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-bug-report-cli-'));
  try {
    const agentDir = path.join(temporary, 'agent');
    fs.mkdirSync(agentDir, { mode: 0o700 });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
      packages: [root], defaultProvider: 'openai-codex', defaultModel: 'gpt-6-sol', defaultThinkingLevel: 'medium',
    }), { mode: 0o600 });
    const child = spawnSync(process.execPath, [path.join(root, 'bin', 'phi.mjs'), '--offline', '--no-session',
      '--no-context-files', '--no-tools', '--no-extensions', '--no-skills', '--no-themes',
      '--prompt-template', path.join(root, 'prompts', 'phi-bug-report.md'),
      '--extension', path.join(root, 'tests', 'fixtures', 'phi-bug-report-provider.ts'),
      '--provider', 'phi-bug-fixture', '--model', 'report', '--print', '--',
      '/phi-bug-report controlled-fixture-failure'], {
      cwd: temporary,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PHI_BUG_FIXTURE_KEY: 'fixture-only' },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 128_000,
    });
    assert.equal(child.status, 0, `Phi CLI failed: ${child.stderr.slice(-1000)}`);
    assert.match(child.stdout, /Symptom: controlled fixture failure\. KNOWN: the prompt reached Pi\. UNKNOWN: root cause not measured\./u);
    assert.doesNotMatch(child.stdout + child.stderr, /fixture-only/u);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
