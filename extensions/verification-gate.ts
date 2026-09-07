import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/verify-project.mjs");
const Params = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("full")], { default: "quick" })),
  listOnly: Type.Optional(Type.Boolean({ default: false })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "verification_gate",
    label: "Verification gate",
    description: "Detect and run repository-appropriate tests, typechecks, lint, build, and git diff checks. Returns real PASS/FAIL evidence; never invent skipped checks.",
    parameters: Params,
    async execute(_id, params, signal, _update, ctx) {
      const args = [script, "--json", params.mode === "full" ? "--full" : "--quick", "--cwd", ctx.cwd];
      if (params.listOnly) args.push("--list");
      const result = await pi.exec(process.execPath, args, { cwd: ctx.cwd, ...(signal ? { signal } : {}), timeout: 16 * 60 * 1000 });
      const text = `${result.stdout}${result.stderr}`.trim() || `verification process exited ${result.code}`;
      return { content: [{ type: "text", text }], details: { exitCode: result.code }, isError: result.code !== 0 };
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
