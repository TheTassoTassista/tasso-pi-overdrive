import path from 'node:path';

export const clone = (value) => value === undefined ? undefined : structuredClone(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sourceOf = (entry) => typeof entry === 'string' ? entry : entry && typeof entry.source === 'string' ? entry.source : undefined;

function sourceResolvesTo(source, target, settingsPath) {
  if (!source || !target || /^(?:npm:|git:|https?:|ssh:)/u.test(source)) return false;
  return path.resolve(path.dirname(settingsPath), source) === path.resolve(target);
}

export function merge(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return clone(overlay);
  const output = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(overlay)) output[key] = merge(output[key], value);
  return output;
}

export function snapshotFields(settings, patch) {
  const result = {};
  for (const key of Object.keys(patch)) {
    result[key] = Object.hasOwn(settings, key) ? { present: true, value: clone(settings[key]) } : { present: false };
  }
  return result;
}

export function shouldPreserveSnapshot(existing, settingsPath) {
  return Boolean(existing?.version === 1 && existing.settingsPath === settingsPath && existing.originalFields);
}

export function restoreFields(current, original, applied) {
  for (const [key, record] of Object.entries(original)) {
    if (!equal(current[key], applied[key])) continue;
    if (record.present) current[key] = clone(record.value);
    else delete current[key];
  }
}

export function removeSelectedPackages(settings, manifest, settingsPath) {
  const protectedSources = new Set((manifest.originalPackages ?? []).map(sourceOf).filter(Boolean));
  const selectedSources = new Set(manifest.selectedSources ?? []);
  if (manifest.packageRoot) selectedSources.add(manifest.packageRoot);
  settings.packages = (settings.packages ?? []).filter((entry) => {
    const source = sourceOf(entry);
    const selected = source && (selectedSources.has(source) || sourceResolvesTo(source, manifest.packageRoot, settingsPath));
    return !selected || protectedSources.has(source);
  });
  if (settings.packages.length === 0 && !(manifest.originalPackages ?? []).length) delete settings.packages;
}

export function replaceLocalPackageRoot(settings, settingsPath, priorRoot, nextRoot) {
  const packages = (settings.packages ?? []).filter((entry) => {
    const source = sourceOf(entry);
    if (!source || /^(?:npm:|git:|https?:|ssh:)/u.test(source)) return true;
    const resolved = path.resolve(path.dirname(settingsPath), source);
    return resolved !== path.resolve(priorRoot ?? nextRoot) && resolved !== path.resolve(nextRoot);
  });
  packages.push(path.resolve(nextRoot));
  settings.packages = packages;
  return settings;
}
