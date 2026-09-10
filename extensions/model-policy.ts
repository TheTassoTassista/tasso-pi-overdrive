import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_PRESETS, MODEL_ROLES, modelPolicyPath, parseModelSelection, policyWithPreset, policyWithRole, publicModelCatalog, readModelPolicy, resolveModelPolicy, settingsAgentOverrides, writeModelPolicy, writePrivateJsonAtomic } from "../lib/model-policy.mjs";

function notifyError(ctx: ExtensionContext, error: unknown): void {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

function renderRouting(resolved: any): string {
  return [
    `Preset: ${resolved.preset}${resolved.preset === "custom" ? ` (base ${resolved.basePreset})` : ""}`,
    ...MODEL_ROLES.map((role) => `${role}: ${resolved.roles[role].model}:${resolved.roles[role].thinking}`),
    `Diversity: ${resolved.diversity.models} model identities / ${resolved.diversity.providers} provider(s)`,
    `Policy receipt: ${resolved.digest.slice(0, 16)}`,
    ...(resolved.routingDecisions ?? []).map((decision: any) => `Fallback ${decision.purpose}: ${decision.selected}; skipped ${decision.skipped.map((item: any) => `${item.model} (${item.reason})`).join(", ")}`),
  ].join("\n");
}

function renderCouncilStatus(resolved: any): string {
  const councilRoles = ["council-1", "council-2", "council-3", "council-judge"];
  return [
    `Preset: ${resolved.preset}`,
    ...councilRoles.map((role) => `${role}: ${resolved.roles[role].model}:${resolved.roles[role].thinking}`),
    "Escalation: explicit /council; high-risk workflow (includeOracle); material reviewer disagreement; second correction after repeated failure",
    "Independence: three fresh read-only contexts, synchronized fanout, Judge only after all three structured results",
    "Hard limits: concurrency=3, depth=1, correction rounds=2, nested council=disabled",
    `Provider diversity currently resolved: ${resolved.diversity.providers}; model identities: ${new Set(councilRoles.map((role) => resolved.roles[role].model)).size}`,
  ].join("\n");
}

function publicInventory(ctx: ExtensionContext): object {
  const available = ctx.modelRegistry.getAvailable();
  const registered = ctx.modelRegistry.getAll();
  const availableByProvider = new Map<string, number>();
  for (const model of available) availableByProvider.set(model.provider, (availableByProvider.get(model.provider) ?? 0) + 1);
  const providers = [...new Set([...ctx.modelRegistry.getRegisteredProviderIds(), ...ctx.modelRegistry.getAll().map((model) => model.provider)])].sort().map((provider) => ({
    provider,
    configured: ctx.modelRegistry.getProviderAuthStatus(provider).configured,
    availableModels: availableByProvider.get(provider) ?? 0,
  }));
  return { availableModels: publicModelCatalog(registered, available), providers };
}

function resolveForContext(ctx: ExtensionContext, stored = readModelPolicy()): any {
  return resolveModelPolicy(ctx.modelRegistry.getAvailable(), stored, { registeredModels: ctx.modelRegistry.getAll() });
}

function syncUserSubagentSettings(resolved: any): void {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const settingsFile = path.join(agentDirectory, "settings.json");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(settingsFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("pi_settings_permissions");
    const settings = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    settings.subagents ??= {};
    settings.subagents.agentOverrides = { ...(settings.subagents.agentOverrides ?? {}), ...settingsAgentOverrides(resolved) };
    writePrivateJsonAtomic(settingsFile, settings);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export default function modelPolicyExtension(pi: ExtensionAPI): void {
  pi.registerCommand("models", {
    description: "List authenticated models and public capability/cost metadata",
    handler: async (_args, ctx) => {
      try { ctx.ui.notify(JSON.stringify(publicInventory(ctx), null, 2), "info"); }
      catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("model-routing", {
    description: "Show the effective persistent role routing and policy receipt",
    handler: async (_args, ctx) => {
      try { ctx.ui.notify(renderRouting(resolveForContext(ctx)), "info"); }
      catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("council-status", {
    description: "Show council routes, escalation policy, independence, and hard limits",
    handler: async (_args, ctx) => {
      try { ctx.ui.notify(renderCouncilStatus(resolveForContext(ctx)), "info"); }
      catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("council", {
    description: "Run a user-requested task through the enforced workflow with council escalation",
    handler: async (args, ctx) => {
      try {
        const task = args.trim();
        if (!task) throw new Error("usage: /council TASK");
        pi.sendUserMessage([
          "Call secure_coding_workflow exactly once with exactly this JSON input:",
          JSON.stringify({ task, includeOracle: true, includeSecurity: true }),
          "Do not call the raw subagent council workflow or any other tool. Report only the controller's structured final status.",
        ].join("\n"), { expandPromptTemplates: false });
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("model-role", {
    description: "List roles or set one role: /model-role ROLE PROVIDER/MODEL[:THINKING]",
    handler: async (args, ctx) => {
      try {
        const [role, ...selectionParts] = args.trim().split(/\s+/u);
        if (!role || role === "list") { ctx.ui.notify(MODEL_ROLES.join("\n"), "info"); return; }
        if (!MODEL_ROLES.includes(role as any) || selectionParts.length !== 1) throw new Error("usage: /model-role ROLE PROVIDER/MODEL[:THINKING]");
        const models = ctx.modelRegistry.getAvailable();
        const options = { registeredModels: ctx.modelRegistry.getAll() };
        const stored = policyWithRole(readModelPolicy(), role, parseModelSelection(selectionParts[0], models, options));
        writeModelPolicy(modelPolicyPath(), stored);
        const resolved = resolveModelPolicy(models, stored, options);
        syncUserSubagentSettings(resolved);
        const selected = resolved.roles[role];
        if (!selected) throw new Error("resolved_model_role_missing");
        ctx.ui.notify(`${role} -> ${selected.model}:${selected.thinking}\nPersistent policy updated. Reload Pi before direct subagent calls; secure_coding_workflow uses it immediately.`, "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("model-preset", {
    description: "List, show, preview, or select budget/efficient/balanced/max-quality/custom",
    handler: async (args, ctx) => {
      try {
        const action = args.trim() || "list";
        if (action === "list") { ctx.ui.notify(MODEL_PRESETS.join("\n"), "info"); return; }
        const models = ctx.modelRegistry.getAvailable();
        const options = { registeredModels: ctx.modelRegistry.getAll() };
        if (action === "show") { ctx.ui.notify(renderRouting(resolveModelPolicy(models, readModelPolicy(), options)), "info"); return; }
        if (action.startsWith("preview ")) {
          const preview = action.slice("preview ".length).trim();
          if (!MODEL_PRESETS.includes(preview as any) || preview === "custom") throw new Error("preview_requires_concrete_preset");
          ctx.ui.notify(`${renderRouting(resolveModelPolicy(models, policyWithPreset(readModelPolicy(), preview), options))}\nPreview only; persistent policy unchanged.`, "info");
          return;
        }
        if (!MODEL_PRESETS.includes(action as any)) throw new Error("unknown_model_preset");
        const stored = policyWithPreset(readModelPolicy(), action);
        writeModelPolicy(modelPolicyPath(), stored);
        const resolved = resolveModelPolicy(models, stored, options);
        syncUserSubagentSettings(resolved);
        ctx.ui.notify(`${renderRouting(resolved)}\nPersistent policy updated. Reload Pi before direct subagent calls; secure_coding_workflow uses it immediately.`, "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
}
