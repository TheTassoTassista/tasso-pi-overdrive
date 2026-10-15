import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectWorkspacePath, isInside } from "./safety.mjs";
import { typescriptDefinition, typescriptDiagnostics } from "./typescript-navigation.mjs";
import { requireCodingBackend, sandboxInvocation, executeCodingLsp } from "../platform/shared/coding-execution.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function lspRuntimeRoot(environment = process.env) {
  return path.resolve(environment.PI_OVERDRIVE_LSP_RUNTIME ?? path.join(packageRoot, "runtime", "lsp"));
}
const runtimeRoot = lspRuntimeRoot();
// The E4 image carries a fixed marker and the official LLVM binary under /usr,
// which the existing LSP sandbox already mounts read-only. Ordinary host Pi
// retains its previously pinned system path and never selects by PATH order.
const clangdSystemPath = fs.existsSync("/opt/phi/config/e4-llvm-toolchain.json")
  ? "/usr/local/lib/phi/llvm/22.1.8/bin/clangd"
  : "/usr/bin/clangd";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SERVERS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const DIAGNOSTIC_WAIT_MS = 4_000;
const IDLE_SHUTDOWN_MS = 5 * 60_000;

const SERVER_REGISTRY = Object.freeze({
  typescript: { version: "@vtsls/language-server@0.3.0", bin: "vtsls", source: "runtime/lsp/package-lock.json", args: ["--stdio"], extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], language: (ext) => [".js", ".jsx", ".mjs", ".cjs"].includes(ext) ? "javascript" : "typescript", markers: ["tsconfig.json", "jsconfig.json", "package.json"] },
  python: { version: "pyright@1.1.410", bin: "pyright-langserver", source: "runtime/lsp/package-lock.json", args: ["--stdio"], extensions: [".py", ".pyi"], language: () => "python", markers: ["pyproject.toml", "pyrightconfig.json", "setup.cfg", "setup.py"] },
  clangd: { version: "clangd@22.1.8", system: clangdSystemPath, source: "explicit clangd 22.1.8 binary path", args: ["--background-index=false", "--clang-tidy=false"], extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], language: (ext) => [".c", ".h"].includes(ext) ? "c" : "cpp", markers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "meson.build"] },
  html: { version: "vscode-langservers-extracted@4.10.0", bin: "vscode-html-language-server", source: "runtime/lsp/package-lock.json", args: ["--stdio"], extensions: [".html", ".htm"], language: () => "html", markers: ["package.json"] },
  css: { version: "vscode-langservers-extracted@4.10.0", bin: "vscode-css-language-server", source: "runtime/lsp/package-lock.json", args: ["--stdio"], extensions: [".css", ".scss", ".less"], language: (ext) => ext.slice(1), markers: ["package.json"] },
  json: { version: "vscode-langservers-extracted@4.10.0", bin: "vscode-json-language-server", source: "runtime/lsp/package-lock.json", args: ["--stdio"], extensions: [".json", ".jsonc"], language: (ext) => ext === ".jsonc" ? "jsonc" : "json", markers: ["package.json"] },
  yaml: { version: "yaml-language-server@1.23.0", bin: "yaml-language-server", source: "runtime/lsp/package-lock.json", args: ["--stdio"], extensions: [".yaml", ".yml"], language: () => "yaml", markers: [".yamllint", "package.json"] },
  bash: {
    version: "bash-language-server@5.6.0", bin: "bash-language-server", source: "runtime/lsp/package-lock.json", args: ["start"],
    extensions: [".sh", ".bash"], language: () => "shellscript", markers: [".shellcheckrc"],
    configuration: { enableSourceErrorDiagnostics: true, shellcheckPath: "", shfmt: { path: "" } },
  },
  rust: { version: "rust-analyzer@0.3.3041-standalone", managedBin: "managed/bin/rust-analyzer", source: "rust-lang/rust-analyzer release 2026-09-07; config/managed-lsp.json", args: [], extensions: [".rs"], language: () => "rust", markers: ["Cargo.toml"] },
  go: { version: "gopls@v0.23.0", managedBin: "managed/bin/gopls", source: "proxy.golang.org + sum.golang.org; config/managed-lsp.json", args: [], extensions: [".go"], language: () => "go", markers: ["go.work", "go.mod"] },
  java: { version: "jdtls (not installed)", pathCommand: "jdtls", extensions: [".java"], language: () => "java", markers: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  lua: { version: "lua-language-server (not installed)", pathCommand: "lua-language-server", extensions: [".lua"], language: () => "lua", markers: [".luarc.json", ".luarc.jsonc"] },
  ruby: { version: "ruby-lsp (not installed)", pathCommand: "ruby-lsp", extensions: [".rb", ".rake"], language: () => "ruby", markers: ["Gemfile", ".ruby-version"] },
});

