import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionQuality } from "../lib/routing-session.mjs";
import { readModelPolicy } from "../lib/model-policy.mjs";
import { availableContextFromPiUsage, resolveTaskPolicy } from "../lib/task-governor.mjs";
import { createSecondBrainRuntime, secondBrainHealth } from "../lib/second-brain-runtime.mjs";
import { syncObsidianVault } from "../lib/obsidian-sync.mjs";
import { createMemorySessionSummaryStore } from "../lib/memory-session-summary.mjs";

const MEMORY_MESSAGE = "tasso-pi-overdrive.second-brain";
const retrievalSummary = createMemorySessionSummaryStore();
let runtime: any;
let runtimeCwd = "";

function runtimeFor(ctx: ExtensionContext, pi: ExtensionAPI): any {
  const stored = readModelPolicy();
  const quality = getSessionQuality();
  const preset = stored.preset === "custom" ? stored.basePreset : stored.preset;
  if (!runtime || runtimeCwd !== ctx.cwd || runtime.policy.preset !== preset || runtime.policy.qualityRequested !== quality) {
    runtimeCwd = ctx.cwd;
    runtime = createSecondBrainRuntime({ cwd: ctx.cwd, preset, qualityRequested: quality, effectiveQuality: quality === "auto" ? "medium" : quality, emit: (metadata: object) => pi.events.emit("pi-overdrive:memory-metadata", metadata) });
  }
  return runtime;
}

function compactStatus(health: any): string {
  return [
    `Second Brain: ${health.status} (enabled=${health.enabled})`,
    `OpenViking: ${health.openViking.available ? "available" : `degraded:${health.openViking.reason}`}`,
    `Hindsight: ${health.hindsight.available ? "available" : `degraded:${health.hindsight.reason}`}`,
    `ACE: ${health.ace.available ? `available (${health.ace.total} entries)` : "degraded"}`,
    `Curated ledger: ${health.ledger.available ? `available (${health.ledger.current}/${health.ledger.total} current)` : "degraded"}`,
    `Memory policy: ${health.policy.preset}/${health.policy.qualityRequested} → ${health.policy.effectiveQuality}; pack<=${health.policy.packCharLimit} chars`,
  ].join("\n");
}

function detailedStatus(health: any): string {
  return `${compactStatus(health)}\nProject scope: ${health.projectId}\nLocal search: ${health.policy.localSearch}; candidate cap=${health.policy.candidateLimit}\nOpenViking: L0/L1/selected-L2 enabled; broad L2 disabled\nHindsight Recall: ${health.policy.hindsight.recall}; Reflect: ${health.policy.hindsight.reflect ? "conditional" : "suppressed unless exceptional and explicit"}\nStorage paths and credentials are intentionally omitted from command output.`;
}

function renderSearch(pack: any): string {
  if (pack.route.decision === "NONE") return "Memory retrieval skipped: current context is sufficient.";
  if (!pack.items.length) return `No accepted memory results. Status=${pack.metadata.status}; sources=${pack.route.sources.join(",")}.`;
  return [
    `Memory search: ${pack.metadata.status}; sources=${pack.route.sources.join(",")}; ${pack.items.length}/${pack.metadata.candidateCount} items; ~${pack.metadata.approximateTokens} estimated context tokens.`,
    ...pack.items.map((item: any) => `- ${item.id} [${item.trustLevel}; ${item.backend}; L${item.level}] ${item.content}\n  source: ${item.source}`),
  ].join("\n");
}

