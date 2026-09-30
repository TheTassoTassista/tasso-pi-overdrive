import fs from 'node:fs';
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
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
const journalKeys = ['version', 'scope', 'transactionId', 'projectIdentity', 'draftId', 'draftVersion', 'verifiedDigest', 'baseDigest', 'phase',
  'sequence', 'operationIndex', 'operations', 'tempIdentity', 'committedIdentity', 'filesCommitted', 'pendingOperations', 'recoveryState', 'cleanup', 'projectPublished'];
const admissionKeys = ['version', 'scope', 'phase', 'transactionId', 'projectIdentity', 'draftId', 'draftVersion', 'verifiedDigest', 'baseDigest', 'operations',
  'journalCreated', 'mutationStarted', 'filesCommitted', 'pendingOperations', 'commitState', 'recoveryState', 'cleanup', 'projectPublished'];
const reconstructionKeys = ['version', 'status', 'transactionId', 'rootIdentity', 'rootIdentityVerified', 'observedStatus', 'decision', 'phase',
  'journalVersion', 'actionPerformed', 'journalMutations', 'projectMutations', 'processKills', 'projectPublished', 'externalRequests'];
const reconstructionStates = new Set(['OLD_COMPLETE_OBSERVED', 'NEW_COMPLETE_OBSERVED', 'DELETE_COMMITTED_QUARANTINE_RETAINED',
  'DELETE_COMMITTED_CLEANUP_OBSERVED', 'RENAME_COMMITTED_DESTINATION_RETAINED', 'CONFLICT', 'UNKNOWN_FAIL_SAFE', 'RECOVERY_REQUIRED']);

// A dead controller's private WeakMap publication proof is intentionally not
// serialized. This decoder can report only read-only filesystem/journal
// observations; it cannot mint PUBLISHED, replay an approval or clean evidence.
export function validateWindowsKnownReconstruction(run, value, transactionId) {
  if (run?.error || run?.status !== 0 || run?.signal || !Number.isSafeInteger(run?.pid) || run.pid < 1 ||
      !exactKeys(value, reconstructionKeys) || value.version !== 1 || value.status !== 'PASS_READ_ONLY_RECONSTRUCTION' ||
      value.transactionId !== transactionId || !/^[0-9a-f]{16}:[0-9a-f]{32}$/u.test(value.rootIdentity ?? '') ||
      !reconstructionStates.has(value.observedStatus) || value.rootIdentityVerified !== true ||
      value.decision !== (value.observedStatus === 'OLD_COMPLETE_OBSERVED' ? 'ROLLBACK' : value.observedStatus === 'CONFLICT' ? 'CONFLICT' : 'MANUAL_RECOVERY_REQUIRED') ||
      typeof value.phase !== 'string' || !/^[A-Z_]{3,32}$/u.test(value.phase) || !Number.isInteger(value.journalVersion) || value.journalVersion < 1 || value.journalVersion > 4 ||
      value.actionPerformed !== false || value.journalMutations !== 0 || value.projectMutations !== 0 || value.processKills !== 0 ||
      value.projectPublished !== false || value.externalRequests !== 0) fail('RECONSTRUCTION_UNCONFIRMED');
  return freeze({ ...value });
}

