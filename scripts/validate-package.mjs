#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const requiredJson = ['package.json', 'config/settings-patch.json', 'config/packages.json', 'config/pi-fff.json', 'config/subagents.json', 'config/browser.json'];
for (const relative of requiredJson) {
  try { JSON.parse(await readFile(path.join(root, relative), 'utf8')); }
  catch (error) { failures.push(`${relative}: invalid JSON (${error.message})`); }
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (new Set(pkg.pi.extensions).size !== pkg.pi.extensions.length) failures.push('duplicate extension hook in package.json');
for (const relative of pkg.pi.extensions) {
  if (!relative.startsWith('./extensions/')) failures.push(`unexpected extension path ${relative}`);
  try { await readFile(path.join(root, relative), 'utf8'); } catch { failures.push(`missing extension ${relative}`); }
}
const packagePolicy = JSON.parse(await readFile(path.join(root, 'config/packages.json'), 'utf8'));
for (const source of packagePolicy.selected) {
  if (!/@\d+\.\d+\.\d+$/u.test(source)) failures.push(`package is not exactly pinned: ${source}`);
}
const settingsPatch = JSON.parse(await readFile(path.join(root, 'config/settings-patch.json'), 'utf8'));
if (JSON.stringify(settingsPatch.defaultTools) !== JSON.stringify(['read', 'edit', 'write'])) failures.push('defaultTools must contain only the intended built-in editor core');
if (!pkg.pi.extensions.includes('./extensions/tool-surface.ts')) failures.push('initial custom-tool surface limiter is missing');

const subagents = JSON.parse(await readFile(path.join(root, 'config/subagents.json'), 'utf8'));
if (subagents.globalConcurrencyLimit !== 3 || subagents.parallel?.concurrency !== 3 || subagents.parallel?.maxTasks !== 3) failures.push('subagent concurrency is not hard-configured to 3');
if (subagents.maxSubagentDepth !== 1) failures.push('subagent depth is not configured to 1');
if (subagents.worktree !== false) failures.push('pi-subagents global worktree must stay false because secure_coding_workflow supplies one shared enforced worktree');
if (subagents.scheduledRuns?.enabled !== false) failures.push('scheduled runs must remain disabled');
if (subagents.missions?.enabled !== false || subagents.missions?.globalIndex !== false) failures.push('automatic/global mission persistence must remain disabled');
if (subagents.intercomBridge?.mode !== 'off' || subagents.intercomBridge?.resultDelivery !== false) failures.push('intercom bridge must stay off because the enforced synchronous controller owns role coordination');

const expectedAgents = ['scout', 'planner', 'oracle', 'worker', 'tester', 'correctness-reviewer', 'security-reviewer', 'simplicity-reviewer'];
for (const name of expectedAgents) {
  const text = await readFile(path.join(root, 'agents', `${name}.md`), 'utf8').catch(() => '');
  if (!text) failures.push(`missing agent ${name}`);
  if (name === 'tester' && /^tools:.*\b(?:bash|safe_exec|edit|write)\b/mu.test(text)) failures.push('Tester has mutation or general command capability');
  if (name === 'worker' && /^tools:.*\bbash\b/mu.test(text)) failures.push('Worker has free-shell capability');
  if (name !== 'worker' && /\n\s*(?:edit|write): allow\b/u.test(text)) failures.push(`${name} overrides mutation permission`);
}

async function checkSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try { await realpath(full); } catch { failures.push(`broken symlink: ${path.relative(root, full)}`); }
    } else if (entry.isDirectory()) await checkSymlinks(full);
  }
}
await checkSymlinks(root);

for (const relative of ['package.json', 'config', 'extensions', 'agents', 'scripts', 'lib']) {
  const target = path.join(root, relative);
  const files = [];
  const walkText = async (item) => {
    const stat = await lstat(item);
    if (stat.isDirectory()) for (const entry of await readdir(item)) await walkText(path.join(item, entry));
    else if (stat.isFile() && /\.(?:json|mjs|ts|sh|md)$/u.test(item)) files.push(item);
  };
  await walkText(target);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (path.basename(file) !== 'validate-package.mjs' && /files-pasted-by-the-user|\.codex\/attachments|\/tmp\/pi-overdrive/u.test(text) && !file.includes(`${path.sep}tests${path.sep}`)) failures.push(`fragile Codex/temp path in active package source: ${path.relative(root, file)}`);
    if (/BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{20,}/u.test(text)) failures.push(`secret-like value: ${path.relative(root, file)}`);
  }
}

for (const directory of ['agents', 'skills']) {
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) {
        const text = await readFile(full, 'utf8');
        if (!text.startsWith('---\n')) failures.push(`${path.relative(root, full)}: missing frontmatter`);
        if (/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}/u.test(text)) failures.push(`${path.relative(root, full)}: secret-like text`);
      }
    }
  };
  await walk(path.join(root, directory));
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.exit(1);
}
process.stdout.write('Package structure and pinned-policy validation: PASS\n');
