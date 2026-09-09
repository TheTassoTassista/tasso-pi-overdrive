import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { typescriptDefinition, typescriptDiagnostics, typescriptReferences } from "../lib/typescript-navigation.mjs";

const Position = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 2048 }),
  line: Type.Integer({ minimum: 1 }),
  character: Type.Integer({ minimum: 1 }),
});
const File = Type.Object({ path: Type.String({ minLength: 1, maxLength: 2048 }) });

function result(kind: string, entries: unknown[]) {
  const value = { status: "PASS", backend: "typescript-language-service@6.0.3", kind, count: entries.length, entries };
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ts_definition", label: "TypeScript definition", description: "Resolve a JS/TS symbol definition using the pinned TypeScript language service. Positions are one-based.", parameters: Position,
    async execute(_id, params, _signal, _update, ctx) {
      try { return result("definition", typescriptDefinition(ctx.cwd, params.path, params.line, params.character)); }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { status: "FAIL" }, isError: true }; }
    },
  });
  pi.registerTool({
    name: "ts_references", label: "TypeScript references", description: "Resolve all JS/TS references using the pinned TypeScript language service. Positions are one-based.", parameters: Position,
    async execute(_id, params, _signal, _update, ctx) {
      try { return result("references", typescriptReferences(ctx.cwd, params.path, params.line, params.character)); }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { status: "FAIL" }, isError: true }; }
    },
  });
  pi.registerTool({
    name: "ts_diagnostics", label: "TypeScript diagnostics", description: "Return semantic and syntactic JS/TS diagnostics from the pinned TypeScript language service.", parameters: File,
    async execute(_id, params, _signal, _update, ctx) {
      try { return result("diagnostics", typescriptDiagnostics(ctx.cwd, params.path)); }
      catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { status: "FAIL" }, isError: true }; }
    },
  });
}
