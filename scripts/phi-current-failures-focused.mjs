#!/usr/bin/env node
// One non-certifying focused Windows execution covering the seven current IDs.
// Every selected test uses the existing 120-second owned validation command;
// no raw TAP, assertion, stderr, command output or fixture contents are logged.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runValidationCommand } from '../platform/windows/validation-process.mjs';
import { failureLedgerEvidence } from '../lib/phi-certification-evidence.mjs';
import { focusedCorpusEvidence } from '../lib/phi-focused-corpus-evidence.mjs';
import { currentFailureStageEvidence } from '../lib/phi-current-failure-evidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cases = [
  ['tests/phi-publication.test.mjs', 'native production Worker move intent/LSP/TEST/READY/V4 journal publishes only intended Git rename without TxF', 'PUBLICATION', '6e564f63a684aa2b9183e09a8714807955f282d9fd391f5e0800f330606d7697'],
  ['tests/phi-publication.test.mjs', 'native user change after READY RENAME is CONFLICT; user destination and verified draft survive', 'PUBLICATION', '4f988b242031439c0acde26c325c3b0d151c582e08b51300e097b7221d10682d'],
  ['tests/phi-publication.test.mjs', 'native V5 governed Worker to controller handoff publishes exact four-operation Git diff once', 'PUBLICATION', 'dda724f3c17f180384d87621e733e3a5a241195182b6e032a32c3f3d7177dbf1'],
  ['tests/phi-publication.test.mjs', 'native V5 controller publishes after Worker revocation without restoring child authority', 'PUBLICATION', '9109f7b71084628b1bbd8a374ba6f9bb68346908fb3d3046674a1b5e0fd9178e'],
  ['tests/phi-publication.test.mjs', 'native V5 stale handoff and concurrent user destination never grant publication or replay', 'PUBLICATION', '999ee2f6e497c788817be953f56bcb597a8974302a0416479cc3862b65f4619a'],
  ['tests/phi-windows-broker.test.mjs', 'native generic broker cancellation reuses scope recovery and removes observed process tree', 'BROKER_DELETION', '81f2fee6438bd7596b22c5cbeccac6dfe50ac61d439a3f61620789a4ab34fd3d'],
  ['tests/phi-windows-lsp.test.mjs', 'native LSP timeout, real target crash and broker death retain failure and owned cleanup', 'LSP_TIMEOUT', 'cb9d825dc27fa31639c498b55b3540c3a8dd8ed4897fda7737821554adbcde51'],
];

