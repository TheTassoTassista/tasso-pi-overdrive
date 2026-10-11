// Campaign-2 test evidence only. This module never grants publication or
// recovery authority and never mutates the project or its receipts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const D_OPERATIONS = Object.freeze([
  Object.freeze({ operation: 'CREATE', journalVersion: 6 }),
  Object.freeze({ operation: 'MODIFY', journalVersion: 2 }),
  Object.freeze({ operation: 'RENAME', journalVersion: 4 }),
  Object.freeze({ operation: 'DELETE', journalVersion: 3 }),
]);

function readBoundedFile(root, name) {
  const file = path.join(root, name);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { kind: 'INVALID' };
    return { kind: 'FILE', content: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'ABSENT' };
    return { kind: 'UNKNOWN' };
  }
}

function expectedPhysical(prefix, created, modified) {
  if (prefix === 0 || prefix === 4) return [{ kind: 'ABSENT' }, { kind: 'ABSENT' }];
  if (prefix === 1) return [{ kind: 'FILE', content: created }, { kind: 'ABSENT' }];
  if (prefix === 2) return [{ kind: 'FILE', content: modified }, { kind: 'ABSENT' }];
  return [{ kind: 'ABSENT' }, { kind: 'FILE', content: modified }];
}

export function classifyDPrefix({ projectRoot, source = 'a.txt', destination = 'b.txt', created, modified, receipts }) {
  let rootValid = false;
  try { rootValid = typeof projectRoot === 'string' && path.isAbsolute(projectRoot) && fs.statSync(projectRoot).isDirectory(); }
  catch { /* Missing or inaccessible evidence is never a valid prefix. */ }
  if (!rootValid ||
      typeof source !== 'string' || typeof destination !== 'string' || source === destination ||
      !/^[A-Za-z0-9_.-]+$/u.test(source) || !/^[A-Za-z0-9_.-]+$/u.test(destination) ||
      typeof created !== 'string' || typeof modified !== 'string' || !Array.isArray(receipts) || receipts.length > 4)
    return { status: 'AMBIGUOUS', reason: 'INVALID_INPUT' };
  const observed = [readBoundedFile(projectRoot, source), readBoundedFile(projectRoot, destination)];
  const seen = new Set();
  for (let index = 0; index < receipts.length; index++) {
    const entry = receipts[index], expected = D_OPERATIONS[index];
    if (!entry || entry.operation !== expected.operation || entry.journalVersion !== expected.journalVersion ||
        entry.status !== 'PASS' || entry.readback !== 'PASS' || entry.journalPhase !== 'CLEANED' ||
        typeof entry.transactionId !== 'string' || !/^[0-9a-f]{32}$/u.test(entry.transactionId) || seen.has(entry.transactionId))
      return { status: 'AMBIGUOUS', reason: 'DURABLE_EVIDENCE_MISMATCH', observed };
    seen.add(entry.transactionId);
  }
  const prefix = receipts.length;
  const expected = expectedPhysical(prefix, created, modified);
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    return { status: 'AMBIGUOUS', reason: 'PHYSICAL_DURABLE_MISMATCH', observed };
  return { status: `PREFIX_${prefix}`, completed: prefix, observed, transactionIds: [...seen] };
}

// A failed native fixture may be discarded only after read-only discovery has
// independently confirmed every journal is terminal. Ambiguity retains it.
export function canReclaimDWorktreeJournal(inventory) {
  return inventory?.status === 'PASS_READ_ONLY_DISCOVERY' && inventory.rootIdentityVerified === true &&
    inventory.projectPublished === false && inventory.actionPerformed === false &&
    Number.isSafeInteger(inventory.projectTransactions) && inventory.projectTransactions > 0 &&
    Array.isArray(inventory.entries) && inventory.entries.length === inventory.projectTransactions &&
    inventory.entries.every(entry => entry?.classification === 'TERMINAL_RETAINED' &&
      ['CLEANED', 'ROLLED_BACK'].includes(entry.phase));
}

