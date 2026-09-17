import fs from "node:fs";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function appendAudit(value: object): void {
  const file = process.env.PI_OVERDRIVE_SENTINEL_AUDIT_FILE;
  if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function emitText(stream: AssistantMessageEventStream, output: AssistantMessage, value: string): void {
  output.content.push({ type: "text", text: value });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
}

function streamSentinel(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      providerThinkingLevel: options?.reasoning,
      usage: { input: 400, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending", timestamp: Date.now(),
    };
    try {
      appendAudit({
        kind: "sentinel_provider_call", provider: model.provider, model: model.id, reasoning: options?.reasoning ?? null,
        maxRetries: options?.maxRetries ?? null, maxTokens: options?.maxTokens ?? null, timeoutMs: options?.timeoutMs ?? null,
        cacheRetention: options?.cacheRetention ?? null, toolCount: context.tools?.length ?? 0, messageCount: context.messages.length,
      });
      stream.push({ type: "start", partial: output });
      const value = JSON.stringify({
        version: 1,
        severity: "CONCERN",
        summary: "The reported timing failure needs a deterministic scheduling reproduction.",
        evidence: ["The supplied task classifies the defect as intermittent and load-sensitive."],
        recommendation: "Capture the failing interleaving before changing synchronization.",
        confidence: "HIGH",
      });
      emitText(stream, output, value);
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

const cost = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 };
const direct = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra"].map((id) => ({
  id, name: `Deterministic Sentinel ${id}`, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text"] as ["text"], cost, contextWindow: 278528, maxTokens: 32768,
}));

export default function deterministicSentinelProvider(pi: ExtensionAPI): void {
  pi.events.on("pi-overdrive:sentinel-metadata", (value) => appendAudit({ auditKind: "sentinel_metadata", ...(value as object) }));
  pi.events.on("pi-overdrive:context-metadata", (value) => appendAudit({ auditKind: "context_metadata", ...(value as object) }));
  pi.registerProvider("pi-overdrive-sentinel-audit", {
    name: "Deterministic Sentinel command driver", baseUrl: "http://127.0.0.1.invalid", apiKey: "$PI_OVERDRIVE_SENTINEL_AUDIT_KEY", api: "pi-overdrive-sentinel-driver-api",
    models: [{ id: "driver", name: "Sentinel command driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple: streamSentinel,
  });
  pi.registerProvider("openai-codex", {
    name: "Deterministic Sentinel Oracle catalog", baseUrl: "http://127.0.0.1.invalid", apiKey: "$PI_OVERDRIVE_SENTINEL_AUDIT_KEY", api: "pi-overdrive-sentinel-oracle-api",
    models: direct, streamSimple: streamSentinel,
  });
}
