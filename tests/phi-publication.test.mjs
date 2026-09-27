import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WorkerDraft, draftContentDigest } from '../lib/phi-worker-draft.mjs';
import { PublicationPreflight, publicationBase, publicationConflicts, publicationOperations, PUBLICATION_STATES } from '../lib/phi-publication-plan.mjs';
import { reserveWindowsWorker, bindWindowsWorker, executePreparedWindowsPublication } from '../lib/phi-worker-authority.mjs';
import { resolveTaskPolicy } from '../lib/task-governor.mjs';
import { executeCodingTool, executeCodingLsp, verifyCodingProject } from '../platform/shared/coding-execution.mjs';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';

const native = { skip: process.platform !== 'win32', timeout: 60000 };
const rootIdentity = 'a'.repeat(16) + ':' + '1'.repeat(32);
const fileIdentity = n => 'a'.repeat(16) + ':' + n.toString(16).padStart(32, '0');
const snapshot = (files = { 'input.txt': 'original' }, offset = 2, root = rootIdentity) => ({
  version: 1, rootIdentity: root, files, identities: Object.fromEntries(Object.keys(files).map((name, i) => [name, fileIdentity(i + offset)])),
});
function edited(files = { 'input.txt': 'verified-change' }) {
  const base = snapshot(), draft = new WorkerDraft(base);
  draft.settle(draft.binding, snapshot(files, 10, fileIdentity(20)), { success: true, edit: true });
  return { base, draft };
}
const verify = draft => draft.settle(draft.binding, draft.snapshot, { success: true, verified: true });

