import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readAstEditPolicy, TransactionalAstEdit } from "../lib/ast-edit-engine.mjs";
import { AST_EDIT_CONTRACT, EDIT_CONTRACT, EditEngine, editRecoveryGuidance, type EditEngineError, snapshotFooter } from "../lib/edit-engine.mjs";
import { LspWriteGuard } from "../lib/lsp-write-guard.mjs";
import { createWorkspaceFile } from "../lib/create-file.mjs";

const Action = Type.Union([Type.Literal("preview"), Type.Literal("apply")]);
const Replacement = Type.Object({
  oldText: Type.String({ minLength: 1, maxLength: 524288, description: "Exact text from the captured snapshot; it must be unique and entirely inside seen ranges." }),
  newText: Type.String({ maxLength: 524288, description: "Replacement text." }),
});

function safeCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as EditEngineError).code) : error instanceof Error ? error.message : "EDIT_ENGINE_FAILED";
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : "EDIT_ENGINE_FAILED";
}

function safeLspClassification(error: unknown): string | undefined {
  const classification = error && typeof error === "object" && "classification" in error ? String((error as { classification?: unknown }).classification) : "";
  return ["UNCHANGED", "IMPROVED", "REGRESSED", "UNKNOWN_UNVERIFIABLE"].includes(classification) ? classification : undefined;
}

