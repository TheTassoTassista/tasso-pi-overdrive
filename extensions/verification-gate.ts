import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requireCodingBackend, verifyCodingProject } from "../platform/shared/coding-execution.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/verify-project.mjs");
const Params = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("full")], { default: "quick" })),
  listOnly: Type.Optional(Type.Boolean({ default: false })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "verification_gate",
    label: "Verification gate",
    description: "Run repository checks through the platform sandbox. Windows accepts registered offline Node file commands in read-only LPAC snapshots. PASS requires a real check and all commands exiting zero; NO_CHECKS is unresolved.",
    parameters: Params,
    async execute(_id, params, signal, _update, ctx) {
      if (process.platform === "win32") {
        const summary = await verifyCodingProject({ cwd: ctx.cwd, mode: params.mode ?? "quick", listOnly: params.listOnly ?? false, signal });
        for (const result of summary.results ?? []) pi.events.emit("pi-overdrive:execution-metadata", result.receipt);
        if (!["PASS", "LIST_ONLY"].includes(summary.status)) throw new Error(JSON.stringify(summary));
        return { content: [{ type: "text", text: JSON.stringify(summary) }], details: { status: summary.status } };
      }
      requireCodingBackend("verification");
      const args = [script, "--json", params.mode === "full" ? "--full" : "--quick", "--cwd", ctx.cwd];
      if (params.listOnly) args.push("--list");
      const result = await pi.exec(process.execPath, args, { cwd: ctx.cwd, ...(signal ? { signal } : {}), timeout: 16 * 60 * 1000 });
      const text = `${result.stdout}${result.stderr}`.trim() || `verification process exited ${result.code}`;
      if (result.code !== 0) throw new Error(text);
      return { content: [{ type: "text", text }], details: { exitCode: result.code } };
    },
  });

  pi.registerCommand("verify", {
    description: "Run the adaptive verification gate; pass 'full' for build/e2e checks",
    handler: async (args, ctx) => {
      const mode = args.trim() === "full" ? "--full" : "--quick";
      ctx.ui.notify(`Run verification_gate with mode ${mode.slice(2)} for model-visible evidence.`, "info");
    },
  });
}
