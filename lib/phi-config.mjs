import path from 'node:path';
import { localDirectories } from '../platform/index.mjs';
import { readLocalJson, writeLocalJson } from '../platform/shared/filesystem.mjs';
import { PRODUCT, themeName } from '../branding/terminal.mjs';

export function readPhiConfig(dirs = localDirectories()) {
  const value = readLocalJson(path.join(dirs.config, 'preferences.json'), { version: 1, theme: PRODUCT.defaultTheme });
  if (value.version !== 1 || Object.keys(value).some((key) => !['version', 'theme'].includes(key))) throw new Error('PHI_PREFERENCES_INVALID');
  return Object.freeze({ version: 1, theme: themeName(value.theme) });
}

export function setPhiTheme(name, dirs = localDirectories()) {
  const value = { version: 1, theme: themeName(name) };
  readPhiConfig(dirs);
  writeLocalJson(path.join(dirs.config, 'preferences.json'), value);
  return value;
}
