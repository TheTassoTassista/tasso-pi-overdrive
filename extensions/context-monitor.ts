import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let warned = false;

  const refresh = (ctx: ExtensionContext) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.tokens === null) return;
    if (usage.percent >= 85) {
      ctx.ui.setStatus("overdrive-context", `ctx ${usage.percent.toFixed(0)}% · handoff soon`);
      if (!warned && ctx.hasUI) {
        ctx.ui.notify(`Context is ${usage.percent.toFixed(0)}% full. Finish the phase, update the notebook, then /handoff.`, "warning");
        warned = true;
      }
    } else {
      ctx.ui.setStatus("overdrive-context", undefined);
      if (usage.percent < 70) warned = false;
    }
  };

  pi.on("turn_end", async (_event, ctx) => refresh(ctx));
  pi.on("session_start", async (_event, ctx) => refresh(ctx));
  pi.registerCommand("context-health", {
    description: "Show current context usage and recommended action",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null || usage.tokens === null) {
        ctx.ui.notify("Context usage is not available until the first model response.", "info");
        return;
      }
      const action = usage.percent >= 85 ? "handoff recommended" : usage.percent >= 70 ? "finish the current phase soon" : "healthy";
      ctx.ui.notify(`${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent.toFixed(1)}%): ${action}`, "info");
    },
  });
}
