#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateRequiredSpawnBudget } from '../lib/workflow-spawn-budget.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const requiredJson = ['package.json', 'config/settings-patch.json', 'config/model-policy.json', 'config/model-callability.json', 'config/routing-policy.json', 'config/managed-lsp.json', 'config/packages.json', 'config/pi-fff.json', 'config/subagents.json', 'config/browser.json', 'config/mcp.json', 'config/web-tools.json', 'runtime/mcp/package.json', 'runtime/mcp/package-lock.json', 'runtime/lsp/package.json', 'runtime/lsp/package-lock.json'];
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
if (!pkg.pi.extensions.includes('./extensions/mcp.ts')) failures.push('compact MCP proxy extension is missing');
if (!pkg.pi.extensions.includes('./extensions/web-policy.ts')) failures.push('bounded dual-provider web policy extension is missing');
if (!pkg.pi.extensions.includes('./extensions/lsp.ts') || pkg.pi.extensions.includes('./extensions/typescript-navigation.ts')) failures.push('generalized one-tool LSP extension must replace the legacy TypeScript extension hook');
if (!pkg.pi.extensions.includes('./extensions/model-policy.ts')) failures.push('user-owned model policy commands are missing');
if (!pkg.pi.extensions.includes('./extensions/omniroute.ts')) failures.push('OmniRoute provider registration is missing');

const lspRuntime = JSON.parse(await readFile(path.join(root, 'runtime/lsp/package.json'), 'utf8'));
const expectedLsp = {
  '@vtsls/language-server': '0.3.0', 'bash-language-server': '5.6.0', pyright: '1.1.410', typescript: '6.0.3',
  'vscode-jsonrpc': '9.0.2', 'vscode-langservers-extracted': '4.10.0', 'yaml-language-server': '1.23.0',
};
if (JSON.stringify(lspRuntime.dependencies) !== JSON.stringify(expectedLsp)) failures.push('LSP dependencies are not the exact reviewed set and versions');
const lspLock = JSON.parse(await readFile(path.join(root, 'runtime/lsp/package-lock.json'), 'utf8'));
for (const [name, version] of Object.entries(expectedLsp)) if (lspLock.packages?.[`node_modules/${name}`]?.version !== version) failures.push(`LSP lock mismatch: ${name}@${version}`);
if (lspRuntime.overrides?.minimatch !== '10.2.6' || lspLock.packages?.['node_modules/minimatch']?.version !== '10.2.6') failures.push('LSP minimatch security override is missing or not locked');
const managedLsp = JSON.parse(await readFile(path.join(root, 'config/managed-lsp.json'), 'utf8'));
if (managedLsp.version !== 1 || managedLsp.platform !== 'linux-x64') failures.push('managed LSP manifest version/platform mismatch');
if (managedLsp.rustAnalyzer?.release !== '2026-09-07' || managedLsp.rustAnalyzer?.version !== '0.3.3041-standalone' || !/^[0-9a-f]{64}$/u.test(managedLsp.rustAnalyzer?.archiveSha256 ?? '') || !/^[0-9a-f]{64}$/u.test(managedLsp.rustAnalyzer?.binarySha256 ?? '')) failures.push('rust-analyzer release or checksums are not pinned');
if (managedLsp.rustSource?.version !== '1.98.1' || !/^[0-9a-f]{64}$/u.test(managedLsp.rustSource?.archiveSha256 ?? '')) failures.push('rust-src is not pinned');
if (managedLsp.go?.version !== '1.26.8' || !/^[0-9a-f]{64}$/u.test(managedLsp.go?.archiveSha256 ?? '') || !/^[0-9a-f]{64}$/u.test(managedLsp.go?.binarySha256 ?? '')) failures.push('managed Go toolchain is not pinned');
if (managedLsp.gopls?.version !== 'v0.23.0' || managedLsp.gopls?.module !== 'golang.org/x/tools/gopls@v0.23.0' || !/^h1:[A-Za-z0-9+/]{43}=$/u.test(managedLsp.gopls?.moduleSum ?? '') || !/^h1:[A-Za-z0-9+/]{43}=$/u.test(managedLsp.gopls?.goModSum ?? '') || !/^[0-9a-f]{64}$/u.test(managedLsp.gopls?.binarySha256 ?? '') || !/^[0-9a-f]{40}$/u.test(managedLsp.gopls?.sourceCommit ?? '')) failures.push('gopls module identity is not pinned');
for (const name of ['rust-analyzer', 'rust-src', 'go', 'gopls']) if (!packagePolicy.trackedRuntimes?.[name]) failures.push(`${name} is missing from tracked runtime provenance`);

