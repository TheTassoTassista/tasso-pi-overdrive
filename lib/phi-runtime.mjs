import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT } from '../branding/terminal.mjs';

export function discoverPiRuntime(env = process.env) {
  const roots = env.PHI_PI_ROOT ? [path.resolve(env.PHI_PI_ROOT)] : [path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'), path.resolve(path.dirname(process.execPath), 'node_modules', '@earendil-works', 'pi-coding-agent')];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const entry = path.resolve(root, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.pi);
      const relative = path.relative(root, entry);
      if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== PRODUCT.piVersion || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || !fs.statSync(entry).isFile()) continue;
      return { root: fs.realpathSync(root), entry: fs.realpathSync(entry), version: pkg.version, node: process.execPath };
    } catch {}
  }
  return null;
}
