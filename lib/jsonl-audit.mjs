export function parseJsonlRecords(text) {
  const source = String(text);
  const lines = source.split("\n");
  const records = [];
  const errors = [];
  let truncatedTail = false;
  const lastNonEmpty = lines.findLastIndex((line) => line.trim() !== "");
  for (let index = 0; index <= lastNonEmpty; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch {
      const isUnterminatedTail = index === lastNonEmpty && !source.endsWith("\n");
      if (isUnterminatedTail) truncatedTail = true;
      else errors.push({ line: index + 1, reason: "malformed-complete-record" });
    }
  }
  return { records, errors, truncatedTail };
}
