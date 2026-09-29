import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper, windowsRecoveryStatus } from '../platform/windows/process.mjs';

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
  for (const option of ['--publication-rename', '--publication-rename-selftest', '--publication-rename-fixture-child', '--publication-rename-fixture-recover']) assert.ok(dispatch.includes(option));
  assert.match(journal, /if \(old && \(!File\.Exists\(source\) \|\| File\.ReadAllText\(source\) != "old-rename-complete"\)\)/u);
  assert.match(journal, /File\.Exists\(target\) != \(!old && name != "destination-missing-after-crash"\)/u);
  const plan = fs.readFileSync(new URL('../lib/phi-publication-plan.mjs', import.meta.url), 'utf8');
  assert.match(plan, /Renames are explicitly DELETE\+CREATE, NOT inferred/u);
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
  if (name === 'normal') {
    assert.equal(receipt.evidence.journal.phase, 'CLEANED');
    assert.equal(receipt.evidence.nativeProof.backend, 'JOURNALED_HANDLE_ANCHORED_RENAME');
    assert.equal(receipt.evidence.nativeProof.primitive.backend, 'HANDLE_ANCHORED_EXPECTED_SOURCE_RENAME');
  }
  assert.doesNotMatch(JSON.stringify(receipt), /old-rename-complete|new-rename-user|unrelated-rename-user/u);
  assert.equal(windowsRecoveryStatus().status, 'PASS');
  console.log(JSON.stringify({ control: 'NATIVE_JOURNAL_RENAME_ONLY', ...receipt }));
});
