import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function containsPath(root, target, api = path) {
  const relative = api.relative(api.resolve(root), api.resolve(target));
  return relative === '' || (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${api.sep}`));
}

export function portableRelativePath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f<>:"|?*]/u.test(value) || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) throw new Error('PHI_PATH_INVALID');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error('PHI_PATH_INVALID');
  return parts;
}

// Local configuration only. This is not a replacement for the autonomous
// sandbox/transactional workspace filesystem and grants no model authority.
export function inspectLocalPath(file, { directory = false } = {}) {
  const full = path.resolve(file);
  let cursor = path.parse(full).root;
  for (const component of path.relative(cursor, full).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') return { exists: false, full }; throw error; }
    if (stat.isSymbolicLink()) throw new Error('PHI_CONFIG_LINK_DENIED');
    if (cursor === full) {
      if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw new Error('PHI_CONFIG_TYPE_DENIED');
      if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('PHI_CONFIG_OWNER_DENIED');
    } else if (!stat.isDirectory()) throw new Error('PHI_CONFIG_PARENT_DENIED');
  }
  return { exists: true, full };
}

export function readLocalJson(file, fallback = null) {
  if (!inspectLocalPath(file).exists) return fallback;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || stat.dev !== current.dev || stat.ino !== current.ino || current.isSymbolicLink()) throw new Error('PHI_CONFIG_CHANGED');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

export function writeLocalText(file, value, mode = 0o600) {
  inspectLocalPath(file);
  const parent = path.dirname(file);
  if (!inspectLocalPath(parent, { directory: true }).exists) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  inspectLocalPath(parent, { directory: true });
  if (process.platform !== 'win32' && (fs.lstatSync(parent).mode & 0o022) !== 0) throw new Error('PHI_CONFIG_PERMISSIONS_DENIED');
  const canonical = fs.realpathSync(parent);
  const temp = path.join(canonical, `.phi-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
  try {
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
    if (fs.realpathSync(parent) !== canonical) throw new Error('PHI_CONFIG_PARENT_CHANGED');
    inspectLocalPath(file);
    fs.renameSync(temp, file);
  } finally { fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function writeLocalJson(file, value) {
  writeLocalText(file, `${JSON.stringify(value, null, 2)}\n`);
}
