import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectWorkspacePath, isInside } from "./safety.mjs";

const require = createRequire(import.meta.url);
const defaultTypescript = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "runtime", "lsp", "node_modules", "typescript", "lib", "typescript.js");

function loadTypescript() {
  const modulePath = process.env.PI_OVERDRIVE_TYPESCRIPT ?? defaultTypescript;
  if (!fs.existsSync(modulePath)) throw new Error(`pinned TypeScript runtime not found: ${modulePath}`);
  return require(modulePath);
}

function findConfig(root, file) {
  let directory = path.dirname(file);
  while (isInside(root, directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  return undefined;
}

function gatherSourceFiles(root, limit = 5000) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || [".git", "node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) result.push(candidate);
      if (result.length > limit) throw new Error(`source file limit exceeded (${limit})`);
    }
  }
  return result;
}

function project(rootCandidate, fileCandidate, options = {}) {
  const root = fs.realpathSync(rootCandidate);
  const inspected = inspectWorkspacePath(root, fileCandidate, { mustExist: true });
  if (!inspected.allowed || !inspected.stat?.isFile()) throw new Error(`source file denied: ${inspected.reason ?? "not a file"}`);
  if (!/\.[cm]?[jt]sx?$/u.test(inspected.canonical)) throw new Error("semantic TypeScript navigation supports JS/JSX/TS/TSX files only");
  const ts = loadTypescript();
  const overrides = new Map();
  if (typeof options.contentOverride === "string") overrides.set(inspected.canonical, options.contentOverride);
  const configPath = findConfig(root, inspected.canonical);
  let fileNames;
  let compilerOptions;
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    if (parsed.errors.length > 0) throw new Error(parsed.errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
    fileNames = parsed.fileNames.filter((name) => {
      try { return isInside(root, fs.realpathSync(name)); } catch { return false; }
    });
    compilerOptions = parsed.options;
  } else {
    fileNames = gatherSourceFiles(root);
    compilerOptions = { allowJs: true, checkJs: options.defaultCheckJs !== false, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2023 };
  }
  if (!fileNames.includes(inspected.canonical)) fileNames.push(inspected.canonical);
  const typescriptLib = fs.realpathSync(path.dirname(ts.getDefaultLibFilePath(compilerOptions)));
  const allowedCompilerPath = (name) => {
    try {
      const canonical = fs.realpathSync(name);
      return isInside(root, canonical) || isInside(typescriptLib, canonical);
    } catch { return false; }
  };
  const host = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => fileNames,
    getScriptVersion: (name) => overrides.has(name) ? "1" : "0",
    getScriptSnapshot: (name) => {
      if (!allowedCompilerPath(name)) return undefined;
      return ts.ScriptSnapshot.fromString(overrides.get(name) ?? fs.readFileSync(name, "utf8"));
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (name) => allowedCompilerPath(name) && ts.sys.fileExists(name),
    readFile: (name) => allowedCompilerPath(name) ? ts.sys.readFile(name) : undefined,
    readDirectory: (directory, ...args) => allowedCompilerPath(directory) ? ts.sys.readDirectory(directory, ...args) : [],
    directoryExists: (directory) => allowedCompilerPath(directory) && (ts.sys.directoryExists?.(directory) ?? false),
    getDirectories: (directory) => allowedCompilerPath(directory) ? ts.sys.getDirectories(directory) : [],
  };
  return { ts, root, file: inspected.canonical, overrides, service: ts.createLanguageService(host, ts.createDocumentRegistry()) };
}

function offsetFor(ts, file, line, character) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  if (line < 1 || character < 1 || line > source.getLineAndCharacterOfPosition(source.end).line + 1) throw new Error("line/character is outside the source file");
  return source.getPositionOfLineAndCharacter(line - 1, character - 1);
}

function location(ts, root, fileName, textSpan, overrides = new Map()) {
  const source = ts.createSourceFile(fileName, overrides.get(fileName) ?? fs.readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true);
  const start = source.getLineAndCharacterOfPosition(textSpan.start);
  const end = source.getLineAndCharacterOfPosition(textSpan.start + textSpan.length);
  return {
    file: isInside(root, fileName) ? path.relative(root, fileName) : fileName,
    line: start.line + 1,
    character: start.character + 1,
    endLine: end.line + 1,
    endCharacter: end.character + 1,
  };
}

export function typescriptDefinition(root, file, line, character) {
  const context = project(root, file);
  const definitions = context.service.getDefinitionAtPosition(context.file, offsetFor(context.ts, context.file, line, character)) ?? [];
  return definitions.map((entry) => ({ name: entry.name, kind: entry.kind, ...location(context.ts, context.root, entry.fileName, entry.textSpan) }));
}

export function typescriptReferences(root, file, line, character) {
  const context = project(root, file);
  const groups = context.service.findReferences(context.file, offsetFor(context.ts, context.file, line, character)) ?? [];
  return groups.flatMap((group) => group.references.map((entry) => ({ definition: group.definition.name, isDefinition: entry.isDefinition, isWriteAccess: entry.isWriteAccess, ...location(context.ts, context.root, entry.fileName, entry.textSpan) })));
}

export function typescriptDiagnostics(root, file, contentOverride, options = {}) {
  const context = project(root, file, { contentOverride, defaultCheckJs: options.defaultCheckJs });
  const diagnostics = [...context.service.getSyntacticDiagnostics(context.file), ...context.service.getSemanticDiagnostics(context.file)];
  return diagnostics.map((entry) => {
    const start = typeof entry.start === "number" ? location(context.ts, context.root, entry.file?.fileName ?? context.file, { start: entry.start, length: entry.length ?? 0 }, context.overrides) : undefined;
    return { code: entry.code, category: context.ts.DiagnosticCategory[entry.category], message: context.ts.flattenDiagnosticMessageText(entry.messageText, "\n"), ...start };
  });
}
