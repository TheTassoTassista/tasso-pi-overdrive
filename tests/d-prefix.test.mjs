import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canReclaimDWorktreeJournal, classifyDPrefix, D_OPERATIONS, runDSequence, verifyDPrefixBridge, verifyDNextBase } from '../scripts/phi-d-prefix.mjs';
import { assertUniqueManagedWorktreeRecord, cleanupRuntimeResources, createRuntimeWorktree } from '../lib/runtime-isolation.mjs';

const created = 'created-state', modified = 'modified-state';
const receipt = index => ({ ...D_OPERATIONS[index], transactionId: (index + 1).toString(16).padStart(32, '0'),
  status: 'PASS', readback: 'PASS', journalPhase: 'CLEANED' });

test('D sequence uses the ratified operation-specific protocols, never legacy V5', () => {
  assert.deepEqual(D_OPERATIONS.map(({ operation, journalVersion }) => [operation, journalVersion]),
    [['CREATE', 6], ['MODIFY', 2], ['RENAME', 4], ['DELETE', 3]]);
});

async function fixture(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'phi-d-prefix-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function put(root, a, b) {
  for (const name of ['a.txt', 'b.txt']) {
    try { unlinkSync(path.join(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (a !== null) writeFileSync(path.join(root, 'a.txt'), a);
  if (b !== null) writeFileSync(path.join(root, 'b.txt'), b);
}
const classify = (root, receipts) => classifyDPrefix({ projectRoot: root, created, modified, receipts });

test('D prefix classifier requires physical and durable evidence at all five states', () => fixture(root => {
  const states = [[null, null], [created, null], [modified, null], [null, modified], [null, null]];
  states.forEach(([a, b], index) => {
    put(root, a, b);
    const result = classify(root, D_OPERATIONS.slice(0, index).map((_, item) => receipt(item)));
    assert.equal(result.status, `PREFIX_${index}`);
    assert.equal(result.completed, index);
    assert.equal(result.transactionIds.length, index);
  });
}));

test('D prefix classifier fails closed on mixed physical or invalid durable state', () => fixture(root => {
  put(root, created, null);
  assert.equal(classify(root, []).status, 'AMBIGUOUS');
  assert.equal(classify(root, [receipt(0)]).status, 'PREFIX_1');
  assert.equal(classify(root, [{ ...receipt(0), readback: 'UNKNOWN' }]).reason, 'DURABLE_EVIDENCE_MISMATCH');
  assert.equal(classify(root, [{ ...receipt(0), journalVersion: 5 }]).status, 'AMBIGUOUS');
  assert.equal(classify(root, [receipt(0), { ...receipt(1), transactionId: receipt(0).transactionId }]).status, 'AMBIGUOUS');
  put(root, created, modified);
  assert.equal(classify(root, [receipt(0)]).reason, 'PHYSICAL_DURABLE_MISMATCH');
  put(root, null, null);
  assert.equal(classify(root, [receipt(0), receipt(1), receipt(2)]).status, 'AMBIGUOUS');
}));

test('D fixture cleanup retains interrupted or ambiguous journals', () => {
  const terminal = { status: 'PASS_READ_ONLY_DISCOVERY', rootIdentityVerified: true,
    projectPublished: false, actionPerformed: false, projectTransactions: 1,
    entries: [{ phase: 'ROLLED_BACK', classification: 'TERMINAL_RETAINED' }] };
  assert.equal(canReclaimDWorktreeJournal(terminal), true);
  assert.equal(canReclaimDWorktreeJournal({ ...terminal, entries: [{ phase: 'CLEANED', classification: 'TERMINAL_RETAINED' }] }), true);
  for (const variant of [
    { ...terminal, entries: [{ phase: 'TEMP_CREATED', classification: 'RECOVERY_REQUIRED' }] },
    { ...terminal, entries: [{ phase: 'CONFLICT', classification: 'CONFLICT' }] },
    { ...terminal, rootIdentityVerified: false },
    { ...terminal, projectTransactions: 2 },
    { ...terminal, status: 'UNKNOWN' },
    { ...terminal, entries: [] },
  ]) assert.equal(canReclaimDWorktreeJournal(variant), false);
});

test('failure after each published prefix stops suffix without rolling prefix back', async () => {
  for (const failAt of [1, 2, 3]) await fixture(async root => {
    put(root, null, null);
    let published = [];
    const invoked = [];
    const inspect = receipts => classify(root, receipts);
    const result = await runDSequence({ inspect, invoke: async (operation, index) => {
      invoked.push(operation.operation);
      if (index === failAt) return { status: 'FAIL' };
      published = [...published, operation.operation];
      if (index === 0) put(root, created, null);
      if (index === 1) put(root, modified, null);
      if (index === 2) put(root, null, modified);
      return { status: 'PASS', receipt: receipt(index) };
    } });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.completed, failAt);
    assert.equal(result.reason, 'OPERATION_FAILED');
    assert.deepEqual(invoked, D_OPERATIONS.slice(0, failAt + 1).map(item => item.operation));
    assert.deepEqual(published, D_OPERATIONS.slice(0, failAt).map(item => item.operation));
    assert.equal(inspect(D_OPERATIONS.slice(0, failAt).map((_, index) => receipt(index))).status, `PREFIX_${failAt}`);
  });
});

test('ambiguous prestate or failed poststate never advances the suffix', async () => fixture(async root => {
  put(root, 'unrelated-user-content', null);
  let calls = 0;
  const inspect = receipts => classify(root, receipts);
  let result = await runDSequence({ inspect, invoke: async () => { calls++; return { status: 'PASS', receipt: receipt(0) }; } });
  assert.deepEqual({ status: result.status, reason: result.reason, calls }, { status: 'FAIL', reason: 'PRESTATE_AMBIGUOUS', calls: 0 });
  put(root, null, null);
  result = await runDSequence({ inspect, invoke: async () => { calls++; return { status: 'PASS', receipt: receipt(0) }; } });
  assert.equal(result.reason, 'POSTSTATE_AMBIGUOUS');
  assert.equal(calls, 1);
}));

test('disposable Git fixture can base the next independent worktree on an already committed published state', async () => fixture(async root => {
  const project = path.join(root, 'project');
  mkdirSync(project);
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git(project, ['init', '-q']);
  writeFileSync(path.join(project, 'config.json'), '{}');
  git(project, ['add', '.']);
  git(project, ['-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  const baselineHead = git(project, ['rev-parse', 'HEAD']).trim();
  const firstRoots = { shareRoot: path.join(root, 'first-worktrees'), stateRoot: path.join(root, 'first-runtime') };
  const secondRoots = { shareRoot: path.join(root, 'second-worktrees'), stateRoot: path.join(root, 'second-runtime') };
  const first = await createRuntimeWorktree(project, firstRoots);
  let second;
  try {
    // This simulates only the test fixture's Git handoff; native publication
    // itself is not credited by this local infrastructure test.
    writeFileSync(path.join(first.worktree, 'a.txt'), created);
    const bridge = () => verifyDPrefixBridge({ sourceRoot: project, candidateRoot: first.worktree,
      priorHead: baselineHead, prefix: 1, receipts: [receipt(0)], created, modified });
    assert.equal(bridge().status, 'PASS');
    const foreign = path.join(root, 'foreign');
    mkdirSync(foreign);
    git(foreign, ['init', '-q']);
    writeFileSync(path.join(foreign, 'a.txt'), created);
    assert.throws(() => verifyDPrefixBridge({ sourceRoot: project, candidateRoot: foreign,
      priorHead: baselineHead, prefix: 1, receipts: [receipt(0)], created, modified }),
    /D_BRIDGE_STATE_MISMATCH:LINEAGE_DISTINCT_OR_UNCONFIRMED/u);
    writeFileSync(path.join(first.worktree, 'unrelated.txt'), 'unrelated');
    assert.throws(bridge, /D_BRIDGE_STATE_MISMATCH:CANDIDATE_DELTA/u);
    unlinkSync(path.join(first.worktree, 'unrelated.txt'));
    assert.equal(bridge().unrelatedDelta, 'NONE');
    git(first.worktree, ['add', 'a.txt']);
    git(first.worktree, ['-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'accepted published fixture state']);
    assert.equal(verifyDPrefixBridge({ sourceRoot: project, candidateRoot: first.worktree,
      priorHead: baselineHead, prefix: 1, receipts: [receipt(0)], created, modified, committed: true }).status, 'PASS');
    second = await createRuntimeWorktree(first.worktree, secondRoots);
    assert.equal(git(second.worktree, ['rev-parse', 'HEAD']).trim(), git(first.worktree, ['rev-parse', 'HEAD']).trim());
    const nextHead = git(first.worktree, ['rev-parse', 'HEAD']).trim();
    const nextBase = () => verifyDNextBase({ sourceRoot: first.worktree, candidateRoot: second.worktree,
      priorHead: nextHead, prefix: 1, receipts: [receipt(0)], created, modified });
    assert.equal(nextBase().exactBase, true);
    writeFileSync(path.join(second.worktree, 'unrelated.txt'), 'unrelated');
    assert.throws(nextBase, /D_NEXT_BASE_MISMATCH:CANDIDATE_DIRTY/u);
    unlinkSync(path.join(second.worktree, 'unrelated.txt'));
    assert.equal(classify(second.worktree, [receipt(0)]).status, 'PREFIX_1');
    assert.notEqual(first.worktree, second.worktree);
    assert.notEqual(first.port, second.port);
    assert.doesNotThrow(() => assertUniqueManagedWorktreeRecord(git(first.worktree, ['worktree', 'list', '--porcelain', '-z']),
      second.worktree, second.branch));
  } finally {
    if (second) cleanupRuntimeResources(second.allocationId, secondRoots);
    cleanupRuntimeResources(first.allocationId, firstRoots);
  }
}));