const mcpConfig = JSON.parse(await readFile(path.join(root, 'config/mcp.json'), 'utf8'));
if (mcpConfig.settings?.directTools !== false || mcpConfig.settings?.scriptMode !== false) failures.push('MCP must expose one proxy only (no direct tools or script surface)');
if (mcpConfig.settings?.approveTools !== true || mcpConfig.settings?.sampling !== false || mcpConfig.settings?.elicitation !== false) failures.push('MCP global mutation/sampling/elicitation policy is not fail-closed');
if (Object.keys(mcpConfig.mcpServers ?? {}).length !== 1 || !mcpConfig.mcpServers?.context7) failures.push('only the audited Context7 MCP server may be configured');
const context7 = mcpConfig.mcpServers?.context7 ?? {};
if (context7.lifecycle !== 'lazy' || context7.directTools !== false || context7.exposeResources !== false) failures.push('Context7 MCP lifecycle/surface is not lazy and bounded');
if (JSON.stringify(context7.includeTools) !== JSON.stringify(['resolve-library-id', 'query-docs'])) failures.push('Context7 MCP allowlist changed');
const mcpRuntime = JSON.parse(await readFile(path.join(root, 'runtime/mcp/package.json'), 'utf8'));
const expectedMcpSource = 'https://codeload.github.com/nicobailon/pi-mcp-adapter/tar.gz/8243eba3421e301c88c047444f34ab7d5d57163e';
if (mcpRuntime.dependencies?.['pi-mcp-adapter'] !== expectedMcpSource) failures.push('MCP adapter commit is not pinned to the audited HTTPS revision');
if (packagePolicy.trackedRuntimes?.['pi-mcp-adapter']?.source !== expectedMcpSource) failures.push('MCP runtime audit policy does not match the installed source');
if (mcpRuntime.overrides?.hono !== '4.13.5') failures.push('MCP runtime Hono security override is missing');
const mcpLock = JSON.parse(await readFile(path.join(root, 'runtime/mcp/package-lock.json'), 'utf8'));
if (mcpLock.packages?.['node_modules/pi-mcp-adapter']?.version !== '2.32.1' || mcpLock.packages?.['node_modules/pi-mcp-adapter']?.resolved !== expectedMcpSource) failures.push('MCP lockfile does not resolve the audited adapter commit');
if (mcpLock.packages?.['node_modules/hono']?.version !== '4.13.5') failures.push('MCP lockfile does not enforce the audited Hono version');

const webConfig = JSON.parse(await readFile(path.join(root, 'config/web-tools.json'), 'utf8'));
if (webConfig.provider !== 'brave' || webConfig.overdriveRouting?.primaryProvider !== 'brave' || webConfig.overdriveRouting?.secondaryProvider !== 'perplexity' || webConfig.overdriveRouting?.automaticFallback !== true) failures.push('web routing must be explicit Brave primary / observable Perplexity fallback');
if (Object.hasOwn(webConfig, 'apiKeys') || Object.hasOwn(webConfig, 'apiKey')) failures.push('tracked web policy must never contain credential slots or values');

const subagents = JSON.parse(await readFile(path.join(root, 'config/subagents.json'), 'utf8'));
const spawnBudget = calculateRequiredSpawnBudget();
if (subagents.globalConcurrencyLimit !== 3 || subagents.parallel?.concurrency !== 3 || subagents.parallel?.maxTasks !== 3) failures.push('subagent concurrency is not hard-configured to 3');
if (subagents.maxSubagentDepth !== 1) failures.push('subagent depth is not configured to 1');
if (!Number.isSafeInteger(subagents.maxSubagentSpawnsPerSession) || subagents.maxSubagentSpawnsPerSession < spawnBudget.requiredTotalSpawns) failures.push(`subagent session spawn limit must cover derived workflow budget ${spawnBudget.requiredBaseSpawns}+${spawnBudget.retryReserve}=${spawnBudget.requiredTotalSpawns}`);
if (subagents.worktree !== false) failures.push('pi-subagents global worktree must stay false because secure_coding_workflow supplies one shared enforced worktree');
if (subagents.scheduledRuns?.enabled !== false) failures.push('scheduled runs must remain disabled');
if (subagents.missions?.enabled !== false || subagents.missions?.globalIndex !== false) failures.push('automatic/global mission persistence must remain disabled');
if (subagents.intercomBridge?.mode !== 'off' || subagents.intercomBridge?.resultDelivery !== false) failures.push('intercom bridge must stay off because the enforced synchronous controller owns role coordination');

