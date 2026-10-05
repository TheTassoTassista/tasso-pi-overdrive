import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const transient = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
const known = new Set([...transient, 'EACCES', 'ENOENT', 'EIO', 'IDENTITY_CHANGED', 'OWNERSHIP_UNVERIFIED', 'TARGET_REJECTED']);
const inside = (base, target) => { const relative = path.relative(base, target); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
export function cloneIdentity(root) {
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PHI_CLONE_IDENTITY_INVALID');
  return { dev: stat.dev, ino: stat.ino };
}
export function cleanupErrorMetadata(error, root, clone = path.join(root, 'source with spaces')) {
  const code = known.has(error?.code) ? error.code : 'UNKNOWN';
  const target = typeof error?.path === 'string' ? path.resolve(error.path) : null;
  const category = target === path.resolve(root) ? 'TEMP_ROOT' : target === path.resolve(clone) ? 'CLONE_ROOT' : target && inside(clone, target) ? 'CLONE_ENTRY' : target && inside(root, target) ? 'TEMP_ENTRY' : 'UNKNOWN';
  const operation = ['rmdir', 'unlink', 'rename', 'open', 'stat'].includes(error?.syscall) ? error.syscall : 'RECURSIVE_REMOVE';
  return { code, operation, pathCategory: category, uvErrno: Number.isInteger(error?.errno) ? error.errno : null,
    nativeError: 'NOT_EXPOSED_BY_NODE', lockOwner: 'UNKNOWN' };
}
// Only a newly-created harness root, never a project/worktree or broad temp base.
// Tests inject filesystem/timing operations, not production model/tool input.
export async function cleanupClone(root, identity, { safeCwd, receipts = [], platform = process.platform, remove = fs.rmSync, stat = (p) => fs.lstatSync(p, { bigint: true, throwIfNoEntry: false }), now = () => performance.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const start = now(), currentCwdInside = inside(root, process.cwd());
  const result = { status: 'FAIL', cleanupAttempted: false, attemptCount: 0, elapsedMs: 0, directoryRemoved: false, currentCwdInsideBefore: currentCwdInside,
    currentCwdInsideAfter: currentCwdInside, childCwdInsideAfter: 'UNKNOWN', inheritedHandleAfter: 'UNKNOWN',
    residualOwnedProcesses: null, processOwnership: platform === 'win32' ? 'NATIVE_JOB_HANDLES' : 'NOT_NATIVE_WINDOWS',
    gitReferences: 'INDEPENDENT_CLONE_NOT_WORKTREE', quarantineState: 'RETAINED_ON_FAILURE', diagnostics: [], error: null };
  try {
    if (!path.isAbsolute(root) || !/^phi-(?:clean-room|clone-cleanup)-[A-Za-z0-9]{6}$/u.test(path.basename(root)) || fs.realpathSync(path.dirname(root)) !== fs.realpathSync(os.tmpdir())) throw Object.assign(new Error(), { code: 'TARGET_REJECTED' });
    if (currentCwdInside) {
      if (!safeCwd || inside(root, safeCwd)) throw Object.assign(new Error(), { code: 'IDENTITY_CHANGED' });
      process.chdir(safeCwd);
    }
    result.currentCwdInsideAfter = inside(root, process.cwd());
    if (platform === 'win32') {
      if (!receipts.length || receipts.some(r => r.scope !== 'TRUSTED_VALIDATION_JOB_NOT_SANDBOX' || !r.jobAttested || !r.jobEmptyVerified || !r.pipesDrained || r.residualOwnedProcesses !== 0)) throw Object.assign(new Error(), { code: 'OWNERSHIP_UNVERIFIED' });
      result.residualOwnedProcesses = 0;
      result.childCwdInsideAfter = false; result.inheritedHandleAfter = false;
    }
    const backoff = [25, 50, 100, 200, 400];
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      const value = stat(root);
      if (!value) { result.directoryRemoved = true; break; }
      if (!value.isDirectory() || value.isSymbolicLink() || value.dev !== identity.dev || value.ino !== identity.ino) throw Object.assign(new Error(), { code: 'IDENTITY_CHANGED' });
      result.cleanupAttempted = true; result.attemptCount++;
      try { remove(root, { recursive: true, force: true, maxRetries: 0 }); }
      catch (error) {
        const diagnostic = cleanupErrorMetadata(error, root); result.diagnostics.push(diagnostic); result.error = diagnostic;
        if (platform !== 'win32' || !transient.has(error?.code) || attempt === backoff.length || now() - start + backoff[attempt] > 2000) throw error;
        await sleep(backoff[attempt]); continue;
      }
      result.directoryRemoved = !stat(root); break;
    }
    result.status = result.directoryRemoved ? 'PASS' : 'FAIL';
    if (result.status === 'PASS') { result.error = null; result.quarantineState = 'NONE'; }
  } catch (error) { result.error = cleanupErrorMetadata(error, root); }
  result.elapsedMs = Math.ceil(now() - start);
  return result;
}
export function combineValidationResults(primary, cleanup) {
  const successful = ['PASS_FOUNDATION_ONLY', 'FOCUSED_TEST206_PASS_NON_CERTIFYING'].includes(primary.status);
  return { version: 2, status: successful && cleanup.status === 'PASS' ? primary.status : 'FAIL',
    classification: cleanup.status !== 'PASS' ? 'INCOMPLETE_SUITE' :
      ['TEST_FAILURE', 'INCOMPLETE_SUITE', 'STALL_TIMEOUT', 'OUTER_RUNTIME_LIMIT'].includes(primary.status) ? primary.status :
      primary.status === 'PASS_FOUNDATION_ONLY' ? 'SUCCESS' :
      primary.status === 'FOCUSED_TEST206_PASS_NON_CERTIFYING' ? 'FOCUSED_DIAGNOSTIC_ONLY' : 'INCOMPLETE_SUITE',
    primary, cleanup, modelCalls: 0 };
}
