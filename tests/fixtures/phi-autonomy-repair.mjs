// Deterministic offline model seam for the E1 fixture. It derives a minimal
// change from observed source and assertions; neither the task nor this file
// carries a preselected replacement. Fail closed outside this tiny grammar.
export function inferOperatorRepair(sourceRead, testRead) {
  if (typeof sourceRead !== 'string' || typeof testRead !== 'string') throw new Error('PHI_E1_SOURCE_EVIDENCE_INVALID');
  const source = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+\2\s*([+*/-])\s*\3\s*;?\s*\}/u.exec(sourceRead);
  if (!source) throw new Error('PHI_E1_SOURCE_EVIDENCE_INVALID');
  const [, name, left, right, current] = source;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const assertions = [...testRead.matchAll(new RegExp(`assert\\.(?:equal|strictEqual)\\s*\\(\\s*${escaped}\\s*\\(\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\)\\s*,\\s*(-?\\d+)\\s*\\)`, 'gu'))]
    .map((row) => row.slice(1).map(Number));
  if (assertions.length < 2 || assertions.some((row) => row.some((value) => !Number.isSafeInteger(value)))) throw new Error('PHI_E1_TEST_EVIDENCE_INVALID');
  const evaluate = (operation, a, b) => ({ '+': a + b, '-': a - b, '*': a * b, '/': b === 0 ? NaN : a / b })[operation];
  const candidates = ['+', '-', '*', '/'].filter((operation) => assertions.every(([a, b, expected]) => evaluate(operation, a, b) === expected));
  if (candidates.length !== 1 || candidates[0] === current || assertions.every(([a, b, expected]) => evaluate(current, a, b) === expected))
    throw new Error('PHI_E1_REPAIR_AMBIGUOUS');
  return Object.freeze({ oldText: `return ${left} ${current} ${right};`, newText: `return ${left} ${candidates[0]} ${right};`,
    assertionCount: assertions.length, operation: candidates[0] });
}