test('publication stores immutable original native IDs/hashes, never raw payload or execution-copy IDs', () => {
  const { base, draft } = edited(), original = publicationBase(base);
  assert.deepEqual(draft.publicationBase, original);
  assert.notEqual(draft.snapshot.identities['input.txt'], original.files['input.txt'].identity);
  assert.throws(() => { draft.publicationBase.files['input.txt'].identity = fileIdentity(30); }, TypeError);
  assert.doesNotMatch(JSON.stringify(draft.publicationBase), /original|verified-change/u);
  assert.equal(draft.publicationMetadata.projectPublished, false);
});
test('native manifest rejects missing/aliased IDs, traversal, protected names, case aliases and ADS', () => {
  for (const bad of [snapshot({ '../escape': 'x' }), snapshot({ '.env': 'x' }), snapshot({ 'name.txt:ads': 'x' }), snapshot({ 'a.txt': 'x', 'A.txt': 'y' }),
    { ...snapshot(), identities: {} }, { ...snapshot(), rootIdentity: 'path-only' },
    { ...snapshot({ 'a.txt': 'x', 'b.txt': 'y' }), identities: { 'a.txt': fileIdentity(2), 'b.txt': fileIdentity(2) } }]) assert.throws(() => publicationBase(bad));
});
test('CREATE/REPLACE/DELETE and rename DELETE+CREATE are explicit, unchanged execution-copy identity is not an edit', () => {
  const base = publicationBase(snapshot({ 'keep.txt': 'same', 'replace.txt': 'old', 'remove.txt': 'gone', 'from.txt': 'move' }));
  const ops = publicationOperations(base, snapshot({ 'keep.txt': 'same', 'replace.txt': 'new', 'create.txt': 'added', 'to.txt': 'move' }, 20));
  assert.deepEqual(ops.map(o => [o.path, o.kind]), [['create.txt', 'CREATE'], ['from.txt', 'DELETE'], ['remove.txt', 'DELETE'], ['replace.txt', 'REPLACE'], ['to.txt', 'CREATE']]);
  assert.equal(ops[0].baseIdentity, null); assert.equal(ops[1].newDigest, null);
  assert.throws(() => { ops[0].kind = 'PUBLISHED'; }, TypeError);
  assert.doesNotMatch(JSON.stringify(ops), /"(?:added|gone|move|old)"/u);
});
test('baseline conflicts detect root/file identity, identical-text delete/recreate, edit, removal and new user file', () => {
  const original = snapshot(), base = publicationBase(original);
  assert.deepEqual(publicationConflicts(base, original), []);
  assert.equal(publicationConflicts(base, snapshot(undefined, 30))[0].reason, 'FILE_IDENTITY');
  assert.equal(publicationConflicts(base, snapshot({ 'input.txt': 'user-change' }))[0].reason, 'FILE_CONTENT');
  assert.equal(publicationConflicts(base, snapshot({}))[0].reason, 'USER_REMOVED');
  const additional = snapshot({ 'input.txt': 'original', 'new.txt': 'user' });
  assert.deepEqual(publicationConflicts(base, additional).map(x => x.reason), ['USER_CREATED']);
  assert.equal(publicationConflicts(base, snapshot(undefined, 2, fileIdentity(9)))[0].reason, 'ROOT_IDENTITY');
});
test('unverified, stale and mismatched-content proofs cannot reach READY_TO_PUBLISH', () => {
  const { base, draft } = edited();
  assert.throws(() => draft.preparePublication(base), /UNVERIFIED_DRAFT/u);
  verify(draft); const binding = draft.binding;
  const preflight = new PublicationPreflight(base); preflight.verified(binding);
  assert.throws(() => preflight.prepare(snapshot({ 'input.txt': 'other' }), binding, base), /UNVERIFIED_DRAFT/u);
  assert.throws(() => preflight.prepare(draft.snapshot, { ...binding, revision: 9 }, base), /UNVERIFIED_DRAFT/u);
  assert.equal(draft.preparePublication(base).state, 'READY_TO_PUBLISH');
  draft.settle(binding, snapshot({ 'input.txt': 'second-edit' }), { success: true, edit: true });
  assert.equal(draft.publicationMetadata.state, 'EDITED');
  assert.throws(() => draft.preparePublication(base), /UNVERIFIED_DRAFT/u);
});
test('JSON analysis success containing Error, absent/unknown diagnostics or stale digest is not semantic publication proof', () => {
  for (const diagnostics of [[{ severity: 1 }], undefined, [{}], [null], [{ severity: 0 }], [{ severity: 5 }]]) {
    const base = snapshot({ 'config.json': '{}' }), draft = new WorkerDraft(base);
    draft.settle(draft.binding, snapshot({ 'config.json': '{"changed":true}' }, 10), { success: true, edit: true }); verify(draft);
    draft.recordLsp(draft.binding, 'config.json', diagnostics, true);
    assert.throws(() => draft.preparePublication(base), /SEMANTIC_UNVERIFIED/u);
  }
  const base = snapshot({ 'config.json': '{}' }), draft = new WorkerDraft(base);
  draft.settle(draft.binding, snapshot({ 'config.json': '{"changed":true}' }, 10), { success: true, edit: true });
  const old = draft.binding; draft.recordLsp(old, 'config.json', [], true);
  draft.settle(old, snapshot({ 'config.json': '{"changed":2}' }, 20), { success: true, edit: true }); verify(draft);
  assert.throws(() => draft.recordLsp(old, 'config.json', [], true), /IDENTITY_INVALID/u);
  assert.throws(() => draft.preparePublication(base), /SEMANTIC_UNVERIFIED/u);
  draft.recordLsp(draft.binding, 'config.json', [{ severity: 2 }], true);
  assert.equal(draft.preparePublication(base).state, 'READY_TO_PUBLISH');
});
test('later same-version LSP Error/failed analysis invalidates READY and its transaction ID', () => {
  for (const success of [true, false]) {
    const base = snapshot({ 'config.json': '{}' }), draft = new WorkerDraft(base);
    draft.settle(draft.binding, snapshot({ 'config.json': '{"changed":true}' }, 10), { success: true, edit: true }); verify(draft);
    draft.recordLsp(draft.binding, 'config.json', [], true);
    assert.equal(draft.preparePublication(base).state, 'READY_TO_PUBLISH');
    draft.recordLsp(draft.binding, 'config.json', success ? [{ severity: 1 }] : [], success);
    assert.equal(draft.publicationMetadata.state, 'VERIFIED'); assert.equal(draft.publicationMetadata.transactionId, null);
    assert.throws(() => draft.preparePublication(base), /SEMANTIC_UNVERIFIED/u);
  }
});
test('JSON case alias does not bypass required supported-language semantic proof', () => {
  const base = snapshot({ 'CONFIG.JSON': '{}' }), draft = new WorkerDraft(base);
  draft.settle(draft.binding, snapshot({ 'CONFIG.JSON': '{"changed":true}' }, 10), { success: true, edit: true }); verify(draft);
  assert.throws(() => draft.preparePublication(base), /SEMANTIC_UNVERIFIED/u);
});
test('failed re-verification invalidates prior approval without replacing draft contents', () => {
  const { base, draft } = edited(); verify(draft); draft.preparePublication(base);
  const digest = draft.metadata.contentDigest; draft.invalidateVerification(draft.binding);
  assert.equal(draft.metadata.contentDigest, digest); assert.equal(draft.snapshot.files['input.txt'], 'verified-change');
  assert.equal(draft.publicationMetadata.state, 'EDITED'); assert.throws(() => draft.preparePublication(base), /UNVERIFIED_DRAFT/u);
});
test('CONFLICT preserves current draft, identifies concurrent changes and never reports project publication', () => {
  const { draft } = edited(); verify(draft); const before = draft.metadata;
  const receipt = draft.preparePublication(snapshot({ 'input.txt': 'user-change' }));
  assert.equal(receipt.state, 'CONFLICT'); assert.equal(receipt.projectPublished, false);
  assert.deepEqual(draft.metadata, before); assert.equal(draft.snapshot.files['input.txt'], 'verified-change');
  assert.equal(receipt.conflicts[0].reason, 'FILE_CONTENT'); assert.doesNotMatch(JSON.stringify(receipt), /user-change|verified-change/u);
});
test('all lifecycle names are explicit but no forged receipt/terminal-state method can claim a published project', () => {
  assert.deepEqual(PUBLICATION_STATES, ['DRAFT_CREATED', 'EDITED', 'VERIFIED', 'READY_TO_PUBLISH', 'PUBLISHING', 'PUBLISHED', 'CONFLICT', 'ROLLED_BACK', 'FAILED']);
  const { base, draft } = edited(); verify(draft); const receipt = draft.preparePublication(base);
  assert.equal(receipt.backend, 'BLOCKED_NOT_IMPLEMENTED'); assert.equal(receipt.projectPublished, false);
  assert.throws(() => { receipt.state = 'PUBLISHED'; }, TypeError);
  for (const fake of [undefined, null, {}, { state: 'PUBLISHED' }, { approveProjectMutation: true }]) assert.throws(() => executePreparedWindowsPublication(fake), /PUBLISH_AUTHORITY_DENIED/u);
  draft.dispose(); assert.equal(draft.publicationMetadata.state, 'FAILED'); assert.equal(draft.publicationMetadata.projectPublished, false);
  assert.throws(() => draft.preparePublication(base), /IDENTITY_INVALID/u);
});
test('no-op verification cannot authorize a host transaction', () => {
  const base = snapshot(), draft = new WorkerDraft(base); verify(draft);
  assert.throws(() => draft.preparePublication(base), /NO_CHANGES/u);
});