function summary(output) {
  return Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => {
    const match = new RegExp(`^# ${key} (\\d+)$`, 'mu').exec(output);
    return [key, match ? Number(match[1]) : null];
  }));
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const contextMode = process.argv.length === 3 && process.argv[2] === '--context';
const crossMode = process.argv.length === 3 && process.argv[2] === '--cross-context';
if (process.platform !== 'win32' || process.argv.length !== (contextMode || crossMode ? 3 : 2)) {
  console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_FOCUS', status: 'USAGE_DENIED' }));
  process.exit(1);
}
const reporter = pathToFileURL(path.join(root, 'scripts', 'phi-runtime-reporter.mjs')).href;
let allPassed = true;
if (crossMode) {
  // One native coordinator, three source files in the original main-corpus
  // order, exactly seven selected tests. This preserves shared runner/file
  // sequencing without starting the full Windows-main qualification.
  const files = ['tests/phi-publication.test.mjs', 'tests/phi-windows-broker.test.mjs', 'tests/phi-windows-lsp.test.mjs'];
  const sourceVerified = cases.every(([sourceFile, name, , testId]) => {
    try {
      const source = fs.readFileSync(path.join(root, sourceFile), 'utf8');
      const actualId = createHash('sha256').update('PHI_TEST_ID_V1\0').update(sourceFile).update('\0').update(name).digest('hex');
      return actualId === testId && source.includes(`test('${name}'`) && source.includes(`diagnosticNativeBody('${name}'`);
    } catch { return false; }
  });
  if (!sourceVerified) {
    console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_CROSS_CONTEXT', status: 'SOURCE_UNVERIFIED' }));
    process.exitCode = 1;
  } else {
    let result;
    try {
      const pattern = `^(?:${cases.map(row => escapeRegex(row[1])).join('|')})$`;
      result = await runValidationCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter', reporter,
        `--test-name-pattern=${pattern}`, ...files.map(file => path.join(root, file))], { cwd: root, timeoutMs: 120000 });
    } catch {
      console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_CROSS_CONTEXT', status: 'OWNER_UNVERIFIED' }));
      process.exitCode = 1;
    }
    if (result) {
      const counts = summary(result.stdout ?? '');
      const ledger = failureLedgerEvidence(result.stdout ?? '', counts.fail, result.status);
      const targetDiagnostics = cases.map(([, , cluster, testId]) => {
        const failed = ledger.status === 'COMPLETE' && ledger.entries.some(row => row.testId === testId);
        return { testId, cluster, result: failed ? 'FAIL' : ledger.status === 'NONE' ? 'PASS' : 'UNKNOWN',
          diagnostic: currentFailureStageEvidence(result.stdout ?? '', testId, cluster, failed) };
      });
      const owner = result.receipt ? { jobAttested: result.receipt.jobAttested, jobEmptyVerified: result.receipt.jobEmptyVerified,
        pipesDrained: result.receipt.pipesDrained, residualOwnedProcesses: result.receipt.residualOwnedProcesses,
        timedOut: result.receipt.timedOut, exitCode: result.receipt.primaryExitCode } : null;
      const owned = owner?.jobAttested === true && owner.jobEmptyVerified === true && owner.pipesDrained === true &&
        owner.residualOwnedProcesses === 0 && owner.timedOut === false;
      const corpus = focusedCorpusEvidence(result.stdout ?? '', counts, ledger,
        { expectedTests: cases.length, selectedIds: cases.map(row => row[3]) });
      const status = owned && corpus.status === 'PASS' && result.status === 0 && counts.pass === cases.length && counts.fail === 0 &&
        targetDiagnostics.every(row => row.diagnostic.status === 'NONE') ? 'PASS' : 'FAIL';
      console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_CROSS_CONTEXT', status, tests: counts,
        corpus, failureLedger: ledger, targetDiagnostics, owner }));
      if (status !== 'PASS') process.exitCode = 1;
    }
  }
} else if (contextMode) {
  // The prior full corpus failed B/C, while two isolated focused executions
  // passed. Preserve each source file's native intra-file predecessor order;
  // this is diagnostic only, never a replacement full-suite qualification.
  for (const [sourceFile, name, cluster, testId, expected] of [
    [...cases[5], 20], [...cases[6], 8],
  ]) {
    const actualId = createHash('sha256').update('PHI_TEST_ID_V1\0').update(sourceFile).update('\0').update(name).digest('hex');
    let source;
    try { source = fs.readFileSync(path.join(root, sourceFile), 'utf8'); } catch { source = null; }
    if (actualId !== testId || !source?.includes(`test('${name}'`) || !source.includes(`diagnosticNativeBody('${name}'`)) {
      console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_CONTEXT', testId, cluster, status: 'SOURCE_UNVERIFIED' }));
      process.exitCode = 1;
      break;
    }
    let result;
    try {
      result = await runValidationCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter', reporter,
        path.join(root, sourceFile)], { cwd: root, timeoutMs: 120000 });
    } catch {
      console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_CONTEXT', testId, cluster, status: 'OWNER_UNVERIFIED' }));
      process.exitCode = 1;
      break;
    }
    const counts = summary(result.stdout ?? '');
    const ledger = failureLedgerEvidence(result.stdout ?? '', counts.fail, result.status);
    const targetFailed = ledger.status === 'COMPLETE' && ledger.entries.some(row => row.testId === testId);
    const stage = currentFailureStageEvidence(result.stdout ?? '', testId, cluster, targetFailed);
    const owner = result.receipt ? { jobAttested: result.receipt.jobAttested, jobEmptyVerified: result.receipt.jobEmptyVerified,
      pipesDrained: result.receipt.pipesDrained, residualOwnedProcesses: result.receipt.residualOwnedProcesses,
      timedOut: result.receipt.timedOut, exitCode: result.receipt.primaryExitCode } : null;
    const owned = owner?.jobAttested === true && owner.jobEmptyVerified === true && owner.pipesDrained === true &&
      owner.residualOwnedProcesses === 0 && owner.timedOut === false;
    const corpus = focusedCorpusEvidence(result.stdout ?? '', counts, ledger, { expectedTests: expected });
    const status = owned && corpus.status === 'PASS' && result.status === 0 && counts.fail === 0 && stage.status === 'NONE' ? 'PASS' : 'FAIL';
    console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_CONTEXT', testId, cluster, status, tests: counts,
      corpus, targetResult: targetFailed ? 'FAIL' : ledger.status === 'NONE' ? 'PASS' : 'UNKNOWN',
      failureLedger: ledger, diagnostic: stage, owner }));
    if (status !== 'PASS') allPassed = false;
    if (!owned) { process.exitCode = 1; break; }
  }
  if (!allPassed) process.exitCode = 1;
} else {
for (const [sourceFile, name, cluster, testId] of cases) {
  let source, actualId;
  try {
    source = fs.readFileSync(path.join(root, sourceFile), 'utf8');
    actualId = createHash('sha256').update('PHI_TEST_ID_V1\0').update(sourceFile).update('\0').update(name).digest('hex');
  } catch { source = null; }
  if (actualId !== testId || !source?.includes(`test('${name}'`) || !source.includes(`diagnosticNativeBody('${name}'`)) {
    console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_FOCUS', testId, cluster, status: 'SOURCE_UNVERIFIED' }));
    process.exitCode = 1;
    break;
  }
  let result;
  try {
    result = await runValidationCommand(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter', reporter,
      `--test-name-pattern=^${escapeRegex(name)}$`, path.join(root, sourceFile)],
    { cwd: root, timeoutMs: 120000 });
  } catch {
    console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_FOCUS', testId, cluster, status: 'OWNER_UNVERIFIED' }));
    process.exitCode = 1;
    break;
  }
  const counts = summary(result.stdout ?? '');
  const ledger = failureLedgerEvidence(result.stdout ?? '', counts.fail, result.status);
  const stage = currentFailureStageEvidence(result.stdout ?? '', testId, cluster, counts.fail === 1);
  const owner = result.receipt ? { jobAttested: result.receipt.jobAttested, jobEmptyVerified: result.receipt.jobEmptyVerified,
    pipesDrained: result.receipt.pipesDrained, residualOwnedProcesses: result.receipt.residualOwnedProcesses,
    timedOut: result.receipt.timedOut, exitCode: result.receipt.primaryExitCode } : null;
  const owned = owner?.jobAttested === true && owner.jobEmptyVerified === true && owner.pipesDrained === true &&
    owner.residualOwnedProcesses === 0 && owner.timedOut === false;
  const corpus = focusedCorpusEvidence(result.stdout ?? '', counts, ledger,
    { expectedTests: 1, selectedIds: [testId] });
  const expectedLedger = counts.fail === 0 ? ledger.status === 'NONE' : counts.fail === 1 && ledger.status === 'COMPLETE' &&
    ledger.entries.length === 1 && ledger.entries[0].testId === testId;
  const status = owned && corpus.status === 'PASS' && expectedLedger && result.status === 0 && counts.pass === 1 &&
    counts.fail === 0 && stage.status === 'NONE' ? 'PASS' : 'FAIL';
  console.log(JSON.stringify({ phase: 'CURRENT_FAILURE_FOCUS', testId, cluster, status, tests: counts,
    corpus, failureLedger: ledger, diagnostic: stage, owner }));
  if (status !== 'PASS') allPassed = false;
  if (!owned) { process.exitCode = 1; break; }
}
if (!allPassed) process.exitCode = 1;
}