// Test-fixture bridge only. The controller must already have published and
// physically verified the single operation before this is called. Git records
// that accepted state as the next task's base; Git is not a Phi publisher.
const bridgeStatus = Object.freeze([
  Object.freeze(['?? a.txt']), Object.freeze([' M a.txt']),
  Object.freeze([' D a.txt', '?? b.txt']), Object.freeze([' D b.txt']),
]);
const bridgeDelta = Object.freeze([
  Object.freeze(['A\ta.txt']), Object.freeze(['M\ta.txt']),
  Object.freeze(['A\tb.txt', 'D\ta.txt']), Object.freeze(['D\tb.txt']),
]);
function bridgeGit(cwd, args) {
  const run = spawnSync('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 8192 });
  if (run.status !== 0 || run.signal || run.error) throw new Error('D_BRIDGE_GIT_UNCONFIRMED');
  return run.stdout.trimEnd();
}
function commonGitDir(cwd) {
  const reported = bridgeGit(cwd, ['rev-parse', '--git-common-dir']).trim();
  return fs.realpathSync(path.resolve(cwd, reported));
}
export function verifyDNextBase({ sourceRoot, candidateRoot, priorHead, prefix, receipts, created, modified }) {
  const fail = () => { throw new Error('D_NEXT_BASE_MISMATCH'); };
  if (typeof sourceRoot !== 'string' || typeof candidateRoot !== 'string' ||
      !path.isAbsolute(sourceRoot) || !path.isAbsolute(candidateRoot) ||
      !/^[0-9a-f]{40}$/u.test(priorHead ?? '') || !Number.isSafeInteger(prefix) || prefix < 0 || prefix > 3 ||
      !Array.isArray(receipts) || receipts.length !== prefix) fail();
  try {
    if (commonGitDir(sourceRoot) !== commonGitDir(candidateRoot) ||
        bridgeGit(sourceRoot, ['rev-parse', 'HEAD']).trim() !== priorHead ||
        bridgeGit(candidateRoot, ['rev-parse', 'HEAD']).trim() !== priorHead ||
        bridgeGit(candidateRoot, ['status', '--porcelain', '--untracked-files=all']) !== '' ||
        classifyDPrefix({ projectRoot: candidateRoot, created, modified, receipts }).status !== `PREFIX_${prefix}`) fail();
  } catch (error) {
    if (error?.message === 'D_NEXT_BASE_MISMATCH') throw error;
    fail();
  }
  return { status: 'PASS', prefix: `PREFIX_${prefix}`, lineage: 'SAME_COMMON_GIT_DIR', exactBase: true };
}
export function verifyDPrefixBridge({ sourceRoot, candidateRoot, priorHead, prefix, receipts,
  created, modified, committed = false }) {
  const fail = () => { throw new Error('D_BRIDGE_STATE_MISMATCH'); };
  if (typeof sourceRoot !== 'string' || typeof candidateRoot !== 'string' ||
      !path.isAbsolute(sourceRoot) || !path.isAbsolute(candidateRoot) ||
      !/^[0-9a-f]{40}$/u.test(priorHead ?? '') || !Number.isSafeInteger(prefix) || prefix < 1 || prefix > 4 ||
      !Array.isArray(receipts) || receipts.length !== prefix) fail();
  try {
    if (commonGitDir(sourceRoot) !== commonGitDir(candidateRoot) ||
        bridgeGit(sourceRoot, ['rev-parse', 'HEAD']).trim() !== priorHead ||
        classifyDPrefix({ projectRoot: candidateRoot, created, modified, receipts }).status !== `PREFIX_${prefix}`) fail();
    if (!committed) {
      if (bridgeGit(candidateRoot, ['rev-parse', 'HEAD']).trim() !== priorHead) fail();
      const actual = bridgeGit(candidateRoot, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...bridgeStatus[prefix - 1]].sort())) fail();
    } else {
      const head = bridgeGit(candidateRoot, ['rev-parse', 'HEAD']).trim();
      if (head === priorHead || bridgeGit(candidateRoot, ['rev-parse', 'HEAD^']).trim() !== priorHead ||
          bridgeGit(candidateRoot, ['status', '--porcelain', '--untracked-files=all']) !== '') fail();
      const actual = bridgeGit(candidateRoot, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--no-renames', 'HEAD'])
        .split('\n').filter(Boolean).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...bridgeDelta[prefix - 1]].sort())) fail();
    }
  } catch (error) {
    if (error?.message === 'D_BRIDGE_STATE_MISMATCH') throw error;
    fail();
  }
  return { status: 'PASS', prefix: `PREFIX_${prefix}`, lineage: 'SAME_COMMON_GIT_DIR',
    exactBase: true, unrelatedDelta: 'NONE', committed };
}

// Test-only sequencing: no task is launched from a predecessor's receipt.
// The caller must independently establish the next trusted user task and
// validate current physical state before invoking the normal workflow.
export async function runDSequence({ inspect, invoke }) {
  if (typeof inspect !== 'function' || typeof invoke !== 'function') throw new Error('D_SEQUENCE_INVALID_CALLBACK');
  const completed = [];
  for (let index = 0; index < D_OPERATIONS.length; index++) {
    const before = await inspect(completed);
    if (before?.status !== `PREFIX_${index}`) return { status: 'FAIL', reason: 'PRESTATE_AMBIGUOUS', completed: index, inFlight: null };
    const result = await invoke(D_OPERATIONS[index], index);
    if (result?.status !== 'PASS') {
      const afterFailure = await inspect(completed);
      return { status: 'FAIL', reason: afterFailure?.status === `PREFIX_${index}` ? 'OPERATION_FAILED' : 'POSTFAIL_AMBIGUOUS',
        completed: index, inFlight: D_OPERATIONS[index].operation };
    }
    completed.push(result.receipt);
    const after = await inspect(completed);
    if (after?.status !== `PREFIX_${index + 1}`)
      return { status: 'FAIL', reason: 'POSTSTATE_AMBIGUOUS', completed: index, inFlight: D_OPERATIONS[index].operation };
  }
  return { status: 'PASS', completed: 4, inFlight: null };
}
