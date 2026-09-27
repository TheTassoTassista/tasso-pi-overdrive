import { createHash, randomUUID } from 'node:crypto';

// Controller memory only. Execution copies are disposable LPAC workspaces;
// the draft is the immutable, bounded payload, not a pathname or host edit.
export const draftContentDigest = files => createHash('sha256').update(JSON.stringify(
  Object.keys(files).sort().map(name => [name, files[name]]),
)).digest('hex');
const fail = () => { throw new Error('PHI_WORKER_DRAFT_IDENTITY_INVALID'); };
const immutable = snapshot => Object.freeze({ ...snapshot, files: Object.freeze({ ...snapshot.files }), identities: Object.freeze({ ...snapshot.identities }) });
export class WorkerDraft {
  #snapshot; #id = randomUUID().replaceAll('-', ''); #revision = 0; #state = 'DRAFT_CREATED';
  #baseRoot; #digest; #nativeRoot; #disposed = false;
  constructor(snapshot) {
    this.#snapshot = immutable(snapshot); this.#baseRoot = snapshot.rootIdentity;
    this.#nativeRoot = snapshot.rootIdentity; this.#digest = draftContentDigest(snapshot.files);
  }
  get snapshot() { if (this.#disposed) fail(); return this.#snapshot; }
  get binding() { return Object.freeze({ id: this.#id, revision: this.#revision, digest: this.#digest }); }
  get metadata() { return Object.freeze({ draftId: this.#id, revision: this.#revision, contentDigest: this.#digest,
    baseRootIdentity: this.#baseRoot, nativeSnapshotIdentity: this.#nativeRoot, state: this.#state,
    payloadCleared: this.#disposed, projectPublished: false }); }
  settle(binding, snapshot, { success, edit = false, verified = false }) {
    if (this.#disposed || !binding || binding.id !== this.#id || binding.revision !== this.#revision || binding.digest !== this.#digest) fail();
    if (!success) return this.metadata; // failed execution never commits its partial copy
    if (!snapshot) fail();
    const next = draftContentDigest(snapshot.files);
    if (!edit && next !== this.#digest) fail();
    if (edit && next !== this.#digest) { this.#revision++; this.#state = 'EDITED'; }
    if (verified) this.#state = 'VERIFIED';
    this.#snapshot = immutable(snapshot); this.#digest = next; this.#nativeRoot = snapshot.rootIdentity;
    return this.metadata;
  }
  dispose() { this.#snapshot = null; this.#disposed = true; this.#state = 'REVOKED'; return this.metadata; }
}
