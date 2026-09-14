import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readModelPolicy } from "../lib/model-policy.mjs";
import { getSessionQuality } from "../lib/routing-session.mjs";
import { availableContextFromPiUsage, resolveTaskPolicy } from "../lib/task-governor.mjs";
import {
  classifyTool,
  hasExplicitToolCliPolicy,
  renderToolPolicy,
  resolveManualToolChange,
  resolveToolPolicy,
  toolPolicyMetadata,
} from "../lib/tool-governor.mjs";

export const CORE_TOOLS = Object.freeze([
  "read",
  "edit",
  "write",
  "secure_coding_workflow",
  "mcp",
  "task_notebook",
  "verification_gate",
]);

export function selectInitialToolSurface(active: string[], available: string[], argv: string[]): string[] {
  if (hasExplicitToolCliPolicy(argv)) return active;
  const known = new Set(available);
  return CORE_TOOLS.filter((name) => known.has(name));
}

function presetAndQuality(): { preset: string; quality: string } {
  const stored = readModelPolicy();
  return { preset: stored.preset === "custom" ? stored.basePreset : stored.preset, quality: getSessionQuality() };
}

function inventory(pi: ExtensionAPI): string {
  const active = new Set(pi.getActiveTools());
  const groups = new Map<string, string[]>();
  for (const tool of pi.getAllTools()) {
    const classification = classifyTool(tool.name);
    const key = classification.tier;
    groups.set(key, [...(groups.get(key) ?? []), `${tool.name}${active.has(tool.name) ? "*" : ""}`]);
  }
  return [...groups.entries()].map(([tier, names]) => `${tier}: ${names.join(", ")}`).join("\n");
}

function currentStatus(pi: ExtensionAPI, mode: string, lastPolicy: any, lastTaskPolicy: any, json: boolean): string {
  if (json) return JSON.stringify({ mode, activeTools: pi.getActiveTools(), lastPolicy: lastPolicy ?? null, inventory: pi.getAllTools().map((tool) => ({ ...classifyTool(tool.name), active: pi.getActiveTools().includes(tool.name) })) }, null, 2);
  return [
    `Tool Governor mode: ${mode}`,
    ...(lastPolicy && lastTaskPolicy ? [renderToolPolicy(lastPolicy, lastTaskPolicy)] : [`Active (${pi.getActiveTools().length}): ${pi.getActiveTools().join(", ") || "none"}`]),
    "Inventory (* active):",
    inventory(pi),
  ].join("\n");
}

export default function toolSurface(pi: ExtensionAPI): void {
  const cliPolicy = hasExplicitToolCliPolicy(process.argv.slice(2));
  let mode = cliPolicy ? "explicit-cli" : "auto";
  let lastPolicy: any;
  let lastTaskPolicy: any;

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const available = pi.getAllTools().map((tool) => tool.name);
    pi.setActiveTools(selectInitialToolSurface(active, available, process.argv.slice(2)));
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (mode !== "auto") {
      ctx.ui.setStatus("tool-governor", `tools: ${mode} (${pi.getActiveTools().length})`);
      return undefined;
    }
    try {
      const routing = presetAndQuality();
      const taskPolicy = resolveTaskPolicy({ task: event.prompt, ...routing, availableContext: availableContextFromPiUsage(ctx.getContextUsage()) });
      const policy = resolveToolPolicy({ taskPolicy, availableTools: pi.getAllTools().map((tool) => tool.name) });
      pi.setActiveTools([...policy.activeTools]);
      lastTaskPolicy = taskPolicy;
      lastPolicy = policy;
      pi.events.emit("pi-overdrive:tool-metadata", toolPolicyMetadata(policy, taskPolicy));
      ctx.ui.setStatus("tool-governor", `tools: auto ${policy.activeTools.length}/${policy.activeTools.length + policy.inactiveToolCount}`);
    } catch {
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      pi.setActiveTools(available.has("read") ? ["read"] : []);
      lastTaskPolicy = undefined;
      lastPolicy = undefined;
      pi.events.emit("pi-overdrive:tool-metadata", { kind: "tool_governor_failure", mode: "auto", activeTools: pi.getActiveTools(), decisionModelCalls: 0 });
      ctx.ui.setStatus("tool-governor", "tools: fail-closed");
    }
    return undefined;
  });

  pi.registerCommand("tools", {
    description: "Inspect or explicitly control the session tool surface: /tools [--json|auto|enable NAME|disable NAME]",
    handler: async (args, ctx: ExtensionContext) => {
      try {
        const parts = args.trim().split(/\s+/u).filter(Boolean);
        const action = parts[0];
        if (!action || action === "--json") {
          ctx.ui.notify(currentStatus(pi, mode, lastPolicy, lastTaskPolicy, action === "--json"), "info");
          return;
        }
        if (mode === "explicit-cli") throw new Error("explicit_cli_tool_policy_is_authoritative");
        if (action === "auto" && parts.length === 1) {
          mode = "auto";
          lastPolicy = undefined;
          lastTaskPolicy = undefined;
          pi.setActiveTools(selectInitialToolSurface(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name), []));
          ctx.ui.setStatus("tool-governor", `tools: auto (${pi.getActiveTools().length})`);
          ctx.ui.notify("Tool Governor automatic selection restored; the next prompt will resolve a fresh surface.", "info");
          return;
        }
        if (!["enable", "disable"].includes(action) || parts.length !== 2) throw new Error("usage: /tools [--json|auto|enable NAME|disable NAME]");
        const changed = resolveManualToolChange({ action, name: parts[1], activeTools: pi.getActiveTools(), availableTools: pi.getAllTools().map((tool) => tool.name) });
        pi.setActiveTools([...changed.activeTools]);
        mode = "manual";
        lastPolicy = undefined;
        lastTaskPolicy = undefined;
        pi.events.emit("pi-overdrive:tool-metadata", { kind: "tool_governor_manual_change", mode, action: changed.action, tool: changed.changed, tier: changed.tier, activeToolCount: changed.activeTools.length });
        ctx.ui.setStatus("tool-governor", `tools: manual (${changed.activeTools.length})`);
        ctx.ui.notify(currentStatus(pi, mode, undefined, undefined, false), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
