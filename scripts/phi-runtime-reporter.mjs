// Owned validation reporter: preserve Node's TAP and append numeric observations
// plus hashed, allowlisted failure metadata. The controller never publishes raw TAP.
// Reporter delivery can be buffered by Node; these are observed completion gaps,
// not proof that a particular test was executing throughout the gap.
import { tap } from 'node:test/reporters';
import { createHash } from 'node:crypto';
import path from 'node:path';

function boundedIdentity(event) {
  const name = event.data?.name;
  const file = event.data?.file;
  if (typeof name !== 'string' || name.length === 0 || name.length > 4096 ||
    typeof file !== 'string' || file.length === 0 || file.length > 4096) return null;
  const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
  if (!/^tests\/phi-[^/]+\.test\.mjs$/u.test(relative)) return null;
  const testId = createHash('sha256').update('PHI_TEST_ID_V1\0').update(relative).update('\0').update(name).digest('hex');
  return { testId, sourceFile: relative };
}

function boundedFailure(event) {
  const identity = boundedIdentity(event);
  if (!identity) return null;
  const error = event.data?.details?.error;
  const failureType = error?.failureType;
  const category = failureType === 'testCodeFailure' ? 'TEST_CODE_FAILURE' :
    failureType === 'subtestsFailed' ? 'SUBTEST_FAILURE' :
    failureType === 'cancelledByParent' ? 'CANCELLED_BY_PARENT' :
    failureType === 'testTimeoutFailure' ? 'TEST_TIMEOUT' : 'TEST_FAILURE_UNKNOWN';
  const assertionCategory = error?.code === 'ERR_ASSERTION' || error?.cause?.code === 'ERR_ASSERTION' ?
    'ASSERTION' : 'UNKNOWN';
  return { ...identity, category, assertionCategory };
}

export default async function* runtimeReporter(source) {
  const started = performance.now();
  let completed = 0;
  const observation = (kind, extra = {}) => ({ type: 'test:diagnostic', data: {
    nesting: 0, message: `PHI_RUNTIME ${JSON.stringify({ kind, elapsedMs: Math.round(performance.now() - started), utc: new Date().toISOString(), ...extra })}`,
  } });
  async function* observed() {
    yield observation('start');
    for await (const event of source) {
      yield event;
      if (event.data?.nesting === 0 && ['test:pass', 'test:fail'].includes(event.type)) {
        completed++;
        yield observation('completion', { ordinal: event.data.testNumber, completed,
          durationMs: event.data.details?.duration_ms ?? null, failed: event.type === 'test:fail',
          identity: boundedIdentity(event),
          ...(event.type === 'test:fail' ? { failure: boundedFailure(event) } : {}) });
      }
    }
    yield observation('end', { completed });
  }
  yield* tap(observed());
}
