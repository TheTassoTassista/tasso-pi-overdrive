import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pruneKnownTraceLogs, resolveRetentionDays } from "../lib/trace-retention.mjs";
import { agentHubTraceMetadata } from "../lib/agent-hub.mjs";
import { directorTraceMetadata } from "../lib/director-mode.mjs";

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
  pi.events.on("pi-overdrive:rule-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "rule_metadata",
      kind: scalar("kind") as string | undefined,
      status: scalar("status") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      decisionModelCalls: scalar("decisionModelCalls") as number | undefined,
      candidateCount: scalar("candidateCount") as number | undefined,
      acceptedCount: scalar("acceptedCount") as number | undefined,
      matchedCount: scalar("matchedCount") as number | undefined,
      deliveredCount: scalar("deliveredCount") as number | undefined,
      nativeCount: scalar("nativeCount") as number | undefined,
      unrelatedCount: scalar("unrelatedCount") as number | undefined,
      duplicateCount: scalar("duplicateCount") as number | undefined,
      conflictCount: scalar("conflictCount") as number | undefined,
      rejectedCount: scalar("rejectedCount") as number | undefined,
      securityOverrideAttempts: scalar("securityOverrideAttempts") as number | undefined,
      truncatedRuleCount: scalar("truncatedRuleCount") as number | undefined,
      omittedForBudget: scalar("omittedForBudget") as number | undefined,
      packChars: scalar("packChars") as number | undefined,
      approximateTokens: scalar("approximateTokens") as number | undefined,
      cacheHits: scalar("cacheHits") as number | undefined,
      cacheMisses: scalar("cacheMisses") as number | undefined,
      registryDigest: scalar("registryDigest") as string | undefined,
      packDigest: scalar("packDigest") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:commit-plan-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "commit_plan_metadata",
      kind: scalar("kind") as string | undefined,
      status: scalar("status") as string | undefined,
      operation: scalar("operation") as string | undefined,
      scope: scalar("scope") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      decisionModelCalls: scalar("decisionModelCalls") as number | undefined,
      changedFileCount: scalar("changedFileCount") as number | undefined,
      protectedChangedFileCount: scalar("protectedChangedFileCount") as number | undefined,
      selectedFileCount: scalar("selectedFileCount") as number | undefined,
      excludedChangedFileCount: scalar("excludedChangedFileCount") as number | undefined,
      groupCount: scalar("groupCount") as number | undefined,
      snapshotDigest: scalar("snapshotDigest") as string | undefined,
      planDigest: scalar("planDigest") as string | undefined,
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
      lspClassification: scalar("lspClassification") as string | undefined,
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
  pi.events.on("pi-overdrive:artifact-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "artifact_metadata",
      kind: scalar("kind") as string | undefined,
      status: scalar("status") as string | undefined,
      producerTool: scalar("producerTool") as string | undefined,
      sourceBytes: scalar("sourceBytes") as number | undefined,
      storedBytes: scalar("storedBytes") as number | undefined,
      previewChars: scalar("previewChars") as number | undefined,
      lines: scalar("lines") as number | undefined,
      redacted: scalar("redacted") as boolean | undefined,
      sanitizedControls: scalar("sanitizedControls") as boolean | undefined,
      deduplicated: scalar("deduplicated") as boolean | undefined,
      artifactDigest: scalar("artifactDigest") as string | undefined,
      sessionDigest: scalar("sessionDigest") as string | undefined,
      taskDigest: scalar("taskDigest") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      scannedArtifacts: scalar("scannedArtifacts") as number | undefined,
      removedArtifacts: scalar("removedArtifacts") as number | undefined,
      scannedOrphans: scalar("scannedOrphans") as number | undefined,
      removedOrphans: scalar("removedOrphans") as number | undefined,
      skipped: scalar("skipped") as number | undefined,
      capped: scalar("capped") as boolean | undefined,
    });
  });
  pi.events.on("pi-overdrive:context-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    const reductions = Array.isArray(data.reductions) ? (data.reductions as Array<Record<string, unknown>>).slice(0, 5) : [];
    const reductionStages = reductions.map((entry) => typeof entry.name === "string" ? entry.name : "unknown");
    const reductionSavedTokens = reductions.reduce((total, entry) => total + (Number.isSafeInteger(entry.savedTokens) && Number(entry.savedTokens) >= 0 ? Number(entry.savedTokens) : 0), 0);
    const reductionChangedMessages = reductions.reduce((total, entry) => total + (Number.isSafeInteger(entry.changedMessages) && Number(entry.changedMessages) >= 0 ? Number(entry.changedMessages) : 0), 0);
    await record({
      event: "context_metadata",
      kind: scalar("kind") as string | undefined,
      status: scalar("status") as string | undefined,
      reason: scalar("reason") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      provider: scalar("provider") as string | undefined,
      model: scalar("model") as string | undefined,
      contextWindow: scalar("contextWindow") as number | undefined,
      reserveOutputTokens: scalar("reserveOutputTokens") as number | undefined,
      safetyTokens: scalar("safetyTokens") as number | undefined,
      usableInputTokens: scalar("usableInputTokens") as number | undefined,
      initialInputTokens: scalar("initialInputTokens") as number | undefined,
      finalInputTokens: scalar("finalInputTokens") as number | undefined,
      messageCount: scalar("messageCount") as number | undefined,
      toolCount: scalar("toolCount") as number | undefined,
      reductionStages,
      reductionSavedTokens,
      reductionChangedMessages,
      requiresConversationCompaction: scalar("requiresConversationCompaction") as boolean | undefined,
      routeSwitchPermitted: scalar("routeSwitchPermitted") as boolean | undefined,
      proofDigest: scalar("proofDigest") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:edit-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "edit_metadata",
      kind: scalar("kind") as string | undefined,
      status: scalar("status") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      contract: scalar("contract") as string | undefined,
      pathDigest: scalar("pathDigest") as string | undefined,
      contentDigest: scalar("contentDigest") as string | undefined,
      beforeDigest: scalar("beforeDigest") as string | undefined,
      afterDigest: scalar("afterDigest") as string | undefined,
      receiptDigest: scalar("receiptDigest") as string | undefined,
      seenRangeCount: scalar("seenRangeCount") as number | undefined,
      totalLines: scalar("totalLines") as number | undefined,
      editCount: scalar("editCount") as number | undefined,
      matchCount: scalar("matchCount") as number | undefined,
      recovered: scalar("recovered") as boolean | undefined,
      syntaxStatus: scalar("syntaxStatus") as string | undefined,
      patternDigest: scalar("patternDigest") as string | undefined,
      rewriteDigest: scalar("rewriteDigest") as string | undefined,
      lspStatus: scalar("lspStatus") as string | undefined,
      baselineErrorCount: scalar("baselineErrorCount") as number | undefined,
      candidateErrorCount: scalar("candidateErrorCount") as number | undefined,
      postErrorCount: scalar("postErrorCount") as number | undefined,
      baselineDiagnosticDigest: scalar("baselineDiagnosticDigest") as string | undefined,
      candidateDiagnosticDigest: scalar("candidateDiagnosticDigest") as string | undefined,
      postDiagnosticDigest: scalar("postDiagnosticDigest") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:dap-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "dap_metadata",
      kind: scalar("kind") as string | undefined,
      action: scalar("action") as string | undefined,
      status: scalar("status") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      adapter: scalar("adapter") as string | undefined,
      state: scalar("state") as string | undefined,
      sandboxed: scalar("sandboxed") as boolean | undefined,
      network: scalar("network") as boolean | undefined,
      workspaceReadOnly: scalar("workspaceReadOnly") as boolean | undefined,
      programDigest: scalar("programDigest") as string | undefined,
      breakpointCount: scalar("breakpointCount") as number | undefined,
      outputBytes: scalar("outputBytes") as number | undefined,
      outputTruncated: scalar("outputTruncated") as boolean | undefined,
      frameCount: scalar("frameCount") as number | undefined,
      scopeCount: scalar("scopeCount") as number | undefined,
      variableCount: scalar("variableCount") as number | undefined,
    });
  });
  pi.events.on("pi-overdrive:eval-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "eval_metadata",
      kind: scalar("kind") as string | undefined,
      language: scalar("language") as string | undefined,
      dialect: scalar("dialect") as string | undefined,
      action: scalar("action") as string | undefined,
      status: scalar("status") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      state: scalar("state") as string | undefined,
      sandboxed: scalar("sandboxed") as boolean | undefined,
      network: scalar("network") as boolean | undefined,
      projectWorkspaceMounted: scalar("projectWorkspaceMounted") as boolean | undefined,
      hostUserFilesystem: scalar("hostUserFilesystem") as boolean | undefined,
      systemRuntimeReadOnly: scalar("systemRuntimeReadOnly") as boolean | undefined,
      subprocessBridge: scalar("subprocessBridge") as boolean | undefined,
      persistent: scalar("persistent") as boolean | undefined,
      activeKernels: scalar("activeKernels") as number | undefined,
      durationMs: scalar("durationMs") as number | undefined,
      outputBytes: scalar("outputBytes") as number | undefined,
      outputTruncated: scalar("outputTruncated") as boolean | undefined,
      valueTruncated: scalar("valueTruncated") as boolean | undefined,
      starts: scalar("starts") as number | undefined,
      executions: scalar("executions") as number | undefined,
      timeouts: scalar("timeouts") as number | undefined,
      crashes: scalar("crashes") as number | undefined,
      cleanups: scalar("cleanups") as number | undefined,
    });
  });
  pi.events.on("pi-overdrive:streamguard-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "stream_guard_metadata",
      kind: scalar("kind") as string | undefined,
      version: scalar("version") as number | undefined,
      status: scalar("status") as string | undefined,
      reservationId: scalar("reservationId") as string | undefined,
      reservationDigest: scalar("reservationDigest") as string | undefined,
      rule: scalar("rule") as string | undefined,
      ruleDigest: scalar("ruleDigest") as string | undefined,
      source: scalar("source") as string | undefined,
      toolName: scalar("toolName") as string | undefined,
      streamKeyDigest: scalar("streamKeyDigest") as string | undefined,
      turnSerial: scalar("turnSerial") as number | undefined,
      outcome: scalar("outcome") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:sentinel-metadata", async (value) => {
    const data = value as Record<string, unknown>;
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "sentinel_metadata",
      kind: scalar("kind") as string | undefined,
      version: scalar("version") as number | undefined,
      status: scalar("status") as string | undefined,
      errorCode: scalar("errorCode") as string | undefined,
      provider: scalar("provider") as string | undefined,
      model: scalar("model") as string | undefined,
      thinking: scalar("thinking") as string | undefined,
      thinkingSource: scalar("thinkingSource") as string | undefined,
      launchStatus: scalar("launchStatus") as string | undefined,
      modelCalls: scalar("modelCalls") as number | undefined,
      inputChars: scalar("inputChars") as number | undefined,
      inputTokensEstimate: scalar("inputTokensEstimate") as number | undefined,
      maxOutputTokens: scalar("maxOutputTokens") as number | undefined,
      estimatedCostCeilingUsd: scalar("estimatedCostCeilingUsd") as number | undefined,
      usageStatus: scalar("usageStatus") as string | undefined,
      actualCostUsd: scalar("actualCostUsd") as number | undefined,
      outputChars: scalar("outputChars") as number | undefined,
      evidenceCount: scalar("evidenceCount") as number | undefined,
      taskPolicyDigest: scalar("taskPolicyDigest") as string | undefined,
      modelPolicyDigest: scalar("modelPolicyDigest") as string | undefined,
      adviceDigest: scalar("adviceDigest") as string | undefined,
      receiptDigest: scalar("receiptDigest") as string | undefined,
      parentReceiptDigest: scalar("parentReceiptDigest") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:agent-hub-metadata", async (value) => {
    let data: Record<string, unknown>;
    try { data = agentHubTraceMetadata(value) as Record<string, unknown>; }
    catch {
      await record({ event: "agent_hub_metadata", status: "REJECTED_INVALID_EVENT" });
      return;
    }
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "agent_hub_metadata",
      kind: scalar("kind") as string | undefined,
      source: scalar("source") as string | undefined,
      runId: scalar("runId") as string | undefined,
      taskDigest: scalar("taskDigest") as string | undefined,
      checkpointSequence: scalar("checkpointSequence") as number | undefined,
      lifecycleStatus: scalar("lifecycleStatus") as string | undefined,
      workflowStatus: scalar("workflowStatus") as string | undefined,
      currentPhase: scalar("currentPhase") as string | undefined,
      role: scalar("role") as string | undefined,
      sequence: scalar("sequence") as number | undefined,
      attempt: scalar("attempt") as number | undefined,
      status: scalar("status") as string | undefined,
      provider: scalar("provider") as string | undefined,
      model: scalar("model") as string | undefined,
      thinking: scalar("thinking") as string | undefined,
      receiptDigest: scalar("receiptDigest") as string | undefined,
    });
  });
  pi.events.on("pi-overdrive:director-metadata", async (value) => {
    let data: Record<string, unknown>;
    try { data = directorTraceMetadata(value) as Record<string, unknown>; }
    catch {
      await record({ event: "director_metadata", status: "REJECTED_INVALID_EVENT" });
      return;
    }
    const scalar = (key: string) => ["string", "number", "boolean"].includes(typeof data[key]) ? data[key] as string | number | boolean : undefined;
    await record({
      event: "director_metadata",
      status: scalar("status") as string | undefined,
      reasonCode: scalar("reasonCode") as string | undefined,
      sessionDigest: scalar("sessionDigest") as string | undefined,
      taskDigest: scalar("taskDigest") as string | undefined,
      taskPolicyDigest: scalar("taskPolicyDigest") as string | undefined,
      activeToolCount: scalar("activeToolCount") as number | undefined,
      blockedTool: scalar("blockedTool") as string | undefined,
    });
  });
  pi.on("session_shutdown", async () => record({ event: "session_shutdown" }));

  pi.registerCommand("trace-path", {
    description: "Show the metadata-only trace path for this session",
    handler: async (_args, ctx) => ctx.ui.notify(traceFile ?? "Trace not initialized", "info"),
  });
}
