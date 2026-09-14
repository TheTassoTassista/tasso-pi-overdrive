import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pruneKnownTraceLogs, resolveRetentionDays } from "../lib/trace-retention.mjs";

interface TraceRow {
  timestamp: string;
  event: string;
  [key: string]: string | number | boolean | string[] | null | undefined;
}

function safeSessionName(sessionFile: string | undefined): string {
  if (!sessionFile) return `ephemeral-${process.pid}`;
  return path.basename(sessionFile).replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export default function (pi: ExtensionAPI) {
  const startedTools = new Map<string, number>();
  let traceFile: string | undefined;

  const record = async (row: Omit<TraceRow, "timestamp">) => {
    if (!traceFile) return;
    const handle = await open(traceFile, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify({ timestamp: new Date().toISOString(), ...row })}\n`, "utf8");
      await handle.sync();
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
    const root = path.join(stateHome, "pi-overdrive", "traces");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("trace root must be a real directory");
    await chmod(root, 0o700);
    traceFile = path.join(root, `${safeSessionName(ctx.sessionManager.getSessionFile())}.jsonl`);
    await record({ event: "session_start", cwd: ctx.cwd, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined });
    const retention = resolveRetentionDays(process.env.PI_OVERDRIVE_TRACE_RETENTION_DAYS ?? process.env.PI_OVERDRIVE_TRACE_DAYS);
    if (!retention.valid) {
      void record({ event: "trace_retention", status: "SKIPPED_INVALID_CONFIG" });
      return;
    }
    void pruneKnownTraceLogs({ stateHome, days: retention.days }).then(async (summary) => {
      await record({
        event: "trace_retention",
        status: summary.status,
        retentionDays: retention.days,
        scanned: summary.scanned,
        removed: summary.removed,
        capped: summary.capped,
      });
    }).catch(async () => {
      await record({ event: "trace_retention", status: "ERROR" }).catch(() => undefined);
    });
  });
  pi.on("model_select", async (event) => record({ event: "model_select", model: `${event.model.provider}/${event.model.id}`, source: event.source }));
  pi.on("agent_start", async () => record({ event: "agent_start" }));
  pi.on("agent_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    await record({ event: "agent_end", contextTokens: usage?.tokens ?? null, contextPercent: usage?.percent ?? null });
  });
  pi.on("agent_settled", async () => record({ event: "agent_settled" }));
  pi.on("tool_execution_start", async (event) => {
    startedTools.set(event.toolCallId, Date.now());
    await record({ event: "tool_start", tool: event.toolName, inputKeys: Object.keys(event.args ?? {}).sort() });
  });
  pi.on("tool_execution_end", async (event) => {
    const started = startedTools.get(event.toolCallId);
    startedTools.delete(event.toolCallId);
    await record({ event: "tool_end", tool: event.toolName, success: !event.isError, durationMs: started ? Date.now() - started : undefined });
  });
  pi.events.on("pi-overdrive:routing-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "routing_metadata",
      kind: scalar("kind") as string | undefined,
      preset: scalar("preset") as string | undefined,
      qualityRequested: scalar("qualityRequested") as string | undefined,
      effectiveQuality: scalar("effectiveQuality") as string | undefined,
      difficulty: scalar("difficulty") as string | undefined,
      securitySensitive: scalar("securitySensitive") as boolean | undefined,
      role: scalar("role") as string | undefined,
      provider: scalar("provider") as string | undefined,
      model: scalar("model") as string | undefined,
      effort: scalar("effort") as string | undefined,
      fallbackIndex: scalar("fallbackIndex") as number | undefined,
      callNumber: scalar("callNumber") as number | undefined,
      retryCount: scalar("retryCount") as number | undefined,
      modelCallLimit: scalar("modelCallLimit") as number | undefined,
      policyDigest: scalar("policyDigest") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:memory-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "memory_metadata",
      kind: scalar("kind") as string | undefined,
      status: scalar("status") as string | undefined,
      backend: scalar("backend") as string | undefined,
      operation: scalar("operation") as string | undefined,
      decision: scalar("decision") as string | undefined,
      retrievalLevel: scalar("retrievalLevel") as number | undefined,
      sourceCount: scalar("sourceCount") as number | undefined,
      reflectRequested: scalar("reflectRequested") as boolean | undefined,
      retrievedCandidateCount: scalar("retrievedCandidateCount") as number | undefined,
      retrievedItemCount: scalar("retrievedItemCount") as number | undefined,
      packChars: scalar("packChars") as number | undefined,
      approximateTokens: scalar("approximateTokens") as number | undefined,
      degradationCount: scalar("degradationCount") as number | undefined,
      latencyMs: scalar("latencyMs") as number | undefined,
      hindsightRecallUsed: scalar("hindsightRecallUsed") as boolean | undefined,
      hindsightReflectUsed: scalar("hindsightReflectUsed") as boolean | undefined,
      aceEntriesUsed: scalar("aceEntriesUsed") as number | undefined,
      accepted: scalar("accepted") as boolean | undefined,
      dedupeHit: scalar("dedupeHit") as boolean | undefined,
      scanned: scalar("scanned") as number | undefined,
      changed: scalar("changed") as number | undefined,
      rejected: scalar("rejected") as number | undefined,
    });
  });
  pi.events.on("pi-overdrive:tool-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    const names = (key: string) => Array.isArray(data[key]) ? (data[key] as unknown[]).filter((entry): entry is string => typeof entry === "string").slice(0, 64) : undefined;
    await record({
      event: "tool_metadata",
      kind: scalar("kind") as string | undefined,
      mode: scalar("mode") as string | undefined,
      action: scalar("action") as string | undefined,
      tool: scalar("tool") as string | undefined,
      tier: scalar("tier") as string | undefined,
      activeToolCount: scalar("activeToolCount") as number | undefined,
      inactiveToolCount: scalar("inactiveToolCount") as number | undefined,
      decisionModelCalls: scalar("decisionModelCalls") as number | undefined,
      taskPolicyDigest: scalar("taskPolicyDigest") as string | undefined,
      digest: scalar("digest") as string | undefined,
      activeTools: names("activeTools"),
      highRiskActive: names("highRiskActive"),
      unavailableCapabilities: names("unavailableCapabilities"),
    });
  });
  pi.events.on("pi-overdrive:resource-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "resource_metadata",
      kind: scalar("kind") as string | undefined,
      status: scalar("status") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      scheme: scalar("scheme") as string | undefined,
      operation: scalar("operation") as string | undefined,
      trust: scalar("trust") as string | undefined,
      immutable: scalar("immutable") as boolean | undefined,
      contentChars: scalar("contentChars") as number | undefined,
      contentBytes: scalar("contentBytes") as number | undefined,
      truncated: scalar("truncated") as boolean | undefined,
      uriDigest: scalar("uriDigest") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:smart-read-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "smart_read_metadata",
      kind: scalar("kind") as string | undefined,
      access: scalar("access") as string | undefined,
      status: scalar("status") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      selectedMode: scalar("selectedMode") as string | undefined,
      parser: scalar("parser") as string | undefined,
      lspStatus: scalar("lspStatus") as string | undefined,
      language: scalar("language") as string | undefined,
      sourceBytes: scalar("sourceBytes") as number | undefined,
      totalLines: scalar("totalLines") as number | undefined,
      sourceChars: scalar("sourceChars") as number | undefined,
      outputChars: scalar("outputChars") as number | undefined,
      reductionPercent: scalar("reductionPercent") as number | undefined,
      declarationCount: scalar("declarationCount") as number | undefined,
      importCount: scalar("importCount") as number | undefined,
      truncated: scalar("truncated") as boolean | undefined,
      uriDigest: scalar("uriDigest") as string | undefined,
      contentDigest: scalar("contentDigest") as string | undefined,
      taskPolicyDigest: scalar("taskPolicyDigest") as string | undefined,
    });
  });
  pi.on("session_shutdown", async () => record({ event: "session_shutdown" }));

  pi.registerCommand("trace-path", {
    description: "Show the metadata-only trace path for this session",
    handler: async (_args, ctx) => ctx.ui.notify(traceFile ?? "Trace not initialized", "info"),
  });
}
