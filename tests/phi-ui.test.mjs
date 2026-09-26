import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installPhiUI } from '../lib/phi-ui.mjs';

test('Phi header is display-only, scoped to phi and cannot mutate routing/tools', () => {
  const events = new Map();
  const pi = { on(name, handler) { events.set(name, handler); } };
  installPhiUI(pi, {}); assert.equal(events.size, 0);
  installPhiUI(pi, { PHI_LAUNCH: '1', PHI_THEME: 'gold', NO_COLOR: '' });
  assert.deepEqual([...events.keys()], ['session_start', 'model_select']);
  let header;
  const ctx = { hasUI: true, model: { id: 'gpt-6-sol' }, ui: { setHeader(factory) { header = factory(); } } };
  events.get('session_start')({}, ctx);
  const rows = header.render(80);
  assert.match(rows.join('\n'), /PHI/u); assert.match(rows.join('\n'), /Phi 1\.0\.0/u); assert.match(rows.join('\n'), /gpt-6-sol/u);
  assert.doesNotMatch(rows.join('\n'), /\x1b/u);
  assert.ok(header.render(20).every((row) => row.length <= 20));
});
test('Phi branding never injects output or installs a header in RPC/non-UI mode', () => {
  const events = new Map();
  installPhiUI({ on(name, handler) { events.set(name, handler); } }, { PHI_LAUNCH: '1' });
  assert.doesNotThrow(() => events.get('session_start')({}, { hasUI: false }));
});
test('early Phi UI loading cannot initialize/freeze the routing controller JSON', () => {
  const source = fs.readFileSync(new URL('../lib/phi-ui.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\/model-policy\.mjs['"]|import\(['"]\.\/model-policy\.mjs/u);
  assert.doesNotMatch(source, /registerTool|setActiveTools|setModel|modelRegistry|sendUserMessage/u);
});
