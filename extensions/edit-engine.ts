import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EditEngine, type EditEngineError, snapshotFooter } from "../lib/edit-engine.mjs";

const Action = Type.Union([Type.Literal("preview"), Type.Literal("apply")]);
const Replacement = Type.Object({
  oldText: Type.String({ minLength: 1, maxLength: 524288, description: "Exact text from the captured snapshot; it must be unique and entirely inside seen ranges." }),
  newText: Type.String({ maxLength: 524288, description: "Replacement text." }),
});

function safeCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as EditEngineError).code) : error instanceof Error ? error.message : "EDIT_ENGINE_FAILED";
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : "EDIT_ENGINE_FAILED";
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
  let engine: EditEngine | undefined;
  let initializationError: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    try {
      engine = new EditEngine({ cwd: ctx.cwd, sessionIdentity: ctx.sessionManager.getSessionFile() ?? undefined });
      initializationError = undefined;
    } catch (error) {
      engine = undefined;
      initializationError = safeCode(error);
      pi.events.emit("pi-overdrive:edit-metadata", { kind: "edit_engine", status: "DEGRADED", errorCode: initializationError });
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
          const result = engine.preview({ snapshotId: parameters.snapshotId, edits: parameters.edits });
          pi.events.emit("pi-overdrive:edit-metadata", {
            kind: "edit_preview", status: result.status, contract: result.contract, pathDigest: result.pathDigest,
            beforeDigest: result.beforeDigest, afterDigest: result.afterDigest, editCount: result.editCount,
            recovered: result.status === "SAFE_RECOVERY", syntaxStatus: result.syntaxStatus,
          });
          return { content: [{ type: "text", text: `${result.preview}\n[Preview only; no file changed. Apply transaction ${result.transactionId} after review.]` }], details: result };
        }
        if (!parameters.transactionId || parameters.snapshotId !== undefined || parameters.edits !== undefined) throw new Error("EDIT_INPUT_INVALID");
        if (signal?.aborted) throw new Error("Transactional edit aborted before mutation.");
        const result = engine.apply({ transactionId: parameters.transactionId });
        pi.events.emit("pi-overdrive:edit-metadata", {
          kind: "edit_apply", status: result.status, contract: result.contract, pathDigest: result.pathDigest,
          beforeDigest: result.beforeDigest, afterDigest: result.afterDigest, editCount: result.editCount,
          recovered: result.recovered, syntaxStatus: result.syntaxStatus, receiptDigest: result.receipt.sha256,
        });
        return { content: [{ type: "text", text: `APPLIED transaction ${result.transactionId}; immutable receipt ${result.receipt.sha256}.` }], details: result };
      } catch (error) {
        const errorCode = safeCode(error);
        pi.events.emit("pi-overdrive:edit-metadata", { kind: parameters.action === "apply" ? "edit_apply" : "edit_preview", status: "FAIL", errorCode });
        throw new Error(errorCode === "STALE_EDIT" ? "STALE_EDIT: file changed or the anchor cannot be recovered safely; read the exact range again." : `Transactional edit denied (${errorCode}).`);
      }
    },
  });

  pi.registerCommand("edit-engine", {
    description: "Show Edit Engine V2 snapshot/transaction/receipt counters without a model call",
    handler: async (_args, ctx) => ctx.ui.notify(engine ? JSON.stringify(engine.status(), null, 2) : `Edit Engine unavailable (${initializationError ?? "not initialized"}).`, engine ? "info" : "error"),
  });
}
