import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { windowsPublicationFailure, consumeWindowsPublicationProof } from '../platform/windows/publication.mjs';

test('DELETE extends the same journal with exclusive identity-checked quarantine, never TxF or bare production unlink', () => {
  const journal = fs.readFileSync(new URL('../platform/windows/native/PublicationJournal.cs', import.meta.url), 'utf8').split('// Fixed fixtures only.')[0];
  const deletion = journal.slice(journal.indexOf('static string DeleteLeaf'), journal.indexOf('void ReadChain'));
  for (const item of ['PublishSingleDelete', 'DELETE_INTENT', 'DELETE_QUARANTINED', 'CLEANUP_STARTED', 'InspectSingleDelete', 'deleteCleanupIntent', 'UNKNOWN_FAIL_SAFE', 'ReadDeleteObject(source)', 'parent.QuarantineDeleteSource', 'parent.UnlinkQuarantinedFile']) assert.ok(deletion.includes(item), item);
  assert.doesNotMatch(deletion, /File\.Delete|File\.Move|Directory\.Delete|CreateTransaction|CommitTransaction|CreateFileTransacted/u);
  assert.match(journal, /version == 3.*kind != "DELETE"/u);
  assert.match(journal, /parsed\.InspectSingleDelete\(recover\)/u);
  assert.match(deletion, /projectMutations = 0, processKills = 0/u);
  assert.ok(deletion.indexOf('Observe("CLEANUP_STARTED"') < deletion.indexOf('parent.UnlinkQuarantinedFile'));
  const native = fs.readFileSync(new URL('../platform/windows/native/RecoveryFilesystem.cs', import.meta.url), 'utf8');
  assert.match(native, /leaf, 0x30081, 0, 1, 0x40/u); // No write rights, sharing or overwrite-open.
  assert.match(native, /QuarantineDeleteSource[\s\S]*?RenameRegisteredFile\(file, destination, deletionFiles\)/u);
  assert.match(native, /RenameNewFile[\s\S]*?RenameRegisteredFile\(file, destination, publicationFiles\)/u);
});

test('DELETE failure metadata cannot claim unstarted conflict after recorded commit or mint a private certificate', () => {
  const identity = 'a'.repeat(16) + ':' + 'b'.repeat(32);
  const op = { path: 'remove.txt', kind: 'DELETE', baseIdentity: identity, baseDigest: 'c'.repeat(64), newDigest: null, newBytes: null };
  const header = { transactionId: 'd'.repeat(32), projectIdentity: identity, draftId: 'e'.repeat(32), draftVersion: 1, verifiedDigest: 'f'.repeat(64), baseDigest: '1'.repeat(64), operations: [op] };
  const value = { version: 1, status: 'FAIL_NATIVE_SINGLE_DELETE', reason: 'CONFLICT', phase: 'before-delete', nativeCode: '80131509', projectPublished: false, externalRequests: 0,
    journal: { version: 3, scope: 'SINGLE_FILE_DELETE_JOURNAL_NOT_CONTROLLER_PUBLICATION', ...header, phase: 'CONFLICT', sequence: 1, operationIndex: 0, tempIdentity: null, committedIdentity: null,
      filesCommitted: [], pendingOperations: 1, recoveryState: 'INSPECTION_REQUIRED', cleanup: 'NOT_PROVEN', projectPublished: false }, admission: null };
  const run = { status: 70, pid: 1234, signal: null };
  assert.equal(windowsPublicationFailure(run, value, header).code, 'PHI_PUBLICATION_CONFLICT');
  const committed = structuredClone(value); committed.journal.committedIdentity = identity; committed.journal.filesCommitted = ['remove.txt']; committed.journal.pendingOperations = 0;
  assert.equal(windowsPublicationFailure(run, committed, header).code, 'PHI_PUBLICATION_NATIVE_EXECUTION_UNCONFIRMED');
  const possibleMutation = structuredClone(value); possibleMutation.journal.tempIdentity = identity;
  assert.equal(windowsPublicationFailure(run, possibleMutation, header).code, 'PHI_PUBLICATION_NATIVE_EXECUTION_UNCONFIRMED');
  for (const change of [x => { x.status = 'FAIL_NATIVE_SINGLE_MODIFY'; }, x => { x.journal.version = 2; }, x => { x.journal.draftVersion++; }, x => { x.journal.stdout = 'RAW_FILE_SENTINEL'; }]) {
    const bad = structuredClone(value); change(bad); assert.equal(windowsPublicationFailure(run, bad, header).publicationEvidence, undefined);
  }
  for (const fake of [value, value.journal, windowsPublicationFailure(run, value, header)]) assert.throws(() => consumeWindowsPublicationProof(fake, {}), /NATIVE_PROOF_DENIED/u);
});

const points = ['before-delete', 'intent', 'renamed', 'quarantined', 'committed', 'verified', 'cleanup-started', 'unlinked', 'cleaned'];
const cases = ['normal', 'already-missing', 'concurrent-modification', 'delete-recreate', 'replacement-before-mutation', 'unauthorized-delete', 'protected', 'root-identity', 'sharing', 'quarantine-collision', 'unobserved-advance',
  ...points.map(p => 'crash-' + p), 'user-recreate-after-crash', 'same-text-recreate-after-crash', 'quarantine-replace-after-crash', 'quarantine-missing-after-crash'];
for (const name of cases) test('native same-journal recoverable DELETE: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--publication-delete-selftest', name], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 22000, maxBuffer: 20000 });
  assert.equal(result.status, 0, result.stderr); const receipt = JSON.parse(result.stdout);
  for (const key of ['passed', 'fixtureCleanup', 'unrelatedPreserved']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.scope, 'NATIVE_JOURNAL_DELETE_NOT_VERIFIED_WORKER_PUBLICATION');
  assert.equal(receipt.txfUsed, false); assert.equal(receipt.projectPublished, false); assert.equal(receipt.externalRequests, 0);
  if (name.startsWith('crash-') || name.endsWith('after-crash')) {
    for (const key of ['actualProcessKilled', 'childGone', 'restartedRecovery']) assert.equal(receipt[key], true, key);
    assert.equal(receipt.evidence.projectMutations, 0); assert.equal(receipt.evidence.processKills, 0); assert.equal(receipt.evidence.projectPublished, false);
    assert.equal(receipt.evidence.metadata.version, 3); assert.equal(receipt.evidence.metadata.operations[0].kind, 'DELETE');
    if (name.endsWith('after-crash')) { assert.equal(receipt.evidence.journalMutations, 0); assert.equal(receipt.evidence.status, name === 'quarantine-missing-after-crash' ? 'UNKNOWN_FAIL_SAFE' : 'CONFLICT'); }
  }
  if (name === 'normal') { assert.equal(receipt.evidence.journal.phase, 'CLEANED'); assert.equal(receipt.evidence.nativeProof.backend, 'HANDLE_ANCHORED_QUARANTINE_DELETE'); assert.equal(receipt.evidence.nativeProof.quarantineAbsent, true); }
  assert.doesNotMatch(JSON.stringify(receipt), /old-delete-complete|new-delete-user|unrelated-delete-user/u);
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'NATIVE_JOURNAL_DELETE_ONLY', ...receipt }));
});
