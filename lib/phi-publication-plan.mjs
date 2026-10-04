import { createHash, randomUUID } from 'node:crypto';
import { validateWindowsBrokerRequest } from '../platform/windows/secure-broker.mjs';
import { consumeWindowsPublicationProof } from '../platform/windows/publication.mjs';

// INTERNAL_TRUSTED preflight only. This module never performs filesystem IO,
// starts a process, copies a draft, or supplies a publication implementation.
const fail = code => { throw new Error('PHI_PUBLICATION_' + code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => typeof value === 'string' && /^[0-9a-f]{16}:[0-9a-f]{32}$/u.test(value);
export const draftContentDigest = files => hash(JSON.stringify(Object.keys(files).sort().map(name => [name, files[name]])));
const validBinding = binding => binding && /^[0-9a-f]{32}$/u.test(binding.id) && Number.isSafeInteger(binding.revision) && binding.revision >= 0 && /^[0-9a-f]{64}$/u.test(binding.digest);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const PUBLICATION_STATES = Object.freeze(['DRAFT_CREATED','EDITED','VERIFIED','READY_TO_PUBLISH','PUBLISHING','PUBLISHED','CONFLICT','ROLLED_BACK','FAILED']);

function validateSource(snapshot) {
  if (!snapshot || !identity(snapshot.rootIdentity) || !snapshot.files || !snapshot.identities || Array.isArray(snapshot.files) || Array.isArray(snapshot.identities) ||
      Object.keys(snapshot.files).length !== Object.keys(snapshot.identities).length || Object.keys(snapshot.files).some(name=>!Object.hasOwn(snapshot.identities,name)||!identity(snapshot.identities[name])) ||
      new Set(Object.values(snapshot.identities)).size !== Object.keys(snapshot.files).length) fail('BASE_INVALID');
  if (Object.keys(snapshot.files).some(name => name.split('/').some(part => /^phi-(?:delete-[0-9a-f]{32}\.quarantine|publish-[0-9a-f]{32}\.tmp)$/iu.test(part)))) fail('RESERVED_TRANSACTION_EVIDENCE');
  validateWindowsBrokerRequest({version:1,executable:{path:'C:/Phi/publication-policy.exe',sha256:'a'.repeat(64)},argv:[],cwd:'.',environment:{},profile:'TEST',
    grants:{workspace:snapshot.files,assets:{}},network:'DENY',timeoutMs:1,guardianPid:process.pid,context:{sessionId:'a'.repeat(32),operation:'verification',role:'tester'}});
}
export function publicationBase(snapshot) {
  validateSource(snapshot);
  const files=Object.fromEntries(Object.keys(snapshot.files).sort().map(name=>[name,{identity:snapshot.identities[name],digest:hash(snapshot.files[name]),bytes:Buffer.byteLength(snapshot.files[name])}]));
  return freeze({rootIdentity:snapshot.rootIdentity,files,digest:hash(JSON.stringify({rootIdentity:snapshot.rootIdentity,files}))});
}
export function publicationOperations(base, snapshot, renameIntent = null) {
  validateSource(snapshot);
  const next=publicationBase(snapshot),operations=[];
  for(const name of [...new Set([...Object.keys(base.files),...Object.keys(next.files)])].sort()) {
    const old=Object.hasOwn(base.files,name)?base.files[name]:null, value=Object.hasOwn(next.files,name)?next.files[name]:null;
    if(old && value && old.digest===value.digest) continue;
    operations.push({path:name,kind:old?value?'REPLACE':'DELETE':'CREATE',baseIdentity:old?.identity??null,baseDigest:old?.digest??null,newDigest:value?.digest??null,newBytes:value?.bytes??null});
  }
  if (renameIntent !== null) {
    if (!renameIntent || typeof renameIntent !== 'object' || Array.isArray(renameIntent) ||
        Object.keys(renameIntent).length !== 2 || !Object.hasOwn(renameIntent, 'sourcePath') || !Object.hasOwn(renameIntent, 'destinationPath')) fail('RENAME_INTENT_INVALID');
    const { sourcePath, destinationPath } = renameIntent;
    if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string' || sourcePath.length > 240 || destinationPath.length > 240 ||
        sourcePath.toLowerCase() === destinationPath.toLowerCase() ||
        sourcePath.split('/').slice(0,-1).join('/').toLowerCase() !== destinationPath.split('/').slice(0,-1).join('/').toLowerCase() ||
        !Object.hasOwn(base.files, sourcePath) || Object.hasOwn(base.files, destinationPath) ||
        Object.hasOwn(next.files, sourcePath) || !Object.hasOwn(next.files, destinationPath) ||
        ![2, 5].includes(operations.length) || !operations.some(op => op.kind === 'DELETE' && op.path === sourcePath) ||
        !operations.some(op => op.kind === 'CREATE' && op.path === destinationPath) ||
        base.files[sourcePath].digest !== next.files[destinationPath].digest || base.files[sourcePath].bytes !== next.files[destinationPath].bytes)
      fail('RENAME_INTENT_INVALID');
    const original = base.files[sourcePath];
    const rename = { sourcePath, path: destinationPath, kind: 'RENAME', baseIdentity: original.identity, baseDigest: original.digest,
      newDigest: original.digest, newBytes: original.bytes };
    if (operations.length === 2) return freeze([rename]);
    // V5 admits only the representative four-operation shape. This is a
    // manifest planner, not a publication grant: the trusted controller must
    // still bind verification, freeze Worker mutation and obtain native proof.
    const remainder = operations.filter(op => op.path !== sourcePath && op.path !== destinationPath);
    if (remainder.length !== 3 || !['REPLACE', 'CREATE', 'DELETE'].every(kind => remainder.filter(op => op.kind === kind).length === 1))
      fail('RENAME_INTENT_INVALID');
    return freeze(['REPLACE', 'CREATE', 'DELETE'].map(kind => remainder.find(op => op.kind === kind)).concat(rename));
  }
  // Without explicit controller intent, equal content remains DELETE+CREATE.
  return freeze(operations);
}

// Journal versions are the durable profile discriminator. Existing V2–V4
// are already single-operation protocols; unprofiled V5 remains the fixed
// historical composite. V6 is reserved solely for journaled single CREATE.
// This describes a manifest, not publication or recovery authority.
export function publicationTransactionProfile(operations) {
  if (!Array.isArray(operations)) fail('TRANSACTION_PROFILE_INVALID');
  if (operations.length === 4 && operations.map(op => op?.kind).join(',') === 'REPLACE,CREATE,DELETE,RENAME')
    return freeze({ profile: 'LEGACY_COMPOSITE', journalVersion: 5, operation: null });
  if (operations.length !== 1) fail('TRANSACTION_PROFILE_INVALID');
  const [op] = operations;
  const version = { CREATE: 6, REPLACE: 2, DELETE: 3, RENAME: 4 }[op?.kind];
  if (!version) fail('TRANSACTION_PROFILE_INVALID');
  return freeze({ profile: 'SINGLE_OPERATION', journalVersion: version, operation: op.kind === 'REPLACE' ? 'MODIFY' : op.kind });
}
export function publicationConflicts(base, snapshot) {
  const current=publicationBase(snapshot),conflicts=[];
  if(current.rootIdentity!==base.rootIdentity) conflicts.push({path:null,reason:'ROOT_IDENTITY'});
  for(const name of [...new Set([...Object.keys(base.files),...Object.keys(current.files)])].sort()) {
    const expected=Object.hasOwn(base.files,name)?base.files[name]:null, actual=Object.hasOwn(current.files,name)?current.files[name]:null;
    if(!expected || !actual || expected.identity!==actual.identity || expected.digest!==actual.digest) conflicts.push({path:name,reason:!expected?'USER_CREATED':!actual?'USER_REMOVED':expected.identity!==actual.identity?'FILE_IDENTITY':'FILE_CONTENT'});
  }
  return freeze(conflicts);
}

// PUBLISHED requires a one-use private proof minted by the actual fixed native
// adapter plus complete secure project readback. JSON/model receipts cannot
// advance this state. Restart observation alone is not this live certificate.
export class PublicationPreflight {
  #base; #operations; #state='DRAFT_CREATED'; #verified=null; #semantic=new Map(); #transaction=null; #conflicts=[]; #disposed=false; #result=null;
  constructor(snapshot) { this.#base=publicationBase(snapshot); }
  get base() { return this.#base; }
  get metadata() { return freeze({state:this.#state,transactionId:this.#transaction,baseDigest:this.#base.digest,verifiedDigest:this.#verified?.digest??null,
    operations:this.#operations??[],conflicts:this.#conflicts,semanticProofs:Object.fromEntries(this.#semantic),
    filesAttempted:this.#result?.filesAttempted??[],filesCommitted:this.#result?.filesCommitted??[],recovery:this.#result?.recovery??'NOT_STARTED',cleanup:this.#result?.cleanup??'NOT_STARTED',
    projectPublished:this.#result?.projectPublished===true,backend:this.#result?.backend??'BLOCKED_NOT_IMPLEMENTED',publicationProof:this.#result?.proof??null,
    commitState:this.#result?.commitState??'NOT_STARTED',failureEvidence:this.#result?.failureEvidence??null}); }
  edited() { if(this.#disposed)fail('REVOKED');this.#state='EDITED';this.#verified=null;this.#semantic.clear();this.#operations=null;this.#transaction=null;this.#conflicts=[];this.#result=null; }
  verified(binding) {
    if(this.#disposed)fail('REVOKED');if(!validBinding(binding))fail('BINDING_INVALID');
    this.#verified=freeze({...binding});this.#transaction=null;this.#state='VERIFIED';
  }
  verificationFailed() { this.edited(); }
  semantic(binding,path,diagnostics,success) {
    if(this.#disposed)fail('REVOKED');if(!validBinding(binding))fail('BINDING_INVALID');
    const clean=success===true && Array.isArray(diagnostics) && diagnostics.every(d=>d && Number.isInteger(d.severity)&&d.severity>=2&&d.severity<=4);
    this.#semantic.set(path,{digest:binding.digest,revision:binding.revision,clean});
    // Even a later successful analysis requires a new preflight. A previously
    // minted grant must not survive a new Error/failed/unknown diagnostic result.
    if(this.#state==='READY_TO_PUBLISH'){this.#state='VERIFIED';this.#transaction=null;}
  }
  prepare(snapshot,binding,currentBase,renameIntent=null) {
    if(this.#disposed)fail('REVOKED');
    if(this.#state==='PUBLISHED'||this.#state==='PUBLISHING')fail('ALREADY_PUBLISHED');
    if(!validBinding(binding) || !this.#verified || ['id','revision','digest'].some(k=>this.#verified[k]!==binding[k])) fail('UNVERIFIED_DRAFT');
    validateSource(snapshot);
    if(draftContentDigest(snapshot.files)!==binding.digest)fail('UNVERIFIED_DRAFT');
    this.#transaction=null;this.#state='VERIFIED';
    this.#operations=publicationOperations(this.#base,snapshot,renameIntent);
    if(!this.#operations.length)fail('NO_CHANGES');
    // Every changed/new supported JSON file must have an actual clean LSP
    // result on this exact revision. Analysis PASS containing Error is not proof.
    for(const op of this.#operations.filter(x=>x.kind!=='DELETE'&&x.path.toLowerCase().endsWith('.json'))) {
      const proof=this.#semantic.get(op.path);
      if(!proof || proof.digest!==binding.digest || proof.revision!==binding.revision || !proof.clean)fail('SEMANTIC_UNVERIFIED');
    }
    this.#conflicts=publicationConflicts(this.#base,currentBase);
    if(this.#conflicts.length){this.#state='CONFLICT';return this.metadata;}
    this.#transaction=randomUUID().replaceAll('-','');this.#state='READY_TO_PUBLISH';return this.metadata;
  }
  begin(binding,transactionId) {
    if(this.#disposed || this.#state!=='READY_TO_PUBLISH' || transactionId!==this.#transaction || !validBinding(binding) || ['id','revision','digest'].some(k=>this.#verified?.[k]!==binding[k]))fail('PUBLISH_AUTHORITY_DENIED');
    this.#state='PUBLISHING';
  }
  complete(binding,proof) {
    if(this.#disposed || this.#state!=='PUBLISHING' || !validBinding(binding) || ['id','revision','digest'].some(k=>this.#verified?.[k]!==binding[k]))fail('PUBLISH_AUTHORITY_DENIED');
    const native=consumeWindowsPublicationProof(proof,{transactionId:this.#transaction,projectIdentity:this.#base.rootIdentity,draftId:binding.id,draftVersion:binding.revision,
      verifiedDigest:binding.digest,baseDigest:this.#base.digest,operations:this.#operations,finalDigest:binding.digest});
    this.#result=freeze({filesAttempted:this.#operations.map(o=>o.path),filesCommitted:this.#operations.map(o=>o.path),recovery:'NOT_REQUIRED',cleanup:'PASS',
      projectPublished:true,backend:native.backend,proof:native,commitState:'VERIFIED_COMMITTED'});this.#state='PUBLISHED';return this.metadata;
  }
  failed(conflict=false,failureEvidence=null) {
    if(this.#disposed||this.#state!=='PUBLISHING')fail('PUBLISH_AUTHORITY_DENIED');
    this.#state=conflict?'CONFLICT':'FAILED';this.#result=freeze({filesAttempted:this.#operations.map(o=>o.path),filesCommitted:[],recovery:conflict?'NOT_STARTED':'INSPECTION_REQUIRED',cleanup:conflict?'NOT_STARTED':'NOT_PROVEN',
      projectPublished:false,backend:this.#operations.length===4?'NATIVE_MIXED_UNCONFIRMED':this.#operations.length===1&&this.#operations[0].kind==='DELETE'?'NATIVE_SINGLE_DELETE_UNCONFIRMED':this.#operations.length===1&&this.#operations[0].kind==='RENAME'?'NATIVE_SINGLE_RENAME_UNCONFIRMED':'NATIVE_SINGLE_MODIFY_UNCONFIRMED',commitState:conflict?'NOT_STARTED':'UNKNOWN',failureEvidence});
  }
  dispose() { this.#disposed=true;this.#verified=null;this.#semantic.clear();if(this.#state!=='PUBLISHED')this.#state='FAILED'; }
}
