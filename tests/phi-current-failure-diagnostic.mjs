// Fixed, test-owned failure-stage metadata for bounded native diagnosis.
// No assertion text, path, stderr, fixture content or environment is emitted.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validCurrentFailureCluster, validCurrentFailureFact, validCurrentFailureStage } from '../lib/phi-current-failure-evidence.mjs';

export function failureStage(error, stage) {
  if (error && typeof error === 'object' && validCurrentFailureStage(stage)) error.phiFailureStage = stage;
  return error;
}

export function diagnosticNativeBody(name, cluster, sourceUrl, body) {
  if (!validCurrentFailureCluster(cluster) || typeof name !== 'string' || typeof body !== 'function') throw new Error('PHI_DIAGNOSTIC_USAGE');
  const relative = path.relative(process.cwd(), fileURLToPath(sourceUrl)).replaceAll('\\', '/');
  if (!/^tests\/phi-[^/]+\.test\.mjs$/u.test(relative)) throw new Error('PHI_DIAGNOSTIC_SOURCE');
  const testId = createHash('sha256').update('PHI_TEST_ID_V1\0').update(relative).update('\0').update(name).digest('hex');
  return async () => {
    let stage = 'SETUP';
    const facts = {};
    const mark = next => {
      if (!validCurrentFailureStage(next)) throw new Error('PHI_DIAGNOSTIC_STAGE');
      stage = next;
    };
    const note = (key, value) => {
      if (!validCurrentFailureFact(key, value)) throw new Error('PHI_DIAGNOSTIC_FACT');
      facts[key] = value;
    };
    try { await body(mark, note); }
    catch (error) {
      const observed = validCurrentFailureStage(error?.phiFailureStage) ? error.phiFailureStage : stage;
      const category = error?.code === 'ERR_ASSERTION' ? 'ASSERTION' :
        error?.code === 'ERR_TEST_FAILURE' ? 'TEST_FAILURE' : 'EXCEPTION';
      console.log(`PHI_CURRENT_FAILURE ${JSON.stringify({ testId, cluster, stage: observed, category, facts })}`);
      throw error;
    }
  };
}
