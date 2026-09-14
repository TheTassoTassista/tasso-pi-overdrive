import { createHash } from "node:crypto";
import path from "node:path";
import { parseResourceUri, readVerifiedRepoText, repoResourceUri } from "./resource-fs.mjs";

export const SMART_READ_VERSION = 1;
const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".kts", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".bash", ".ts", ".tsx"]);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_LINES = 20_000;
const DEFAULT_TARGET_CHARS = 6_000;
const MIN_TARGET_CHARS = 2_000;
const MAX_TARGET_CHARS = 12_000;
const MAX_RAW_CHARS = 64 * 1024;
const MAX_RANGE_LINES = 500;
const MIN_SMART_LINES = 160;
const MAX_IMPORT_LINES = 40;
const MAX_DECLARATIONS = MAX_SOURCE_LINES;
const STOP_WORDS = new Set(["about", "after", "before", "change", "code", "file", "from", "implement", "inspect", "into", "large", "read", "source", "that", "the", "this", "with", "without"]);
const SYMBOL_KINDS = Object.freeze({ 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 22: "enum-member", 23: "struct", 26: "type-parameter" });

function fail(code) { throw new Error(code); }

function integer(value, fallback, minimum, maximum, code) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) fail(code);
  return resolved;
}

function linesOf(text) {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function languageFor(relative) {
  const extension = path.extname(relative).toLowerCase();
  const names = { ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".cs": "csharp", ".go": "go", ".h": "c", ".hpp": "cpp", ".java": "java", ".js": "javascript", ".jsx": "javascript", ".kt": "kotlin", ".kts": "kotlin", ".mjs": "javascript", ".php": "php", ".py": "python", ".rb": "ruby", ".rs": "rust", ".sh": "shell", ".bash": "shell", ".ts": "typescript", ".tsx": "typescript" };
  return names[extension] ?? "text";
}

function sourceRelative(value) {
  if (typeof value !== "string" || !value) fail("smart_read_source_required");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) {
    const parsed = parseResourceUri(value);
    if (parsed.scheme !== "repo" || parsed.authority !== "root" || parsed.segments.length === 0) fail("smart_read_repo_uri_required");
    return parsed.segments.join(path.sep);
  }
  repoResourceUri(value);
  return value;
}

