#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const requiredJson = ['package.json', 'config/settings-patch.json', 'config/packages.json', 'config/pi-fff.json', 'config/lsp.json', 'config/subagents.json', 'config/browser.json'];
for (const relative of requiredJson) {
  try { JSON.parse(await readFile(path.join(root, relative), 'utf8')); }
  catch (error) { failures.push(`${relative}: invalid JSON (${error.message})`); }
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const relative of pkg.pi.extensions) {
  if (!relative.startsWith('./extensions/')) failures.push(`unexpected extension path ${relative}`);
}
const packagePolicy = JSON.parse(await readFile(path.join(root, 'config/packages.json'), 'utf8'));
for (const source of packagePolicy.selected) {
  if (!/@\d+\.\d+\.\d+$/u.test(source)) failures.push(`package is not exactly pinned: ${source}`);
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
