import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerDraft, draftContentDigest } from '../lib/phi-worker-draft.mjs';
import { validateWindowsSnapshot, verifyWindowsProject } from '../platform/windows/coding-tools.mjs';

const snapshot = (text = 'source', index = '1') => validateWindowsSnapshot({ version: 1,
  rootIdentity: 'a'.repeat(16) + ':' + index.repeat(32), files: { 'input.txt': text },
  identities: { 'input.txt': 'a'.repeat(16) + ':' + '2'.repeat(32) } });
test('controller draft keeps immutable payload, content identity and stable draft ID across execution copies', () => {
  const draft = new WorkerDraft(snapshot()), binding = draft.binding, original = draft.metadata;
  assert.throws(() => { draft.snapshot.files['input.txt'] = 'attack'; }, TypeError);
  draft.settle(binding, snapshot('edited', '3'), { success: true, edit: true });
  assert.equal(draft.snapshot.files['input.txt'], 'edited'); assert.equal(draft.metadata.draftId, original.draftId);
  assert.equal(draft.metadata.baseRootIdentity, original.baseRootIdentity); assert.notEqual(draft.metadata.nativeSnapshotIdentity, original.nativeSnapshotIdentity);
  assert.equal(draft.metadata.revision, 1); assert.equal(draft.metadata.state, 'EDITED'); assert.equal(draft.metadata.projectPublished, false);
});
test('failed execution preserves exact prior draft and receipt identity, never commits partial output', () => {
  const draft = new WorkerDraft(snapshot('edited')), before = draft.metadata;
  draft.settle(draft.binding, snapshot('corrupt'), { success: false, edit: true });
  assert.deepEqual(draft.metadata, before); assert.equal(draft.snapshot.files['input.txt'], 'edited');
});
test('missing, foreign and stale draft revisions/digests fail closed', () => {
  const draft = new WorkerDraft(snapshot()), binding = draft.binding;
  for (const invalid of [null, { ...binding, id: 'b'.repeat(32) }, { ...binding, digest: 'b'.repeat(64) }, { ...binding, revision: 1 }])
    assert.throws(() => draft.settle(invalid, snapshot(), { success: true }), /IDENTITY_INVALID/u);
  draft.settle(binding, snapshot('edited'), { success: true, edit: true });
  assert.throws(() => draft.settle(binding, snapshot('stale'), { success: true, edit: true }), /IDENTITY_INVALID/u);
});
test('verification accepts only same content and cannot mutate or claim project publication', () => {
  const draft = new WorkerDraft(snapshot('edited'));
  assert.throws(() => draft.settle(draft.binding, snapshot('source'), { success: true, verified: true }), /IDENTITY_INVALID/u);
  draft.settle(draft.binding, snapshot('edited', '3'), { success: true, verified: true });
  assert.equal(draft.metadata.state, 'VERIFIED'); assert.equal(draft.metadata.revision, 0);
  assert.equal(draft.metadata.projectPublished, false);
});
test('revocation clears payload but retains prior digest/identity evidence; no resurrection', () => {
  const draft = new WorkerDraft(snapshot('edited')), before = draft.metadata, binding = draft.binding;
  draft.dispose(); assert.equal(draft.metadata.payloadCleared, true); assert.equal(draft.metadata.state, 'REVOKED');
  assert.equal(draft.metadata.contentDigest, before.contentDigest); assert.equal(draft.metadata.draftId, before.draftId);
  assert.throws(() => draft.snapshot, /IDENTITY_INVALID/u);
  assert.throws(() => draft.settle(binding, snapshot('attack'), { success: true, edit: true }), /IDENTITY_INVALID/u);
  assert.doesNotMatch(JSON.stringify(draft.metadata), /edited|input\.txt/u);
});
test('native snapshot shape, file identities, limits and protected names are mandatory, not path-only', () => {
  const raw = { version: 1, rootIdentity: 'a'.repeat(16) + ':' + '1'.repeat(32), files: { 'input.txt': 'source' }, identities: { 'input.txt': 'a'.repeat(16) + ':' + '2'.repeat(32) } };
  for (const invalid of [{ ...raw, rootIdentity: null }, { ...raw, identities: {} }, { ...raw, identities: { 'wrong.txt': raw.identities['input.txt'] } },
    { ...raw, files: { '.env': 'secret' }, identities: { '.env': raw.identities['input.txt'] } }, { ...raw, files: { 'input.txt': 'x'.repeat(512 * 1024 + 1) } }])
    assert.throws(() => validateWindowsSnapshot(invalid));
  assert.equal(draftContentDigest({ b: '2', a: '1' }), draftContentDigest({ a: '1', b: '2' }));
});
test('verification cannot silently downgrade a present but invalid Worker authority', async () => {
  for (const workerAuthority of [undefined, null, false, 0, {}])
    await assert.rejects(verifyWindowsProject({ cwd: '.', workerAuthority, sessionId: 'a'.repeat(32) }), /AUTHORITY_UNAVAILABLE/u);
});