function commandExists(command) {
  const search = (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter);
  return search.some((directory) => {
    try { fs.accessSync(path.join(directory, command), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function serverPolicy(id, server) {
  const binaryPath = server.bin
    ? path.join(runtimeRoot, "node_modules", ".bin", server.bin)
    : server.managedBin
      ? path.join(runtimeRoot, server.managedBin)
      : server.system ?? (commandExists(server.pathCommand) ? server.pathCommand : null);
  const installed = typeof binaryPath === "string" && (path.isAbsolute(binaryPath) ? fs.existsSync(binaryPath) : commandExists(binaryPath));
  const pinned = Boolean(server.bin || server.managedBin || server.system);
  return Object.freeze({
    language: id,
    server: server.bin ?? server.managedBin?.split("/").at(-1) ?? server.system?.split("/").at(-1) ?? server.pathCommand,
    version: server.version,
    binaryPath,
    source: server.source ?? "untracked PATH",
    installed,
    pinned,
    allowed: installed && pinned,
    runtimeStatus: installed ? (pinned ? "READY" : "REJECTED_UNPINNED") : "MISSING",
  });
}

function backendForFile(file) {
  const ext = path.extname(file).toLowerCase();
  return Object.entries(SERVER_REGISTRY).find(([, entry]) => entry.extensions.includes(ext));
}

function findProjectRoot(workspace, file, markers) {
  let current = path.dirname(file);
  while (isInside(workspace, current)) {
    if (markers.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
    if (current === workspace) break;
    current = path.dirname(current);
  }
  return workspace;
}

function resolveContext(cwd, fileCandidate) {
  const workspace = fs.realpathSync(cwd);
  const inspected = inspectWorkspacePath(workspace, fileCandidate, { mustExist: true });
  if (!inspected.allowed || !inspected.stat?.isFile()) throw new Error(`source_file_denied:${inspected.reason ?? "not_a_file"}`);
  if (inspected.stat.size > MAX_FILE_BYTES) throw new Error("source_file_too_large");
  const selected = backendForFile(inspected.canonical);
  if (!selected) throw new Error("unsupported_language");
  const [serverId, server] = selected;
  const projectRoot = fs.realpathSync(findProjectRoot(workspace, inspected.canonical, server.markers));
  if (!isInside(workspace, projectRoot)) throw new Error("project_root_escape");
  return { workspace, file: inspected.canonical, projectRoot, serverId, server, languageId: server.language(path.extname(inspected.canonical).toLowerCase()) };
}

function sanitizeMessage(value) {
  return String(value ?? "").replace(/[\r\n\t]+/gu, " ").slice(0, 1000);
}

function relativePath(projectRoot, uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return "external";
  let local;
  try { local = fileURLToPath(uri); } catch { return "invalid-uri"; }
  if (local === "/workspace") return ".";
  if (local.startsWith("/workspace/")) return local.slice("/workspace/".length);
  if (isInside(projectRoot, local)) return path.relative(projectRoot, local);
  return `external/${path.basename(local)}`;
}

function position(value) {
  return { line: Number(value?.line ?? 0) + 1, character: Number(value?.character ?? 0) + 1 };
}

function normalizeLocation(projectRoot, item) {
  const uri = item?.targetUri ?? item?.uri;
  const range = item?.targetSelectionRange ?? item?.targetRange ?? item?.range;
  if (!uri || !range) return undefined;
  return { path: relativePath(projectRoot, uri), start: position(range.start), end: position(range.end) };
}

class LspProcess {
  constructor(context, onExit) {
    this.context = context;
    this.onExit = onExit;
    this.nextId = 1;
    this.pending = new Map();
    this.diagnostics = new Map();
    this.diagnosticWaiters = new Map();
    this.serverStatusWaiters = [];
    this.serverStatusSeen = false;
    this.serverQuiescent = false;
    this.openFiles = new Map();
    this.buffer = Buffer.alloc(0);
    this.lastUsed = Date.now();
    this.busy = 0;
    this.closed = false;
    this.stderrBytes = 0;
  }

  async start() {
    const { server, projectRoot } = this.context;
    let command;
    if (server.bin) {
      const hostBin = path.join(runtimeRoot, "node_modules", ".bin", server.bin);
      try { fs.accessSync(hostBin, fs.constants.X_OK); } catch { throw new Error("language_server_missing"); }
      command = `/opt/pi-overdrive-tools/node_modules/.bin/${server.bin}`;
    } else if (server.managedBin) {
      const hostBin = path.join(runtimeRoot, server.managedBin);
      try { fs.accessSync(hostBin, fs.constants.X_OK); } catch { throw new Error("language_server_missing"); }
      command = `/opt/pi-overdrive-tools/${server.managedBin}`;
    } else if (server.system) {
      try { fs.accessSync(server.system, fs.constants.X_OK); } catch { throw new Error("language_server_missing"); }
      command = server.system;
    } else {
      if (!commandExists(server.pathCommand)) throw new Error("language_server_missing");
      // Untracked PATH servers are intentionally not admitted into the sandbox.
      throw new Error("language_server_unpinned");
    }
    const invocation = sandboxInvocation("lsp", ["--workspace-read-only", projectRoot, "--", command, ...server.args], { runner: this.context.sandboxRunner });
    this.child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot,
      shell: invocation.shell,
      env: { ...process.env, PI_OVERDRIVE_TOOL_ROOT: runtimeRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stdin.on("error", () => this.failAll("language_server_exited"));
    this.child.stderr.on("data", (chunk) => { this.stderrBytes = Math.min(64 * 1024, this.stderrBytes + chunk.length); });
    this.child.on("error", () => this.failAll("language_server_start_failed"));
    this.child.on("exit", () => {
      this.closed = true;
      this.failAll("language_server_exited");
      this.onExit?.();
    });
    const rootUri = "file:///workspace";
    const initialized = await this.request("initialize", {
      processId: null,
      rootPath: "/workspace",
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(projectRoot) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          rename: { dynamicRegistration: false, prepareSupport: true },
        },
        window: { workDoneProgress: true },
        general: { positionEncodings: ["utf-16"] },
        experimental: { serverStatusNotification: true },
      },
      clientInfo: { name: "tasso-pi-overdrive", version: "1.0.0" },
      initializationOptions: {},
    }, 25_000);
    this.capabilities = initialized?.capabilities ?? {};
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", { settings: {
      typescript: { tsdk: "/opt/pi-overdrive-tools/node_modules/typescript/lib" },
      vtsls: { typescript: { globalTsdk: "/opt/pi-overdrive-tools/node_modules/typescript/lib" } },
    } });
    this.idleTimer = setInterval(() => {
      if (!this.busy && Date.now() - this.lastUsed >= IDLE_SHUTDOWN_MS) void this.shutdown();
    }, 30_000);
    this.idleTimer.unref?.();
  }

  send(message) {
    if (this.closed || !this.child?.stdin?.writable) throw new Error("language_server_not_running");
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("language_server_timeout")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const header = this.buffer.subarray(0, boundary).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header);
      if (!match) { this.buffer = Buffer.alloc(0); this.failAll("language_server_protocol_error"); return; }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) { this.failAll("language_server_message_too_large"); return; }
      const end = boundary + 4 + length;
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(boundary + 4, end);
      this.buffer = this.buffer.subarray(end);
      try { this.handle(JSON.parse(body.toString("utf8"))); }
      catch { this.failAll("language_server_protocol_error"); return; }
    }
  }

  handle(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`language_server_rpc_${message.error.code ?? "error"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(message.params?.uri, message.params?.diagnostics ?? []);
      for (const resolve of this.diagnosticWaiters.get(message.params?.uri) ?? []) resolve();
      this.diagnosticWaiters.delete(message.params?.uri);
      return;
    }
    if (message.method === "experimental/serverStatus") {
      this.serverStatusSeen = true;
      this.serverQuiescent = message.params?.quiescent === true;
      if (this.serverQuiescent) {
        for (const resolve of this.serverStatusWaiters) resolve();
        this.serverStatusWaiters = [];
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      let result = null;
      if (message.method === "workspace/configuration") result = (message.params?.items ?? []).map((item) => {
        if (item?.section === "typescript") return { tsdk: "/opt/pi-overdrive-tools/node_modules/typescript/lib" };
        if (item?.section === "vtsls") return { typescript: { globalTsdk: "/opt/pi-overdrive-tools/node_modules/typescript/lib" } };
        if (item?.section === "vtsls.typescript") return { globalTsdk: "/opt/pi-overdrive-tools/node_modules/typescript/lib" };
        if (item?.section === "vtsls.typescript.globalTsdk") return "/opt/pi-overdrive-tools/node_modules/typescript/lib";
        if (item?.section === "bashIde" && this.context.serverId === "bash") return this.context.server.configuration;
        return {};
      });
      else if (message.method === "workspace/workspaceFolders") result = [{ uri: "file:///workspace", name: path.basename(this.context.projectRoot) }];
      else if (message.method === "workspace/applyEdit") result = { applied: false, failureReason: "Pi Overdrive LSP is read-only; use rename_preview then an authorized editor." };
      this.send({ jsonrpc: "2.0", id: message.id, result });
    }
  }

  failAll(code) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(code)); }
    this.pending.clear();
  }

  sandboxUri(file) {
    const relative = path.relative(this.context.projectRoot, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("source_outside_project");
    return pathToFileURL(path.posix.join("/workspace", relative.split(path.sep).join("/"))).href;
  }

  open(file, languageId, contentOverride, forceChange = false) {
    const text = contentOverride === undefined ? fs.readFileSync(file, "utf8") : contentOverride;
    const uri = this.sandboxUri(file);
    const previous = this.openFiles.get(uri);
    let justOpened = false;
    if (!previous) {
      justOpened = true;
      this.openFiles.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    } else if (previous.text !== text || forceChange) {
      const version = previous.version + 1;
      this.openFiles.set(uri, { version, text });
      this.diagnostics.delete(uri);
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    return { uri, justOpened };
  }

  async waitForDiagnostics(uri, timeoutMs = DIAGNOSTIC_WAIT_MS) {
    if (this.diagnostics.has(uri)) return true;
    return await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(true); };
      const list = this.diagnosticWaiters.get(uri) ?? [];
      list.push(done);
      this.diagnosticWaiters.set(uri, list);
      const timer = setTimeout(() => {
        const pending = (this.diagnosticWaiters.get(uri) ?? []).filter((candidate) => candidate !== done);
        if (pending.length) this.diagnosticWaiters.set(uri, pending);
        else this.diagnosticWaiters.delete(uri);
        resolve(false);
      }, timeoutMs);
    });
  }

  async waitForServerReady() {
    if (this.context.serverId !== "rust" || (this.serverStatusSeen && this.serverQuiescent)) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.serverStatusWaiters = this.serverStatusWaiters.filter((candidate) => candidate !== done);
        reject(new Error("language_server_readiness_timeout"));
      }, REQUEST_TIMEOUT_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      this.serverStatusWaiters.push(done);
    });
  }

  async execute(operation, file, languageId, params, options = {}) {
    this.busy += 1;
    this.lastUsed = Date.now();
    try {
      const opened = this.open(file, languageId, options.contentOverride, options.forceChange === true);
      const { uri } = opened;
      if (opened.justOpened && this.context.serverId === "typescript") await new Promise((resolve) => setTimeout(resolve, 500));
      if (opened.justOpened && this.context.serverId === "bash" && !(await this.waitForDiagnostics(uri))) throw new Error("language_server_readiness_timeout");
      if (opened.justOpened) await this.waitForServerReady();
      const textDocument = { uri };
      const lspPosition = { line: params.line - 1, character: params.character - 1 };
      if (operation === "diagnostics") {
        if (this.capabilities?.diagnosticProvider) {
          try {
            const report = await this.request("textDocument/diagnostic", { textDocument });
            if (Array.isArray(report?.items)) this.diagnostics.set(uri, report.items);
          } catch {}
        }
        let barrierConfirmed = false;
        if (options.allowEmptyDiagnosticsAfterBarrier === true) {
          await this.request("textDocument/documentSymbol", { textDocument });
          barrierConfirmed = true;
        }
        const diagnosticsReady = barrierConfirmed ? this.diagnostics.has(uri) : await this.waitForDiagnostics(uri, options.forceChange === true ? REQUEST_TIMEOUT_MS : DIAGNOSTIC_WAIT_MS);
        if (options.forceChange === true && !diagnosticsReady && !barrierConfirmed) throw new Error("language_server_diagnostics_timeout");
        return (this.diagnostics.get(uri) ?? []).map((entry) => ({
          path: relativePath(this.context.projectRoot, uri), severity: ["Error", "Warning", "Information", "Hint"][Number(entry.severity ?? 4) - 1] ?? "Unknown",
          code: entry.code ?? null, source: entry.source ?? null, message: sanitizeMessage(entry.message), start: position(entry.range?.start), end: position(entry.range?.end),
        }));
      }
      if (operation === "definition") {
        let raw = await this.request("textDocument/definition", { textDocument, position: lspPosition });
        let list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
        // Some servers resolve a use to its local import alias first. Follow that
        // alias once so the tool returns the actual declaration without exposing
        // a second overlapping "implementation" tool.
        if (list.length === 1) {
          const alias = list[0];
          const aliasUri = alias?.targetUri ?? alias?.uri;
          const aliasRange = alias?.targetSelectionRange ?? alias?.targetRange ?? alias?.range;
          if (aliasUri === uri && aliasRange?.start && (aliasRange.start.line !== lspPosition.line || aliasRange.start.character !== lspPosition.character)) {
            const followed = await this.request("textDocument/definition", { textDocument: { uri: aliasUri }, position: aliasRange.start });
            const followedList = followed == null ? [] : Array.isArray(followed) ? followed : [followed];
            if (followedList.length && !(followedList.length === 1 && JSON.stringify(followedList[0]) === JSON.stringify(alias))) list = followedList;
            else {
              if (this.context.serverId === "typescript") {
                try {
                  const source = await this.request("workspace/executeCommand", { command: "typescript.goToSourceDefinition", arguments: [uri, lspPosition] });
                  const sourceList = source == null ? [] : Array.isArray(source) ? source : [source];
                  if (sourceList.length && !(sourceList.length === 1 && JSON.stringify(sourceList[0]) === JSON.stringify(alias))) list = sourceList;
                } catch {}
              }
              for (const method of ["textDocument/typeDefinition", "textDocument/implementation"]) {
                if (!(list.length === 1 && JSON.stringify(list[0]) === JSON.stringify(alias))) break;
                try {
                  const resolved = await this.request(method, { textDocument, position: lspPosition });
                  const resolvedList = resolved == null ? [] : Array.isArray(resolved) ? resolved : [resolved];
                  if (resolvedList.length && !(resolvedList.length === 1 && JSON.stringify(resolvedList[0]) === JSON.stringify(alias))) { list = resolvedList; break; }
                } catch {}
              }
            }
          }
        }
        return list.map((item) => normalizeLocation(this.context.projectRoot, item)).filter(Boolean);
      }
      if (operation === "references") {
        const raw = await this.request("textDocument/references", { textDocument, position: lspPosition, context: { includeDeclaration: true } });
        return (raw ?? []).map((item) => normalizeLocation(this.context.projectRoot, item)).filter(Boolean);
      }
      if (operation === "hover") {
        const raw = await this.request("textDocument/hover", { textDocument, position: lspPosition });
        return raw ? { contents: sanitizeMessage(typeof raw.contents === "string" ? raw.contents : JSON.stringify(raw.contents)), range: raw.range ? { start: position(raw.range.start), end: position(raw.range.end) } : null } : null;
      }
      if (operation === "document_symbols") {
        const raw = await this.request("textDocument/documentSymbol", { textDocument });
        return (raw ?? []).slice(0, 500).map((item) => ({ name: sanitizeMessage(item.name), kind: item.kind, location: normalizeLocation(this.context.projectRoot, item.location ?? { uri, range: item.selectionRange ?? item.range }) }));
      }
      if (operation === "workspace_symbols") {
        const raw = await this.request("workspace/symbol", { query: params.query ?? "" });
        return (raw ?? []).slice(0, 500).map((item) => ({ name: sanitizeMessage(item.name), kind: item.kind, location: normalizeLocation(this.context.projectRoot, item.location) }));
      }
      if (operation === "rename_preview") {
        const raw = await this.request("textDocument/rename", { textDocument, position: lspPosition, newName: params.newName });
        const edits = [];
        for (const [editUri, changes] of Object.entries(raw?.changes ?? {})) {
          for (const edit of changes) edits.push({ path: relativePath(this.context.projectRoot, editUri), start: position(edit.range?.start), end: position(edit.range?.end), newText: sanitizeMessage(edit.newText) });
        }
        for (const document of raw?.documentChanges ?? []) {
          const editUri = document?.textDocument?.uri;
          for (const edit of document?.edits ?? []) edits.push({ path: relativePath(this.context.projectRoot, editUri), start: position(edit.range?.start), end: position(edit.range?.end), newText: sanitizeMessage(edit.newText) });
        }
        return edits.slice(0, 1000);
      }
      throw new Error("unsupported_lsp_operation");
    } finally {
      this.busy -= 1;
      this.lastUsed = Date.now();
    }
  }

  async shutdown() {
    if (this.closed) return;
    clearInterval(this.idleTimer);
    try { await this.request("shutdown", null, 2_000); } catch {}
    const child = this.child;
    if (!child) { this.closed = true; return; }
    if (this.closed || child.exitCode !== null) return;
    const exited = new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(forceTimer);
        clearTimeout(failTimer);
        resolve();
      };
      child.once("exit", done);
      const forceTimer = setTimeout(() => { if (!this.closed && child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
      const failTimer = setTimeout(() => {
        child.off("exit", done);
        reject(new Error("language_server_cleanup_timeout"));
      }, 2_500);
    });
    try { this.notify("exit", null); } catch {}
    await exited;
  }
}

const servers = new Map();
let starts = 0;

async function acquire(context) {
  const key = `${context.serverId}:${context.projectRoot}`;
  let instance = servers.get(key);
  if (instance && !instance.closed) return { instance, reused: true };
  const available = [...servers.entries()].filter(([, value]) => !value.closed);
  if (available.length >= MAX_SERVERS) {
    const idle = available.filter(([, value]) => !value.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!idle) throw new Error("lsp_concurrency_limit");
    servers.delete(idle[0]);
    await idle[1].shutdown();
  }
  instance = new LspProcess(context, () => { if (servers.get(key) === instance) servers.delete(key); });
  servers.set(key, instance);
  try { await instance.start(); starts += 1; }
  catch (error) { servers.delete(key); await instance.shutdown(); throw error; }
  return { instance, reused: false };
}

export async function executeLsp(cwd, parameters, options = {}) {
  if (process.platform === "win32") {
    if (options.sandboxRunner !== undefined || !options.workerAuthority) return { status: "FAIL", error: "PHI_CODING_BACKEND_UNAVAILABLE", entries: [] };
    try {
      const result = await executeCodingLsp(cwd, parameters, { sessionId: options.sessionId, workerAuthority: options.workerAuthority,
        signal: options.signal, runtime: runtimeRoot, onWrite: options.forceChange === true });
      options.emitMetadata?.(result.receipt);
      return result;
    } catch (error) { return { status: "FAIL", error: sanitizeMessage(error instanceof Error ? error.message : error), entries: [] }; }
  }
  let context;
  try { requireCodingBackend("lsp"); context = resolveContext(cwd, parameters.path); }
  catch (error) { return { status: "FAIL", error: sanitizeMessage(error instanceof Error ? error.message : error), entries: [] }; }
  context.sandboxRunner = options.sandboxRunner;
  const policy = serverPolicy(context.serverId, context.server);
  if (!policy.allowed) {
    return { status: "PARTIAL", error: policy.installed ? "language_server_unpinned" : "language_server_missing", language: context.serverId, backend: context.server.version, projectRoot: path.relative(context.workspace, context.projectRoot) || ".", entries: [] };
  }
  if (!["diagnostics", "document_symbols", "workspace_symbols"].includes(parameters.operation) && (!Number.isInteger(parameters.line) || !Number.isInteger(parameters.character) || parameters.line < 1 || parameters.character < 1)) {
    return { status: "FAIL", error: "line_and_character_required", language: context.serverId, entries: [] };
  }
  if (parameters.operation === "rename_preview" && !/^[A-Za-z_$][\w$]*$/u.test(parameters.newName ?? "")) return { status: "FAIL", error: "safe_new_name_required", language: context.serverId, entries: [] };
  try {
    const { instance, reused } = await acquire(context);
    let entries = await instance.execute(parameters.operation, context.file, context.languageId, parameters, options);
    let semanticResolver = "lsp";
    if (context.serverId === "typescript" && parameters.operation === "definition") {
      const direct = typescriptDefinition(context.projectRoot, context.file, parameters.line, parameters.character).map((entry) => ({
        path: entry.file,
        start: { line: entry.line, character: entry.character },
        end: { line: entry.endLine, character: entry.endCharacter },
      }));
      if (direct.length && (entries.length === 0 || entries.every((entry) => entry.path === path.relative(context.projectRoot, context.file)))) {
        entries = direct;
        semanticResolver = "typescript-language-service@6.0.3-after-vtsls-alias";
      }
    }
    return { status: "PASS", operation: parameters.operation, language: context.serverId, backend: context.server.version, semanticResolver, projectRoot: path.relative(context.workspace, context.projectRoot) || ".", serverReused: reused, sandbox: "bubblewrap-read-only-no-network", count: Array.isArray(entries) ? entries.length : entries ? 1 : 0, entries };
  } catch (error) {
    return { status: "FAIL", error: sanitizeMessage(error instanceof Error ? error.message : error), language: context.serverId, backend: context.server.version, projectRoot: path.relative(context.workspace, context.projectRoot) || ".", entries: [] };
  }
}

export async function executeLspOverlay(cwd, source, content) {
  if (content !== undefined && (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES || content.includes("\0"))) {
    return { status: "FAIL", error: "lsp_overlay_invalid", entries: [] };
  }
  const typescriptFamily = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(path.extname(source).toLowerCase());
  const result = await executeLsp(cwd, { operation: "diagnostics", path: source }, { contentOverride: content, forceChange: true, allowEmptyDiagnosticsAfterBarrier: typescriptFamily });
  if (result.status !== "PASS" || result.language !== "typescript") return result;
  try {
    const entries = typescriptDiagnostics(cwd, source, content, { defaultCheckJs: false }).map((entry) => ({
      path: entry.file ?? source,
      severity: entry.category === "Error" ? "Error" : entry.category === "Warning" ? "Warning" : "Information",
      code: entry.code,
      source: "typescript-language-service",
      message: sanitizeMessage(entry.message),
      start: { line: entry.line ?? 1, character: entry.character ?? 1 },
      end: { line: entry.endLine ?? entry.line ?? 1, character: entry.endCharacter ?? entry.character ?? 1 },
    }));
    return { ...result, backend: `${result.backend}+typescript-language-service@6.0.3`, semanticResolver: "lsp-overlay+typescript-language-service@6.0.3", count: entries.length, entries };
  } catch (error) {
    return { ...result, status: "FAIL", error: sanitizeMessage(error instanceof Error ? error.message : error), entries: [], count: 0 };
  }
}

export function lspRuntimeStatus() {
  return {
    activeServers: [...servers.values()].filter((server) => !server.closed).length,
    starts,
    maximumServers: MAX_SERVERS,
    isolation: "bubblewrap-read-only-no-network",
    runtimeRoot,
    languages: Object.fromEntries(Object.entries(SERVER_REGISTRY).map(([id, server]) => [id, serverPolicy(id, server)])),
  };
}

export async function shutdownLspServers() {
  const active = [...servers.entries()];
  const results = await Promise.allSettled(active.map(([, server]) => server.shutdown()));
  for (const [index, [key, server]] of active.entries()) {
    if (results[index]?.status === "fulfilled" && servers.get(key) === server) servers.delete(key);
  }
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
