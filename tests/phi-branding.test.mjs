import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT, THEMES, renderSplash, terminalCapabilities, themeName } from '../branding/terminal.mjs';

test('Phi has an independent portable product identity', () => {
  assert.equal(PRODUCT.name, 'Phi'); assert.equal(PRODUCT.command, 'phi');
  assert.notEqual(PRODUCT.version, PRODUCT.piVersion);
});
test('NO_COLOR disables even explicitly truecolor Windows Terminal', () => {
  const caps = terminalCapabilities({ isTTY: true, columns: 80 }, { WT_SESSION: 'test', NO_COLOR: '' }, 'win32');
  assert.equal(caps.color, false); assert.equal(caps.unicode, true);
});
test('non-TTY and dumb terminal output is plain ASCII without ANSI escapes', () => {
  for (const stream of [{ isTTY: false }, { isTTY: true }]) {
    const rendered = renderSplash({ capabilities: terminalCapabilities(stream, { TERM: 'dumb' }) });
    assert.doesNotMatch(rendered, /[^\x00-\x7f]|\x1b/u); assert.match(rendered, /PHI/u);
  }
});
test('ambiguous legacy Windows terminal falls back without Unicode dependency', () => {
  assert.equal(terminalCapabilities({ isTTY: true }, {}, 'win32').unicode, false);
});
test('all bundled themes fit terminal widths 1 through 160', () => {
  for (const theme of Object.keys(THEMES)) for (const width of [1, 8, 20, 45, 46, 64, 80, 120, 160]) {
    const rendered = renderSplash({ theme, capabilities: { color: false, unicode: true, width }, state: { model: 'gpt-6-sol:medium' } });
    assert.ok(rendered.split('\n').every((line) => [...line].length <= width), `${theme}/${width}`);
  }
});
test('truecolor gradients reset colors and mono emits no control sequences', () => {
  const caps = { color: true, truecolor: true, unicode: true, width: 80 };
  assert.match(renderSplash({ capabilities: caps }), /\x1b\[38;2;/u);
  assert.doesNotMatch(renderSplash({ theme: 'mono', capabilities: caps }), /\x1b/u);
});
test('untrusted startup state cannot inject terminal escapes or line breaks', () => {
  const rendered = renderSplash({ capabilities: { color: false, unicode: false, width: 80 }, state: { model: '\x1b[31mFORGED\nPASS' } });
  assert.doesNotMatch(rendered, /\x1b|FORGED\n/u);
});
test('theme names cannot be paths or dynamically evaluated', () => {
  for (const name of ['../aurora', 'toString', 'constructor', '\x1b', 'unknown']) assert.throws(() => themeName(name), /PHI_UNKNOWN_THEME/u);
});
