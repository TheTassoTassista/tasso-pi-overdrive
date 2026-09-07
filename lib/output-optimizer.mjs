const ERROR_LINE = /(?:\berror\b|\bfail(?:ed|ure)?\b|\bwarn(?:ing)?\b|\bexception\b|\btraceback\b|\bpanic\b|\bundefined reference\b|\bnot found\b|\bdenied\b|\btimeout\b)/iu;

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
  const diagnostics = [];
  const seen = new Set([...head, ...tail]);
  for (const line of lines) {
    if (diagnostics.length >= diagnosticLines) break;
    if (ERROR_LINE.test(line) && !seen.has(line)) {
      diagnostics.push(line);
      seen.add(line);
    }
  }

  const kept = [
    ...head,
    `\n[... compacted ${Math.max(0, lines.length - head.length - tail.length)} low-signal lines ...]`,
    ...(diagnostics.length > 0 ? ["\n[diagnostic lines]", ...diagnostics] : []),
    "\n[tail]",
    ...tail,
  ];
  const result = kept.join("\n");
  return {
    text: `${result}\n\n[Pi Overdrive: ${originalLines.length} lines / ${text.length} chars reduced to ${kept.length} lines / ${result.length} chars. Re-run a narrower command for omitted detail.]`,
    compacted: true,
    originalLines: originalLines.length,
    outputLines: kept.length,
  };
}
