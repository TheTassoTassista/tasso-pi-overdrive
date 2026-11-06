import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createArtifactStore, defaultArtifactRoot, pruneArtifactStore, readArtifactPolicy, sanitizeArtifactText } from "../lib/artifact-store.mjs";
import { compactToolText } from "../lib/output-optimizer.mjs";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "artifact_externalization_failed";
  return /^artifact_[a-z0-9_]+$/u.test(code) ? code : "artifact_externalization_failed";
}

export default function artifactsExtension(pi: ExtensionAPI): void {
  let policy: ReturnType<typeof readArtifactPolicy> | undefined;
  let policyError: string | undefined;
  try { policy = readArtifactPolicy(); }
  catch (error) { policyError = safeErrorCode(error); }
  let store: any;
  let taskDigest = digest("artifact-task-unassigned");
  const stats = { externalized: 0, deduplicated: 0, sourceBytes: 0, storedBytes: 0, previewChars: 0, failures: 0, pruned: 0 };

  pi.on("session_start", (_event, ctx) => {
    if (!policy) {
      pi.events.emit("pi-overdrive:artifact-metadata", { kind: "artifact_retention", status: "SKIPPED_ARTIFACT_POLICY", errorCode: policyError });
      return;
    }
    const root = defaultArtifactRoot();
    store = createArtifactStore({ root, sessionIdentity: ctx.sessionManager.getSessionFile() ?? undefined, cwd: ctx.cwd, policy });
    const pruned = pruneArtifactStore({ root });
    stats.pruned += pruned.removedArtifacts;
    pi.events.emit("pi-overdrive:artifact-metadata", { kind: "artifact_retention", status: pruned.status, scannedArtifacts: pruned.scannedArtifacts, removedArtifacts: pruned.removedArtifacts, scannedOrphans: pruned.scannedOrphans, removedOrphans: pruned.removedOrphans, skipped: pruned.skipped, capped: pruned.capped });
  });

  pi.on("before_agent_start", (event) => { taskDigest = event.messageType === "user" ? digest(event.prompt) : ""; });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "resource_fs" && /^artifact:\/\//iu.test(String(event.input?.uri ?? ""))) return undefined;
    const textBlocks = event.content.filter((block) => block.type === "text");
    if (!textBlocks.length) return undefined;
    const fullText = textBlocks.map((block: any) => String(block.text ?? "")).join("\n");
    if (Buffer.byteLength(fullText) <= (policy?.inlineThresholdBytes ?? 12_000)) return undefined;
    try {
      if (!store) throw Object.assign(new Error("artifact_session_unavailable"), { code: "artifact_session_unavailable" });
      const saved = await store.save(fullText, { producerTool: event.toolName, taskDigest, mime: "text/plain" });
      stats.externalized += 1;
      stats.deduplicated += Number(saved.metadata.deduplicated);
      stats.sourceBytes += saved.metadata.sourceBytes;
      stats.storedBytes += saved.metadata.sizeBytes;
      stats.previewChars += saved.preview.length;
      pi.events.emit("pi-overdrive:artifact-metadata", {
        kind: "artifact_externalized", status: "PASS", producerTool: event.toolName,
        sourceBytes: saved.metadata.sourceBytes, storedBytes: saved.metadata.sizeBytes, previewChars: saved.preview.length,
        lines: saved.metadata.lines, redacted: saved.metadata.redacted, sanitizedControls: saved.metadata.sanitizedControls,
        deduplicated: saved.metadata.deduplicated, artifactDigest: saved.metadata.sha256,
        sessionDigest: saved.metadata.sessionDigest, taskDigest,
      });
      const nonText = event.content.filter((block) => block.type !== "text");
      const priorDetails = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details : {};
      return { content: [{ type: "text", text: saved.preview }, ...nonText], details: { ...priorDetails, artifact: saved.metadata } };
    } catch (error) {
      stats.failures += 1;
      const errorCode = safeErrorCode(error);
      pi.events.emit("pi-overdrive:artifact-metadata", { kind: "artifact_externalized", status: "DEGRADED", producerTool: event.toolName, sourceBytes: Buffer.byteLength(fullText), errorCode, taskDigest });
      const safe = sanitizeArtifactText(fullText);
      const compacted = compactToolText(safe.text, { maxChars: policy?.previewMaxChars ?? 6_000, maxLines: 120, headLines: 30, tailLines: 40, diagnosticLines: 40 });
      return { content: [{ type: "text", text: `${compacted.text}\n[Artifact externalization unavailable (${errorCode}); full output was not persisted.]` }, ...event.content.filter((block) => block.type !== "text")] };
    }
  });

  pi.registerCommand("artifacts", {
    description: "Show current session Artifact Store metadata and counters without a model call",
    handler: async (_args, ctx) => {
      try {
        const items = store?.list() ?? [];
        ctx.ui.notify(JSON.stringify({ status: policy ? "PASS" : "DEGRADED", errorCode: policyError, stats, artifacts: items.map((item: any) => ({ uri: item.uri, sha256: item.sha256, sizeBytes: item.sizeBytes, lines: item.lines, mime: item.mime, producerTools: item.producerTools, retentionDays: item.retentionDays, redacted: item.redacted, trust: item.trust })) }, null, 2), "info");
      } catch { ctx.ui.notify("Artifact Store metadata is unavailable.", "warning"); }
    },
  });
}
