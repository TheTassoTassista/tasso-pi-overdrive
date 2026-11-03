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

// Read only the catalog bundled with the already-pinned Pi runtime. This is
// configuration identity, not proof of authentication or live callability.
export function bundledPiModel(provider, id, env = process.env) {
  if (!/^[a-z0-9-]{2,64}$/u.test(provider ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,127}$/u.test(id ?? '')) return null;
  const runtime = discoverPiRuntime(env);
  if (!runtime) return null;
  try {
    // npm may place a matching Pi package beside pi-coding-agent rather than
    // nesting it. Prefer the nested copy and reject a mismatched copy there.
    const root = [path.join(runtime.root, 'node_modules', '@earendil-works', 'pi-ai'), path.join(runtime.root, '..', 'pi-ai')]
      .find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
    if (!root) return null;
    const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (packageInfo.name !== '@earendil-works/pi-ai' || packageInfo.version !== runtime.version) return null;
    const data = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'providers', 'data', `${provider}.json`), 'utf8'));
    const model = Object.values(data).flatMap((group) => group && typeof group === 'object' ? Object.values(group) : []).find((entry) => entry?.provider === provider && entry?.id === id);
    if (!model || !model.cost || !Number.isFinite(model.cost.input) || !Number.isFinite(model.cost.output) || model.cost.input < 0 || model.cost.output < 0) return null;
    return { provider, id, cost: { input: model.cost.input, output: model.cost.output } };
  } catch { return null; }
}
