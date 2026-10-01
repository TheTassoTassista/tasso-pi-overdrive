import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { validateWindowsKnownReconstruction, validateWindowsKnownRecovery, validateWindowsTransactionDiscovery } from '../platform/windows/publication.mjs';
import { draftContentDigest, publicationBase } from '../lib/phi-publication-plan.mjs';

test('explicit same-directory RENAME is V4 journaled, bound to the expected source, and never inferred from equal content', () => {
  const journal = fs.readFileSync(new URL('../platform/windows/native/PublicationJournal.cs', import.meta.url), 'utf8');
  const production = journal.slice(0, journal.indexOf('// Fixed fixtures only.'));
  const rename = production.slice(production.indexOf('internal object PublishSingleRename'), production.indexOf('void ReadChain'));
  for (const item of ['version == 4', 'sourcePath', 'kind != "RENAME"', 'RENAME_INTENT', 'RENAMED', 'MatchesBase',
    'PublishSingleRename', 'InspectSingleRename', 'parent.OpenRenameSource', 'parent.RenameExpectedSource',
    'ReadDeleteObject(source)', 'ReadDeleteLeaf(parent, targetParts.Last())', 'RECOVERY_REQUIRED', 'UNKNOWN_FAIL_SAFE',
    'projectMutations = 0, processKills = 0', 'projectPublished = false']) assert.ok(production.includes(item), item);
  assert.ok(rename.indexOf('Observe("RENAME_INTENT"') < rename.indexOf('parent.RenameExpectedSource'));
  assert.ok(rename.indexOf('parent.RenameExpectedSource') < rename.indexOf('Observe("RENAMED"'));
  assert.ok(rename.indexOf('Observe("COMMITTED"') < rename.indexOf('Observe("POST_COMMIT_VERIFIED"'));
  assert.doesNotMatch(rename, /File\.Move|File\.Delete|Directory\.Move|CreateTransaction|CommitTransaction|CreateFileTransacted/u);
  const dispatch = fs.readFileSync(new URL('../platform/windows/native/OwnedProcess.cs', import.meta.url), 'utf8');
  for (const option of ['--publication-rename', '--publication-rename-selftest', '--publication-rename-fixture-child', '--publication-rename-fixture-recover', '--publication-inspect-known', '--publication-discover', '--publication-discovery-selftest', '--publication-recover-known', '--publication-rename-controller-recovery-selftest']) assert.ok(dispatch.includes(option));
  assert.match(journal, /if \(old && \(!File\.Exists\(source\) \|\| File\.ReadAllText\(source\) != "old-rename-complete"\)\)/u);
  assert.match(journal, /File\.Exists\(target\) != \(!old && name != "destination-missing-after-crash"\)/u);
  const plan = fs.readFileSync(new URL('../lib/phi-publication-plan.mjs', import.meta.url), 'utf8');
  assert.match(plan, /Without explicit controller intent, equal content remains DELETE\+CREATE/u);
});

const points = ['before-rename', 'intent', 'renamed', 'journal-renamed', 'committed', 'verified', 'cleaned'];
const cases = ['normal', 'production-normal', 'production-conflict', 'source-missing', 'source-content-changed', 'source-replaced', 'source-removed-before-mutation',
  'source-changed-before-mutation', 'source-replaced-before-mutation', 'destination-exists', 'destination-after-intent',
  'unauthorized', 'protected-source', 'protected-destination', 'cross-parent', 'root-identity', 'source-sharing', 'unobserved-advance',
  ...points.map(point => 'crash-' + point), 'source-recreate-after-crash', 'destination-replace-after-crash', 'destination-missing-after-crash'];
for (const name of cases) test('native same-journal expected-source RENAME: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const result = spawnSync(ownedWindowsHelper(), ['--publication-rename-selftest', name], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 22000, maxBuffer: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.caseName, name);
  for (const key of ['passed', 'fixtureCleanup', 'unrelatedPreserved']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.scope, 'NATIVE_JOURNAL_RENAME_NOT_VERIFIED_WORKER_PUBLICATION');
  assert.equal(receipt.projectPublished, false); assert.equal(receipt.txfUsed, false); assert.equal(receipt.externalRequests, 0);
  if (name.startsWith('crash-') || name.endsWith('after-crash')) {
    for (const key of ['actualProcessKilled', 'childGone', 'restartedRecovery']) assert.equal(receipt[key], true, key);
    assert.equal(receipt.evidence.metadata.version, 4);
    assert.equal(receipt.evidence.metadata.operations[0].kind, 'RENAME');
    assert.equal(receipt.evidence.projectMutations, 0); assert.equal(receipt.evidence.processKills, 0);
    assert.equal(receipt.evidence.projectPublished, false);
    if (name.endsWith('after-crash')) assert.equal(receipt.evidence.journalMutations, 0);
  }
  const reconstruction = name === 'crash-intent' ? 'ROLLBACK' : name === 'source-recreate-after-crash' ? 'CONFLICT' :
    name === 'crash-journal-renamed' ? 'MANUAL_RECOVERY_REQUIRED' : null;
  assert.equal(receipt.reconstructionDecision, reconstruction);
  if (reconstruction) {
    const result = receipt.reconstructionReceipt;
    assert.equal(result.decision, reconstruction);
    assert.deepEqual(validateWindowsKnownReconstruction({ status: 0, signal: null, pid: 1 }, result, result.transactionId), result);
  } else assert.equal(receipt.reconstructionReceipt, null);
  if (name === 'normal') {
    assert.equal(receipt.evidence.journal.phase, 'CLEANED');
    assert.equal(receipt.evidence.nativeProof.backend, 'JOURNALED_HANDLE_ANCHORED_RENAME');
    assert.equal(receipt.evidence.nativeProof.primitive.backend, 'HANDLE_ANCHORED_EXPECTED_SOURCE_RENAME');
  }
  assert.doesNotMatch(JSON.stringify(receipt), /old-rename-complete|new-rename-user|unrelated-rename-user/u);
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'NATIVE_JOURNAL_RENAME_ONLY', ...receipt }));
});

