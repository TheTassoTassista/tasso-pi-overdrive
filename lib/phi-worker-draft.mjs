import { randomUUID } from 'node:crypto';
import { PublicationPreflight, draftContentDigest } from './phi-publication-plan.mjs';

// Controller memory only. Execution copies are disposable LPAC workspaces;
// the draft is the immutable, bounded payload, not a pathname or host edit.
export { draftContentDigest };
const fail = () => { throw new Error('PHI_WORKER_DRAFT_IDENTITY_INVALID'); };
const immutable = snapshot => Object.freeze({ ...snapshot, files: Object.freeze({ ...snapshot.files }), identities: Object.freeze({ ...snapshot.identities }) });
export class WorkerDraft {
  #snapshot; #id = randomUUID().replaceAll('-', ''); #revision = 0; #state = 'DRAFT_CREATED';
  #baseRoot; #digest; #nativeRoot; #disposed = false;
  #publication;
  constructor(snapshot) {
    this.#snapshot = immutable(snapshot); this.#baseRoot = snapshot.rootIdentity;
    this.#nativeRoot = snapshot.rootIdentity; this.#digest = draftContentDigest(snapshot.files);
    this.#publication = new PublicationPreflight(snapshot);
  }
  get snapshot() { if (this.#disposed) fail(); return this.#snapshot; }
  get binding() { return Object.freeze({ id: this.#id, revision: this.#revision, digest: this.#digest }); }
  get publicationMetadata() { return Object.freeze({...this.#publication.metadata,draftId:this.#id,draftVersion:this.#revision,sourceDigest:this.#digest}); }
  get publicationBase() { return this.#publication.base; }
  recordLsp(binding, path, diagnostics, success) {
    if(this.#disposed || !binding || ['id','revision','digest'].some(k=>binding[k]!==this.binding[k]) || !Object.hasOwn(this.#snapshot.files,path)) fail();
    this.#publication.semantic(binding,path,diagnostics,success);
  }
  preparePublication(currentBase) { if(this.#disposed)fail();this.#publication.prepare(this.#snapshot,this.binding,currentBase);return this.publicationMetadata; }
  beginPublication(binding,transactionId) { if(this.#disposed||['id','revision','digest'].some(k=>binding?.[k]!==this.binding[k]))fail();this.#publication.begin(binding,transactionId); }
  completePublication(binding,proof) { if(this.#disposed||['id','revision','digest'].some(k=>binding?.[k]!==this.binding[k]))fail();this.#publication.complete(binding,proof);this.#state='PUBLISHED';return this.publicationMetadata; }
  failPublication(conflict,evidence) { if(this.#disposed)fail();this.#publication.failed(conflict,evidence); }
  invalidateVerification(binding) {
    if(this.#disposed || !binding || ['id','revision','digest'].some(k=>binding[k]!==this.binding[k]))fail();
    this.#publication.verificationFailed();this.#state='EDITED';
  }
  get metadata() { return Object.freeze({ draftId: this.#id, revision: this.#revision, contentDigest: this.#digest,
    baseRootIdentity: this.#baseRoot, nativeSnapshotIdentity: this.#nativeRoot, state: this.#state,
    payloadCleared: this.#disposed, projectPublished: this.#publication.metadata.projectPublished }); }
  settle(binding, snapshot, { success, edit = false, verified = false }) {
    if (this.#disposed || this.#publication.metadata.projectPublished || !binding || binding.id !== this.#id || binding.revision !== this.#revision || binding.digest !== this.#digest) fail();
    if (!success) return this.metadata; // failed execution never commits its partial copy
    if (!snapshot) fail();
    const next = draftContentDigest(snapshot.files);
    if (!edit && next !== this.#digest) fail();
    if (edit && next !== this.#digest) { this.#revision++; this.#state = 'EDITED'; this.#publication.edited(); }
    if (verified) this.#state = 'VERIFIED';
    this.#snapshot = immutable(snapshot); this.#digest = next; this.#nativeRoot = snapshot.rootIdentity;
    if(verified)this.#publication.verified(this.binding);
    return this.metadata;
  }
  dispose() { this.#snapshot = null; this.#disposed = true; this.#state = 'REVOKED'; this.#publication.dispose(); return this.metadata; }
}
