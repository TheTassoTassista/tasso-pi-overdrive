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