function nativeFixture(task = 'Fix JSON configuration code and test diagnostics') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-publication-')), project = path.join(root, 'project'); fs.mkdirSync(project);
  const files = {
    'config.json': '{}',
    'package.json': JSON.stringify({ scripts: { lint: 'node --check test.cjs', test: 'node test.cjs' } }),
    'edit.cjs': "require('node:fs').writeFileSync('config.json','{\"changed\":true}');console.log(process.pid)",
    'test.cjs': "const f=require('node:fs'),a=require('node:assert/strict');a.equal(JSON.parse(f.readFileSync('config.json','utf8')).changed,true);a.throws(()=>f.writeFileSync('config.json','forbidden'),e=>['EACCES','EPERM'].includes(e.code));console.log(process.pid)",
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(project, name), text);
  assert.equal(spawnSync('git', ['init', '--quiet', project], { shell: false }).status, 0);
  const sessionId = randomUUID();
  const reservation = reserveWindowsWorker({ executionId: randomUUID(), parentSessionId: randomUUID(), cwd: project, task, taskPolicy: resolveTaskPolicy({ task }) });
  const token = bindWindowsWorker({ cwd: project, task: 'Task: ' + task, sessionId });
  return { project, reservation, token, sessionId, context: { workerAuthority: token, sessionId, runtime: path.resolve(import.meta.dirname, '../runtime/lsp') },
    close: () => { reservation.revoke(); fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); } };
}
async function nativeVerified(item) {
  const edit = await executeCodingTool({ program: 'node', args: ['edit.cjs'], cwd: item.project, timeoutMs: 8000 }, { operation: 'safe-exec', sessionId: item.sessionId, workerAuthority: item.token });
  assert.equal(edit.code, 0); assert.equal(edit.metadata.profile, 'EDIT'); assert.equal(edit.metadata.cleanup, 'PASS');
  assert.throws(() => process.kill(Number(edit.stdout.trim()), 0), e => e.code === 'ESRCH');
  const lsp = await executeCodingLsp(item.project, { operation: 'diagnostics', path: 'config.json' }, item.context);
  assert.equal(lsp.status, 'PASS'); assert.equal(lsp.count, 0); assert.equal(lsp.receipt.profile, 'LSP_READ_ONLY');
  const verified = await verifyCodingProject({ cwd: item.project, workerAuthority: item.token, sessionId: item.sessionId });
  assert.equal(verified.status, 'PASS'); assert.equal(verified.draft.contentDigest, lsp.receipt.draft.contentDigest);
  for (const row of verified.results) {
    assert.equal(row.receipt.profile, 'TEST'); assert.equal(row.receipt.cleanup, 'PASS'); assert.equal(row.receipt.jobEmptyVerified, true);
    if (row.name === 'test') assert.throws(() => process.kill(Number(row.output.trim()), 0), e => e.code === 'ESRCH');
  }
  return { edit: edit.metadata, lsp: lsp.receipt, verification: verified };
}
test('native real draft EDIT/LSP/TEST reaches controller-only READY, but missing transactional backend cannot publish', native, async () => {
  const item = nativeFixture();
  try {
    assert.throws(() => item.reservation.preparePublication({ approveProjectMutation: true }), /UNVERIFIED_DRAFT/u);
    const evidence = await nativeVerified(item);
    for (const approval of [undefined, {}, { approveProjectMutation: false }, { approveProjectMutation: true, runner: 'copy' }, Object.assign(Object.create({ approveProjectMutation: true }), { other: true })]) assert.throws(() => item.reservation.preparePublication(approval), /PUBLISH_AUTHORITY_DENIED/u);
    const ready = item.reservation.preparePublication({ approveProjectMutation: true });
    assert.equal(ready.receipt.state, 'READY_TO_PUBLISH'); assert.equal(ready.receipt.verifiedDigest, evidence.verification.draft.contentDigest);
    assert.deepEqual(ready.receipt.operations.map(o => [o.path, o.kind]), [['config.json', 'REPLACE']]);
    assert.throws(() => executePreparedWindowsPublication(item.token), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => executePreparedWindowsPublication(structuredClone(ready.authority)), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /BACKEND_UNAVAILABLE/u);
    const second = item.reservation.preparePublication({ approveProjectMutation: true });
    assert.notEqual(second.receipt.transactionId, ready.receipt.transactionId);
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    await assert.rejects(executeCodingLsp(item.project, { operation: 'diagnostics', path: 'config.json' }, { ...item.context, runtime: path.join(item.project, 'absent-runtime') }), error => error.code === 'ENOENT');
    assert.throws(() => executePreparedWindowsPublication(second.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => item.reservation.preparePublication({ approveProjectMutation: true }), /SEMANTIC_UNVERIFIED/u);
    const clean = await executeCodingLsp(item.project, { operation: 'diagnostics', path: 'config.json' }, item.context); assert.equal(clean.status, 'PASS');
    const third = item.reservation.preparePublication({ approveProjectMutation: true });
    await assert.rejects(verifyCodingProject({ cwd: item.project, mode: 'unregistered-mode', workerAuthority: item.token, sessionId: item.sessionId }), /MODE_INVALID/u);
    assert.equal(item.reservation.publicationStatus().state, 'EDITED');
    assert.throws(() => executePreparedWindowsPublication(third.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => item.reservation.preparePublication({ approveProjectMutation: true }), /UNVERIFIED_DRAFT/u);
    assert.equal(fs.readFileSync(path.join(item.project, 'config.json'), 'utf8'), '{}');
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'PUBLICATION_PREFLIGHT_ONLY', receipts: [evidence.edit, evidence.lsp, ...evidence.verification.results.map(x => x.receipt)], publication: second.receipt, hostUnchanged: true, externalRequests: 0 }));
    item.reservation.revoke(); assert.throws(() => executePreparedWindowsPublication(second.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.equal(item.reservation.status().draft.payloadCleared, true);
  } finally { item.close(); }
});
test('native controller approval cannot override read-only Task/Tool Governor policy', native, () => {
  const item = nativeFixture('Read a note');
  try { assert.throws(() => item.reservation.preparePublication({ approveProjectMutation: true }), /PUBLISH_AUTHORITY_DENIED/u); }
  finally { item.close(); }
});
test('native concurrent user edit and identical-text delete/recreate both CONFLICT, preserving real project and draft', native, async () => {
  for (const mode of ['content', 'identity']) {
    const item = nativeFixture();
    try {
      const evidence = await nativeVerified(item), before = item.reservation.status().draft;
      const destination = path.join(item.project, 'config.json');
      if (mode === 'identity') fs.renameSync(destination, path.join(item.project, 'previous.txt'));
      const user = mode === 'content' ? '{"user":true}' : '{}'; fs.writeFileSync(destination, user);
      const result = item.reservation.preparePublication({ approveProjectMutation: true });
      assert.equal(result.receipt.state, 'CONFLICT'); assert.equal(result.authority, null); assert.equal(result.receipt.projectPublished, false);
      assert.ok(result.receipt.conflicts.some(x => x.path === 'config.json' && x.reason === (mode === 'content' ? 'FILE_CONTENT' : 'FILE_IDENTITY')));
      assert.deepEqual(item.reservation.status().draft, before); assert.equal(fs.readFileSync(destination, 'utf8'), user);
      assert.equal(evidence.verification.draft.contentDigest, before.contentDigest); assert.equal(windowsRecoveryStatus().status, 'PASS');
      console.log(JSON.stringify({ control: 'PUBLICATION_CONFLICT', mode, publication: result.receipt, draftPreserved: true, userPreserved: true, externalRequests: 0 }));
    } finally { item.close(); }
  }
});

const atomicCases = ['create', 'existing', 'case-alias', 'concurrent-create', 'junction', 'protected', 'ads', 'root-identity',
  'foreign-handle', 'parent-pinned', 'before-temp', 'temp', 'write', 'flush', 'validation', 'precommit', 'rename', 'postverify'];
for (const name of atomicCases) test('native no-clobber atomic CREATE primitive: ' + name, native, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--atomic-create-selftest', name], { shell: false, encoding: 'utf8', windowsHide: true, timeout: 16000, maxBuffer: 8192 });
  assert.equal(result.status, 0, result.stderr); const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, true); assert.equal(receipt.fixtureCleanup, true);
  assert.equal(receipt.scope, 'NATIVE_CREATE_PRIMITIVE_NOT_PROJECT_TRANSACTION');
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'NATIVE_ATOMIC_CREATE_ONLY', ...receipt }));
});