function astGrepBinary(): { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } {
  const configured = process.env.PI_OVERDRIVE_AST_GREP_BIN?.trim();
  const candidate = configured || path.join(homedir(), ".local", "share", "pi-overdrive", "lsp-node", "node_modules", "@ast-grep", "cli", "ast-grep");
  if (!path.isAbsolute(candidate)) throw new Error("AST_BINARY_INVALID");
  const canonical = fs.realpathSync(candidate);
  const stat = fs.lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.nlink !== 1 || (stat.mode & 0o111) === 0) throw new Error("AST_BINARY_UNSAFE");
  return { path: canonical, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

type AstEditPolicy = NonNullable<ReturnType<typeof readAstEditPolicy>>;
function loadAstEditPolicy(): AstEditPolicy {
  const policy = readAstEditPolicy();
  if (!policy) throw new Error("AST_POLICY_UNREADABLE");
  return policy;
}

function smartReadEvidence(event: any): { source: string; seenAll?: boolean; seenRanges?: Array<{ start: number; end: number }> } | undefined {
  const source = typeof event.input?.source === "string" ? event.input.source : typeof event.input?.path === "string" ? event.input.path : "";
  if (!source) return undefined;
  const details = event.details && typeof event.details === "object" ? event.details : {};
  if (details.selectedMode === "range") {
    const start = Number.isSafeInteger(event.input?.offsetLine) ? event.input.offsetLine : 1;
    const limit = Number.isSafeInteger(event.input?.limitLines) ? event.input.limitLines : 200;
    return { source, seenRanges: [{ start, end: start + limit - 1 }] };
  }
  if (details.selectedMode === "raw" && details.truncated === false) return { source, seenAll: true };
  return { source, seenRanges: [] };
}

function readEvidence(event: any): { source: string; seenAll?: boolean; seenRanges?: Array<{ start: number; end: number }> } | undefined {
  const source = typeof event.input?.path === "string" ? event.input.path : "";
  if (!source) return undefined;
  if (event.details?.kind === "smart_read") return smartReadEvidence(event);
  const start = Number.isSafeInteger(event.input?.offset) ? Math.max(1, event.input.offset) : 1;
  const truncation = event.details?.truncation;
  if (truncation?.firstLineExceedsLimit === true) return { source, seenRanges: [] };
  if (Number.isSafeInteger(truncation?.outputLines) && truncation.outputLines > 0) return { source, seenRanges: [{ start, end: start + truncation.outputLines - 1 }] };
  if (Number.isSafeInteger(event.input?.limit) && event.input.limit > 0) return { source, seenRanges: [{ start, end: start + event.input.limit - 1 }] };
  if (start > 1) return { source, seenRanges: [{ start, end: Number.MAX_SAFE_INTEGER }] };
  return { source, seenAll: true };
}

function resourceEvidence(event: any): { source: string; seenRanges: Array<{ start: number; end: number }> } | undefined {
  const source = typeof event.input?.uri === "string" ? event.input.uri : "";
  if (String(event.input?.operation ?? "").toLowerCase() !== "read" || !source.startsWith("repo://root")) return undefined;
  const start = Number.isSafeInteger(event.input?.offsetLine) ? event.input.offsetLine : 1;
  const limit = Number.isSafeInteger(event.input?.limitLines) ? event.input.limitLines : 200;
  return { source, seenRanges: [{ start, end: start + limit - 1 }] };
}

function evidenceFor(event: any) {
  if (event.toolName === "read") return readEvidence(event);
  if (event.toolName === "smart_read") return smartReadEvidence(event);
  if (event.toolName === "resource_fs") return resourceEvidence(event);
  return undefined;
}

export default function editEngineExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "create_file",
    label: "Create file",
    description: "Create a new workspace file without overwriting an existing path. Parent directory must already exist; protected paths and symlinks are refused.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String({ maxLength: 524288 }) }),
    execute: async (_toolCallId, parameters, signal, _update, ctx) => {
      try {
        if (signal?.aborted) throw new Error("CREATE_FILE_ABORTED");
        const result = createWorkspaceFile(ctx.cwd, parameters.path, parameters.content);
        return { content: [{ type: "text" as const, text: `File created (${result.bytes} bytes).` }], details: result };
      } catch (error) {
        return { content: [{ type: "text" as const, text: safeCode(error) }], details: { status: "DENIED" }, isError: true };
      }
    },
  });
  let engine: EditEngine | undefined;
  let astEngine: TransactionalAstEdit | undefined;
  let writeGuard: LspWriteGuard | undefined;
  let initializationError: string | undefined;
  let writeGuardInitializationError: string | undefined;
  let astInitializationError: string | undefined;
  let astVersion: string | undefined;
  let astBinaryIdentity: { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } | undefined;

  const ensureAstRuntime = async (cwd: string, policy: AstEditPolicy, signal?: AbortSignal) => {
    const identity = astGrepBinary();
    if (astBinaryIdentity?.path === identity.path && astBinaryIdentity.dev === identity.dev && astBinaryIdentity.ino === identity.ino && astBinaryIdentity.size === identity.size && astBinaryIdentity.mtimeMs === identity.mtimeMs && astBinaryIdentity.ctimeMs === identity.ctimeMs && astVersion === policy.binaryVersion) return identity.path;
    const digest = createHash("sha256").update(fs.readFileSync(identity.path)).digest("hex");
    if (digest !== policy.binarySha256) throw new Error("AST_BINARY_DIGEST_MISMATCH");
    const check = await pi.exec(identity.path, ["--version"], { cwd, timeout: 5000, ...(signal ? { signal } : {}) });
    const version = check.stdout.trim();
    if (check.code !== 0 || check.killed || version !== policy.binaryVersion) throw new Error("AST_BINARY_VERSION_MISMATCH");
    astBinaryIdentity = identity;
    astVersion = version;
    return identity.path;
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      engine = new EditEngine({ cwd: ctx.cwd, sessionIdentity: ctx.sessionManager.getSessionFile() ?? undefined });
      initializationError = undefined;
    } catch (error) {
      engine = undefined;
      writeGuard = undefined;
      initializationError = safeCode(error);
      pi.events.emit("pi-overdrive:edit-metadata", { kind: "edit_engine", status: "DEGRADED", errorCode: initializationError });
    }
    if (!engine) return;
    try {
      writeGuard = new LspWriteGuard({ cwd: ctx.cwd, editEngine: engine });
      writeGuardInitializationError = undefined;
    } catch (error) {
      writeGuard = undefined;
      writeGuardInitializationError = safeCode(error);
      pi.events.emit("pi-overdrive:edit-metadata", { kind: "lsp_write_guard", status: "DEGRADED", errorCode: writeGuardInitializationError });
    }
    try {
      const astPolicy = loadAstEditPolicy();
      astEngine = new TransactionalAstEdit({
        editEngine: engine,
        policy: astPolicy,
        runner: async (args: string[], options: { signal?: AbortSignal; timeoutMs: number }) => {
          const binary = await ensureAstRuntime(ctx.cwd, astPolicy, options.signal);
          return pi.exec(binary, args, { cwd: ctx.cwd, timeout: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
        },
      });
      astInitializationError = undefined;
    } catch (error) {
      astEngine = undefined;
      astInitializationError = safeCode(error);
      pi.events.emit("pi-overdrive:edit-metadata", { kind: "ast_edit_engine", status: "DEGRADED", errorCode: astInitializationError });
    }
  });

  pi.on("tool_result", async (event) => {
    if (!engine || event.isError) return undefined;
    const evidence = evidenceFor(event);
    if (!evidence) return undefined;
    try {
      const snapshot = engine.capture(evidence);
      pi.events.emit("pi-overdrive:edit-metadata", {
        kind: "edit_snapshot", status: "PASS", contract: snapshot.contract, pathDigest: snapshot.pathDigest,
        contentDigest: snapshot.contentDigest, seenRangeCount: snapshot.seenRanges.length, totalLines: snapshot.totalLines,
      });
      return {
        content: [...event.content, { type: "text", text: snapshotFooter(snapshot) }],
        details: { ...(event.details && typeof event.details === "object" ? event.details : {}), editSnapshot: snapshot },
        isError: false,
      };
    } catch (error) {
      pi.events.emit("pi-overdrive:edit-metadata", { kind: "edit_snapshot", status: "DEGRADED", errorCode: safeCode(error) });
      return undefined;
    }
  });

  pi.registerTool({
    name: "transactional_edit",
    label: "Transactional Edit",
    description: "Preview and atomically apply exact replacements bound to an EDIT SNAPSHOT produced by read, smart_read range, or repo ResourceFS read. Preview is mandatory. Stale, ambiguous, unseen, symlinked, hard-linked, protected, or concurrently changed targets fail closed.",
    promptSnippet: "Use transactional_edit preview then apply for existing files; edits must be bound to a current read snapshot",
    promptGuidelines: [
      "Read the exact target range first and copy its EDIT SNAPSHOT id. Structural summaries do not count as seen source; reopen an exact smart_read range.",
      "Call action=preview with snapshotId and disjoint exact replacements. Review the returned diff and SAFE_RECOVERY/READY status.",
      "Only then call action=apply with transactionId. A STALE_EDIT requires a fresh read and preview; never retry with guessed text.",
      "The built-in edit tool remains an explicit exact-replace fallback; AST mutation uses the separately governed structural path.",
    ],
    parameters: Type.Object({
      action: Action,
      snapshotId: Type.Optional(Type.String({ minLength: 36, maxLength: 36, description: "Snapshot id from a prior exact read; required for preview." })),
      transactionId: Type.Optional(Type.String({ minLength: 36, maxLength: 36, description: "Transaction id returned by preview; required for apply." })),
      edits: Type.Optional(Type.Array(Replacement, { minItems: 1, maxItems: 32, description: "Disjoint replacements matched against the snapshot, not incrementally." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, parameters, signal) {
      if (!engine) throw new Error(`Transactional edit unavailable (${initializationError ?? "EDIT_ENGINE_UNAVAILABLE"}).`);
      if (signal?.aborted) throw new Error("Transactional edit aborted before mutation.");
      try {
        if (parameters.action === "preview") {
          if (!parameters.snapshotId || !parameters.edits || parameters.transactionId !== undefined) throw new Error("EDIT_INPUT_INVALID");
          if (!writeGuard) throw new Error(writeGuardInitializationError ?? "LSP_WRITE_GUARD_UNAVAILABLE");
          const result = engine.preview({ snapshotId: parameters.snapshotId, edits: parameters.edits });
          const lspValidation: any = await writeGuard.preview({ transactionId: result.transactionId, expectedContract: EDIT_CONTRACT });
          pi.events.emit("pi-overdrive:edit-metadata", {
            kind: "edit_preview", status: result.status, contract: result.contract, pathDigest: result.pathDigest,
            beforeDigest: result.beforeDigest, afterDigest: result.afterDigest, editCount: result.editCount,
            recovered: result.status === "SAFE_RECOVERY", syntaxStatus: result.syntaxStatus,
            lspStatus: lspValidation.status, baselineErrorCount: lspValidation.baselineErrorCount, candidateErrorCount: lspValidation.candidateErrorCount,
            baselineDiagnosticDigest: lspValidation.baselineDigest, candidateDiagnosticDigest: lspValidation.candidateDigest,
          });
          return { content: [{ type: "text", text: `${result.preview}\n[LSP preflight=${lspValidation.status}; baseline errors=${lspValidation.baselineErrorCount ?? "n/a"}; candidate errors=${lspValidation.candidateErrorCount ?? "n/a"}.]\n[Preview only; no file changed. Apply transaction ${result.transactionId} after review.]` }], details: { ...result, lspValidation } };
        }
        if (!parameters.transactionId || parameters.snapshotId !== undefined || parameters.edits !== undefined) throw new Error("EDIT_INPUT_INVALID");
        if (signal?.aborted) throw new Error("Transactional edit aborted before mutation.");
        if (!writeGuard) throw new Error(writeGuardInitializationError ?? "LSP_WRITE_GUARD_UNAVAILABLE");
        const result = await writeGuard.apply({ transactionId: parameters.transactionId, expectedContract: EDIT_CONTRACT });
        pi.events.emit("pi-overdrive:edit-metadata", {
          kind: "edit_apply", status: result.status, contract: result.contract, pathDigest: result.pathDigest,
          beforeDigest: result.beforeDigest, afterDigest: result.afterDigest, editCount: result.editCount,
          recovered: result.recovered, syntaxStatus: result.syntaxStatus, receiptDigest: result.receipt.sha256,
          lspStatus: result.validation?.status, postErrorCount: result.validation?.postErrorCount, postDiagnosticDigest: result.validation?.postDigest,
        });
        return { content: [{ type: "text", text: `APPLIED transaction ${result.transactionId}; immutable receipt ${result.receipt.sha256}.` }], details: result };
      } catch (error) {
        const errorCode = safeCode(error);
        pi.events.emit("pi-overdrive:edit-metadata", { kind: parameters.action === "apply" ? "edit_apply" : "edit_preview", status: "FAIL", errorCode, lspClassification: safeLspClassification(error) });
        const guidance = editRecoveryGuidance(errorCode);
        throw new Error(`Transactional edit denied (${errorCode}).${guidance ? ` ${guidance}` : ""}`);
      }
    },
  });

  pi.registerTool({
    name: "transactional_ast_edit",
    label: "Transactional AST Edit",
    description: "Preview and atomically apply one bounded ast-grep pattern rewrite against the exact snapshot content previously observed. Match count is explicit; changed, unseen, overlapping, excessive, stale, or malformed match sets fail closed.",
    promptSnippet: "Use transactional_ast_edit for bounded structural rewrites after an exact read; preview and verify the match count before apply",
    promptGuidelines: [
      "Read every target range first and use its EDIT SNAPSHOT id; structural summaries do not authorize mutation.",
      "Call preview with one ast-grep pattern/rewrite pair and the exact expectedMatches count. Review every returned hunk before apply.",
      "Apply only the returned transaction id. Any source change after the read or preview requires a new read and preview.",
      "Use the separately governed ast_grep_rewrite only as a fallback; this transactional contract is intentionally single-file and capped.",
    ],
    parameters: Type.Object({
      action: Action,
      snapshotId: Type.Optional(Type.String({ minLength: 36, maxLength: 36, description: "Snapshot id from a prior exact read; required for preview." })),
      transactionId: Type.Optional(Type.String({ minLength: 36, maxLength: 36, description: "AST transaction id returned by preview; required for apply." })),
      pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "One ast-grep structural pattern." })),
      rewrite: Type.Optional(Type.String({ maxLength: 4096, description: "Replacement template using the pattern's meta variables." })),
      lang: Type.Optional(Type.String({ minLength: 1, maxLength: 32, description: "Optional ast-grep language alias; otherwise inferred from the snapshotted file extension." })),
      expectedMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, description: "Exact number of replacements expected; mismatch fails closed." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, parameters, signal) {
      if (!astEngine) throw new Error(`Transactional AST edit unavailable (${astInitializationError ?? "AST_ENGINE_UNAVAILABLE"}).`);
      if (signal?.aborted) throw new Error("Transactional AST edit aborted before mutation.");
      try {
        if (parameters.action === "preview") {
          if (!parameters.snapshotId || !parameters.pattern || parameters.rewrite === undefined || !parameters.expectedMatches || parameters.transactionId !== undefined) throw new Error("AST_INPUT_INVALID");
          if (!writeGuard) throw new Error(writeGuardInitializationError ?? "LSP_WRITE_GUARD_UNAVAILABLE");
          const result = await astEngine.preview({ snapshotId: parameters.snapshotId, pattern: parameters.pattern, rewrite: parameters.rewrite, lang: parameters.lang, expectedMatches: parameters.expectedMatches }, signal);
          const lspValidation: any = await writeGuard.preview({ transactionId: result.transactionId, expectedContract: AST_EDIT_CONTRACT });
          pi.events.emit("pi-overdrive:edit-metadata", {
            kind: "ast_edit_preview", status: result.status, contract: result.contract, pathDigest: result.pathDigest,
            beforeDigest: result.beforeDigest, afterDigest: result.afterDigest, editCount: result.editCount, matchCount: result.matchCount,
            patternDigest: result.patternDigest, rewriteDigest: result.rewriteDigest, syntaxStatus: result.syntaxStatus,
            lspStatus: lspValidation.status, baselineErrorCount: lspValidation.baselineErrorCount, candidateErrorCount: lspValidation.candidateErrorCount,
            baselineDiagnosticDigest: lspValidation.baselineDigest, candidateDiagnosticDigest: lspValidation.candidateDigest,
          });
          return { content: [{ type: "text", text: `${result.preview}\n[LSP preflight=${lspValidation.status}; baseline errors=${lspValidation.baselineErrorCount ?? "n/a"}; candidate errors=${lspValidation.candidateErrorCount ?? "n/a"}.]\n[AST preview only; ${result.matchCount} matches, no file changed. Apply transaction ${result.transactionId} after review.]` }], details: { ...result, lspValidation } };
        }
        if (!parameters.transactionId || parameters.snapshotId !== undefined || parameters.pattern !== undefined || parameters.rewrite !== undefined || parameters.lang !== undefined || parameters.expectedMatches !== undefined) throw new Error("AST_INPUT_INVALID");
        if (!writeGuard) throw new Error(writeGuardInitializationError ?? "LSP_WRITE_GUARD_UNAVAILABLE");
        const result = await writeGuard.apply({ transactionId: parameters.transactionId, expectedContract: AST_EDIT_CONTRACT }, astEngine);
        pi.events.emit("pi-overdrive:edit-metadata", {
          kind: "ast_edit_apply", status: result.status, contract: result.contract, pathDigest: result.pathDigest,
          beforeDigest: result.beforeDigest, afterDigest: result.afterDigest, editCount: result.editCount,
          syntaxStatus: result.syntaxStatus, receiptDigest: result.receipt.sha256,
          lspStatus: result.validation?.status, postErrorCount: result.validation?.postErrorCount, postDiagnosticDigest: result.validation?.postDigest,
        });
        return { content: [{ type: "text", text: `APPLIED AST transaction ${result.transactionId}; immutable receipt ${result.receipt.sha256}.` }], details: result };
      } catch (error) {
        const errorCode = safeCode(error);
        pi.events.emit("pi-overdrive:edit-metadata", { kind: parameters.action === "apply" ? "ast_edit_apply" : "ast_edit_preview", status: "FAIL", contract: AST_EDIT_CONTRACT, errorCode, lspClassification: safeLspClassification(error) });
        const guidance = editRecoveryGuidance(errorCode);
        throw new Error(`Transactional AST edit denied (${errorCode}).${guidance ? ` ${guidance}` : ""}`);
      }
    },
  });

  pi.registerCommand("edit-engine", {
    description: "Show Edit Engine V2 snapshot/transaction/receipt counters without a model call",
    handler: async (_args, ctx) => ctx.ui.notify(engine ? JSON.stringify(engine.status(), null, 2) : `Edit Engine unavailable (${initializationError ?? "not initialized"}).`, engine ? "info" : "error"),
  });

  pi.registerCommand("ast-edit", {
    description: "Show transactional AST edit status without a model call",
    handler: async (_args, ctx) => {
      if (!astEngine) {
        ctx.ui.notify(`Transactional AST edit unavailable (${astInitializationError ?? "not initialized"}).`, "error");
        return;
      }
      try {
        const astPolicy = loadAstEditPolicy();
        await ensureAstRuntime(ctx.cwd, astPolicy);
        ctx.ui.notify(JSON.stringify({ ...astEngine.status(), binaryVersion: astVersion }, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(`Transactional AST edit unavailable (${safeCode(error)}).`, "error");
      }
    },
  });

  pi.registerCommand("lsp-write", {
    description: "Show transactional LSP write-guard status without a model call",
    handler: async (_args, ctx) => ctx.ui.notify(writeGuard ? JSON.stringify(writeGuard.status(), null, 2) : `LSP write guard unavailable (${writeGuardInitializationError ?? "not initialized"}).`, writeGuard ? "info" : "error"),
  });
}