// Internal trusted-controller known-locator bridge. Transaction discovery is
// separate; this is never registered as a model tool or a recovery mutation.
export function inspectKnownWindowsTransaction({ cwd, transactionId }) {
  if (process.platform !== 'win32') fail('BACKEND_UNAVAILABLE');
  if (typeof cwd !== 'string' || cwd.length > 1024 || cwd.includes('\0') || !/^[0-9a-f]{32}$/u.test(transactionId ?? '')) fail('RECONSTRUCTION_REQUEST_INVALID');
  const root = fs.realpathSync(cwd), stat = fs.lstatSync(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RECONSTRUCTION_REQUEST_INVALID');
  const input = JSON.stringify({ version: 1, root, transactionId }) + '\n';
  const run = spawnSync(ownedWindowsHelper(), ['--publication-inspect-known'], { shell: false, windowsHide: true, encoding: 'utf8', input,
    timeout: 15000, maxBuffer: 8192 });
  let value; try { value = JSON.parse(run.stdout); } catch { fail('RECONSTRUCTION_UNCONFIRMED'); }
  return validateWindowsKnownReconstruction(run, value, transactionId);
}

const discoveryKeys = ['version', 'status', 'rootIdentity', 'rootIdentityVerified', 'scannedTransactions', 'projectTransactions',
  'entries', 'actionPerformed', 'journalMutations', 'projectMutations', 'processKills', 'projectPublished', 'externalRequests'];
const discoveryEntryKeys = ['transactionId', 'journalVersion', 'phase', 'observedStatus', 'classification'];
export function validateWindowsTransactionDiscovery(run, value) {
  if (run?.error || run?.status !== 0 || run?.signal || !Number.isSafeInteger(run?.pid) || run.pid < 1 ||
      !exactKeys(value, discoveryKeys) || value.version !== 1 || value.status !== 'PASS_READ_ONLY_DISCOVERY' ||
      !/^[0-9a-f]{16}:[0-9a-f]{32}$/u.test(value.rootIdentity ?? '') || value.rootIdentityVerified !== true ||
      !Number.isInteger(value.scannedTransactions) || value.scannedTransactions < 0 || value.scannedTransactions > 64 ||
      !Number.isInteger(value.projectTransactions) || value.projectTransactions < 0 || value.projectTransactions > value.scannedTransactions ||
      !Array.isArray(value.entries) || value.entries.length !== value.projectTransactions ||
      value.actionPerformed !== false || value.journalMutations !== 0 || value.projectMutations !== 0 ||
      value.processKills !== 0 || value.projectPublished !== false || value.externalRequests !== 0) fail('DISCOVERY_UNCONFIRMED');
  let previous = '';
  for (const entry of value.entries) {
    if (!exactKeys(entry, discoveryEntryKeys) || !/^[0-9a-f]{32}$/u.test(entry.transactionId ?? '') ||
        entry.transactionId <= previous || !Number.isInteger(entry.journalVersion) || entry.journalVersion < 1 || entry.journalVersion > 4 ||
        !/^[A-Z_]{3,32}$/u.test(entry.phase ?? '') ||
        !['ACTIVE', 'OLD_COMPLETE_OBSERVED', 'NEW_COMPLETE_OBSERVED', 'DELETE_COMMITTED_QUARANTINE_RETAINED',
          'DELETE_COMMITTED_CLEANUP_OBSERVED', 'RENAME_COMMITTED_DESTINATION_RETAINED', 'CONFLICT', 'UNKNOWN_FAIL_SAFE',
          'RECOVERY_REQUIRED'].includes(entry.observedStatus)) fail('DISCOVERY_UNCONFIRMED');
    const expected = entry.observedStatus === 'ACTIVE' ? 'ACTIVE_UNVERIFIED' : entry.observedStatus === 'CONFLICT' ? 'CONFLICT' :
      entry.observedStatus === 'UNKNOWN_FAIL_SAFE' ? 'MANUAL_RECOVERY_REQUIRED' :
      ['CLEANED', 'ROLLED_BACK'].includes(entry.phase) ? 'TERMINAL_RETAINED' : 'RECOVERY_REQUIRED';
    if (entry.classification !== expected || (entry.observedStatus === 'ACTIVE') !== (entry.phase === 'UNKNOWN_ACTIVE')) fail('DISCOVERY_UNCONFIRMED');
    previous = entry.transactionId;
  }
  return freeze({ ...value });
}

// This internal bridge is an advisory inventory, never a model tool or a
// recovered publication grant. Every later action must revalidate its known
// transaction under the native lease against the actual project state.
export function discoverWindowsTransactions({ cwd }) {
  if (process.platform !== 'win32') fail('BACKEND_UNAVAILABLE');
  if (typeof cwd !== 'string' || cwd.length > 1024 || cwd.includes('\0')) fail('DISCOVERY_REQUEST_INVALID');
  const root = fs.realpathSync(cwd), stat = fs.lstatSync(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('DISCOVERY_REQUEST_INVALID');
  const run = spawnSync(ownedWindowsHelper(), ['--publication-discover'], { shell: false, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({ version: 1, root }) + '\n', timeout: 15000, maxBuffer: 32768 });
  let value; try { value = JSON.parse(run.stdout); } catch { fail('DISCOVERY_UNCONFIRMED'); }
  return validateWindowsTransactionDiscovery(run, value);
}

const recoveryKeys = ['version', 'status', 'transactionId', 'rootIdentity', 'rootIdentityVerified', 'observedStatus', 'decision',
  'phaseBefore', 'phaseAfter', 'baseDigestVerified', 'verifiedDraftDigestMatched', 'actionPerformed', 'journalMutations',
  'projectMutations', 'processKills', 'projectPublished', 'externalRequests'];
export function validateWindowsKnownRecovery(run, value, transactionId) {
  const action = new Set(['ROLLBACK', 'RESUME', 'FINALIZE_COMMIT']);
  const terminal = value?.decision === 'ROLLBACK' ? 'ROLLED_BACK' : 'CLEANED';
  const phaseActions = {
    ROLLBACK: { PREPARED: 2 },
    RESUME: { RENAME_INTENT: 4, RENAMED: 3 },
    FINALIZE_COMMIT: { COMMITTED: 2, POST_COMMIT_VERIFIED: 1, RECOVERY_REQUIRED: 1 },
  };
  if (run?.error || run?.status !== 0 || run?.signal || !Number.isSafeInteger(run?.pid) || run.pid < 1 ||
      !exactKeys(value, recoveryKeys) || value.version !== 1 || value.status !== 'PASS_BOUNDED_RENAME_RECOVERY' ||
      value.transactionId !== transactionId || !/^[0-9a-f]{16}:[0-9a-f]{32}$/u.test(value.rootIdentity ?? '') ||
      value.rootIdentityVerified !== true || !/^[A-Z_]{3,32}$/u.test(value.phaseBefore ?? '') ||
      !/^[A-Z_]{3,32}$/u.test(value.phaseAfter ?? '') ||
      !['OLD_COMPLETE_OBSERVED', 'RENAME_COMMITTED_DESTINATION_RETAINED', 'CONFLICT', 'UNKNOWN_FAIL_SAFE'].includes(value.observedStatus) ||
      !['ROLLBACK', 'RESUME', 'FINALIZE_COMMIT', 'CLEANUP_ONLY', 'CONFLICT', 'MANUAL_RECOVERY_REQUIRED'].includes(value.decision) ||
      !Number.isInteger(value.projectMutations) || value.projectMutations < 0 || value.projectMutations > 1 ||
      value.processKills !== 0 || value.projectPublished !== false || value.externalRequests !== 0 ||
      !Number.isInteger(value.journalMutations) || value.journalMutations < 0 || value.journalMutations > 4 ||
      typeof value.baseDigestVerified !== 'boolean' || typeof value.verifiedDraftDigestMatched !== 'boolean' ||
      value.baseDigestVerified !== value.verifiedDraftDigestMatched) fail('RECOVERY_UNCONFIRMED');
  if (action.has(value.decision)) {
    if (value.actionPerformed !== true || value.journalMutations !== phaseActions[value.decision][value.phaseBefore] || value.phaseAfter !== terminal ||
        value.baseDigestVerified !== true ||
        (value.decision === 'ROLLBACK' ? value.observedStatus !== 'OLD_COMPLETE_OBSERVED' : value.decision === 'RESUME'
          ? !['OLD_COMPLETE_OBSERVED', 'RENAME_COMMITTED_DESTINATION_RETAINED'].includes(value.observedStatus)
          : value.observedStatus !== 'RENAME_COMMITTED_DESTINATION_RETAINED') ||
        value.projectMutations !== (value.decision === 'RESUME' && value.observedStatus === 'OLD_COMPLETE_OBSERVED' ? 1 : 0) ||
        value.decision === 'RESUME' && value.observedStatus === 'OLD_COMPLETE_OBSERVED' && value.phaseBefore !== 'RENAME_INTENT') fail('RECOVERY_UNCONFIRMED');
  } else if (value.actionPerformed !== false || value.journalMutations !== 0 || value.phaseAfter !== value.phaseBefore ||
      value.projectMutations !== 0 ||
      value.decision === 'CLEANUP_ONLY' && (!value.baseDigestVerified || !['CLEANED', 'ROLLED_BACK'].includes(value.phaseAfter)) ||
      value.decision === 'CLEANUP_ONLY' && (value.phaseAfter === 'CLEANED' ? value.observedStatus !== 'RENAME_COMMITTED_DESTINATION_RETAINED' : value.observedStatus !== 'OLD_COMPLETE_OBSERVED') ||
      value.decision === 'MANUAL_RECOVERY_REQUIRED' && value.observedStatus !== 'UNKNOWN_FAIL_SAFE' ||
      ['CONFLICT', 'MANUAL_RECOVERY_REQUIRED'].includes(value.decision) && value.baseDigestVerified) fail('RECOVERY_UNCONFIRMED');
  return freeze({ ...value });
}

// Recovery-only: V4 INTENT may complete exactly one held-source no-clobber
// rename; all other dispositions are metadata-only. No restored WeakMap grant
// or new PUBLISHED certificate is minted.
export function recoverKnownWindowsRename({ cwd, transactionId }) {
  if (process.platform !== 'win32') fail('BACKEND_UNAVAILABLE');
  if (typeof cwd !== 'string' || cwd.length > 1024 || cwd.includes('\0') || !/^[0-9a-f]{32}$/u.test(transactionId ?? '')) fail('RECOVERY_REQUEST_INVALID');
  const root = fs.realpathSync(cwd), stat = fs.lstatSync(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RECOVERY_REQUEST_INVALID');
  const run = spawnSync(ownedWindowsHelper(), ['--publication-recover-known'], { shell: false, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({ version: 1, root, transactionId, guardianPid: process.pid, timeoutMs: 10000 }) + '\n', timeout: 11000, maxBuffer: 8192 });
  let value; try { value = JSON.parse(run.stdout); } catch { fail('RECOVERY_UNCONFIRMED'); }
  return validateWindowsKnownRecovery(run, value, transactionId);
}

// Pure bounded failure decoder, not an execution endpoint or publication proof.
// Production calls it ONLY with the result of the fixed attested native spawn.
// Tests may decode metadata, but no Error/JSON can mint the private certificate.
export function windowsPublicationFailure(run, value, header) {
  const error = new Error('PHI_PUBLICATION_NATIVE_EXECUTION_UNCONFIRMED'); error.code = error.message;
  if (run.error || run.status !== 70 || run.signal || !Number.isSafeInteger(run.pid) || run.pid < 1 || value?.version !== 1 ||
      !['FAIL_NATIVE_SINGLE_MODIFY', 'FAIL_NATIVE_SINGLE_DELETE', 'FAIL_NATIVE_SINGLE_RENAME'].includes(value.status) || value.projectPublished !== false || value.externalRequests !== 0) return error;
  const deletion = value.status === 'FAIL_NATIVE_SINGLE_DELETE';
  const renaming = value.status === 'FAIL_NATIVE_SINGLE_RENAME';
  if (!Array.isArray(header.operations) || header.operations.length !== 1 || header.operations[0].kind !== (deletion ? 'DELETE' : renaming ? 'RENAME' : 'REPLACE')) return error;
  const bound = item => Object.keys(header).every(key => same(item?.[key], header[key]));
  const phase = /^[a-zA-Z-]{1,40}$/u.test(value.phase ?? '') ? value.phase : 'UNKNOWN';
  const nativeCode = /^[0-9a-f]{8}$/u.test(value.nativeCode ?? '') ? value.nativeCode : null;
  const j = value.journal, a = value.admission;
  if (exactKeys(j, journalKeys) && j.version === (deletion ? 3 : renaming ? 4 : 2) && j.scope === (deletion ? 'SINGLE_FILE_DELETE_JOURNAL_NOT_CONTROLLER_PUBLICATION' : renaming ? 'SINGLE_FILE_RENAME_JOURNAL_NOT_CONTROLLER_PUBLICATION' : 'SINGLE_FILE_MODIFY_JOURNAL_NOT_CONTROLLER_PUBLICATION') &&
      j.projectPublished === false && bound(j)) {
    error.publicationEvidence = freeze({ phase, nativeCode, journal: j });
    if (value.reason === 'CONFLICT' && j.phase === 'CONFLICT' && j.committedIdentity === null && (!(deletion || renaming) || j.tempIdentity === null) && j.pendingOperations === 1 && same(j.filesCommitted, [])) {
      error.code = 'PHI_PUBLICATION_CONFLICT'; error.message = error.code;
    }
  } else if (value.reason === 'CONFLICT' && value.phase === 'ADMISSION' && nativeCode !== null && j === null && exactKeys(a, admissionKeys) &&
      a.version === 1 && a.scope === 'VALIDATED_BASE_CONFLICT_BEFORE_JOURNAL' && a.phase === 'ADMISSION_CONFLICT' && bound(a) &&
      a.journalCreated === false && a.mutationStarted === false && a.projectPublished === false && a.pendingOperations === 1 && same(a.filesCommitted, []) &&
      a.commitState === 'NOT_STARTED' && a.recoveryState === 'NOT_STARTED' && a.cleanup === 'NOT_STARTED') {
    error.code = 'PHI_PUBLICATION_CONFLICT'; error.message = error.code;
    error.publicationEvidence = freeze({ phase, nativeCode, journal: null, admission: a });
  }
  return error;
}

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
    throw windowsPublicationFailure(run, value, header);
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

// Same opaque trusted-controller grant, journal, source-attested helper and
// one-use private certificate. No extra role/model execution authority.
export function publishWindowsSingleOperation(options) {
  if (options?.metadata?.operations?.length === 1 && options.metadata.operations[0].kind === 'RENAME') return publishWindowsSingleRename(options);
  const operations = publicationOperations(options.base, options.snapshot);
  if (operations.length === 1 && operations[0].kind === 'DELETE') return publishWindowsSingleDelete(options);
  return publishWindowsSingleModify(options); // Existing MODIFY path unchanged.
}
function publishWindowsSingleRename({ cwd, base, snapshot, binding, metadata, remainingMs }) {
  if (process.platform !== 'win32') fail('BACKEND_UNAVAILABLE');
  const proposed = metadata?.operations?.[0];
  if (metadata?.operations?.length !== 1 || proposed?.kind !== 'RENAME') fail('SINGLE_RENAME_ONLY');
  const operations = publicationOperations(base, snapshot, { sourcePath: proposed.sourcePath, destinationPath: proposed.path }), op = operations[0];
  if (metadata.transactionId === null || binding.digest !== draftContentDigest(snapshot.files) || metadata.verifiedDigest !== binding.digest ||
      metadata.baseDigest !== base.digest || !same(metadata.operations, operations) || !Number.isSafeInteger(remainingMs) || remainingMs < 1) fail('BINDING_INVALID');
  if (publicationConflicts(base, readWindowsProjectSnapshot(cwd)).length) fail('CONFLICT');
  const timeoutMs = Math.min(remainingMs, 30000);
  const header = { transactionId: metadata.transactionId, projectIdentity: base.rootIdentity, draftId: binding.id, draftVersion: binding.revision,
    verifiedDigest: binding.digest, baseDigest: base.digest, operations };
  const input = JSON.stringify({ version: 1, root: cwd, header, guardianPid: process.pid, timeoutMs }) + '\n';
  if (Buffer.byteLength(input) > 65536) fail('REQUEST_LIMIT');
  const run = spawnSync(ownedWindowsHelper(), ['--publication-rename'], { shell: false, windowsHide: true, encoding: 'utf8', input,
    timeout: timeoutMs + 1000, maxBuffer: 32768 });
  let value; try { value = JSON.parse(run.stdout); } catch { fail('NATIVE_RECEIPT_INVALID'); }
  if (run.error || run.status !== 0 || run.signal || !Number.isSafeInteger(run.pid) || run.pid < 1) throw windowsPublicationFailure(run, value, header);
  const journal = value?.receipt?.journal, native = value?.receipt?.nativeProof, primitive = native?.primitive;
  const nativeKeys = ['backend', 'primitive', 'sourceIdentity', 'destinationIdentity', 'digest', 'sameDirectory', 'noClobber', 'committed', 'txfUsed', 'projectPublished'];
  const primitiveKeys = ['backend', 'sourceIdentity', 'destinationIdentity', 'digest', 'sameDirectory', 'noClobber', 'sourceAuthorityConsumed', 'txfUsed', 'journalUsed', 'projectPublished'];
  if (value.version !== 1 || value.status !== 'PASS_NATIVE_SINGLE_RENAME' || value.projectPublished !== false || value.externalRequests !== 0 ||
      !exactKeys(journal, journalKeys) || journal.version !== 4 || journal.scope !== 'SINGLE_FILE_RENAME_JOURNAL_NOT_CONTROLLER_PUBLICATION' ||
      journal.phase !== 'CLEANED' || journal.cleanup !== 'PASS' || journal.projectPublished !== false || journal.pendingOperations !== 0 ||
      !same(journal.filesCommitted, [op.path]) || !same(journal.operations, operations) || Object.keys(header).some(k => !same(journal[k], header[k])) ||
      journal.tempIdentity !== op.baseIdentity || journal.committedIdentity !== op.baseIdentity || !exactKeys(native, nativeKeys) ||
      native.backend !== 'JOURNALED_HANDLE_ANCHORED_RENAME' || native.sourceIdentity !== op.baseIdentity || native.destinationIdentity !== op.baseIdentity ||
      native.digest !== op.baseDigest || native.txfUsed !== false || native.projectPublished !== false ||
      !['sameDirectory', 'noClobber', 'committed'].every(k => native[k] === true) || !exactKeys(primitive, primitiveKeys) ||
      primitive.backend !== 'HANDLE_ANCHORED_EXPECTED_SOURCE_RENAME' || primitive.sourceIdentity !== op.baseIdentity ||
      primitive.destinationIdentity !== op.baseIdentity || primitive.digest !== op.baseDigest ||
      !['sameDirectory', 'noClobber', 'sourceAuthorityConsumed'].every(k => primitive[k] === true) ||
      primitive.txfUsed !== false || primitive.journalUsed !== false || primitive.projectPublished !== false) fail('NATIVE_RECEIPT_INVALID');
  const final = readWindowsProjectSnapshot(cwd);
  if (final.rootIdentity !== base.rootIdentity || draftContentDigest(final.files) !== binding.digest ||
      !same(Object.keys(final.files).sort(), Object.keys(snapshot.files).sort()) || Object.hasOwn(final.files, op.sourcePath) ||
      final.identities[op.path] !== op.baseIdentity || Object.entries(base.files).some(([name, file]) => name !== op.sourcePath && final.identities[name] !== file.identity)) fail('POSTVERIFY_FAILED');
  const proof = Object.freeze({});
  proofs.set(proof, freeze({ ...header, finalDigest: binding.digest, operation: 'RENAME', native, journal, publisherPid: run.pid,
    publisherExitCode: run.status, publisherExited: true, cleanup: 'PASS', projectPublished: true, backend: native.backend, scope: 'VERIFIED_WORKER_SINGLE_RENAME' }));
  return proof;
}
function publishWindowsSingleDelete({ cwd, base, snapshot, binding, metadata, remainingMs }) {
  if (process.platform !== 'win32') fail('BACKEND_UNAVAILABLE');
  const operations = publicationOperations(base, snapshot), op = operations[0];
  if (operations.length !== 1 || op.kind !== 'DELETE') fail('SINGLE_DELETE_ONLY');
  if (metadata.transactionId === null || binding.digest !== draftContentDigest(snapshot.files) || metadata.verifiedDigest !== binding.digest ||
      metadata.baseDigest !== base.digest || !same(metadata.operations, operations) || !Number.isSafeInteger(remainingMs) || remainingMs < 1) fail('BINDING_INVALID');
  if (publicationConflicts(base, readWindowsProjectSnapshot(cwd)).length) fail('CONFLICT');
  const timeoutMs = Math.min(remainingMs, 30000);
  const header = { transactionId: metadata.transactionId, projectIdentity: base.rootIdentity, draftId: binding.id, draftVersion: binding.revision,
    verifiedDigest: binding.digest, baseDigest: base.digest, operations };
  const request = { version: 1, root: cwd, header, guardianPid: process.pid, timeoutMs };
  const input = JSON.stringify(request) + '\n'; if (Buffer.byteLength(input) > 65536) fail('REQUEST_LIMIT');
  const run = spawnSync(ownedWindowsHelper(), ['--publication-delete'], { shell: false, windowsHide: true, encoding: 'utf8', input,
    timeout: timeoutMs + 1000, maxBuffer: 32768 });
  let value; try { value = JSON.parse(run.stdout); } catch { fail('NATIVE_RECEIPT_INVALID'); }
  if (run.error || run.status !== 0 || run.signal || !Number.isSafeInteger(run.pid) || run.pid < 1) throw windowsPublicationFailure(run, value, header);
  const journal = value?.receipt?.journal, native = value?.receipt?.nativeProof;
  const nativeKeys = ['backend', 'sourceIdentity', 'oldDigest', 'quarantineIdentity', 'sameDirectory', 'noClobber', 'committed', 'destinationAbsent', 'quarantineAbsent', 'txfUsed'];
  if (value.version !== 1 || value.status !== 'PASS_NATIVE_SINGLE_DELETE' || value.projectPublished !== false || value.externalRequests !== 0 ||
      !exactKeys(journal, journalKeys) || journal.version !== 3 || journal.scope !== 'SINGLE_FILE_DELETE_JOURNAL_NOT_CONTROLLER_PUBLICATION' ||
      journal.phase !== 'CLEANED' || journal.cleanup !== 'PASS' || journal.projectPublished !== false || journal.pendingOperations !== 0 ||
      !same(journal.filesCommitted, [op.path]) || !same(journal.operations, operations) || Object.keys(header).some(k => !same(journal[k], header[k])) ||
      journal.tempIdentity !== op.baseIdentity || journal.committedIdentity !== op.baseIdentity || !exactKeys(native, nativeKeys) ||
      native.backend !== 'HANDLE_ANCHORED_QUARANTINE_DELETE' || native.sourceIdentity !== op.baseIdentity || native.quarantineIdentity !== op.baseIdentity ||
      native.oldDigest !== op.baseDigest || native.txfUsed !== false ||
      !['sameDirectory', 'noClobber', 'committed', 'destinationAbsent', 'quarantineAbsent'].every(k => native[k] === true)) fail('NATIVE_RECEIPT_INVALID');
  const final = readWindowsProjectSnapshot(cwd);
  if (final.rootIdentity !== base.rootIdentity || draftContentDigest(final.files) !== binding.digest || !same(Object.keys(final.files).sort(), Object.keys(snapshot.files).sort()) ||
      Object.hasOwn(final.files, op.path) || Object.entries(base.files).some(([name, file]) => name !== op.path && final.identities[name] !== file.identity)) fail('POSTVERIFY_FAILED');
  const proof = Object.freeze({});
  proofs.set(proof, freeze({ ...header, finalDigest: binding.digest, operation: 'DELETE', native, journal, publisherPid: run.pid,
    publisherExitCode: run.status, publisherExited: true, cleanup: 'PASS', projectPublished: true, backend: native.backend, scope: 'VERIFIED_WORKER_SINGLE_DELETE' }));
  return proof;
}

export function consumeWindowsPublicationProof(proof, expected) {
  const value = proofs.get(proof);
  if (!value || Object.entries(expected).some(([key, item]) => !same(value[key], item))) fail('NATIVE_PROOF_DENIED');
  proofs.delete(proof); return value;
}
