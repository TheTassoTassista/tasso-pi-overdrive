import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeLsp, lspRuntimeStatus, shutdownLspServers } from "../lib/lsp-manager.mjs";

const Operations = Type.Union([
  Type.Literal("diagnostics"), Type.Literal("definition"), Type.Literal("references"), Type.Literal("hover"),
  Type.Literal("document_symbols"), Type.Literal("workspace_symbols"), Type.Literal("rename_preview"),
]);

export default function lspExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "semantic_nav",
    label: "Semantic Navigation (LSP)",
    description: "Project-aware semantic diagnostics and navigation through a lazy, pinned language server. Servers run without network in a read-only Bubblewrap sandbox. Rename is preview-only.",
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
    async execute(_id, parameters, _signal, _update, ctx) {
      const result = await executeLsp(ctx.cwd, parameters);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: result.status === "FAIL" };
    },
  });
  pi.registerCommand("lsp-status", {
    description: "Show pinned language-server availability and isolation status",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(lspRuntimeStatus(), null, 2), "info"),
  });
  pi.on("session_shutdown", async () => { await shutdownLspServers(); });
}
