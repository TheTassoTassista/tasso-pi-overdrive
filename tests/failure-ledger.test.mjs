import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { failureLedgerEvidence, mainSuiteEvidence } from '../lib/phi-certification-evidence.mjs';
import { currentFailureStageEvidence } from '../lib/phi-current-failure-evidence.mjs';

const reporter = new URL('../scripts/phi-runtime-reporter.mjs', import.meta.url).href;

function fixture(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-ledger-'));
  try {
    const tests = path.join(root, 'tests');
    fs.mkdirSync(tests);
    const file = path.join(tests, 'phi-ledger-fixture.test.mjs');
    fs.writeFileSync(file, source);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter', reporter, file],
      { cwd: root, encoding: 'utf8', timeout: 30000, env });
    assert.equal(result.error, undefined);
    return result;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const oneFailure = `import test from 'node:test';
import assert from 'node:assert/strict';
test('stable assertion identity', () => assert.equal(1, 2));
test('passing control', () => assert.equal(1, 1));
`;
const twoFailures = `import test from 'node:test';
import assert from 'node:assert/strict';
test('stable assertion identity', () => assert.equal(1, 2));
test('stable exception identity', () => { throw new Error('UNSTRUCTURED_CANARY_DO_NOT_PUBLISH'); });
test('passing control', () => assert.equal(1, 1));
`;

test('one real reporter failure yields one bounded stable ledger entry', () => {
  const first = fixture(oneFailure);
  const second = fixture(oneFailure);
  assert.equal(first.status, 1);
  const ledger = failureLedgerEvidence(first.stdout, 1, first.status);
  assert.equal(ledger.status, 'COMPLETE');
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].ordinal, 1);
  assert.equal(ledger.entries[0].result, 'FAIL');
  assert.equal(ledger.entries[0].sourceFile, 'tests/phi-ledger-fixture.test.mjs');
  assert.equal(ledger.entries[0].category, 'TEST_CODE_FAILURE');
  assert.equal(ledger.entries[0].assertionCategory, 'ASSERTION');
  assert.match(ledger.entries[0].testId, /^[a-f0-9]{64}$/u);
  assert.equal(ledger.entries[0].testId, failureLedgerEvidence(second.stdout, 1, second.status).entries[0].testId);
  assert.equal(ledger.entries[0].suiteExitCategory, 'NONZERO_SUITE_EXIT');
});

test('multiple failures match aggregate count and nonzero wrapper output contains no raw diagnostic', () => {
  const run = fixture(twoFailures);
  assert.equal(run.status, 1);
  const ledger = failureLedgerEvidence(run.stdout, 2, run.status);
  assert.equal(ledger.status, 'COMPLETE');
  assert.deepEqual(ledger.entries.map(row => row.ordinal), [1, 2]);
  assert.equal(new Set(ledger.entries.map(row => row.testId)).size, 2);
  const wrapper = mainSuiteEvidence({ status: 1, stdout: run.stdout,
    stderr: 'UNSTRUCTURED_STDERR_CANARY_DO_NOT_PUBLISH' }, 'linux');
  assert.equal(wrapper.status, 'FAIL');
  assert.deepEqual(wrapper.failureLedger, ledger);
  const published = JSON.stringify(wrapper);
  assert.equal(published.includes('UNSTRUCTURED_CANARY_DO_NOT_PUBLISH'), false);
  assert.equal(published.includes('UNSTRUCTURED_STDERR_CANARY_DO_NOT_PUBLISH'), false);
  assert.equal(published.includes('stable assertion identity'), false);
  assert.equal(published.includes(path.join(os.tmpdir(), 'phi-ledger-')), false);
  assert.equal(published.includes('ERR_ASSERTION:'), false);
});

