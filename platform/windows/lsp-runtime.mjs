import fs from 'node:fs';
import path from 'node:path';
import { createRequire, builtinModules } from 'node:module';
import { createHash } from 'node:crypto';

export const WINDOWS_JSON_LSP = Object.freeze({ package: 'vscode-langservers-extracted', version: '4.10.0',
  entry: 'vscode-langservers-extracted/lib/json-language-server/node/jsonServerMain.js',
  argv: Object.freeze(['--no-addons', '--no-global-search-paths', '--preserve-symlinks-main', '--preserve-symlinks', '../assets/node_modules/vscode-langservers-extracted/lib/json-language-server/node/jsonServerMain.js', '--stdio']) });
const fail = () => { throw new Error('PHI_LSP_RUNTIME_REJECTED'); };
const builtins = new Set(builtinModules.flatMap(x => [x, 'node:' + x]));

// Trusted runtime collector, NOT caller-selected dependencies or host grants.
// Export just the pinned server's literal CommonJS closure; unknown/dynamic
// imports get no ambient filesystem access and fail in the LPAC copy.
export function windowsJsonLspAssets(runtime) {
  const root = fs.realpathSync(path.join(runtime, 'node_modules'));
  const lock = JSON.parse(fs.readFileSync(path.join(runtime, 'package-lock.json'), 'utf8'));
  const files = Object.create(null), seen = new Set(); let bytes = 0;
  const read = (file) => {
    if (!file.startsWith(root + path.sep) || fs.realpathSync(file) !== file) fail();
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 512n * 1024n) fail();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail();
      const content = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || content.includes(0) || fs.realpathSync(file) !== file) fail();
      return new TextDecoder('utf-8', { fatal: true }).decode(content);
    } finally { fs.closeSync(fd); }
  };
  const pending = [path.join(root, WINDOWS_JSON_LSP.entry)];
  const add = (file, text) => {
    const relative = 'node_modules/' + path.relative(root, file).split(path.sep).join('/');
    if (Object.hasOwn(files, relative)) return;
    bytes += Buffer.byteLength(text);
    if (Object.keys(files).length >= 512 || bytes > 2 * 1024 * 1024) fail();
    files[relative] = text;
  };
  while (pending.length) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    const text = read(file); add(file, text);
    let directory = path.dirname(file);
    while (directory !== root) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const source = read(manifest), pkg = JSON.parse(source);
        const key = 'node_modules/' + path.relative(root, directory).split(path.sep).join('/');
        const pinned = lock.packages?.[key];
        if (!pinned || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(pinned.version) || pkg.version !== pinned.version) fail();
        if (key === 'node_modules/' + WINDOWS_JSON_LSP.package && pkg.version !== WINDOWS_JSON_LSP.version) fail();
        add(manifest, source); break;
      }
      directory = path.dirname(directory);
      if (!directory.startsWith(root)) fail();
    }
    for (const match of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      if (builtins.has(match[1])) continue;
      const next = createRequire(file).resolve(match[1]);
      if (!path.isAbsolute(next)) fail(); pending.push(next);
    }
  }
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  return Object.freeze({ files: Object.freeze(files), digest, fileCount: Object.keys(files).length, bytes });
}
