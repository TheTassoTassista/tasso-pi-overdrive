import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WorkerDraft, draftContentDigest } from '../lib/phi-worker-draft.mjs';
import { PublicationPreflight, publicationBase, publicationConflicts, publicationOperations, PUBLICATION_STATES } from '../lib/phi-publication-plan.mjs';
import { reserveWindowsWorker, bindWindowsWorker, executePreparedWindowsPublication, registerWindowsWorkerBoundary } from '../lib/phi-worker-authority.mjs';
import { resolveTaskPolicy } from '../lib/task-governor.mjs';
import { executeBrokeredSafeExec } from '../platform/shared/safe-exec-handler.mjs';
import { executeCodingTool, executeCodingLsp, verifyCodingProject } from '../platform/shared/coding-execution.mjs';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { consumeWindowsPublicationProof, publishWindowsSingleOperation, windowsPublicationFailure } from '../platform/windows/publication.mjs';

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
    snapshot({ 'phi-publish-0123456789abcdef0123456789abcdef.tmp': 'owned temp' }),
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
test('explicit RENAME intent requires exactly one same-directory, byte-identical DELETE+CREATE pair', () => {
  const base = publicationBase(snapshot({ 'old.txt': 'unchanged bytes', 'keep.txt': 'same' }));
  const next = snapshot({ 'new.txt': 'unchanged bytes', 'keep.txt': 'same' }, 10);
  const intent = { sourcePath: 'old.txt', destinationPath: 'new.txt' };
  assert.deepEqual(publicationOperations(base, next).map(op => op.kind), ['CREATE', 'DELETE']);
  const [op] = publicationOperations(base, next, intent);
  assert.deepEqual([op.kind, op.sourcePath, op.path], ['RENAME', 'old.txt', 'new.txt']);
  assert.equal(op.baseIdentity, base.files['old.txt'].identity);
  assert.equal(op.baseDigest, op.newDigest);
  assert.equal(op.newBytes, base.files['old.txt'].bytes);
  assert.throws(() => { op.path = 'other.txt'; }, TypeError);
  for (const bad of [
    { ...intent, runner: 'copy' }, { sourcePath: 'old.txt' }, { sourcePath: 'OLD.txt', destinationPath: 'new.txt' },
    { sourcePath: 'old.txt', destinationPath: 'old.txt' }, { sourcePath: 'old.txt', destinationPath: 'sub/new.txt' },
    { sourcePath: 'keep.txt', destinationPath: 'new.txt' }, { sourcePath: 'old.txt', destinationPath: 'keep.txt' },
  ]) assert.throws(() => publicationOperations(base, next, bad), /RENAME_INTENT_INVALID/u);
  assert.throws(() => publicationOperations(base, snapshot({ 'new.txt': 'modified bytes', 'keep.txt': 'same' }, 10), intent), /RENAME_INTENT_INVALID/u);
  assert.throws(() => publicationOperations(base, snapshot({ 'new.txt': 'unchanged bytes', 'keep.txt': 'changed' }, 10), intent), /RENAME_INTENT_INVALID/u);
  assert.throws(() => publicationOperations(base, snapshot({ 'new.txt': 'unchanged bytes', 'old.txt': 'unchanged bytes', 'keep.txt': 'same' }, 10), intent), /RENAME_INTENT_INVALID/u);
});
test('V5 representative mixed manifest folds only an explicit rename pair and preserves operation order', () => {
  const base = publicationBase(snapshot({ 'a.txt': 'old a', 'c.txt': 'old c', 'd.txt': 'old d', 'keep.txt': 'same' }));
  const next = snapshot({ 'a.txt': 'new a', 'b.txt': 'new b', 'e.txt': 'old d', 'keep.txt': 'same' }, 10);
  const intent = { sourcePath: 'd.txt', destinationPath: 'e.txt' };
  assert.deepEqual(publicationOperations(base, next).map(op => op.kind), ['REPLACE', 'CREATE', 'DELETE', 'DELETE', 'CREATE']);
  const operations = publicationOperations(base, next, intent);
  assert.deepEqual(operations.map(op => [op.kind, op.path]), [
    ['REPLACE', 'a.txt'], ['CREATE', 'b.txt'], ['DELETE', 'c.txt'], ['RENAME', 'e.txt'],
  ]);
  assert.equal(operations[3].sourcePath, 'd.txt');
  assert.equal(operations[3].baseIdentity, base.files['d.txt'].identity);
  assert.throws(() => { operations[1].newBytes = 0; }, TypeError);
  assert.throws(() => publicationOperations(base, snapshot({ ...next.files, 'e.txt': 'changed d' }, 10), intent), /RENAME_INTENT_INVALID/u);
  assert.throws(() => publicationOperations(base, snapshot({ ...next.files, 'c.txt': 'retained' }, 10), intent), /RENAME_INTENT_INVALID/u);
  assert.throws(() => publicationOperations(base, snapshot({ ...next.files, 'extra.txt': 'extra' }, 10), intent), /RENAME_INTENT_INVALID/u);
  assert.throws(() => publicationOperations(base, snapshot({ 'a.txt': 'old a', 'b.txt': 'new b', 'e.txt': 'old d', 'keep.txt': 'same' }, 10), intent), /RENAME_INTENT_INVALID/u);
  const publisher = fs.readFileSync(new URL('../platform/windows/publication.mjs', import.meta.url), 'utf8');
  assert.match(publisher, /operations\?\.length === 4\) return publishWindowsMixed\(options\)/u);
  assert.match(publisher, /\['--publication-mixed'\]/u);
  if (process.platform !== 'win32') assert.throws(() => publishWindowsSingleOperation({ metadata: { operations } }), /BACKEND_UNAVAILABLE/u);
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
test('forged native JSON cannot mint PUBLISHED or a reusable publication certificate', () => {
  const { base, draft } = edited(); verify(draft); const ready = draft.preparePublication(base), binding = draft.binding;
  draft.beginPublication(binding, ready.transactionId);
  for (const fake of [undefined, null, {}, { committed: true, cleanup: 'PASS', finalDigest: binding.digest }, { state: 'PUBLISHED', projectPublished: true }]) {
    assert.throws(() => consumeWindowsPublicationProof(fake, {}), /NATIVE_PROOF_DENIED/u);
    assert.throws(() => draft.completePublication(binding, fake), /NATIVE_PROOF_DENIED/u);
    assert.equal(draft.publicationMetadata.state, 'PUBLISHING'); assert.equal(draft.publicationMetadata.projectPublished, false);
  }
  draft.failPublication(false); assert.equal(draft.publicationMetadata.state, 'FAILED'); assert.equal(draft.publicationMetadata.cleanup, 'NOT_PROVEN');
});

function admissionFixture() {
  const { base, draft } = edited(); verify(draft);
  const ready = draft.preparePublication(base), header = { transactionId: ready.transactionId, projectIdentity: base.rootIdentity,
    draftId: draft.binding.id, draftVersion: draft.binding.revision, verifiedDigest: draft.binding.digest, baseDigest: ready.baseDigest, operations: ready.operations };
  const admission = { version: 1, scope: 'VALIDATED_BASE_CONFLICT_BEFORE_JOURNAL', phase: 'ADMISSION_CONFLICT', ...header,
    journalCreated: false, mutationStarted: false, filesCommitted: [], pendingOperations: 1, commitState: 'NOT_STARTED',
    recoveryState: 'NOT_STARTED', cleanup: 'NOT_STARTED', projectPublished: false };
  const value = { version: 1, status: 'FAIL_NATIVE_SINGLE_MODIFY', phase: 'ADMISSION', reason: 'CONFLICT', nativeCode: '80131509',
    journal: null, admission, projectPublished: false, externalRequests: 0 };
  return { draft, ready, header, value, run: { pid: 1234, status: 70, signal: null } };
}
test('failure decoder retains bound admission CONFLICT without inventing PREPARED, journal or publication', () => {
  const { draft, ready, header, value, run } = admissionFixture();
  const error = windowsPublicationFailure(run, value, header);
  assert.equal(error.code, 'PHI_PUBLICATION_CONFLICT'); assert.equal(error.publicationEvidence.journal, null);
  assert.equal(error.publicationEvidence.admission.journalCreated, false); assert.equal(Object.isFrozen(error.publicationEvidence.admission), true);
  draft.beginPublication(draft.binding, ready.transactionId); draft.failPublication(true, error.publicationEvidence);
  assert.equal(draft.publicationMetadata.state, 'CONFLICT'); assert.equal(draft.publicationMetadata.commitState, 'NOT_STARTED');
  assert.equal(draft.publicationMetadata.projectPublished, false); assert.deepEqual(draft.publicationMetadata.filesCommitted, []);
  assert.equal(draft.snapshot.files['input.txt'], 'verified-change');
  for (const fake of [error, error.publicationEvidence, error.publicationEvidence.admission]) assert.throws(() => consumeWindowsPublicationProof(fake, {}), /NATIVE_PROOF_DENIED/u);
});
test('admission decoder rejects mismatched binding, extra/raw fields, ambiguous execution and unsupported failure classes', () => {
  const mutations = [
    x => { x.value.reason = 'UNCONFIRMED'; }, x => { x.value.phase = 'PREPARED'; }, x => { x.value.nativeCode = 'raw-secret'; },
    x => { x.value.journal = {}; }, x => { x.value.projectPublished = true; }, x => { x.value.externalRequests = 1; },
    ...['transactionId', 'projectIdentity', 'draftId', 'draftVersion', 'verifiedDigest', 'baseDigest', 'operations'].map(key => x => { x.value.admission[key] = null; }),
    ...['journalCreated', 'mutationStarted', 'projectPublished'].map(key => x => { x.value.admission[key] = true; }),
    ...['commitState', 'recoveryState', 'cleanup'].map(key => x => { x.value.admission[key] = 'PASS'; }),
    x => { x.value.admission.version = 2; }, x => { x.value.admission.scope = 'JOURNAL'; }, x => { x.value.admission.phase = 'COMMITTED'; },
    x => { x.value.admission.filesCommitted = ['input.txt']; }, x => { x.value.admission.pendingOperations = 0; },
    x => { x.value.admission.stdout = 'RAW_FILE_SENTINEL'; }, x => { delete x.value.admission.cleanup; },
    x => { x.run.error = new Error('RAW_ERROR_SENTINEL'); }, x => { x.run.status = 0; }, x => { x.run.status = null; },
    x => { x.run.signal = 'SIGTERM'; }, x => { x.run.pid = null; },
  ];
  for (const mutate of mutations) {
    const item = admissionFixture(); mutate(item);
    const error = windowsPublicationFailure(item.run, item.value, item.header);
    assert.equal(error.code, 'PHI_PUBLICATION_NATIVE_EXECUTION_UNCONFIRMED'); assert.equal(error.publicationEvidence, undefined);
    assert.doesNotMatch(JSON.stringify(error), /RAW_|raw-secret/u);
  }
});
test('failure decoder preserves actual bound post-journal conflicts, without propagating raw extra fields', () => {
  const { run, value, header } = admissionFixture();
  value.admission = null; value.phase = 'validation';
  value.journal = { version: 2, scope: 'SINGLE_FILE_MODIFY_JOURNAL_NOT_CONTROLLER_PUBLICATION', ...header,
    phase: 'CONFLICT', sequence: 5, operationIndex: 0, tempIdentity: fileIdentity(9), committedIdentity: null, filesCommitted: [], pendingOperations: 1,
    recoveryState: 'INSPECTION_REQUIRED', cleanup: 'NOT_PROVEN', projectPublished: false };
  const error = windowsPublicationFailure(run, value, header);
  assert.equal(error.code, 'PHI_PUBLICATION_CONFLICT'); assert.equal(error.publicationEvidence.journal.phase, 'CONFLICT');
  const bad = structuredClone(value); bad.journal.prompt = 'RAW_PROMPT_SENTINEL';
  assert.equal(windowsPublicationFailure(run, bad, header).publicationEvidence, undefined);
});
test('RENAME failure decoder accepts only bound V4 pre-mutation conflicts, never post-intent ambiguity', () => {
  const { run, value, header } = admissionFixture();
  header.operations = publicationOperations(publicationBase(snapshot({ 'old.txt': 'bytes' })), snapshot({ 'new.txt': 'bytes' }, 10),
    { sourcePath: 'old.txt', destinationPath: 'new.txt' });
  value.status = 'FAIL_NATIVE_SINGLE_RENAME'; value.admission.operations = header.operations;
  assert.equal(windowsPublicationFailure(run, value, header).code, 'PHI_PUBLICATION_CONFLICT');
  value.admission = null; value.phase = 'RENAME_INTENT';
  value.journal = { version: 4, scope: 'SINGLE_FILE_RENAME_JOURNAL_NOT_CONTROLLER_PUBLICATION', ...header,
    phase: 'CONFLICT', sequence: 2, operationIndex: 0, tempIdentity: null, committedIdentity: null, filesCommitted: [], pendingOperations: 1,
    recoveryState: 'INSPECTION_REQUIRED', cleanup: 'NOT_PROVEN', projectPublished: false };
  assert.equal(windowsPublicationFailure(run, value, header).code, 'PHI_PUBLICATION_CONFLICT');
  value.journal = { ...value.journal, tempIdentity: header.operations[0].baseIdentity };
  assert.equal(windowsPublicationFailure(run, value, header).code, 'PHI_PUBLICATION_NATIVE_EXECUTION_UNCONFIRMED');
  value.journal = { ...value.journal, tempIdentity: null, operations: [] };
  assert.equal(windowsPublicationFailure(run, value, header).publicationEvidence, undefined);
});

function nativeFixture(task = 'Fix JSON configuration code and test diagnostics', operation = 'modify') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-publication-')), project = path.join(root, 'project'); fs.mkdirSync(project);
  const files = {
    'config.json': '{}',
    'package.json': JSON.stringify({ scripts: { lint: 'node --check test.cjs', test: 'node test.cjs' } }),
    'edit.cjs': "require('node:fs').writeFileSync('config.json','{\"changed\":true}');console.log(process.pid)",
    'test.cjs': "const f=require('node:fs'),a=require('node:assert/strict');a.equal(JSON.parse(f.readFileSync('config.json','utf8')).changed,true);a.throws(()=>f.writeFileSync('config.json','forbidden'),e=>['EACCES','EPERM'].includes(e.code));console.log(process.pid)",
  };
  if (operation === 'delete') {
    files['remove.txt'] = 'obsolete-delete-fixture';
    files['edit.cjs'] = "require('node:fs').unlinkSync('remove.txt');console.log(process.pid)";
    files['test.cjs'] = "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.existsSync('remove.txt'),false);a.throws(()=>f.unlinkSync('config.json'),e=>['EACCES','EPERM'].includes(e.code));console.log(process.pid)";
  }
  if (operation === 'rename') {
    files['move.txt'] = 'unchanged-rename-fixture';
    // Draft intent is DELETE+CREATE. Only the trusted publisher executes the
    // native expected-ID, no-clobber RENAME after the full verification gate.
    files['edit.cjs'] = "try{const f=require('node:fs');f.writeFileSync('moved.txt',f.readFileSync('move.txt'),{flag:'wx'});f.unlinkSync('move.txt');console.log(process.pid)}catch(e){process.stderr.write('PHI_MOVE_DRAFT:'+e.code+':'+e.syscall);process.exitCode=1}";
    files['test.cjs'] = "const f=require('node:fs'),a=require('node:assert/strict');a.equal(f.existsSync('move.txt'),false);a.equal(f.readFileSync('moved.txt','utf8'),'unchanged-rename-fixture');a.throws(()=>f.writeFileSync('moved.txt','forbidden'),e=>['EACCES','EPERM'].includes(e.code));console.log(process.pid)";
  }
  if (operation === 'mixed') {
    files['remove.txt'] = 'obsolete-mixed-fixture';
    files['move.txt'] = 'unchanged-mixed-rename-fixture';
    files['edit.cjs'] = "const f=require('node:fs');f.writeFileSync('config.json','{\"changed\":true}');f.writeFileSync('created.txt','created-mixed-fixture',{flag:'wx'});f.unlinkSync('remove.txt');f.writeFileSync('moved.txt',f.readFileSync('move.txt'),{flag:'wx'});f.unlinkSync('move.txt');console.log(process.pid)";
    files['test.cjs'] = "const f=require('node:fs'),a=require('node:assert/strict');a.equal(JSON.parse(f.readFileSync('config.json','utf8')).changed,true);a.equal(f.readFileSync('created.txt','utf8'),'created-mixed-fixture');a.equal(f.existsSync('remove.txt'),false);a.equal(f.existsSync('move.txt'),false);a.equal(f.readFileSync('moved.txt','utf8'),'unchanged-mixed-rename-fixture');a.throws(()=>f.writeFileSync('config.json','forbidden'),e=>['EACCES','EPERM'].includes(e.code));console.log(process.pid)";
  }
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
  const boundedRenameFailure = /^PHI_MOVE_DRAFT:[A-Z0-9]+:[a-z]+$/u.test(edit.stderr?.trim() ?? '') ? edit.stderr.trim() : 'EDIT_NONZERO';
  assert.equal(edit.code, 0, boundedRenameFailure); assert.equal(edit.metadata.profile, 'EDIT'); assert.equal(edit.metadata.cleanup, 'PASS');
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
test('native real draft EDIT/LSP/TEST reaches controller-only READY, stale/forged/re-analysis grants cannot publish', native, async () => {
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
test('native production Worker EDIT/LSP/TEST/READY/journal/MODIFY reaches PUBLISHED with exact verified Git diff and cleanup', native, async () => {
  const item = nativeFixture(); let publication;
  try {
    assert.equal(spawnSync('git', ['-C', item.project, 'add', 'config.json', 'package.json', 'edit.cjs', 'test.cjs'], { shell: false }).status, 0);
    assert.equal(spawnSync('git', ['-C', item.project, '-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture baseline'], { shell: false }).status, 0);
    const evidence = await nativeVerified(item), before = item.reservation.status().draft;
    assert.equal(fs.readFileSync(path.join(item.project, 'config.json'), 'utf8'), '{}');
    const ready = item.reservation.preparePublication({ approveProjectMutation: true });
    assert.equal(ready.receipt.state, 'READY_TO_PUBLISH');
    publication = executePreparedWindowsPublication(ready.authority);
    assert.equal(publication.state, 'PUBLISHED'); assert.equal(publication.projectPublished, true); assert.equal(publication.cleanup, 'PASS');
    assert.deepEqual(publication.filesCommitted, ['config.json']);
    const proof = publication.publicationProof;
    assert.equal(proof.scope, 'VERIFIED_WORKER_SINGLE_MODIFY'); assert.equal(proof.operation, 'MODIFY');
    assert.equal(proof.verifiedDigest, before.contentDigest); assert.equal(proof.finalDigest, before.contentDigest); assert.equal(publication.sourceDigest, before.contentDigest);
    assert.equal(proof.native.tempDigest, publication.operations[0].newDigest); assert.equal(proof.native.finalDigest, proof.native.tempDigest);
    assert.equal(proof.native.destinationIdentity, publication.operations[0].baseIdentity);
    assert.equal(proof.journal.phase, 'CLEANED'); assert.equal(proof.journal.cleanup, 'PASS');
    assert.equal(proof.publisherExited, true); assert.equal(proof.publisherExitCode, 0);
    assert.throws(() => process.kill(proof.publisherPid, 0), e => e.code === 'ESRCH');
    assert.equal(fs.readFileSync(path.join(item.project, 'config.json'), 'utf8'), '{"changed":true}');
    const diff = spawnSync('git', ['-C', item.project, 'diff', '--name-only', '--no-renames'], { shell: false, encoding: 'utf8' });
    assert.equal(diff.status, 0); assert.equal(diff.stdout.trim(), 'config.json');
    assert.equal(spawnSync('git', ['-C', item.project, 'diff', '--check'], { shell: false }).status, 0);
    assert.equal(fs.readdirSync(item.project).some(name => name.startsWith('phi-publish-')), false);
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => consumeWindowsPublicationProof(proof, {}), /NATIVE_PROOF_DENIED/u); // Public metadata is not the private certificate.
    await assert.rejects(executeCodingTool({ program: 'node', args: ['edit.cjs'], cwd: item.project, timeoutMs: 8000 },
      { operation: 'safe-exec', sessionId: item.sessionId, workerAuthority: item.token }), /ATTEMPT_ALREADY_PUBLISHED/u);
    assert.equal(fs.readFileSync(path.join(item.project, 'config.json'), 'utf8'), '{"changed":true}');
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    item.reservation.revoke(); assert.equal(item.reservation.status().draft.payloadCleared, true);
    console.log(JSON.stringify({ control: 'VERIFIED_WORKER_SINGLE_MODIFY', receipts: [evidence.edit, evidence.lsp, ...evidence.verification.results.map(x => x.receipt)], publication,
      gitDiffOnlyIntendedChange: true, sourceWasUnchangedUntilCommit: true, publisherGone: true, authorityRevoked: true, payloadCleared: true, externalRequests: 0 }));
  } finally { item.close(); }
});
test('native user change after READY is CONFLICT, preserving real user bytes and verified draft without replay', native, async () => {
  const item = nativeFixture();
  try {
    await nativeVerified(item); const ready = item.reservation.preparePublication({ approveProjectMutation: true }), before = item.reservation.status().draft;
    fs.writeFileSync(path.join(item.project, 'config.json'), '{"user":true}');
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PHI_PUBLICATION_CONFLICT/u);
    assert.equal(item.reservation.publicationStatus().state, 'CONFLICT'); assert.equal(item.reservation.publicationStatus().projectPublished, false);
    assert.equal(item.reservation.status().draft.contentDigest, before.contentDigest);
    assert.equal(fs.readFileSync(path.join(item.project, 'config.json'), 'utf8'), '{"user":true}');
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'VERIFIED_WORKER_SINGLE_MODIFY_CONFLICT', publication: item.reservation.publicationStatus(), userPreserved: true, draftPreserved: true, replayDenied: true, externalRequests: 0 }));
  } finally { item.close(); }
});
test('native production Worker DELETE/LSP/TEST/READY/same-journal publishes only intended Git deletion without TxF', native, async () => {
  const item = nativeFixture('Fix JSON code and remove obsolete fixture with tests', 'delete');
  try {
    assert.equal(spawnSync('git', ['-C', item.project, 'add', 'config.json', 'package.json', 'edit.cjs', 'test.cjs', 'remove.txt'], { shell: false }).status, 0);
    assert.equal(spawnSync('git', ['-C', item.project, '-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'DELETE fixture baseline'], { shell: false }).status, 0);
    const evidence = await nativeVerified(item), before = item.reservation.status().draft;
    assert.equal(fs.existsSync(path.join(item.project, 'remove.txt')), true); // Real Worker only edited its isolated draft.
    const ready = item.reservation.preparePublication({ approveProjectMutation: true });
    assert.equal(ready.receipt.state, 'READY_TO_PUBLISH'); assert.deepEqual(ready.receipt.operations.map(o => [o.path, o.kind]), [['remove.txt', 'DELETE']]);
    for (const fake of [item.token, structuredClone(ready.authority)]) assert.throws(() => executePreparedWindowsPublication(fake), /PUBLISH_AUTHORITY_DENIED/u);
    const publication = executePreparedWindowsPublication(ready.authority), proof = publication.publicationProof;
    assert.equal(publication.state, 'PUBLISHED'); assert.equal(publication.projectPublished, true); assert.equal(publication.cleanup, 'PASS');
    assert.deepEqual(publication.filesCommitted, ['remove.txt']); assert.equal(proof.scope, 'VERIFIED_WORKER_SINGLE_DELETE'); assert.equal(proof.operation, 'DELETE');
    assert.equal(proof.native.txfUsed, false); assert.equal(proof.native.sourceIdentity, publication.operations[0].baseIdentity);
    assert.equal(proof.native.oldDigest, publication.operations[0].baseDigest); assert.equal(proof.native.quarantineAbsent, true);
    assert.equal(proof.journal.version, 3); assert.equal(proof.journal.phase, 'CLEANED'); assert.equal(proof.journal.pendingOperations, 0);
    assert.equal(proof.verifiedDigest, before.contentDigest); assert.equal(proof.finalDigest, before.contentDigest);
    assert.equal(proof.publisherExited, true); assert.equal(proof.publisherExitCode, 0);
    assert.throws(() => process.kill(proof.publisherPid, 0), e => e.code === 'ESRCH');
    assert.equal(fs.existsSync(path.join(item.project, 'remove.txt')), false);
    const diff = spawnSync('git', ['-C', item.project, 'diff', '--name-status', '--no-renames'], { shell: false, encoding: 'utf8' });
    assert.equal(diff.status, 0); assert.equal(diff.stdout.trim(), 'D\tremove.txt');
    assert.equal(spawnSync('git', ['-C', item.project, 'diff', '--check'], { shell: false }).status, 0);
    assert.equal(fs.readdirSync(item.project).some(name => name.startsWith('phi-delete-')), false);
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => consumeWindowsPublicationProof(proof, {}), /NATIVE_PROOF_DENIED/u);
    await assert.rejects(executeCodingTool({ program: 'node', args: ['edit.cjs'], cwd: item.project, timeoutMs: 8000 }, { operation: 'safe-exec', sessionId: item.sessionId, workerAuthority: item.token }), /ATTEMPT_ALREADY_PUBLISHED/u);
    item.reservation.revoke(); assert.equal(item.reservation.status().draft.payloadCleared, true); assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'VERIFIED_WORKER_SINGLE_DELETE', receipts: [evidence.edit, evidence.lsp, ...evidence.verification.results.map(x => x.receipt)], publication,
      gitDiffOnlyIntendedDeletion: true, sourceWasUnchangedUntilCommit: true, publisherGone: true, authorityRevoked: true, payloadCleared: true, externalRequests: 0 }));
  } finally { item.close(); }
});
test('native production Worker DELETE concurrent replacement after READY is preserved and cannot be replayed', native, async () => {
  const item = nativeFixture('Fix JSON code and remove obsolete fixture with tests', 'delete');
  try {
    await nativeVerified(item); const ready = item.reservation.preparePublication({ approveProjectMutation: true }), before = item.reservation.status().draft;
    fs.renameSync(path.join(item.project, 'remove.txt'), path.join(item.project, 'previous.txt'));
    fs.writeFileSync(path.join(item.project, 'remove.txt'), 'obsolete-delete-fixture');
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PHI_PUBLICATION_CONFLICT/u);
    assert.equal(item.reservation.publicationStatus().state, 'CONFLICT'); assert.equal(item.reservation.publicationStatus().projectPublished, false);
    assert.equal(item.reservation.status().draft.contentDigest, before.contentDigest); assert.equal(fs.readFileSync(path.join(item.project, 'remove.txt'), 'utf8'), 'obsolete-delete-fixture');
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.equal(fs.readdirSync(item.project).some(name => name.startsWith('phi-delete-')), false);
    console.log(JSON.stringify({ control: 'VERIFIED_WORKER_SINGLE_DELETE_CONFLICT', publication: item.reservation.publicationStatus(), userPreserved: true, draftPreserved: true, replayDenied: true, externalRequests: 0 }));
  } finally { item.close(); }
});
test('native production Worker move intent/LSP/TEST/READY/V4 journal publishes only intended Git rename without TxF', native, async () => {
  const item = nativeFixture('Fix JSON code and rename obsolete fixture with tests', 'rename');
  const intent = { sourcePath: 'move.txt', destinationPath: 'moved.txt' };
  try {
    assert.equal(spawnSync('git', ['-C', item.project, 'add', 'config.json', 'package.json', 'edit.cjs', 'test.cjs', 'move.txt'], { shell: false }).status, 0);
    assert.equal(spawnSync('git', ['-C', item.project, '-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'RENAME fixture baseline'], { shell: false }).status, 0);
    const evidence = await nativeVerified(item), before = item.reservation.status().draft;
    assert.equal(fs.existsSync(path.join(item.project, 'move.txt')), true);
    assert.equal(fs.existsSync(path.join(item.project, 'moved.txt')), false);
    for (const bad of [
      { approveProjectMutation: true, rename: null }, { approveProjectMutation: true, rename: { ...intent, runner: 'copy' } },
      { approveProjectMutation: true, rename: intent, runner: 'copy' },
    ]) assert.throws(() => item.reservation.preparePublication(bad), /PUBLISH_AUTHORITY_DENIED|RENAME_INTENT_INVALID/u);
    const ready = item.reservation.preparePublication({ approveProjectMutation: true, rename: intent });
    assert.equal(ready.receipt.state, 'READY_TO_PUBLISH');
    assert.deepEqual(ready.receipt.operations.map(op => [op.sourcePath, op.path, op.kind]), [['move.txt', 'moved.txt', 'RENAME']]);
    assert.throws(() => executePreparedWindowsPublication(structuredClone(ready.authority)), /PUBLISH_AUTHORITY_DENIED/u);
    const publication = executePreparedWindowsPublication(ready.authority), proof = publication.publicationProof;
    assert.equal(publication.state, 'PUBLISHED'); assert.equal(publication.projectPublished, true); assert.equal(publication.cleanup, 'PASS');
    assert.deepEqual(publication.filesCommitted, ['moved.txt']); assert.equal(proof.scope, 'VERIFIED_WORKER_SINGLE_RENAME');
    assert.equal(proof.operation, 'RENAME'); assert.equal(proof.native.txfUsed, false);
    assert.equal(proof.native.sourceIdentity, ready.receipt.operations[0].baseIdentity);
    assert.equal(proof.native.destinationIdentity, ready.receipt.operations[0].baseIdentity);
    assert.equal(proof.journal.version, 4); assert.equal(proof.journal.phase, 'CLEANED'); assert.equal(proof.journal.pendingOperations, 0);
    assert.equal(proof.verifiedDigest, before.contentDigest); assert.equal(proof.finalDigest, before.contentDigest);
    assert.equal(proof.publisherExited, true); assert.equal(proof.publisherExitCode, 0);
    assert.throws(() => process.kill(proof.publisherPid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.existsSync(path.join(item.project, 'move.txt')), false);
    assert.equal(fs.readFileSync(path.join(item.project, 'moved.txt'), 'utf8'), 'unchanged-rename-fixture');
    assert.equal(spawnSync('git', ['-C', item.project, 'add', '-N', 'moved.txt'], { shell: false }).status, 0);
    const diff = spawnSync('git', ['-C', item.project, 'diff', '--name-status', '--no-renames'], { shell: false, encoding: 'utf8' });
    assert.equal(diff.status, 0); assert.deepEqual(diff.stdout.trim().split('\n').sort(), ['A\tmoved.txt', 'D\tmove.txt']);
    assert.equal(spawnSync('git', ['-C', item.project, 'diff', '--check'], { shell: false }).status, 0);
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => consumeWindowsPublicationProof(proof, {}), /NATIVE_PROOF_DENIED/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    item.reservation.revoke(); assert.equal(item.reservation.status().draft.payloadCleared, true);
    console.log(JSON.stringify({ control: 'VERIFIED_WORKER_SINGLE_RENAME', receipts: [evidence.edit, evidence.lsp, ...evidence.verification.results.map(x => x.receipt)], publication,
      gitDiffOnlyIntendedRename: true, sourceWasUnchangedUntilCommit: true, publisherGone: true, authorityRevoked: true, payloadCleared: true, externalRequests: 0 }));
  } finally { item.close(); }
});
test('native user change after READY RENAME is CONFLICT; user destination and verified draft survive', native, async () => {
  const item = nativeFixture('Fix JSON code and rename obsolete fixture with tests', 'rename');
  const intent = { sourcePath: 'move.txt', destinationPath: 'moved.txt' };
  try {
    await nativeVerified(item);
    const ready = item.reservation.preparePublication({ approveProjectMutation: true, rename: intent }), before = item.reservation.status().draft;
    fs.writeFileSync(path.join(item.project, 'moved.txt'), 'user-destination');
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PHI_PUBLICATION_CONFLICT/u);
    assert.equal(item.reservation.publicationStatus().state, 'CONFLICT'); assert.equal(item.reservation.publicationStatus().projectPublished, false);
    assert.equal(item.reservation.status().draft.contentDigest, before.contentDigest);
    assert.equal(fs.readFileSync(path.join(item.project, 'move.txt'), 'utf8'), 'unchanged-rename-fixture');
    assert.equal(fs.readFileSync(path.join(item.project, 'moved.txt'), 'utf8'), 'user-destination');
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'VERIFIED_WORKER_SINGLE_RENAME_CONFLICT', publication: item.reservation.publicationStatus(), userPreserved: true, draftPreserved: true, replayDenied: true, externalRequests: 0 }));
  } finally { item.close(); }
});
test('native V5 governed Worker to controller handoff publishes exact four-operation Git diff once', native, async () => {
  const task = 'Fix JSON code, create and remove a fixture, rename a fixture, then test all changes';
  const item = nativeFixture(task, 'mixed');
  const hooks = new Map(); registerWindowsWorkerBoundary({ on: (event, hook) => hooks.set(event, hook) });
  const ctx = { cwd: item.project, sessionManager: { getSessionId: () => item.sessionId } };
  try {
    for (const name of ['config.json', 'package.json', 'edit.cjs', 'test.cjs', 'remove.txt', 'move.txt'])
      assert.equal(fs.existsSync(path.join(item.project, name)), true);
    assert.equal(spawnSync('git', ['-C', item.project, 'add', '.'], { shell: false }).status, 0);
    assert.equal(spawnSync('git', ['-C', item.project, '-c', 'user.name=Phi fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'V5 fixture baseline'], { shell: false }).status, 0);
    // The actual Worker extension hooks and registered safe_exec handler use
    // the same package-scoped foreground reservation as production Pi.
    hooks.get('before_agent_start')({ prompt: `Task: ${task}` }, ctx);
    assert.equal(hooks.get('tool_call')({ toolName: 'safe_exec' }, ctx), undefined);
    assert.equal(hooks.get('tool_call')({ toolName: 'write' }, ctx).block, true);
    const edit = await executeBrokeredSafeExec({ program: 'node', args: ['edit.cjs'], timeoutMs: 8000 }, ctx);
    assert.equal(edit.details.receipt.profile, 'EDIT'); assert.equal(edit.details.receipt.cleanup, 'PASS');
    assert.equal(edit.details.receipt.projectPublished, false);
    const lsp = await executeCodingLsp(item.project, { operation: 'diagnostics', path: 'config.json' }, item.context);
    assert.equal(lsp.status, 'PASS'); assert.equal(lsp.count, 0);
    const verified = await verifyCodingProject({ cwd: item.project, workerAuthority: item.token, sessionId: item.sessionId });
    assert.equal(verified.status, 'PASS');
    assert.equal(fs.readFileSync(path.join(item.project, 'config.json'), 'utf8'), '{}');
    assert.equal(fs.existsSync(path.join(item.project, 'created.txt')), false);
    const intent = { sourcePath: 'move.txt', destinationPath: 'moved.txt' };
    const ready = item.reservation.preparePublication({ approveProjectMutation: true, rename: intent });
    assert.equal(ready.receipt.state, 'READY_TO_PUBLISH');
    assert.deepEqual(ready.receipt.operations.map(op => op.kind), ['REPLACE', 'CREATE', 'DELETE', 'RENAME']);
    assert.throws(() => item.reservation.preparePublication({ approveProjectMutation: true, rename: intent }), /AUTHORITY_UNAVAILABLE/u);
    assert.throws(() => executePreparedWindowsPublication(item.token), /PUBLISH_AUTHORITY_DENIED/u);
    assert.throws(() => executePreparedWindowsPublication(structuredClone(ready.authority)), /PUBLISH_AUTHORITY_DENIED/u);
    await assert.rejects(executeBrokeredSafeExec({ program: 'node', args: ['edit.cjs'], timeoutMs: 8000 }, ctx), /PUBLISH_HANDOFF_CLOSED/u);
    const publication = executePreparedWindowsPublication(ready.authority);
    assert.equal(publication.state, 'PUBLISHED'); assert.equal(publication.projectPublished, true); assert.equal(publication.cleanup, 'PASS');
    assert.deepEqual(publication.filesCommitted, ['config.json', 'created.txt', 'remove.txt', 'moved.txt']);
    assert.equal(publication.publicationProof.scope, 'VERIFIED_WORKER_MIXED');
    assert.equal(publication.publicationProof.journal.version, 5);
    assert.equal(publication.publicationProof.journal.phase, 'CLEANED');
    assert.equal(publication.publicationProof.native.quarantineAbsent, true);
    assert.equal(publication.publicationProof.verifiedDigest, verified.draft.contentDigest);
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.equal(fs.readFileSync(path.join(item.project, 'config.json'), 'utf8'), '{"changed":true}');
    assert.equal(fs.readFileSync(path.join(item.project, 'created.txt'), 'utf8'), 'created-mixed-fixture');
    assert.equal(fs.existsSync(path.join(item.project, 'remove.txt')), false);
    assert.equal(fs.existsSync(path.join(item.project, 'move.txt')), false);
    assert.equal(fs.readFileSync(path.join(item.project, 'moved.txt'), 'utf8'), 'unchanged-mixed-rename-fixture');
    assert.equal(spawnSync('git', ['-C', item.project, 'add', '-N', 'created.txt', 'moved.txt'], { shell: false }).status, 0);
    const diff = spawnSync('git', ['-C', item.project, 'diff', '--name-status', '--no-renames'], { shell: false, encoding: 'utf8' });
    assert.equal(diff.status, 0);
    assert.deepEqual(diff.stdout.trim().split('\n').sort(), ['M\tconfig.json', 'A\tcreated.txt', 'D\tmove.txt', 'A\tmoved.txt', 'D\tremove.txt'].sort());
    assert.equal(spawnSync('git', ['-C', item.project, 'diff', '--check'], { shell: false }).status, 0);
    assert.equal(fs.readdirSync(item.project).some(name => /^phi-(?:publish|delete)-/u.test(name)), false);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    hooks.get('session_shutdown')();
    assert.equal(item.reservation.status().draft.payloadCleared, true);
    console.log(JSON.stringify({ control: 'VERIFIED_WORKER_MIXED', edit: edit.details.receipt, lsp: lsp.receipt,
      verification: verified.status, publication, exactGitDiff: true, oneUseHandoff: true, workerAuthorityRevoked: true, externalRequests: 0 }));
  } finally { item.close(); }
});
test('native V5 stale handoff and concurrent user destination never grant publication or replay', native, async () => {
  const task = 'Fix JSON code, create and remove a fixture, rename a fixture, then test all changes';
  const intent = { sourcePath: 'move.txt', destinationPath: 'moved.txt' };
  const stale = nativeFixture(task, 'mixed');
  try {
    await nativeVerified(stale);
    const ready = stale.reservation.preparePublication({ approveProjectMutation: true, rename: intent });
    assert.equal(ready.receipt.operations.length, 4);
    stale.reservation.revoke();
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.equal(fs.readFileSync(path.join(stale.project, 'config.json'), 'utf8'), '{}');
    assert.equal(fs.existsSync(path.join(stale.project, 'created.txt')), false);
  } finally { stale.close(); }
  const conflict = nativeFixture(task, 'mixed');
  try {
    await nativeVerified(conflict);
    const ready = conflict.reservation.preparePublication({ approveProjectMutation: true, rename: intent });
    fs.writeFileSync(path.join(conflict.project, 'moved.txt'), 'concurrent-user-destination');
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PHI_PUBLICATION_CONFLICT/u);
    assert.equal(conflict.reservation.publicationStatus().state, 'CONFLICT');
    assert.equal(conflict.reservation.publicationStatus().projectPublished, false);
    assert.equal(fs.readFileSync(path.join(conflict.project, 'moved.txt'), 'utf8'), 'concurrent-user-destination');
    assert.equal(fs.readFileSync(path.join(conflict.project, 'config.json'), 'utf8'), '{}');
    assert.equal(fs.existsSync(path.join(conflict.project, 'created.txt')), false);
    assert.equal(fs.existsSync(path.join(conflict.project, 'remove.txt')), true);
    assert.equal(fs.existsSync(path.join(conflict.project, 'move.txt')), true);
    assert.throws(() => executePreparedWindowsPublication(ready.authority), /PUBLISH_AUTHORITY_DENIED/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
  } finally { conflict.close(); }
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
