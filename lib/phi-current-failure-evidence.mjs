// Parse only fixed diagnostic tokens from selected native tests. Raw TAP stays private.
const stages = new Set([
  'SETUP', 'GIT_BASELINE', 'WORKER_EDIT', 'WORKER_LSP', 'WORKER_VERIFY',
  'WORKER_REVOKE', 'CONTROLLER_READY', 'NATIVE_PUBLISH', 'POSTVERIFY',
  'USER_CONFLICT', 'REPLAY_DENIAL', 'RECOVERY_CHECK', 'CLEANUP',
  'WAIT_CHILD_TREE', 'CANCEL_BROKER', 'BROKER_RESULT', 'CHILD_GONE',
  'LSP_TIMEOUT', 'LSP_CRASH', 'LSP_BROKER_DEATH',
  'LSP_TIMEOUT_RESULT', 'LSP_CRASH_RESULT', 'LSP_BROKER_RESULT',
]);
const clusters = new Set(['PUBLICATION', 'BROKER_DELETION', 'LSP_TIMEOUT']);
const categories = new Set(['ASSERTION', 'TEST_FAILURE', 'EXCEPTION']);
const factNames = new Set(['workerEditExit', 'workerEditError', 'brokerExit', 'lspExit',
  'targetObserved', 'scopeObserved', 'childCount', 'jobEmptyVerified', 'cleanupPass']);

export const validCurrentFailureStage = value => stages.has(value);
export const validCurrentFailureCluster = value => clusters.has(value);
export function validCurrentFailureFact(key, value) {
  return factNames.has(key) && (key === 'workerEditError' ?
    ['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'OTHER'].includes(value) : key === 'childCount' ?
      Number.isSafeInteger(value) && value >= 0 && value <= 2 : key.endsWith('Exit') ?
        Number.isSafeInteger(value) && value >= 0 && value <= 255 : typeof value === 'boolean');
}

function validFacts(facts) {
  return facts && typeof facts === 'object' && !Array.isArray(facts) && Object.keys(facts).length <= 9 &&
    Object.entries(facts).every(([key, value]) => validCurrentFailureFact(key, value));
}

export function currentFailureStageEvidence(output, testId, expectedCluster, failed) {
  const incomplete = { status: 'DIAGNOSTIC_INCOMPLETE', stage: null, category: null, facts: null };
  if (typeof output !== 'string' || !/^[0-9a-f]{64}$/u.test(testId) || !clusters.has(expectedCluster)) return incomplete;
  const markers = output.split(/\r?\n/u).filter(line => /^# PHI_CURRENT_FAILURE /u.test(line));
  if (!failed) return markers.length === 0 ? { status: 'NONE', stage: null, category: null, facts: null } : incomplete;
  if (markers.length !== 1) return incomplete;
  let value;
  try { value = JSON.parse(markers[0].slice('# PHI_CURRENT_FAILURE '.length)); } catch { return incomplete; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5 ||
    value.testId !== testId || value.cluster !== expectedCluster || !stages.has(value.stage) ||
    !categories.has(value.category) || !validFacts(value.facts)) return incomplete;
  return { status: 'COMPLETE', stage: value.stage, category: value.category, facts: value.facts };
}
