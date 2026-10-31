import test from 'node:test';
import assert from 'node:assert/strict';
import { phiDoctor } from '../lib/phi-doctor.mjs';

test('Doctor does not report optional services unavailable when probes were skipped', async () => {
  const report = await phiDoctor({ probeServices: false });
  for (const name of ['SearXNG', 'OpenViking', 'Hindsight']) {
    const row = report.checks.find((check) => check.capability === name);
    assert.equal(row?.status, 'NOT VERIFIED', name);
    assert.match(row.detail, /not probed/u);
  }
});
