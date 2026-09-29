import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { consumeWindowsPublicationProof } from '../platform/windows/publication.mjs';
import { publicationBase, publicationOperations } from '../lib/phi-publication-plan.mjs';

const cases = ['normal', 'destination-exists', 'destination-created-after-lock', 'case-alias-destination', 'same-source-alias',
  'expected-id-mismatch', 'expected-digest-mismatch', 'source-name-mismatch', 'foreign-owner', 'create-handle', 'delete-handle',
  'protected-destination', 'reserved-destination', 'cross-parent-destination', 'traversal-destination', 'ads-destination',
  'source-sharing', 'pinned-parent', 'source-writer-denied', 'consumed-authority'];
const movedCases = new Set(['normal', 'pinned-parent', 'source-writer-denied', 'consumed-authority']);

test('bounded expected-source RENAME consumes private name/ID/hash authority without new rights, sharing, unlink or pathname fallback', () => {
  const source = fs.readFileSync(new URL('../platform/windows/native/RecoveryFilesystem.cs', import.meta.url), 'utf8');
  const rename = source.slice(source.indexOf('internal IntPtr OpenRenameSource'), source.indexOf('internal void QuarantineDeleteSource'));
  for (const value of ['AnchoredFile.Segments', 'OpenDeleteSource', 'renameSources.TryGetValue', 'origin != source', 'StringComparison.OrdinalIgnoreCase',
    'RenameSourceDigest(file) != expectedDigest', 'HandleIdentity(file) != expectedIdentity', 'RenameRegisteredFile(file, destination, deletionFiles)', 'renameSources.Remove(file)', 'journalUsed = false', 'projectPublished = false']) assert.ok(rename.includes(value), value);
  assert.doesNotMatch(rename, /File\.Move|File\.Delete|File\.Write|Directory\.Move|CreateFileW|NtCreateFile|CreateTransaction|UnlinkQuarantinedFile|deletionFiles\.Add/u);
  assert.match(source, /leaf, 0x30081, 0, 1, 0x40/u);
  const dispatch = fs.readFileSync(new URL('../platform/windows/native/OwnedProcess.cs', import.meta.url), 'utf8');
  assert.match(dispatch, /args.Length == 2 && args\[0\] == "--rename-primitive-selftest"/u);
  assert.doesNotMatch(dispatch, /args\[0\] == "--publication-rename"/u); // Not a production publication endpoint yet.
});

test('equal content still produces explicit DELETE+CREATE, never an inferred rename or JSON publication authority', () => {
  const rootIdentity = 'a'.repeat(16) + ':' + 'b'.repeat(32), identity = 'c'.repeat(16) + ':' + 'd'.repeat(32);
  const base = publicationBase({ rootIdentity, files: { 'old.txt': 'same' }, identities: { 'old.txt': identity } });
  const ops = publicationOperations(base, { rootIdentity, files: { 'new.txt': 'same' }, identities: { 'new.txt': identity } });
  assert.deepEqual(ops.map(op => [op.path, op.kind]), [['new.txt', 'CREATE'], ['old.txt', 'DELETE']]);
  assert.throws(() => consumeWindowsPublicationProof({ backend: 'HANDLE_ANCHORED_EXPECTED_SOURCE_RENAME', sourceIdentity: identity, destinationIdentity: identity, projectPublished: true }, {}), /NATIVE_PROOF_DENIED/u);
});

test('native expected-ID no-clobber RENAME: all fixed same-parent controls and owned cleanup', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--rename-primitive-selftest', 'same-parent'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 22000, maxBuffer: 64000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.version, 1); assert.equal(value.status, 'PASS'); assert.equal(value.scope, 'NATIVE_RENAME_PRIMITIVE_NOT_JOURNAL_OR_PUBLICATION');
  for (const key of ['journalUsed', 'recoveryImplemented', 'projectPublished', 'txfUsed']) assert.equal(value[key], false, key);
  assert.equal(value.externalRequests, 0); assert.equal(value.expectedCases, cases.length); assert.equal(value.completedCases, cases.length);
  assert.deepEqual(value.receipts.map(receipt => receipt.caseName), cases);
  for (const receipt of value.receipts) {
    for (const key of ['passed', 'fixtureCleanup', 'securityPreserved', 'creationPreserved', 'unrelatedPreserved']) assert.equal(receipt[key], true, receipt.caseName + '/' + key);
    const moved = movedCases.has(receipt.caseName);
    assert.equal(receipt.moved, moved); assert.equal(receipt.denied, !moved);
    assert.match(receipt.originalId, /^[0-9a-f]{16}:[0-9a-f]{32}$/u); assert.match(receipt.originalDigest, /^[0-9a-f]{64}$/u);
    if (moved) {
      assert.equal(receipt.sourceId, null); assert.equal(receipt.sourceDigest, null);
      assert.equal(receipt.destinationId, receipt.originalId); assert.equal(receipt.destinationDigest, receipt.originalDigest);
      assert.equal(receipt.proof.backend, 'HANDLE_ANCHORED_EXPECTED_SOURCE_RENAME');
      assert.equal(receipt.proof.sourceIdentity, receipt.originalId); assert.equal(receipt.proof.destinationIdentity, receipt.originalId);
      assert.equal(receipt.proof.digest, receipt.originalDigest);
      for (const key of ['sourceAuthorityConsumed', 'sameDirectory', 'noClobber']) assert.equal(receipt.proof[key], true, key);
      for (const key of ['txfUsed', 'journalUsed', 'projectPublished']) assert.equal(receipt.proof[key], false, key);
      assert.throws(() => consumeWindowsPublicationProof(receipt.proof, {}), /NATIVE_PROOF_DENIED/u);
    } else {
      assert.equal(receipt.sourceId, receipt.originalId); assert.equal(receipt.sourceDigest, receipt.originalDigest); assert.equal(receipt.proof, null);
      if (receipt.collisionId !== null) {
        assert.notEqual(receipt.collisionId, receipt.originalId); assert.equal(receipt.destinationId, receipt.collisionId); assert.equal(receipt.destinationDigest, receipt.collisionDigest);
        assert.ok([80, 183].includes(receipt.rejectionCode));
      } else { assert.equal(receipt.destinationId, null); assert.equal(receipt.destinationDigest, null); }
    }
    assert.equal(receipt.writerDenied, receipt.caseName === 'source-writer-denied');
    assert.equal(receipt.parentRenameDenied, receipt.caseName === 'pinned-parent');
    assert.equal(receipt.consumedAuthorityDenied, receipt.caseName === 'consumed-authority');
    if (receipt.caseName === 'source-sharing') assert.ok([32, 33].includes(receipt.rejectionCode));
  }
  assert.doesNotMatch(JSON.stringify(value), /rename-original-complete|rename-unrelated-user|rename-new-user|rename-writer-forbidden|[A-Z]:\\/u);
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'NATIVE_EXPECTED_SOURCE_RENAME_PRIMITIVE_ONLY', ...value }));
});

test('native rename fixture rejects caller-selected suites/paths without execution', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--rename-primitive-selftest', '../caller-path'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 22000, maxBuffer: 8192 });
  assert.equal(result.status, 70); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