export default function secondBrainExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    retrievalSummary.reset();
    ctx.ui.setStatus("second-brain", "memory: lazy");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const stored = readModelPolicy();
      const taskPolicy = resolveTaskPolicy({
        task: event.prompt,
        preset: stored.preset === "custom" ? stored.basePreset : stored.preset,
        quality: getSessionQuality(),
        availableContext: availableContextFromPiUsage(ctx.getContextUsage()),
      });
      if (!taskPolicy.needs.secondBrain) {
        retrievalSummary.record({ outcome: "SKIPPED", reason: "task-policy-current-context-sufficient" });
        ctx.ui.setStatus("second-brain", "memory: skipped (context sufficient)");
        pi.events.emit("pi-overdrive:memory-metadata", { kind: "memory_policy_skip", reason: "task_policy_current_context_sufficient", taskPolicyDigest: taskPolicy.digest });
        return undefined;
      }
      const active = runtimeFor(ctx, pi);
      const pack = await active.controller.build(event.prompt);
      if (!pack.text) {
        retrievalSummary.record({ pack, outcome: "EMPTY" });
        ctx.ui.setStatus("second-brain", `memory: empty (${pack.metadata.status.toLowerCase()})`);
        return undefined;
      }
      retrievalSummary.record({ pack, outcome: "ATTACHED" });
      ctx.ui.setStatus("second-brain", `memory: attached (${pack.metadata.itemCount})`);
      return { message: { customType: MEMORY_MESSAGE, content: pack.text, display: false, details: { id: pack.id, route: pack.route.decision, itemCount: pack.metadata.itemCount, approximateTokens: pack.metadata.approximateTokens } } };
    } catch {
      retrievalSummary.record({ outcome: "UNAVAILABLE", reason: "retrieval-error" });
      ctx.ui.setStatus("second-brain", "memory: unavailable");
      pi.events.emit("pi-overdrive:memory-metadata", { kind: "memory_degradation_event", backend: "controller", reason: "unavailable" });
      return undefined;
    }
  });

  pi.registerCommand("memory", {
    description: "Show Second Brain state, or explicitly curate: /memory [remember|learn|sync] ...",
    handler: async (args, ctx) => {
      try {
        const active = runtimeFor(ctx, pi);
        const value = args.trim();
        if (!value) { ctx.ui.notify(compactStatus(await secondBrainHealth(active)), "info"); return; }
        if (value === "sync") {
          const result = syncObsidianVault({ vaultRoot: active.config.vaultRoot, projectId: active.projectId, ledger: active.ledger });
          pi.events.emit("pi-overdrive:memory-metadata", { kind: "obsidian_sync", scanned: result.scanned, changed: result.changed, accepted: result.accepted, rejected: result.rejected });
          ctx.ui.notify(`Obsidian sync complete: ${result.accepted} accepted, ${result.rejected} rejected, ${result.changed} changed.`, "info");
          return;
        }
        if (value.startsWith("remember ")) {
          const content = value.slice("remember ".length).trim();
          const result = active.ledger.accept({ type: "decision", project: active.projectId, content, source: "explicit user decision", sourceType: "user", trustLevel: "USER", confidence: 1, verified: false, importance: "high", retentionDays: 0, tags: ["user-decision"], reason: "User explicitly requested durable memory" });
          pi.events.emit("pi-overdrive:memory-metadata", { kind: "memory_write_candidate", accepted: result.status === "ACCEPTED", reason: result.reason, dedupeHit: result.dedupeHit === true });
          const projection = result.entry ? await active.publishDurable(result.entry) : undefined;
          ctx.ui.notify(`Memory ${result.status}${result.entry ? `: ${result.entry.id}; local services=${projection.status}` : ` (${result.reason})`}.`, result.status === "ACCEPTED" ? "info" : "warning");
          return;
        }
        if (value.startsWith("learn ")) {
          const procedure = value.slice("learn ".length).trim();
          const result = active.ace.add({ title: procedure.slice(0, 120), procedure, project: active.projectId, outcome: "success", source: "explicit user lesson", sourceType: "user", verified: false, tags: ["user-lesson"], reason: "User explicitly requested a reusable lesson" });
          pi.events.emit("pi-overdrive:memory-metadata", { kind: "memory_write_candidate", backend: "ace", accepted: result.status === "ACCEPTED", reason: result.reason, dedupeHit: result.dedupeHit === true });
          ctx.ui.notify(`ACE lesson ${result.status}${result.entry ? `: ${result.entry.id}` : ` (${result.reason})`}.`, result.status === "ACCEPTED" ? "info" : "warning");
          return;
        }
        throw new Error("usage: /memory [remember TEXT|learn PROCEDURE|sync]");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show detailed zero-model-call Second Brain health and policy",
    handler: async (_args, ctx) => { try { ctx.ui.notify(detailedStatus(await secondBrainHealth(runtimeFor(ctx, pi))), "info"); } catch (error) { ctx.ui.notify(`Second Brain degraded: ${error instanceof Error ? error.message : String(error)}`, "warning"); } },
  });
  pi.registerCommand("memory-last", {
    description: "Summarize the last automatic memory-context decision in this session",
    handler: async (_args, ctx) => { ctx.ui.notify(retrievalSummary.render(), "info"); },
  });
  pi.registerCommand("memory-search", {
    description: "Search curated/OpenViking/Hindsight/ACE memory without a Pi model call",
    handler: async (args, ctx) => {
      try {
        const query = args.trim();
        if (!query) throw new Error("usage: /memory-search QUERY");
        ctx.ui.notify(renderSearch(await runtimeFor(ctx, pi).controller.build(query, { currentContextSufficient: false })), "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("memory-recent", {
    description: "Show recent accepted durable memories",
    handler: async (_args, ctx) => {
      try {
        const active = runtimeFor(ctx, pi);
        const entries = active.ledger.recent({ project: active.projectId, limit: 10 });
        ctx.ui.notify(entries.length ? entries.map((entry: any) => `${entry.id} [${entry.trustLevel}] ${entry.content}`).join("\n") : "No current durable memories.", "info");
      } catch (error) { ctx.ui.notify(`Curated memory unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
    },
  });
  pi.registerCommand("memory-why", {
    description: "Explain provenance/currentness for one memory: /memory-why ID",
    handler: async (args, ctx) => {
      try {
        const active = runtimeFor(ctx, pi);
        const entry = active.ledger.get(args.trim());
        if (!entry) throw new Error("memory_not_found");
        ctx.ui.notify([`Memory: ${entry.id}`, `Why: ${entry.reason}`, `Source: ${entry.source} (${entry.sourceType})`, `Trust/confidence: ${entry.trustLevel}/${entry.confidence}; verified=${entry.verified}`, `Current: ${entry.current}; supersedes=${entry.supersedes ?? "none"}; superseded-by=${entry.supersededBy ?? "none"}`, `Retention: ${entry.retentionDays === 0 ? "durable" : `${entry.retentionDays} days`}`].join("\n"), "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}

export { compactStatus as renderMemoryStatus, detailedStatus as renderDetailedMemoryStatus, renderSearch as renderMemorySearch };
