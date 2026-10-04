// Diagnostic reporter only: preserve Node's TAP and append numeric observations.
// Reporter delivery can be buffered by Node; these are observed completion gaps,
// not proof that a particular test was executing throughout the gap.
import { tap } from 'node:test/reporters';

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
          durationMs: event.data.details?.duration_ms ?? null, failed: event.type === 'test:fail' });
      }
    }
    yield observation('end', { completed });
  }
  yield* tap(observed());
}
