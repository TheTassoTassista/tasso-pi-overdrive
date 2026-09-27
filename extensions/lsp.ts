import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeLsp, lspRuntimeStatus, shutdownLspServers } from "../lib/lsp-manager.mjs";
import { windowsWorkerAuthority } from "../lib/phi-worker-authority.mjs";

const Operations = Type.Union([
  Type.Literal("diagnostics"), Type.Literal("definition"), Type.Literal("references"), Type.Literal("hover"),
  Type.Literal("document_symbols"), Type.Literal("workspace_symbols"), Type.Literal("rename_preview"),
]);

export default function lspExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "semantic_nav",
    label: "Semantic Navigation (LSP)",
    description: "Project-aware semantic diagnostics/navigation through a pinned read-only, no-network server. Linux uses Bubblewrap; Windows permits governed Worker same-draft JSON diagnostics through LPAC/Job only. Rename is preview-only.",
    promptSnippet: "Use one semantic tool for diagnostics, definitions, references, hover, symbols, and safe rename previews",
    promptGuidelines: [
      "Use FFF/rg for text discovery, ast-grep for syntax structure, and semantic_nav only for language-aware meaning.",
      "Positions are one-based. rename_preview never writes files; apply reviewed changes through the normal editor workflow.",
      "A PARTIAL result means the language is recognized but its pinned server is not installed.",
    ],
    parameters: Type.Object({
      operation: Operations,
      path: Type.String({ minLength: 1, maxLength: 2048 }),
      line: Type.Optional(Type.Integer({ minimum: 1 })),
      character: Type.Optional(Type.Integer({ minimum: 1 })),
      query: Type.Optional(Type.String({ maxLength: 200 })),
      newName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
    async execute(_id, parameters, signal, _update, ctx) {
      const result = await executeLsp(ctx.cwd, parameters, process.platform === "win32" ? {
        sessionId: ctx.sessionManager.getSessionId(), workerAuthority: windowsWorkerAuthority(ctx.sessionManager.getSessionId()), signal,
        emitMetadata: (metadata: Record<string, unknown>) => pi.events.emit("pi-overdrive:execution-metadata", metadata),
      } : {});
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: result.status === "FAIL" };
    },
  });
  pi.registerCommand("lsp-status", {
    description: "Show pinned language-server availability and isolation status",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(lspRuntimeStatus(), null, 2), "info"),
  });
  pi.on("tool_result", async (event, ctx) => {
    if (process.platform !== "win32" || event.toolName !== "safe_exec" || event.isError) return;
    const details = event.details as { lspOnWritePaths?: string[] } | undefined;
    const paths = details?.lspOnWritePaths;
    if (!paths?.length) return;
    // Code-owned bounded on-write analysis, not another model call. The same
    // opaque governor authority and fixed tool-call budget apply; no host write.
    const results = [];
    if (paths.length > 3) results.push({ status: "FAIL", error: "PHI_LSP_ON_WRITE_LIMIT", entries: [] });
    else for (const source of paths) {
      const sessionId = ctx.sessionManager.getSessionId();
      results.push(await executeLsp(ctx.cwd, { operation: "diagnostics", path: source }, {
        sessionId, workerAuthority: windowsWorkerAuthority(sessionId), forceChange: true,
        emitMetadata: (metadata: Record<string, unknown>) => pi.events.emit("pi-overdrive:execution-metadata", metadata),
      }));
    }
    return { details: { ...details, lspOnWrite: results }, content: [...event.content,
      { type: "text" as const, text: JSON.stringify({ lspOnWrite: results }) }] };
  });
  pi.on("session_shutdown", async () => { await shutdownLspServers(); });
}
