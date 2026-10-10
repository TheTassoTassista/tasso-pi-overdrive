// Campaign-2 test evidence only. This module never grants publication or
// recovery authority and never mutates the project or its receipts.
import fs from 'node:fs';
import path from 'node:path';

export const D_OPERATIONS = Object.freeze([
  Object.freeze({ operation: 'CREATE', journalVersion: 6 }),
  Object.freeze({ operation: 'MODIFY', journalVersion: 2 }),
  Object.freeze({ operation: 'RENAME', journalVersion: 4 }),
  Object.freeze({ operation: 'DELETE', journalVersion: 3 }),
]);

function readBoundedFile(root, name) {
  const file = path.join(root, name);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { kind: 'INVALID' };
    return { kind: 'FILE', content: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'ABSENT' };
    return { kind: 'UNKNOWN' };
  }
}

function expectedPhysical(prefix, created, modified) {
  if (prefix === 0 || prefix === 4) return [{ kind: 'ABSENT' }, { kind: 'ABSENT' }];
  if (prefix === 1) return [{ kind: 'FILE', content: created }, { kind: 'ABSENT' }];
  if (prefix === 2) return [{ kind: 'FILE', content: modified }, { kind: 'ABSENT' }];
  return [{ kind: 'ABSENT' }, { kind: 'FILE', content: modified }];
}

export function classifyDPrefix({ projectRoot, source = 'a.txt', destination = 'b.txt', created, modified, receipts }) {
  let rootValid = false;
  try { rootValid = typeof projectRoot === 'string' && path.isAbsolute(projectRoot) && fs.statSync(projectRoot).isDirectory(); }
  catch { /* Missing or inaccessible evidence is never a valid prefix. */ }
  if (!rootValid ||
      typeof source !== 'string' || typeof destination !== 'string' || source === destination ||
      !/^[A-Za-z0-9_.-]+$/u.test(source) || !/^[A-Za-z0-9_.-]+$/u.test(destination) ||
      typeof created !== 'string' || typeof modified !== 'string' || !Array.isArray(receipts) || receipts.length > 4)
    return { status: 'AMBIGUOUS', reason: 'INVALID_INPUT' };
  const observed = [readBoundedFile(projectRoot, source), readBoundedFile(projectRoot, destination)];
  const seen = new Set();
  for (let index = 0; index < receipts.length; index++) {
    const entry = receipts[index], expected = D_OPERATIONS[index];
    if (!entry || entry.operation !== expected.operation || entry.journalVersion !== expected.journalVersion ||
        entry.status !== 'PASS' || entry.readback !== 'PASS' || entry.journalPhase !== 'CLEANED' ||
        typeof entry.transactionId !== 'string' || !/^[0-9a-f]{32}$/u.test(entry.transactionId) || seen.has(entry.transactionId))
      return { status: 'AMBIGUOUS', reason: 'DURABLE_EVIDENCE_MISMATCH', observed };
    seen.add(entry.transactionId);
  }
  const prefix = receipts.length;
  const expected = expectedPhysical(prefix, created, modified);
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    return { status: 'AMBIGUOUS', reason: 'PHYSICAL_DURABLE_MISMATCH', observed };
  return { status: `PREFIX_${prefix}`, completed: prefix, observed, transactionIds: [...seen] };
}

// Test-only sequencing: no task is launched from a predecessor's receipt.
// The caller must independently establish the next trusted user task and
// validate current physical state before invoking the normal workflow.
export async function runDSequence({ inspect, invoke }) {
  if (typeof inspect !== 'function' || typeof invoke !== 'function') throw new Error('D_SEQUENCE_INVALID_CALLBACK');
  const completed = [];
  for (let index = 0; index < D_OPERATIONS.length; index++) {
    const before = await inspect(completed);
    if (before?.status !== `PREFIX_${index}`) return { status: 'FAIL', reason: 'PRESTATE_AMBIGUOUS', completed: index, inFlight: null };
    const result = await invoke(D_OPERATIONS[index], index);
    if (result?.status !== 'PASS') {
      const afterFailure = await inspect(completed);
      return { status: 'FAIL', reason: afterFailure?.status === `PREFIX_${index}` ? 'OPERATION_FAILED' : 'POSTFAIL_AMBIGUOUS',
        completed: index, inFlight: D_OPERATIONS[index].operation };
    }
    completed.push(result.receipt);
    const after = await inspect(completed);
    if (after?.status !== `PREFIX_${index + 1}`)
      return { status: 'FAIL', reason: 'POSTSTATE_AMBIGUOUS', completed: index, inFlight: D_OPERATIONS[index].operation };
  }
  return { status: 'PASS', completed: 4, inFlight: null };
}
