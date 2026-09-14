import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MODEL_PRESETS, MODEL_ROLES, ROUTING_POLICY, modelPolicyPath, parseModelSelection, parsePreset,
  policyWithPreset, policyWithRole, publicModelCatalog, readModelPolicy, resolveModelPolicy,
  settingsAgentOverrides, writeModelPolicy, writePrivateJsonAtomic,
} from "../lib/model-policy.mjs";
import { getSessionQuality, QUALITY_LEVELS, resetSessionQuality, setSessionQuality } from "../lib/routing-session.mjs";
import { calculateRequiredSpawnBudget, EXTERNAL_SUBAGENT_QUOTA, readConfiguredSpawnLimit } from "../lib/workflow-spawn-budget.mjs";
import { memoryPolicyTopology, resolveMemoryPolicy } from "../lib/memory-policy.mjs";
import { availableContextFromPiUsage, renderTaskPolicy, resolveTaskPolicy } from "../lib/task-governor.mjs";

function notifyError(ctx: ExtensionContext, error: unknown): void {
  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

function emitRoutingMetadata(pi: ExtensionAPI, data: Record<string, unknown>): void {
  pi.events.emit("pi-overdrive:routing-metadata", data);
}

function resolveForContext(ctx: ExtensionContext, stored = readModelPolicy(), quality = getSessionQuality()): any {
  return resolveModelPolicy(ctx.modelRegistry.getAvailable(), stored, {
    registeredModels: ctx.modelRegistry.getAll(),
    qualityRequested: quality,
    effectiveQuality: quality === "auto" ? "medium" : quality,
  });
}

function renderRouting(resolved: any): string {
  return [
    `Preset: ${resolved.displayName} (${resolved.preset}${resolved.preset === "custom" ? `; base ${resolved.basePreset}` : ""})`,
    `Quality: ${resolved.qualityRequested} (route effort profile: ${resolved.qualityRequested === "auto" ? "adaptive/base" : resolved.effectiveQuality})`,
    ...MODEL_ROLES.map((role) => {
      const route = resolved.roles[role];
      return `${role}: ${route.model}:${route.thinking} [${route.source}; fallback ${route.fallbackIndex}]`;
    }),
    `Diversity: ${resolved.diversity.models} model identities / ${resolved.diversity.families} families / ${resolved.diversity.providers} infrastructure provider(s)`,
    `Policy receipt: ${resolved.digest.slice(0, 16)}`,
    ...(resolved.routingDecisions ?? []).filter((decision: any) => decision.fallbackIndex > 0).map((decision: any) => `Fallback ${decision.role}: selected ${decision.selected}; skipped ${decision.skipped.map((item: any) => `${item.model} (${item.reason})`).join(", ")}`),
  ].join("\n");
}

function renderCouncilStatus(resolved: any): string {
  const councilRoles = ["council-1", "council-2", "council-3", "council-judge"];
  const spawnBudget = calculateRequiredSpawnBudget();
  const configuredSpawnLimit = readConfiguredSpawnLimit();
  return [
    `Preset: ${resolved.displayName}`,
    `Quality: ${getSessionQuality()} (session)`,
    ...councilRoles.map((role) => `${role}: ${resolved.roles[role].model}:${resolved.roles[role].thinking} [${resolved.roles[role].family}; ${resolved.roles[role].source}]`),
    "Escalation: explicit /council; critical risk; material reviewer disagreement when quality authorizes it; second bounded correction",
    "Independence: three fresh read-only contexts, synchronized fanout, Judge only after three valid structured results",
    "Infrastructure note: DeepSeek and Qwen are different model families behind the same OmniRoute gateway, not independent infrastructure",
    "Hard limits: concurrency=3, depth=1, correction rounds=2, nested council=disabled",
    `Spawn budget: base=${spawnBudget.requiredBaseSpawns}, retry reserve=${spawnBudget.retryReserve}, required total=${spawnBudget.requiredTotalSpawns}, configured=${configuredSpawnLimit}`,
    `External pi-subagents quota: ${EXTERNAL_SUBAGENT_QUOTA.status} (${EXTERNAL_SUBAGENT_QUOTA.reason}); upstream still fails closed before provider launch`,
  ].join("\n");
}

function aiTreeObject(resolved: any, quality: string): object {
  const memoryPolicy = resolveMemoryPolicy({ preset: resolved.basePreset, qualityRequested: quality, effectiveQuality: quality === "auto" ? resolved.effectiveQuality : quality });
  return {
    title: "PI OVERDRIVE AI ROUTING",
    preset: { id: resolved.preset, base: resolved.basePreset, displayName: resolved.displayName },
    quality: { requested: quality, resolution: quality === "auto" ? "simple→low, normal→medium, hard→high, critical→max; security risk may elevate to high" : "explicit session overlay; security constraints may elevate" },
    roles: MODEL_ROLES.map((role) => ({
      role,
      mode: (ROUTING_POLICY as any).presets[resolved.basePreset].roles[role].mode,
      selected: resolved.roles[role],
      fallbackChain: resolved.routeChains[role].map((candidate: any) => ({
        index: candidate.fallbackIndex,
        provider: candidate.provider,
        modelId: candidate.modelId,
        identity: candidate.model,
        source: candidate.source,
        family: candidate.family,
        effort: candidate.desiredThinking ?? candidate.configuredThinking,
        callability: candidate.callability,
      })),
    })),
    deterministicVerification: { position: "before AI tester/review escalation", mandatory: true, failurePropagation: "fail-closed" },
    council: { members: ROUTING_POLICY.council.members, judge: ROUTING_POLICY.council.judge, triggers: ROUTING_POLICY.council.triggers, concurrency: 3, depth: 1, sharedGatewayWarning: "DeepSeek and Qwen share OmniRoute infrastructure" },
    tokenContextPolicy: { toolsFirst: true, stopWhenSolved: true, presetCaps: (ROUTING_POLICY as any).context[resolved.basePreset], correctionRounds: 2, retryPolicy: "one retry only for eligible transient/attested structured-output failures; workflow reserve 3" },
    secondBrain: memoryPolicyTopology(memoryPolicy),
    policyDigest: resolved.digest,
  };
}

export function renderAiTree(resolved: any, quality = getSessionQuality(), json = false): string {
  const tree: any = aiTreeObject(resolved, quality);
  if (json) return JSON.stringify(tree, null, 2);
  const roleLines = tree.roles.flatMap((entry: any, index: number) => {
    const last = index === tree.roles.length - 1;
    const arm = last ? "└──" : "├──";
    const pad = last ? "    " : "│   ";
    const selected = entry.selected;
    const chain = entry.fallbackChain.map((candidate: any) => `${candidate.source} ${candidate.identity}:${candidate.effort} [${candidate.callability.runtimeStatus}/${candidate.callability.authenticationStatus}]`).join(" → ");
    return [`${arm} ${entry.role} [${entry.mode}]`, `${pad}selected: ${selected.source} ${selected.model}:${selected.thinking} (fallback ${selected.fallbackIndex})`, `${pad}chain: ${chain}`];
  });
  return [
    tree.title,
    `Preset: ${tree.preset.displayName} (${tree.preset.id})`,
    `Quality: ${quality} (session)` ,
    `Quality resolution: ${tree.quality.resolution}`,
    "Task Router",
    ...roleLines,
    "Verification: deterministic/local tools first; non-zero exit cannot become PASS",
    `Council: conditional; ${tree.council.triggers.join("; ")}`,
    "Council topology: OpenAI direct + DeepSeek via OmniRoute + Qwen via OmniRoute → GPT-6 Astra Judge (exact route shown above)",
    "Diversity note: DeepSeek and Qwen are model-family diverse but share the OmniRoute gateway",
    `Context: tools-first, compact handoffs <=${tree.tokenContextPolicy.presetCaps.handoffChars} chars, stop when solved, corrections<=2`,
    "Second Brain",
    `├── Current-context check → Memory Router (${tree.secondBrain.router})`,
    `├── OpenViking: ${tree.secondBrain.openViking}`,
    `├── Hindsight: ${tree.secondBrain.hindsight}`,
    `├── ACE: ${tree.secondBrain.ace}`,
    `├── Shared Memory Pack: ${tree.secondBrain.sharedMemoryPack}`,
    `├── Memory Curator: ${tree.secondBrain.curator}`,
    `└── Token Governor memory policy: ${tree.secondBrain.tokenGovernor}`,
    `Policy receipt: ${tree.policyDigest.slice(0, 16)}`,
  ].join("\n");
}

function presetStatus(stored: any, quality: string): string {
  const base = stored.preset === "custom" ? stored.basePreset : stored.preset;
  return [
    `Preset: ${(ROUTING_POLICY as any).presets[base].displayName} (${stored.preset})`,
    `Quality: ${quality} (session)`,
    `Strategy: ${(ROUTING_POLICY as any).presets[base].description}`,
    "Available: normal — direct proven models first; token-saver — tools-first and minimal fan-out",
    "Compatibility: efficient is accepted as an alias for normal",
  ].join("\n");
}

function qualityStatus(quality: string): string {
  return [
    `Quality: ${quality} (session)`,
    `Available: ${QUALITY_LEVELS.join(", ")}`,
    quality === "auto" ? "Adaptive difficulty: simple→low, normal→medium, hard→high, critical→max." : `Explicit ${quality} overlay is active for this session.`,
    "Security and hard-correctness constraints always take precedence. New Pi sessions reset quality to auto.",
  ].join("\n");
}

function publicInventory(ctx: ExtensionContext): object {
  const available = ctx.modelRegistry.getAvailable();
  const registered = ctx.modelRegistry.getAll();
  const availableByProvider = new Map<string, number>();
  for (const model of available) availableByProvider.set(model.provider, (availableByProvider.get(model.provider) ?? 0) + 1);
  const providers = [...new Set([...ctx.modelRegistry.getRegisteredProviderIds(), ...registered.map((model) => model.provider)])].sort().map((provider) => ({
    provider,
    configured: ctx.modelRegistry.getProviderAuthStatus(provider).configured,
    availableModels: availableByProvider.get(provider) ?? 0,
  }));
  return { availableModels: publicModelCatalog(registered, available), providers };
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
  resetSessionQuality();
  pi.registerCommand("task-policy", {
    description: "Inspect the deterministic policy for a task without making a model call",
    handler: async (args, ctx) => {
      try {
        let task = args.trim();
        const json = task.startsWith("--json ");
        if (json) task = task.slice("--json ".length).trim();
        if (!task) throw new Error("usage: /task-policy [--json] TASK");
        const stored = readModelPolicy();
        const preset = stored.preset === "custom" ? stored.basePreset : stored.preset;
        ctx.ui.notify(renderTaskPolicy(resolveTaskPolicy({ task, preset, quality: getSessionQuality(), availableContext: availableContextFromPiUsage(ctx.getContextUsage()) }), json), "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("models", {
    description: "List registered/authenticated models and public callability metadata",
    handler: async (_args, ctx) => { try { ctx.ui.notify(JSON.stringify(publicInventory(ctx), null, 2), "info"); } catch (error) { notifyError(ctx, error); } },
  });
  pi.registerCommand("preset", {
    description: "Show or select persistent routing preset: /preset [normal|token-saver]",
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        if (!action) { ctx.ui.notify(presetStatus(readModelPolicy(), getSessionQuality()), "info"); return; }
        const selected = parsePreset(action);
        if (selected === "custom") throw new Error("usage: /preset [normal|token-saver]");
        const stored = policyWithPreset(readModelPolicy(), selected);
        writeModelPolicy(modelPolicyPath(), stored);
        const resolvedForSettings = resolveForContext(ctx, stored, "auto");
        syncUserSubagentSettings(resolvedForSettings);
        emitRoutingMetadata(pi, { kind: "preset-change", preset: stored.preset, qualityRequested: getSessionQuality() });
        ctx.ui.notify(`${presetStatus(stored, getSessionQuality())}\nCouncil: conditional; never enabled merely because it exists.`, "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("quality", {
    description: "Show or select session quality: /quality [auto|low|medium|high|max]",
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        if (action) {
          setSessionQuality(action);
          emitRoutingMetadata(pi, { kind: "quality-change", preset: readModelPolicy().preset, qualityRequested: getSessionQuality() });
        }
        ctx.ui.notify(qualityStatus(getSessionQuality()), "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("ai-tree", {
    description: "Show the effective routing architecture without making a model call",
    handler: async (args, ctx) => {
      try {
        const action = args.trim();
        if (action && action !== "--json") throw new Error("usage: /ai-tree [--json]");
        ctx.ui.notify(renderAiTree(resolveForContext(ctx), getSessionQuality(), action === "--json"), "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("model-routing", {
    description: "Show the effective role routing and policy receipt",
    handler: async (_args, ctx) => { try { ctx.ui.notify(renderRouting(resolveForContext(ctx)), "info"); } catch (error) { notifyError(ctx, error); } },
  });
  pi.registerCommand("council-status", {
    description: "Show Council routes, triggers, independence, and hard limits",
    handler: async (_args, ctx) => { try { ctx.ui.notify(renderCouncilStatus(resolveForContext(ctx)), "info"); } catch (error) { notifyError(ctx, error); } },
  });
  pi.registerCommand("council", {
    description: "Run a user-requested task through the enforced workflow with Council escalation",
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
    description: "List roles or set one persistent route: /model-role ROLE PROVIDER/MODEL[:THINKING]",
    handler: async (args, ctx) => {
      try {
        const [role, ...selectionParts] = args.trim().split(/\s+/u);
        if (!role || role === "list") { ctx.ui.notify(MODEL_ROLES.join("\n"), "info"); return; }
        if (!MODEL_ROLES.includes(role as any) || selectionParts.length !== 1) throw new Error("usage: /model-role ROLE PROVIDER/MODEL[:THINKING]");
        const models = ctx.modelRegistry.getAvailable();
        const options = { registeredModels: ctx.modelRegistry.getAll() };
        const stored = policyWithRole(readModelPolicy(), role, parseModelSelection(selectionParts[0], models, options));
        writeModelPolicy(modelPolicyPath(), stored);
        const resolved: any = resolveModelPolicy(models, stored, { ...options, qualityRequested: "auto", effectiveQuality: "medium" });
        syncUserSubagentSettings(resolved);
        ctx.ui.notify(`${role} -> ${resolved.roles[role].model}:${resolved.roles[role].thinking}\nPersistent policy updated.`, "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand("model-preset", {
    description: "Compatibility command for /preset, plus show/preview/custom",
    handler: async (args, ctx) => {
      try {
        const action = args.trim() || "list";
        if (action === "list") { ctx.ui.notify(`${MODEL_PRESETS.join("\n")}\nefficient (alias → normal)`, "info"); return; }
        const models = ctx.modelRegistry.getAvailable();
        const options = { registeredModels: ctx.modelRegistry.getAll(), qualityRequested: getSessionQuality(), effectiveQuality: getSessionQuality() === "auto" ? "medium" : getSessionQuality() };
        if (action === "show") { ctx.ui.notify(renderRouting(resolveModelPolicy(models, readModelPolicy(), options)), "info"); return; }
        if (action.startsWith("preview ")) {
          const preview = parsePreset(action.slice("preview ".length).trim());
          if (preview === "custom") throw new Error("preview_requires_concrete_preset");
          ctx.ui.notify(`${renderRouting(resolveModelPolicy(models, policyWithPreset(readModelPolicy(), preview), options))}\nPreview only; persistent policy unchanged.`, "info");
          return;
        }
        const selected = parsePreset(action);
        const stored = policyWithPreset(readModelPolicy(), selected);
        writeModelPolicy(modelPolicyPath(), stored);
        const resolved = resolveModelPolicy(models, stored, options);
        syncUserSubagentSettings(resolveModelPolicy(models, stored, { ...options, qualityRequested: "auto", effectiveQuality: "medium" }));
        ctx.ui.notify(`${renderRouting(resolved)}\nPersistent policy updated.`, "info");
      } catch (error) { notifyError(ctx, error); }
    },
  });
}
