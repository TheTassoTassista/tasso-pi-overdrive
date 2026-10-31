import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPiRuntime } from '../lib/phi-runtime.mjs';

const project = path.resolve(import.meta.dirname, '..');

test('Pi registers the Phi bug prompt without shadowing its /bug command', async () => {
  const runtime = discoverPiRuntime();
  assert.ok(runtime, 'the pinned Pi runtime must be discoverable');
  const { loadPromptTemplates, expandPromptTemplate } = await import(
    pathToFileURL(path.join(runtime.root, 'dist', 'core', 'prompt-templates.js')).href
  );
  const { BUILTIN_SLASH_COMMANDS } = await import(
    pathToFileURL(path.join(runtime.root, 'dist', 'core', 'slash-commands.js')).href
  );
  const loaded = loadPromptTemplates({
    cwd: project,
    agentDir: path.join(project, 'tests', 'fixtures', 'no-agent-dir'),
    promptPaths: [path.join(project, 'prompts')],
    includeDefaults: false,
  });
  assert.deepEqual(loaded.diagnostics, []);
  assert.ok(BUILTIN_SLASH_COMMANDS.some((command) => command.name === 'bug'));
  assert.equal(loaded.templates.some((template) => template.name === 'bug'), false);
  const phiPrompt = loaded.templates.find((template) => template.name === 'phi-bug-report');
  assert.ok(phiPrompt);
  assert.equal(phiPrompt.filePath, path.join(project, 'prompts', 'phi-bug-report.md'));
  const expanded = expandPromptTemplate('/phi-bug-report deterministic-fixture', loaded.templates);
  assert.match(expanded, /Observed issue: deterministic-fixture\./u);
  assert.match(expanded, /Produce a diagnostic report, not a fix/u);
  assert.match(expanded, /confirmed facts \(`KNOWN`\)/u);
  assert.match(expanded, /Do not dump complete logs, environment variables, credentials/u);
  assert.match(expandPromptTemplate('/phi-bug-report', loaded.templates), /ask for a concise symptom/u);
});