test('missing, malformed, duplicate and aggregate-mismatched failure rows fail closed', () => {
  const run = fixture(twoFailures);
  assert.equal(failureLedgerEvidence(run.stdout, 3, run.status).status, 'FAILURE_LEDGER_INCOMPLETE');
  const missing = run.stdout.split(/\r?\n/u).filter(line =>
    !(line.startsWith('# PHI_RUNTIME ') && line.includes('"failed":true') && line.includes('"ordinal":2'))).join('\n');
  assert.equal(failureLedgerEvidence(missing, 2, run.status).status, 'FAILURE_LEDGER_INCOMPLETE');
  const malformed = run.stdout.replace(/"testId":"[0-9a-f]{64}"/u, '"testId":null');
  assert.equal(failureLedgerEvidence(malformed, 2, run.status).status, 'FAILURE_LEDGER_INCOMPLETE');
  const id = failureLedgerEvidence(run.stdout, 2, run.status).entries[0].testId;
  const duplicate = run.stdout.replace(/("ordinal":2[^\n]*"testId":")[0-9a-f]{64}/u, `$1${id}`);
  assert.equal(failureLedgerEvidence(duplicate, 2, run.status).status, 'FAILURE_LEDGER_INCOMPLETE');
});

test('zero failures do not fabricate entries; contradictory TAP fails closed', () => {
  const run = fixture(`import test from 'node:test'; test('passing', () => {});`);
  assert.equal(run.status, 0);
  assert.deepEqual(failureLedgerEvidence(run.stdout, 0, run.status),
    { status: 'NONE', expected: 0, observed: 0, entries: [] });
  assert.equal(failureLedgerEvidence(run.stdout.replace('ok 1 - passing', 'not ok 1 - passing'), 0, run.status).status,
    'FAILURE_LEDGER_INCOMPLETE');
});

test('diagnostic selector cannot start default foundation or integrated jobs and has no clone/Pi steps', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const diagnostic = workflow.split('  windows-main-failure-diagnostic:\n')[1]?.split('  ordinary-create-finalization-diagnostic:\n')[0];
  assert.ok(diagnostic);
  assert.match(diagnostic, /node scripts\/phi-owned-main-suite\.mjs/u);
  assert.match(diagnostic, /Final fixed-scope ownership baseline even after failure\n\s+if: always\(\)/u);
  assert.doesNotMatch(diagnostic, /phi-clean-room|phi-worker-pi-smoke|phi-bounded-workflow-pi-smoke/u);
  const defaultJob = workflow.split('  native-foundation:\n')[1]?.split('\n  [a-z][a-z-]+:\n')[0];
  assert.match(defaultJob, /!inputs\['windows-main-failure-diagnostic-only'\]/u);
  const integrated = workflow.split('  integrated-ubuntu:\n')[1]?.split('  windows-main-failure-diagnostic:\n')[0];
  assert.match(integrated, /!inputs\['windows-main-failure-diagnostic-only'\]/u);
});

test('focused stage marker survives the reporter but publishes only fixed bounded metadata', () => {
  const helper = new URL('./phi-current-failure-diagnostic.mjs', import.meta.url).href;
  const run = fixture(`import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticNativeBody } from ${JSON.stringify(helper)};
test('selected bounded failure', {}, diagnosticNativeBody('selected bounded failure', 'PUBLICATION', import.meta.url, async (mark, note) => {
  mark('NATIVE_PUBLISH');
  note('workerEditExit', 5);
  assert.equal('PRIVATE_SENTINEL_NEVER_IN_RESULT', 'different');
}));`);
  assert.equal(run.status, 1);
  const ledger = failureLedgerEvidence(run.stdout, 1, run.status);
  assert.equal(ledger.status, 'COMPLETE');
  const stage = currentFailureStageEvidence(run.stdout, ledger.entries[0].testId, 'PUBLICATION', true);
  assert.deepEqual(stage, { status: 'COMPLETE', stage: 'NATIVE_PUBLISH', category: 'ASSERTION', facts: { workerEditExit: 5 } });
  assert.equal(JSON.stringify({ ledger, stage }).includes('PRIVATE_SENTINEL_NEVER_IN_RESULT'), false);
  const malformed = run.stdout.replace('"stage":"NATIVE_PUBLISH"', '"stage":"PRIVATE_SENTINEL_NEVER_IN_RESULT"');
  assert.equal(currentFailureStageEvidence(malformed, ledger.entries[0].testId, 'PUBLICATION', true).status, 'DIAGNOSTIC_INCOMPLETE');
  const invalidFact = run.stdout.replace('"workerEditExit":5', '"workerEditExit":"PRIVATE_SENTINEL_NEVER_IN_RESULT"');
  assert.equal(currentFailureStageEvidence(invalidFact, ledger.entries[0].testId, 'PUBLICATION', true).status, 'DIAGNOSTIC_INCOMPLETE');
  assert.equal(currentFailureStageEvidence(run.stdout, '0'.repeat(64), 'PUBLICATION', true).status, 'DIAGNOSTIC_INCOMPLETE');
  assert.equal(currentFailureStageEvidence(run.stdout, ledger.entries[0].testId, 'PUBLICATION', false).status, 'DIAGNOSTIC_INCOMPLETE');
});

test('seven-ID focused selector is isolated from full, clone, Pi and ordinary jobs', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const job = workflow.split('  current-failure-focused:\n')[1]?.split('  ordinary-create-finalization-diagnostic:\n')[0];
  assert.ok(job);
  assert.match(job, /node scripts\/phi-current-failures-focused\.mjs/u);
  assert.match(job, /Final fixed-scope ownership baseline even after failure\n\s+if: always\(\)/u);
  assert.doesNotMatch(job, /phi-clean-room|phi-worker-pi-smoke|phi-bounded-workflow-pi-smoke|phi-owned-main-suite/u);
  const defaultJob = workflow.split('  native-foundation:\n')[1]?.split('\n  [a-z][a-z-]+:\n')[0];
  assert.match(defaultJob, /!inputs\['current-failure-focused-only'\]/u);
  const integrated = workflow.split('  integrated-ubuntu:\n')[1]?.split('  windows-main-failure-diagnostic:\n')[0];
  assert.match(integrated, /!inputs\['current-failure-focused-only'\]/u);
});

