import { spawnSync } from 'node:child_process';
import { ownedWindowsHelper } from './process.mjs';
import { readWindowsProjectSnapshot } from './coding-tools.mjs';
import { draftContentDigest, publicationConflicts, publicationOperations } from '../../lib/phi-publication-plan.mjs';

// INTERNAL_TRUSTED controller adapter. Never registered as a model tool and
// never accepts a caller-supplied runner, binary/profile or successful receipt.
const proofs = new WeakMap();
const fail = code => { const error = new Error('PHI_PUBLICATION_' + code); error.code = 'PHI_PUBLICATION_' + code; throw error; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function publishWindowsSingleModify({ cwd, base, snapshot, binding, metadata, remainingMs }) {
  if (process.platform !== 'win32') fail('BACKEND_UNAVAILABLE');
  const operations = publicationOperations(base, snapshot);
  if (operations.length !== 1 || operations[0].kind !== 'REPLACE') fail('SINGLE_MODIFY_ONLY');
  if (metadata.transactionId === null || binding.digest !== draftContentDigest(snapshot.files) || metadata.verifiedDigest !== binding.digest ||
      metadata.baseDigest !== base.digest || !same(metadata.operations, operations) || !Number.isSafeInteger(remainingMs) || remainingMs < 1) fail('BINDING_INVALID');
  if (publicationConflicts(base, readWindowsProjectSnapshot(cwd)).length) fail('CONFLICT');
  const op = operations[0], timeoutMs = Math.min(remainingMs, 30000);
  const header = { transactionId: metadata.transactionId, projectIdentity: base.rootIdentity, draftId: binding.id, draftVersion: binding.revision,
    verifiedDigest: binding.digest, baseDigest: base.digest, operations };
  const request = { version: 1, root: cwd, header, content: snapshot.files[op.path], guardianPid: process.pid, timeoutMs };
  const input = JSON.stringify(request) + '\n'; if (Buffer.byteLength(input) > 1024 * 1024) fail('REQUEST_LIMIT');
  const run = spawnSync(ownedWindowsHelper(), ['--publication-modify'], { shell: false, windowsHide: true, encoding: 'utf8', input,
    timeout: timeoutMs + 1000, maxBuffer: 32768 });
  let value; try { value = JSON.parse(run.stdout); } catch { fail('NATIVE_RECEIPT_INVALID'); }
  if (run.error || run.status !== 0 || !run.pid) {
    const error = new Error('PHI_PUBLICATION_NATIVE_EXECUTION_UNCONFIRMED'); error.code = error.message;
    // Only selected, bounded fixed metadata from this actual attested native
    // execution is retained. Never propagate raw stdout/stderr/exception text.
    const j = value?.journal;
    if (value?.version === 1 && value.status === 'FAIL_NATIVE_SINGLE_MODIFY' && value.projectPublished === false && value.externalRequests === 0 &&
        j?.transactionId === header.transactionId && j.projectIdentity === header.projectIdentity && j.draftId === header.draftId &&
        j.draftVersion === header.draftVersion && j.verifiedDigest === header.verifiedDigest && j.baseDigest === header.baseDigest && same(j.operations, operations)) {
      error.publicationEvidence = freeze({ phase: /^[a-zA-Z-]{1,40}$/u.test(value.phase ?? '') ? value.phase : 'UNKNOWN',
        nativeCode: /^[0-9a-f]{8}$/u.test(value.nativeCode ?? '') ? value.nativeCode : null, journal: j });
    }
    throw error;
  }
  const journal = value?.receipt?.journal, native = value?.receipt?.nativeProof;
  if (value.version !== 1 || value.status !== 'PASS_NATIVE_SINGLE_MODIFY' || value.projectPublished !== false || value.externalRequests !== 0 ||
      journal?.version !== 2 || journal.scope !== 'SINGLE_FILE_MODIFY_JOURNAL_NOT_CONTROLLER_PUBLICATION' || journal.phase !== 'CLEANED' ||
      journal.cleanup !== 'PASS' || journal.projectPublished !== false || journal.pendingOperations !== 0 || !same(journal.operations, operations) ||
      !same(journal.filesCommitted, [op.path]) || Object.keys(header).filter(k => k !== 'operations').some(k => journal[k] !== header[k]) ||
      native?.backend !== 'NTFS_KTM_TRANSACTIONAL_DEFAULT_STREAM' || native.committed !== true || native.rootIdentity !== base.rootIdentity ||
      native.destinationIdentity !== op.baseIdentity || journal.committedIdentity !== op.baseIdentity || native.oldDigest !== op.baseDigest ||
      native.tempIdentity !== journal.tempIdentity || native.tempDigest !== op.newDigest || native.finalDigest !== op.newDigest ||
      !['sameVolume', 'securityPreserved', 'creationTimePreserved', 'temporaryObjectInPrivateTransaction', 'tempAbsent'].every(k => native[k] === true)) fail('NATIVE_RECEIPT_INVALID');
  const final = readWindowsProjectSnapshot(cwd);
  if (final.rootIdentity !== base.rootIdentity || draftContentDigest(final.files) !== binding.digest || !same(Object.keys(final.files).sort(), Object.keys(snapshot.files).sort()) ||
      Object.entries(base.files).some(([name, file]) => final.identities[name] !== file.identity)) fail('POSTVERIFY_FAILED');
  const proof = Object.freeze({});
  proofs.set(proof, freeze({ ...header, finalDigest: binding.digest, operation: 'MODIFY', native, journal, publisherPid: run.pid,
    publisherExitCode: run.status, publisherExited: true, cleanup: 'PASS', projectPublished: true, backend: native.backend, scope: 'VERIFIED_WORKER_SINGLE_MODIFY' }));
  return proof;
}

export function consumeWindowsPublicationProof(proof, expected) {
  const value = proofs.get(proof);
  if (!value || Object.entries(expected).some(([key, item]) => !same(value[key], item))) fail('NATIVE_PROOF_DENIED');
  proofs.delete(proof); return value;
}
