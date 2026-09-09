const CRITICAL_LINE = /(?:\bfatal\b|\berror\b|\bpanic\b|\bexception\b|\btraceback\b|\bassertionerror\b|\bassert(?:ion)?\s+failed\b|\bfailed\b|\bfailure\b|\bundefined reference\b|\bnpm\s+err!\b|^\s*(?:not ok|✖|×)\b)/iu;
const WARNING_LINE = /(?:\bwarn(?:ing)?\b|\bnot found\b|\bdenied\b|\btimeout\b|\btime out\b)/iu;

function collapseRuns(lines) {
  const result = [];
  let previous;
  let repeats = 0;
  for (const line of lines) {
    if (line === previous) {
      repeats += 1;
      continue;
    }
    if (repeats > 0) result.push(`[previous line repeated ${repeats} more time${repeats === 1 ? "" : "s"}]`);
    result.push(line);
    previous = line;
    repeats = 0;
  }
  if (repeats > 0) result.push(`[previous line repeated ${repeats} more time${repeats === 1 ? "" : "s"}]`);
  return result;
}

export function compactToolText(text, options = {}) {
  const maxChars = options.maxChars ?? 12000;
  const maxLines = options.maxLines ?? 240;
  const headLines = options.headLines ?? 55;
  const tailLines = options.tailLines ?? 75;
  const diagnosticLines = options.diagnosticLines ?? 80;
  const originalLines = String(text).replace(/\r\n/gu, "\n").split("\n");
  const lines = collapseRuns(originalLines);
  if (text.length <= maxChars && lines.length <= maxLines) {
    return { text: lines.join("\n"), compacted: lines.length !== originalLines.length, originalLines: originalLines.length, outputLines: lines.length };
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const headEnd = Math.min(headLines, lines.length);
  const tailStart = Math.max(headEnd, lines.length - tailLines);
  const critical = [];
  const warnings = [];
  for (let index = headEnd; index < tailStart; index += 1) {
    const line = lines[index];
    if (CRITICAL_LINE.test(line)) critical.push(`[line ${index + 1}] ${line}`);
    else if (WARNING_LINE.test(line) && warnings.length < diagnosticLines) warnings.push(`[line ${index + 1}] ${line}`);
  }

  const kept = [
    ...head,
    `\n[... compacted ${Math.max(0, lines.length - head.length - tail.length)} low-signal lines ...]`,
    ...(critical.length > 0 ? ["\n[all critical diagnostics; never capped]", ...critical] : []),
    ...(warnings.length > 0 ? ["\n[representative warnings]", ...warnings] : []),
    "\n[tail]",
    ...tail,
  ];
  const result = kept.join("\n");
  return {
    text: `${result}\n\n[Pi Overdrive: ${originalLines.length} lines / ${text.length} chars reduced to ${kept.length} lines / ${result.length} chars. Re-run a narrower command for omitted detail.]`,
    compacted: true,
    originalLines: originalLines.length,
    outputLines: kept.length,
    criticalLinesRetained: critical.length,
    warningLinesRetained: warnings.length,
  };
}