const expectedAgents = ['scout', 'planner', 'oracle', 'worker', 'tester', 'correctness-reviewer', 'security-reviewer', 'simplicity-reviewer', 'council-1', 'council-2', 'council-3', 'council-judge'];
for (const name of expectedAgents) {
  const text = await readFile(path.join(root, 'agents', `${name}.md`), 'utf8').catch(() => '');
  if (!text) failures.push(`missing agent ${name}`);
  if (name === 'tester' && /^tools:.*\b(?:bash|safe_exec|edit|write)\b/mu.test(text)) failures.push('Tester has mutation or general command capability');
  if (name === 'worker' && /^tools:.*\bbash\b/mu.test(text)) failures.push('Worker has free-shell capability');
  if (['worker', 'tester'].includes(name) && /^tools:.*\b(?:web_search|web_fetch|web_research|safe_web_fetch)\b/mu.test(text)) failures.push(`${name} must not receive autonomous network tools`);
  if (name !== 'worker' && /\n\s*(?:edit|write): allow\b/u.test(text)) failures.push(`${name} overrides mutation permission`);
  if (name.startsWith('council-') && /^tools:.*\b(?:bash|safe_exec|safe_remove_file|edit|write|subagent)\b/mu.test(text)) failures.push(`${name} council role is not read-only and non-delegating`);
  if (name.startsWith('council-') && !/^completionGuard: false$/mu.test(text)) failures.push(`${name} council role must disable implementation-mutation completion semantics`);
}

const modelPolicy = JSON.parse(await readFile(path.join(root, 'config/model-policy.json'), 'utf8'));
if (modelPolicy.version !== 2 || modelPolicy.preset !== 'normal' || modelPolicy.basePreset !== 'normal' || Object.keys(modelPolicy.overrides ?? {}).length !== 0) failures.push('tracked model policy default is not minimal normal/user-owned state');
const routingPolicy = JSON.parse(await readFile(path.join(root, 'config/routing-policy.json'), 'utf8'));
const exactOmniRouteIds = [
  'deepseek/deepseek-v4-pro-high', 'deepseek/deepseek-v4-flash', 'openrouter/qwen/qwen3.8-27b',
  'openrouter/qwen/qwen3-coder-next', 'groq/qwen/qwen3-32b', 'auto/best-fast', 'auto/best-reasoning', 'auto/best-coding',
];
if (routingPolicy.version !== 1 || JSON.stringify(Object.keys(routingPolicy.presets ?? {}).sort()) !== JSON.stringify(['normal', 'token-saver'])) failures.push('routing policy must define exactly normal and token-saver');
if (routingPolicy.governor?.absoluteModelCallCeiling !== 42 || routingPolicy.governor?.maxRetriesPerDelegation !== 1 || routingPolicy.governor?.maxCorrectionRounds !== 2) failures.push('routing governor hard limits are missing or invalid');
for (const preset of ['normal', 'token-saver']) {
  const caps = routingPolicy.context?.[preset];
  const limits = routingPolicy.governor?.maxModelCalls?.[preset];
  if (!caps || !['handoffChars', 'evidenceChars', 'councilChars'].every((key) => Number.isSafeInteger(caps[key]) && caps[key] >= 1000 && caps[key] <= 12000)) failures.push(`routing context caps are invalid for ${preset}`);
  if (!limits || !['low', 'medium', 'high', 'max'].every((key) => Number.isSafeInteger(limits[key]) && limits[key] >= 1 && limits[key] <= 42)) failures.push(`routing governor call limits are invalid for ${preset}`);
}
for (const id of exactOmniRouteIds) {
  const definition = Object.values(routingPolicy.models ?? {}).find((entry) => entry.catalogId === id);
  if (!definition || definition.identity !== `omniroute/${id}` || definition.source !== 'OmniRoute') failures.push(`routing policy is missing exact OmniRoute catalog identity ${id}`);
  if (!settingsPatch.enabledModels?.includes(`omniroute/${id}`) || !settingsPatch.subagents?.modelScope?.allow?.includes(`omniroute/${id}`)) failures.push(`OmniRoute route is outside enforced model scope: ${id}`);
}
for (const preset of ['normal', 'token-saver']) {
  for (const role of expectedAgents.map((agent) => ({ 'correctness-reviewer': 'correctness', 'security-reviewer': 'security', 'simplicity-reviewer': 'simplicity', 'council-judge': 'council-judge' }[agent] ?? agent))) {
    const route = routingPolicy.presets?.[preset]?.roles?.[role];
    if (!route || !Array.isArray(route.chain) || route.chain.length === 0) failures.push(`routing policy missing ${preset}/${role}`);
    for (const candidate of route?.chain ?? []) if (!routingPolicy.models?.[candidate?.[0]] || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(candidate?.[1])) failures.push(`invalid routing candidate in ${preset}/${role}`);
  }
}
const callability = JSON.parse(await readFile(path.join(root, 'config/model-callability.json'), 'utf8'));
if (callability.version !== 1 || callability.entries?.['openai-codex/gpt-5.4']?.runtimeStatus !== 'RUNTIME_REJECTED') failures.push('tracked runtime-callability evidence does not reject the known unsupported model');
for (const [agent, route] of Object.entries(settingsPatch.subagents?.agentOverrides ?? {})) if (callability.entries?.[route.model]?.runtimeStatus === 'RUNTIME_REJECTED') failures.push(`${agent} active route uses a runtime-rejected model`);

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
