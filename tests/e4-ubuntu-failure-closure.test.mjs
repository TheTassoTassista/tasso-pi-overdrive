import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ledger = readFileSync(new URL('../docs/e4-ubuntu-failure-closure-v1.md', import.meta.url), 'utf8');
const expected = [
  'browser-engine.test.mjs:41', 'browser-engine.test.mjs:90',
  'clone-runtime-gate.test.mjs:107',
  'dap-engine.test.mjs:248', 'dap-engine.test.mjs:302', 'dap-engine.test.mjs:353', 'dap-engine.test.mjs:402',
  'lsp-additional-languages.test.mjs:20', 'lsp-additional-languages.test.mjs:33',
  'lsp-additional-languages.test.mjs:46', 'lsp-additional-languages.test.mjs:61',
  'lsp-manager.test.mjs:20', 'lsp-manager.test.mjs:57', 'lsp-manager.test.mjs:79',
  'lsp-manager.test.mjs:96', 'lsp-manager.test.mjs:112', 'lsp-manager.test.mjs:146',
  'lsp-manager.test.mjs:180', 'lsp-manager.test.mjs:265', 'lsp-manager.test.mjs:292',
  'lsp-write-guard.test.mjs:161',
  'persistent-eval.test.mjs:37', 'persistent-eval.test.mjs:48', 'persistent-eval.test.mjs:87',
  'persistent-eval.test.mjs:110', 'persistent-eval.test.mjs:124', 'persistent-eval.test.mjs:141',
  'pi-launcher.test.mjs:142', 'sandbox.test.mjs:11',
].map((id) => `tests/${id}`);

test('Preflight 2 closure ledger accounts for all 29 exact failures once without promoting proposed fixes', () => {
  const rows = [...ledger.matchAll(/^\| (\d+) \| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gmu)];
  assert.equal(rows.length, 29);
  assert.deepEqual(rows.map((row) => Number(row[1])), Array.from({ length: 29 }, (_, index) => index + 1));
  assert.deepEqual(rows.map((row) => row[2]), expected);
  assert.equal(new Set(rows.map((row) => row[2])).size, 29);
  for (const row of rows) {
    assert.match(row[3], /full check/u);
    assert.match(row[4], /\b(?:KNOWN|LIKELY|POSSIBLE|UNKNOWN)\b/u);
    assert.match(row[5], /; [PTCG]$/u);
    assert.ok(row[6].length >= 20, 'every failure needs a concrete proposed disposition');
    assert.match(row[7], /^(?:NOT_RUN|LOCAL_[A-Z0-9_]+|NODE26_EXACT_FOCUS_PASS); OPEN$/u);
  }
  assert.match(ledger, /PREFLIGHT2_FAILURE_COUNT = 29/u);
  assert.match(ledger, /LEDGER_ENTRY_COUNT = 29/u);
  assert.match(ledger, /Tier A must retain strict nested-userns denial/u);
  assert.match(ledger, /Tier B may allow child userns for \*trusted certification orchestration only\*/u);
  assert.match(ledger, /PROVEN SAME MISSING HERMETIC DEPENDENCY NOW SUPPLIED/u);
  assert.match(ledger, /Native image callability remains unverified/u);
});
