import { discoverWindowsTransactions, recoverKnownWindowsModify, recoverKnownWindowsDelete, recoverKnownWindowsRename } from './publication.mjs';

const terminal = new Set(['CLEANED', 'ROLLED_BACK']);
const recover = Object.freeze({ 2: recoverKnownWindowsModify, 3: recoverKnownWindowsDelete, 4: recoverKnownWindowsRename });
const fail = () => { throw new Error('PHI_STARTUP_RECOVERY_UNCONFIRMED'); };

// Selection is advisory only. The native known-transaction endpoint must
// revalidate the complete journal, dead creator, pinned root and filesystem
// under its own lease before it takes any recovery-only action.
export function planWindowsStartupRecovery(inventory) {
  if (inventory?.status !== 'PASS_READ_ONLY_DISCOVERY' || inventory.rootIdentityVerified !== true ||
      !Array.isArray(inventory.entries) || inventory.entries.length > 64 || inventory.entries.length !== inventory.projectTransactions ||
      inventory.projectPublished !== false || inventory.actionPerformed !== false) fail();
  // A terminal phase is ignorable only when native discovery also verified
  // the terminal filesystem state. A terminal journal with a later conflict
  // must still block startup.
  const pending = inventory.entries.filter(entry => !terminal.has(entry.phase) || entry.classification !== 'TERMINAL_RETAINED');
  if (pending.length === 0) return Object.freeze({ kind: 'NO_PENDING', entry: null });
  if (pending.length !== 1) return Object.freeze({ kind: 'BLOCKED_MULTIPLE_PENDING', entry: null });
  const entry = pending[0];
  if (entry.classification !== 'RECOVERY_REQUIRED') return Object.freeze({ kind: 'BLOCKED_' + entry.classification, entry });
  if (!Object.hasOwn(recover, entry.journalVersion)) return Object.freeze({ kind: 'BLOCKED_UNSUPPORTED_VERSION', entry });
  return Object.freeze({ kind: 'RECOVER', entry });
}

function receipt(inventory, status, reason, entry = null, action = null) {
  return Object.freeze({ version: 1, scope: 'PHI_WINDOWS_STARTUP_RECOVERY_ONLY_NOT_PUBLICATION', status, reason,
    rootIdentity: inventory.rootIdentity, scannedTransactions: inventory.scannedTransactions,
    projectTransactions: inventory.projectTransactions, transactionId: entry?.transactionId ?? null,
    journalVersion: entry?.journalVersion ?? null, decision: action?.decision ?? null,
    phaseBefore: action?.phaseBefore ?? entry?.phase ?? null, phaseAfter: action?.phaseAfter ?? entry?.phase ?? null,
    journalMutations: action?.journalMutations ?? 0, projectMutations: action?.projectMutations ?? 0,
    projectPublished: false, externalRequests: 0 });
}

// Called by the ordinary `phi` launch path on Windows before its existing
// autonomous-backend gate. One nonterminal transaction at most is recovered
// per launch; multiple/active/ambiguous records stop startup without action.
// No caller can supply an action, helper, profile, authority or retry policy.
export function runWindowsStartupRecovery({ cwd }) {
  if (process.platform !== 'win32') fail();
  const before = discoverWindowsTransactions({ cwd });
  const plan = planWindowsStartupRecovery(before);
  if (plan.kind === 'NO_PENDING') return receipt(before, 'PASS_NO_PENDING', 'NO_NONTERMINAL_TRANSACTION');
  if (plan.kind !== 'RECOVER') return receipt(before, 'BLOCKED', plan.kind, plan.entry);

  const entry = plan.entry;
  const action = recover[entry.journalVersion]({ cwd, transactionId: entry.transactionId });
  if (action.rootIdentity !== before.rootIdentity || action.transactionId !== entry.transactionId ||
      action.projectPublished !== false || action.externalRequests !== 0) fail();
  const after = discoverWindowsTransactions({ cwd });
  if (after.rootIdentity !== before.rootIdentity) fail();
  const updated = after.entries.find(item => item.transactionId === entry.transactionId);
  if (!updated || updated.journalVersion !== entry.journalVersion || updated.phase !== action.phaseAfter) fail();
  const cleared = planWindowsStartupRecovery(after).kind === 'NO_PENDING';
  const successful = ['ROLLBACK', 'RESUME', 'FINALIZE_COMMIT', 'CLEANUP_ONLY'].includes(action.decision) &&
    terminal.has(action.phaseAfter) && cleared;
  return receipt(after, successful ? 'PASS_RECOVERED' : 'BLOCKED', successful ? action.decision : action.decision === 'CONFLICT' ||
    action.decision === 'MANUAL_RECOVERY_REQUIRED' ? action.decision : 'PENDING_AFTER_RECOVERY', entry, action);
}
