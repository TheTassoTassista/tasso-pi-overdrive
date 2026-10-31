import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const docFile = path.join(root, 'docs', 'PHI_ENCYCLOPEDIA.md');

test('encyclopedia links resolve and statically registered Phi commands are catalogued', () => {
  const document = fs.readFileSync(docFile, 'utf8');
  for (const [, link] of document.matchAll(/\]\(([^)]+)\)/gu)) {
    if (link.startsWith('#')) continue;
    const target = path.resolve(path.dirname(docFile), decodeURIComponent(link.split('#')[0]));
    assert.ok(fs.existsSync(target), `missing documentation target: ${link}`);
  }
  for (const file of fs.readdirSync(path.join(root, 'extensions')).filter((name) => name.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(root, 'extensions', file), 'utf8');
    for (const [, command] of source.matchAll(/pi\.registerCommand\("([^"]+)"/gu)) {
      assert.ok(document.includes(`\`/${command}\``), `undocumented command: ${command}`);
    }
  }
  for (const file of fs.readdirSync(path.join(root, 'prompts')).filter((name) => name.endsWith('.md'))) {
    assert.ok(document.includes(`\`/${file.slice(0, -3)}\``), `undocumented prompt: ${file}`);
  }
});