test('B/C contextual diagnosis preserves native file order, exact corpus size and unchanged owner limit', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const job = workflow.split('  current-failure-focused:\n')[1]?.split('  ordinary-create-finalization-diagnostic:\n')[0];
  const script = fs.readFileSync(new URL('../scripts/phi-current-failures-focused.mjs', import.meta.url), 'utf8');
  assert.match(job, /inputs\['current-failure-context-only'\]/u);
  assert.match(job, /'--context'/u);
  assert.doesNotMatch(job, /phi-clean-room|phi-worker-pi-smoke|phi-bounded-workflow-pi-smoke|phi-owned-main-suite/u);
  assert.match(script, /\[\.\.\.cases\[5\], 20\], \[\.\.\.cases\[6\], 8\]/u);
  assert.match(script, /path\.join\(root, sourceFile\)\], \{ cwd: root, timeoutMs: 120000 \}/u);
  assert.match(script, /counts\.tests === expected/u);
  assert.match(script, /jobEmptyVerified === true && owner\.pipesDrained === true/u);
  const defaultJob = workflow.split('  native-foundation:\n')[1]?.split('\n  [a-z][a-z-]+:\n')[0];
  assert.match(defaultJob, /!inputs\['current-failure-context-only'\]/u);
  const integrated = workflow.split('  integrated-ubuntu:\n')[1]?.split('  windows-main-failure-diagnostic:\n')[0];
  assert.match(integrated, /!inputs\['current-failure-context-only'\]/u);
});

test('cross-file seven-case diagnosis remains bounded and excludes certifying jobs', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/phi-foundation.yml', import.meta.url), 'utf8');
  const job = workflow.split('  current-failure-focused:\n')[1]?.split('  ordinary-create-finalization-diagnostic:\n')[0];
  const script = fs.readFileSync(new URL('../scripts/phi-current-failures-focused.mjs', import.meta.url), 'utf8');
  assert.match(job, /inputs\['current-failure-cross-context-only'\]/u);
  assert.match(job, /'--cross-context'/u);
  assert.doesNotMatch(job, /phi-clean-room|phi-worker-pi-smoke|phi-bounded-workflow-pi-smoke|phi-owned-main-suite/u);
  assert.match(script, /'tests\/phi-publication\.test\.mjs', 'tests\/phi-windows-broker\.test\.mjs', 'tests\/phi-windows-lsp\.test\.mjs'/u);
  assert.match(script, /files\.map\(file => path\.join\(root, file\)\)\], \{ cwd: root, timeoutMs: 120000 \}/u);
  assert.match(script, /counts\.tests === 91 && counts\.pass \+ counts\.fail === 7/u);
  assert.match(script, /jobEmptyVerified === true && owner\.pipesDrained === true/u);
  const defaultJob = workflow.split('  native-foundation:\n')[1];
  assert.match(defaultJob, /!inputs\['current-failure-cross-context-only'\]/u);
  const integrated = workflow.split('  integrated-ubuntu:\n')[1]?.split('  windows-main-failure-diagnostic:\n')[0];
  assert.match(integrated, /!inputs\['current-failure-cross-context-only'\]/u);
});
