#!/usr/bin/env node
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

const [manifestPath, packagesPath] = process.argv.slice(2);
if (!manifestPath || !packagesPath) {
  process.stderr.write('usage: update-manifest.mjs MANIFEST PACKAGES_JSON\n');
  process.exit(2);
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packages = JSON.parse(await readFile(packagesPath, 'utf8'));
manifest.selectedSources = packages.selected;
const temp = `${manifestPath}.${process.pid}.tmp`;
await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await rename(temp, manifestPath);
await chmod(manifestPath, 0o600);
