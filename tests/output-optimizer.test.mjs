import test from 'node:test';
import assert from 'node:assert/strict';
import { compactToolText } from '../lib/output-optimizer.mjs';

test('small output stays intact', () => {
  const result = compactToolText('alpha\nbeta');
  assert.equal(result.text, 'alpha\nbeta');
  assert.equal(result.compacted, false);
});

test('duplicate runs collapse deterministically', () => {
  const result = compactToolText('same\nsame\nsame\nnext');
  assert.match(result.text, /repeated 2 more times/u);
});

test('large output retains diagnostics and tail', () => {
  const lines = Array.from({ length: 500 }, (_, index) => index === 250 ? 'ERROR important failure' : `line ${index}`);
  const result = compactToolText(lines.join('\n'), { maxChars: 100, maxLines: 20, headLines: 4, tailLines: 4, diagnosticLines: 5 });
  assert.equal(result.compacted, true);
  assert.match(result.text, /ERROR important failure/u);
  assert.match(result.text, /line 499/u);
  assert.doesNotMatch(result.text, /line 200\n/u);
});

test('critical diagnostics survive first, middle, late warning floods, and last positions', () => {
  const lines = [
    'FATAL first failure',
    ...Array.from({ length: 180 }, (_, index) => `warning ${index}`),
    'AssertionError middle failure',
    ...Array.from({ length: 220 }, (_, index) => `WARNING late ${index}`),
    'ERROR after hundreds of warnings',
    ...Array.from({ length: 120 }, (_, index) => `noise ${index}`),
    'panic last failure',
  ];
  const result = compactToolText(lines.join('\n'), { maxChars: 100, maxLines: 20, headLines: 2, tailLines: 2, diagnosticLines: 5 });
  for (const expected of ['FATAL first failure', 'AssertionError middle failure', 'ERROR after hundreds of warnings', 'panic last failure']) {
    assert.match(result.text, new RegExp(expected, 'u'), expected);
  }
  assert.equal(result.warningLinesRetained, 5);
});

test('critical diagnostic count is not capped by warning/diagnostic limit', () => {
  const critical = Array.from({ length: 120 }, (_, index) => `ERROR unique-${index}`);
  const result = compactToolText(['head', ...critical, 'tail'].join('\n'), { maxChars: 20, maxLines: 5, headLines: 1, tailLines: 1, diagnosticLines: 2 });
  for (const line of critical) assert.match(result.text, new RegExp(line, 'u'));
  assert.equal(result.criticalLinesRetained, 120);
});
