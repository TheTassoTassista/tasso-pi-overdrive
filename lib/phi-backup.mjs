import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRODUCT } from '../branding/terminal.mjs';
import { localDirectories, requireAutonomousBackend } from '../platform/index.mjs';
import { readLocalJson, writeLocalJson, inspectLocalPath } from '../platform/shared/filesystem.mjs';
import { readPhiConfig } from './phi-config.mjs';
import { validateStoredPolicy, ROUTING_POLICY } from './model-policy.mjs';
import { validateCallabilityCache } from './model-callability.mjs';
const KNOWN_MODELS = new Set(Object.values(ROUTING_POLICY.models).map((model) => model.identity));

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('PHI_BACKUP_SCHEMA_INVALID');
}
function selectedDefault(value) {
  exactKeys(value, ['provider', 'model', 'thinking']);
  if (value.provider !== 'openai-codex' || !KNOWN_MODELS.has(`${value.provider}/${value.model}`) || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.thinking)) throw new Error('PHI_BACKUP_DEFAULT_INVALID');
  return { provider: value.provider, model: value.model, thinking: value.thinking };
}
function selectedPolicy(value) {
  const result = validateStoredPolicy(value);
  for (const candidate of Object.values(result.overrides)) if (!KNOWN_MODELS.has(candidate.model) || !candidate.model.startsWith('openai-codex/')) throw new Error('PHI_BACKUP_ROUTE_UNATTESTED');
  // Provider provenance/callability is deliberately NOT exported to another
  // machine. Provider routes needing separate cost attestation are refused.
  return { version: result.version, preset: result.preset, basePreset: result.basePreset, overrides: result.overrides };
}
export function validatePhiBackup(value) {
  exactKeys(value, ['version', 'product', 'phiVersion', 'createdAt', 'preferences', 'default', 'rolePolicy']);
  if (value.version !== 1 || value.product !== 'Phi' || !/^\d+\.\d+\.\d+$/u.test(value.phiVersion) || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/u.test(value.createdAt)) throw new Error('PHI_BACKUP_SCHEMA_INVALID');
  exactKeys(value.preferences, ['version', 'theme']);
  if (value.preferences.version !== 1 || !['aurora', 'cyber', 'gold', 'gothic', 'mono', 'midnight-violet'].includes(value.preferences.theme)) throw new Error('PHI_BACKUP_SCHEMA_INVALID');
  return { ...value, default: selectedDefault(value.default), rolePolicy: selectedPolicy(value.rolePolicy) };
}

export function createPhiBackup(dirs = localDirectories()) {
  requireAutonomousBackend(); // private NTFS ACL attestation not yet implemented
  const settings = readLocalJson(path.join(dirs.agent, 'settings.json'), {});
  const policy = readLocalJson(path.join(dirs.legacyConfig, 'model-policy.json'), { version: 2, preset: 'normal', basePreset: 'normal', overrides: {} });
  const value = validatePhiBackup({ version: 1, product: 'Phi', phiVersion: PRODUCT.version, createdAt: new Date().toISOString(), preferences: readPhiConfig(dirs), default: { provider: settings.defaultProvider, model: settings.defaultModel, thinking: settings.defaultThinkingLevel }, rolePolicy: policy });
  const parent = path.join(dirs.state, 'backups');
  if (!inspectLocalPath(parent, { directory: true }).exists) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if ((fs.lstatSync(parent).mode & 0o077) !== 0) throw new Error('PHI_BACKUP_PERMISSIONS_DENIED');
  const file = path.join(parent, `phi-${randomUUID()}.json`);
  writeLocalJson(file, value);
  return { status: 'PASS', file, secretsIncluded: false, modelCalls: 0, includes: ['theme', 'interactive default', 'bounded subscription role preferences'], excluded: ['auth', 'credentials', 'callability evidence', 'sessions', 'logs', 'browser', 'memory', 'machine paths'] };
}

export function restorePhiBackup(file, { dirs = localDirectories(), apply = false } = {}) {
  requireAutonomousBackend();
  if (typeof file !== 'string' || !/^phi-[0-9a-f-]{36}\.json$/u.test(path.basename(file))) throw new Error('PHI_BACKUP_PATH_INVALID');
  const value = validatePhiBackup(readLocalJson(path.resolve(file)));
  if (!apply) return { status: 'PLAN', writes: 0, modelCalls: 0, requires: 'explicit --apply and existing machine-local callability evidence', restores: ['theme', 'interactive default', 'role preferences'], secretsIncluded: false };
  const callability = validateCallabilityCache(readLocalJson(path.join(dirs.legacyConfig, 'model-callability.json')));
  const required = [`${value.default.provider}/${value.default.model}`, ...Object.values(value.rolePolicy.overrides).map((route) => route.model)];
  if (required.some((identity) => callability.entries[identity]?.runtimeStatus !== 'RUNTIME_CALLABLE')) throw new Error('PHI_RESTORE_MODEL_UNATTESTED');
  const targets = [path.join(dirs.config, 'preferences.json'), path.join(dirs.agent, 'settings.json'), path.join(dirs.legacyConfig, 'model-policy.json')];
  const previous = targets.map((target) => readLocalJson(target, null));
  if (!previous[1]) throw new Error('PHI_RESTORE_BOOTSTRAP_REQUIRED');
  for (const target of targets) {
    inspectLocalPath(target);
    const parent = path.dirname(target);
    if (inspectLocalPath(parent, { directory: true }).exists && (fs.lstatSync(parent).mode & 0o077) !== 0) throw new Error('PHI_RESTORE_PERMISSIONS_DENIED');
  }
  const values = [value.preferences, { ...previous[1], defaultProvider: value.default.provider, defaultModel: value.default.model, defaultThinkingLevel: value.default.thinking }, value.rolePolicy];
  const written = [];
  try {
    for (let index = 0; index < targets.length; index++) { writeLocalJson(targets[index], values[index]); written.push(index); }
  } catch {
    let rollbackFailed = false;
    for (const index of written.reverse()) {
      try { if (previous[index]) writeLocalJson(targets[index], previous[index]); else fs.unlinkSync(targets[index]); } catch { rollbackFailed = true; }
    }
    throw new Error(rollbackFailed ? 'PHI_RESTORE_ROLLBACK_INCOMPLETE' : 'PHI_RESTORE_FAILED_ROLLED_BACK');
  }
  return { status: 'PASS', writes: targets.length, modelCalls: 0, authModified: false, callabilityImported: false };
}
