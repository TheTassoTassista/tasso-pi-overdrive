import test from 'node:test';
import assert from 'node:assert/strict';
import { inferOperatorRepair } from './fixtures/phi-autonomy-repair.mjs';

test('E1 offline seam derives repair from observed source and two assertions', () => {
  const result = inferOperatorRepair('function add(a, b) { return a - b; }',
    "assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1);");
  assert.deepEqual(result, { oldText: 'return a - b;', newText: 'return a + b;', assertionCount: 2, operation: '+' });
});

test('E1 offline seam rejects absent, ambiguous and already-correct evidence', () => {
  assert.throws(() => inferOperatorRepair('function add(a, b) { return a - b; }', 'assert.equal(add(2, 3), 5);'), /TEST_EVIDENCE_INVALID/u);
  assert.throws(() => inferOperatorRepair('function add(a, b) { return a + b; }',
    'assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1);'), /REPAIR_AMBIGUOUS/u);
  assert.throws(() => inferOperatorRepair('const answer = 5',
    'assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1);'), /SOURCE_EVIDENCE_INVALID/u);
  assert.throws(() => inferOperatorRepair('function add(a, b) { return a - b; }',
    'assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 99);'), /REPAIR_AMBIGUOUS/u);
});