for (const name of ['rollback', 'resume', 'resume-journal', 'finalize', 'cleanup-only', 'conflict', 'unrelated-change', 'source-replaced', 'manual', 'invalid-locator']) {
  test('native killed-publisher fresh-controller bounded recovery: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-rename-controller-recovery-selftest', name], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 22000, maxBuffer: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.caseName, name);
    for (const key of ['passed', 'fixtureCleanup', 'actualProcessKilled', 'childGone', 'restartedControllerGone']) assert.equal(receipt[key], true, key);
    assert.equal(receipt.scope, 'NATIVE_BOUNDED_RENAME_RECOVERY_NOT_RESTORED_PUBLICATION');
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    const base = publicationBase({ rootIdentity: receipt.rootIdentity,
      files: { 'input.txt': 'old-rename-complete', 'unrelated.txt': 'unrelated-rename-user' },
      identities: { 'input.txt': receipt.sourceIdentity, 'unrelated.txt': receipt.unrelatedIdentity } });
    assert.equal(receipt.baseDigest, base.digest);
    assert.equal(receipt.verifiedDigest, draftContentDigest({ 'renamed.txt': 'old-rename-complete', 'unrelated.txt': 'unrelated-rename-user' }));
    assert.equal(receipt.digestContractVector, draftContentDigest({ 'sample.txt': 'A/\b\t\n\r\f"\\<>&é😀\u2028' }));
    if (name !== 'invalid-locator') assert.deepEqual(validateWindowsKnownRecovery({ status: 0, signal: null, pid: 1 }, receipt.evidence, receipt.evidence.transactionId), receipt.evidence);
    else assert.equal(receipt.controllerExit, 70);
    if (['resume', 'conflict', 'manual'].includes(name)) {
      assert.deepEqual(validateWindowsTransactionDiscovery({ status: 0, signal: null, pid: 1 }, receipt.discoveryEvidence), receipt.discoveryEvidence);
      assert.equal(receipt.discoveryEvidence.entries.length, 1);
      assert.equal(receipt.discoveryEvidence.entries[0].transactionId, receipt.evidence.transactionId);
    } else assert.equal(receipt.discoveryEvidence, null);
    assert.doesNotMatch(JSON.stringify(receipt), /old-rename-complete|new-rename-user|unrelated-rename-user|new-unrelated-user/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'NATIVE_BOUNDED_RENAME_RECOVERY', ...receipt }));
  });
}

for (const name of ['empty', 'foreign', 'active', 'corrupt']) {
  test('native private-index discovery fails closed: ' + name, { skip: process.platform !== 'win32', timeout: 30000 }, () => {
    const run = spawnSync(ownedWindowsHelper(), ['--publication-discovery-selftest', name], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 22000, maxBuffer: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.caseName, name);
    for (const key of ['passed', 'fixtureCleanup', 'readerGone']) assert.equal(receipt[key], true, key);
    assert.equal(receipt.retentionBlocked, name === 'active' || name === 'corrupt');
    assert.equal(receipt.ownedKeyPreserved, name === 'active' || name === 'corrupt');
    assert.equal(receipt.scope, 'NATIVE_READ_ONLY_PHI_INDEX_DISCOVERY_NOT_RECOVERY_AUTHORITY');
    assert.equal(receipt.projectPublished, false);
    assert.equal(receipt.externalRequests, 0);
    const evidence = receipt.evidence;
    if (name === 'corrupt') {
      assert.equal(receipt.readerExit, 70);
      assert.equal(evidence.status, 'FAIL_READ_ONLY_DISCOVERY');
      assert.equal(evidence.decision, 'UNKNOWN_FAIL_SAFE');
      assert.equal('entries' in evidence, false);
    } else {
      assert.equal(receipt.readerExit, 0);
      assert.deepEqual(validateWindowsTransactionDiscovery({ status: 0, signal: null, pid: 1 }, evidence), evidence);
      assert.equal(evidence.projectTransactions, name === 'active' ? 1 : 0);
      if (name === 'active') assert.equal(evidence.entries[0].classification, 'ACTIVE_UNVERIFIED');
    }
    assert.equal(evidence.projectMutations, 0);
    assert.equal(evidence.journalMutations, 0);
    assert.equal(evidence.processKills, 0);
    assert.equal(evidence.projectPublished, false);
    assert.doesNotMatch(JSON.stringify(receipt), /old-rename-complete|unrelated-rename-user/u);
    assert.equal(windowsRecoveryStatus().status, 'PASS');
    console.log(JSON.stringify({ control: 'NATIVE_READ_ONLY_PHI_INDEX_DISCOVERY', ...receipt }));
  });
}
