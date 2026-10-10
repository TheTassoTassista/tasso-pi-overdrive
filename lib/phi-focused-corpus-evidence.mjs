// The expected scope is fixed before the owned command runs. Never derive it
// from observed TAP or reporter output, especially with --test-name-pattern.
export function focusedCorpusEvidence(output, counts, ledger, { expectedTests, selectedIds = null }) {
  const fail = reason => ({ status: 'FAIL', reason, expectedTests });
  if (!Number.isSafeInteger(expectedTests) || expectedTests < 1 || expectedTests > 500 ||
    selectedIds !== null && (!Array.isArray(selectedIds) || selectedIds.length !== expectedTests ||
      new Set(selectedIds).size !== expectedTests || selectedIds.some(id => !/^[0-9a-f]{64}$/u.test(id))))
    return fail('EXPECTED_SCOPE_INVALID');
  if (!counts || !['tests', 'pass', 'fail', 'skipped'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
    counts.tests !== expectedTests || counts.tests !== counts.pass + counts.fail + counts.skipped)
    return fail('AGGREGATE_MISMATCH');
  const footers = ['tests', 'pass', 'fail', 'skipped'].map(key => [...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gmu'))]);
  if (footers.some(rows => rows.length !== 1)) return fail('FOOTER_INCOMPLETE');
  if (ledger?.expected !== counts.fail || ledger?.observed !== counts.fail ||
    (counts.fail === 0 ? ledger.status !== 'NONE' || ledger.entries.length !== 0 :
      ledger.status !== 'COMPLETE' || ledger.entries.length !== counts.fail))
    return fail('FAILURE_LEDGER_INCOMPLETE');
  const rows = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith('# PHI_RUNTIME ')) continue;
    let row;
    try { row = JSON.parse(line.slice(14)); } catch { return fail('REPORTER_INVALID'); }
    if (!['start', 'completion', 'end'].includes(row?.kind)) return fail('REPORTER_INVALID');
    rows.push(row);
  }
  if (rows.length !== expectedTests + 2 || rows[0]?.kind !== 'start' || rows.at(-1)?.kind !== 'end' ||
    rows.at(-1).completed !== expectedTests) return fail('REPORTER_INCOMPLETE');
  const completions = rows.slice(1, -1);
  if (completions.some((row, index) => row.kind !== 'completion' || row.ordinal !== index + 1 ||
    row.completed !== index + 1 || typeof row.failed !== 'boolean' ||
    !/^[0-9a-f]{64}$/u.test(row.identity?.testId) ||
    !/^tests\/phi-[^/]+\.test\.mjs$/u.test(row.identity?.sourceFile))) return fail('REPORTER_INVALID');
  const observedIds = completions.map(row => row.identity.testId);
  if (new Set(observedIds).size !== expectedTests) return fail('DUPLICATE_RESULT');
  if (selectedIds !== null && (counts.skipped !== 0 ||
    observedIds.some(id => !selectedIds.includes(id)))) return fail('SELECTED_SCOPE_MISMATCH');
  const tap = [...output.matchAll(/^(?:ok|not ok) (\d+)(?=\s|$)/gmu)].map(match => Number(match[1]));
  if (tap.length !== expectedTests || tap.some((ordinal, index) => ordinal !== index + 1))
    return fail('TAP_INCOMPLETE');
  const failures = completions.filter(row => row.failed);
  if (failures.length !== counts.fail || ledger.entries.some(entry => !failures.some(row =>
    row.ordinal === entry.ordinal && row.identity.testId === entry.testId &&
    row.identity.sourceFile === entry.sourceFile))) return fail('FAILURE_LEDGER_MISMATCH');
  return { status: 'PASS', reason: 'EXACT_SCOPE', expectedTests };
}