function importLine(line, language) {
  const trimmed = line.trim();
  if (["javascript", "typescript"].includes(language)) return /^(?:import\b|export\s+.+\s+from\b|(?:const|let|var)\s+.+?=\s*require\s*\()/u.test(trimmed);
  if (language === "python") return /^(?:from\s+\S+\s+import\b|import\s+)/u.test(trimmed);
  if (["c", "cpp"].includes(language)) return /^#\s*include\b/u.test(trimmed);
  if (language === "go") return /^(?:package\s+\w+|import\b)/u.test(trimmed);
  if (language === "rust") return /^(?:use|mod|extern\s+crate)\b/u.test(trimmed);
  if (["java", "kotlin"].includes(language)) return /^(?:package|import)\b/u.test(trimmed);
  if (language === "php") return /^(?:namespace|use|require|include)(?:_once)?\b/iu.test(trimmed);
  if (language === "shell") return /^(?:source\s+|\.\s+\S+)/u.test(trimmed);
  return false;
}

function declaration(line, language) {
  const clean = line.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().replace(/\s+/gu, " ").slice(0, 320);
  if (!clean || clean.startsWith("//") || clean.startsWith("# ") || clean.startsWith("*")) return null;
  let match;
  if (["javascript", "typescript"].includes(language)) {
    match = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|namespace|function)\s+([A-Za-z_$][\w$]*)/u.exec(clean);
    if (!match) match = /^(?:export\s+)?(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u.exec(clean);
  } else if (language === "python") match = /^(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/u.exec(clean);
  else if (language === "go") match = /^(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^(type)\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/u.exec(clean);
  else if (language === "rust") match = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod|type)\s+([^\s<{(:]+)/u.exec(clean);
  else if (["c", "cpp", "csharp", "java", "kotlin"].includes(language)) {
    match = /^(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|virtual|override|extern|inline|constexpr|template\s*<[^>]+>)\s+)*(class|struct|interface|enum|namespace)\s+([A-Za-z_]\w*)/u.exec(clean);
    if (!match && /\([^;]*\)\s*(?:const\s*)?(?:\{|=>)/u.test(clean) && !/^(?:if|for|while|switch|catch)\b/u.test(clean)) {
      const name = clean.slice(0, clean.indexOf("(")).match(/(?:^|\s|::)([~A-Za-z_]\w*)\s*$/u)?.[1];
      if (name) match = [clean, "function", name];
    }
  } else if (language === "shell") {
    const named = /^(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\))?\s*\{/u.exec(clean);
    if (named) return { kind: "function", name: named[1], signature: clean };
  }
  else if (language === "ruby") match = /^(class|module|def)\s+([^\s(<]+)/u.exec(clean);
  else if (language === "php") match = /^(?:(?:abstract|final|public|protected|private|static)\s+)*(class|interface|trait|enum|function)\s+([A-Za-z_]\w*)/iu.exec(clean);
  if (!match) return null;
  const kind = match[1] ?? match[3] ?? "symbol";
  const name = match[2] ?? match[4] ?? match[3];
  return name ? { kind: String(kind).toLowerCase(), name, signature: clean } : null;
}

function braceEnd(lines, startIndex, fallbackEnd) {
  let depth = 0;
  let seen = false;
  let blockComment = false;
  let quote = "";
  let escaped = false;
  for (let index = startIndex; index < Math.min(lines.length, fallbackEnd); index += 1) {
    const line = lines[index];
    for (let offset = 0; offset < line.length; offset += 1) {
      const current = line[offset];
      const next = line[offset + 1];
      if (blockComment) { if (current === "*" && next === "/") { blockComment = false; offset += 1; } continue; }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (current === "\\") { escaped = true; continue; }
        if (current === quote) quote = "";
        continue;
      }
      if (current === "/" && next === "*") { blockComment = true; offset += 1; continue; }
      if (current === "/" && next === "/") break;
      if (["\"", "'", "`"].includes(current)) { quote = current; continue; }
      if (current === "{") { depth += 1; seen = true; }
      else if (current === "}") depth -= 1;
    }
    if (seen && depth <= 0) return index + 1;
  }
  return fallbackEnd;
}

function lexicalDeclarations(lines, language) {
  const found = [];
  for (const [index, line] of lines.entries()) {
    const entry = declaration(line, language);
    if (entry) found.push({ ...entry, startLine: index + 1, endLine: index + 1, source: "deterministic-parser" });
    if (found.length >= MAX_DECLARATIONS) break;
  }
  for (const [index, entry] of found.entries()) {
    const boundary = index + 1 < found.length ? found[index + 1].startLine - 1 : lines.length;
    if (["python", "ruby"].includes(language)) entry.endLine = Math.max(entry.startLine, boundary);
    else entry.endLine = braceEnd(lines, entry.startLine - 1, Math.max(entry.startLine, boundary));
  }
  return found;
}

function lspDeclarations(entries, lexical, lines) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, MAX_DECLARATIONS).flatMap((entry) => {
    const name = typeof entry?.name === "string" ? entry.name.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 160) : "";
    const startLine = entry?.location?.start?.line;
    if (!name || !Number.isSafeInteger(startLine) || startLine < 1 || startLine > lines.length) return [];
    const matching = lexical.find((candidate) => candidate.name === name && Math.abs(candidate.startLine - startLine) <= 2);
    return [{ kind: SYMBOL_KINDS[entry.kind] ?? "symbol", name, signature: matching?.signature ?? lines[startLine - 1].trim().slice(0, 320), startLine, endLine: matching?.endLine ?? startLine, source: "lsp" }];
  });
}

function focusTokens(value) {
  return [...new Set(String(value ?? "").toLocaleLowerCase("en-US").match(/[\p{L}_$][\p{L}\p{N}_$]*(?:[.-][\p{L}\p{N}_$]+)*/gu) ?? [])].filter((token) => token.length >= 3 && !STOP_WORDS.has(token)).slice(0, 64);
}

function rankDeclarations(entries, focus) {
  const tokens = focusTokens(focus);
  return entries.map((entry, index) => ({
    ...entry,
    score: tokens.reduce((total, token) => total + (`${entry.name} ${entry.signature}`.toLocaleLowerCase("en-US").includes(token) ? 10 : 0), 0) + (index < 20 ? 2 : 0),
  })).sort((left, right) => right.score - left.score || left.startLine - right.startLine);
}

function rangeResult(lines, offsetLine, limitLines) {
  const offset = integer(offsetLine, 1, 1, Math.max(1, lines.length), "smart_read_range_offset_invalid");
  const limit = integer(limitLines, 200, 1, MAX_RANGE_LINES, "smart_read_range_limit_invalid");
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const end = offset + selected.length - 1;
  const before = offset - 1;
  const after = Math.max(0, lines.length - end);
  return {
    content: [
      ...(before ? [`[${before} lines omitted before; reopen 1-${offset - 1} if needed]`] : []),
      ...selected.map((line, index) => `${offset + index}|${line}`),
      ...(after ? [`[${after} lines omitted after; reopen ${end + 1}-${Math.min(lines.length, end + limit)} if needed]`] : []),
    ].join("\n"),
    truncated: before > 0 || after > 0,
    range: { start: offset, end },
  };
}

function rawResult(text) {
  const content = text.slice(0, MAX_RAW_CHARS);
  return { content: content.length < text.length ? `${content}\n[${text.length - content.length} characters omitted; use range mode]` : content, truncated: content.length < text.length };
}

function fallbackOutline(lines) {
  const head = lines.slice(0, 40).map((line, index) => ({ line: index + 1, text: line }));
  const tailStart = Math.max(head.length, lines.length - 20);
  const tail = lines.slice(tailStart).map((line, index) => ({ line: tailStart + index + 1, text: line }));
  return [...head, ...tail];
}

function smartResult({ lines, imports, declarations, uri, language, targetChars }) {
  const sections = [`Resource: ${uri}`, `Structure: language=${language}; lines=${lines.length}; imports/includes=${imports.length}; declarations/symbols=${declarations.length}`];
  const omittedFooter = () => `[${Math.max(0, lines.length - visibleLines.size)} source lines omitted from structural view; use smart_read mode=range with an exact suggested range]`;
  const fits = (rows, reserve = 0) => [...sections, ...rows, omittedFooter()].join("\n").length + reserve <= targetChars;
  const visibleLines = new Set();
  const importRows = [];
  for (const entry of imports) {
    const row = `${entry.line}|${entry.text}`;
    if (!fits([...(importRows.length ? ["", "Imports/includes:"] : ["", "Imports/includes:"]), ...importRows, row], 600)) break;
    importRows.push(row);
    visibleLines.add(entry.line);
  }
  if (importRows.length) sections.push("", "Imports/includes:", ...importRows);
  const ranked = declarations;
  const selected = [];
  for (const entry of ranked) {
    const row = `- ${entry.kind} ${entry.name} lines ${entry.startLine}-${entry.endLine}: ${entry.signature}`;
    const candidateRows = ["", "Major declarations/symbols:", ...selected.map((value) => value.row), row];
    if (!fits(candidateRows, 500) || selected.length >= 80) continue;
    selected.push({ ...entry, row });
    visibleLines.add(entry.startLine);
  }
  if (selected.length) sections.push("", "Major declarations/symbols:", ...selected.sort((left, right) => left.startLine - right.startLine).map((entry) => entry.row));
  else {
    const fallbackRows = [];
    for (const entry of fallbackOutline(lines)) {
      const row = `${entry.line}|${entry.text.slice(0, 320)}`;
      if (!fits(["", "Deterministic line fallback:", ...fallbackRows, row], 180)) break;
      fallbackRows.push(row);
      visibleLines.add(entry.line);
    }
    sections.push("", "Deterministic line fallback:", ...fallbackRows);
  }
  const suggestions = selected.slice().sort((left, right) => right.score - left.score || left.startLine - right.startLine).slice(0, 8);
  const suggestionRows = [];
  for (const entry of suggestions) {
    const row = `- ${entry.startLine}-${Math.min(lines.length, Math.max(entry.startLine + 20, entry.endLine))} (${entry.name})`;
    if (!fits(["", "Suggested exact ranges:", ...suggestionRows, row], 0)) break;
    suggestionRows.push(row);
  }
  if (suggestionRows.length) sections.push("", "Suggested exact ranges:", ...suggestionRows);
  sections.push("", omittedFooter());
  const content = sections.join("\n");
  return { content, truncated: true, selectedDeclarations: selected.length, suggestedRanges: suggestions.slice(0, suggestionRows.length).map((entry) => ({ start: entry.startLine, end: Math.min(lines.length, Math.max(entry.startLine + 20, entry.endLine)), name: entry.name })) };
}

export async function smartReadRepo(input = {}) {
  const relative = sourceRelative(input.source);
  const loaded = readVerifiedRepoText(input.cwd, relative, { maxBytes: MAX_SOURCE_BYTES });
  const lines = linesOf(loaded.text);
  if (lines.length > MAX_SOURCE_LINES) fail("smart_read_source_too_many_lines");
  const language = languageFor(relative);
  const source = SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase());
  const targetChars = integer(input.targetChars, DEFAULT_TARGET_CHARS, MIN_TARGET_CHARS, MAX_TARGET_CHARS, "smart_read_target_invalid");
  const requestedMode = input.mode ?? "auto";
  if (!["auto", "raw", "smart", "range"].includes(requestedMode)) fail("smart_read_mode_invalid");
  const selectedMode = requestedMode === "range" || input.offsetLine !== undefined || input.limitLines !== undefined
    ? "range"
    : requestedMode === "auto"
      ? source && (lines.length >= MIN_SMART_LINES || loaded.text.length > targetChars) ? "smart" : "raw"
      : requestedMode;
  let body;
  let parser = "raw";
  let lspStatus = "SKIPPED";
  let declarationCount = 0;
  let importCount = 0;
  let suggestedRanges = [];
  if (selectedMode === "range") body = rangeResult(lines, input.offsetLine, input.limitLines);
  else if (selectedMode === "raw") body = rawResult(loaded.text);
  else {
    const imports = lines.map((text, index) => ({ line: index + 1, text: text.trim().slice(0, 320) })).filter((entry) => importLine(entry.text, language)).slice(0, MAX_IMPORT_LINES);
    const lexical = lexicalDeclarations(lines, language);
    let lsp = [];
    if (typeof input.symbolProvider === "function" && source) {
      try {
        const result = await input.symbolProvider(relative);
        lspStatus = result?.status === "PASS" ? "PASS" : result?.status === "PARTIAL" ? "PARTIAL" : "FAIL";
        lsp = result?.status === "PASS" ? lspDeclarations(result.entries, lexical, lines) : [];
      } catch { lspStatus = "FAIL"; }
    }
    const declarations = lsp.length ? [...lsp, ...lexical.filter((entry) => !lsp.some((candidate) => candidate.name === entry.name && Math.abs(candidate.startLine - entry.startLine) <= 2))] : lexical;
    const ranked = rankDeclarations(declarations, `${input.taskContext ?? ""} ${input.focus ?? ""}`);
    body = smartResult({ lines, imports, declarations: ranked, uri: loaded.uri, language, targetChars });
    parser = lsp.length ? "lsp+deterministic-parser" : lexical.length ? "deterministic-parser" : "line-fallback";
    declarationCount = declarations.length;
    importCount = imports.length;
    suggestedRanges = body.suggestedRanges;
  }
  const outputChars = body.content.length;
  return Object.freeze({
    version: SMART_READ_VERSION,
    kind: "SMART_READ_RESULT",
    uri: loaded.uri,
    uriDigest: createHash("sha256").update(loaded.uri).digest("hex"),
    contentDigest: createHash("sha256").update(loaded.text).digest("hex"),
    language,
    sourceBytes: loaded.bytes,
    totalLines: lines.length,
    requestedMode,
    selectedMode,
    parser,
    lspStatus,
    targetChars,
    sourceChars: loaded.text.length,
    outputChars,
    reductionPercent: loaded.text.length ? Number((Math.max(0, 1 - outputChars / loaded.text.length) * 100).toFixed(2)) : 0,
    declarationCount,
    importCount,
    truncated: body.truncated,
    range: body.range ?? null,
    suggestedRanges,
    immutable: true,
    trust: "WORKSPACE_UNTRUSTED",
    untrustedData: true,
    content: body.content,
  });
}

export function smartReadMetadata(result) {
  if (!result || result.kind !== "SMART_READ_RESULT") fail("smart_read_metadata_invalid");
  return Object.freeze({ kind: "smart_read", version: result.version, selectedMode: result.selectedMode, parser: result.parser, lspStatus: result.lspStatus, language: result.language, sourceBytes: result.sourceBytes, totalLines: result.totalLines, sourceChars: result.sourceChars, outputChars: result.outputChars, reductionPercent: result.reductionPercent, declarationCount: result.declarationCount, importCount: result.importCount, truncated: result.truncated, uriDigest: result.uriDigest, contentDigest: result.contentDigest, immutable: result.immutable, trust: result.trust });
}
