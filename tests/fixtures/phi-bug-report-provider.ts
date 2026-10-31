import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function register(pi: ExtensionAPI): void {
  pi.registerProvider("phi-bug-fixture", {
    baseUrl: "http://127.0.0.1.invalid", apiKey: "$PHI_BUG_FIXTURE_KEY", api: "phi-bug-fixture-api",
    models: [{ id: "report", name: "Local bug-report fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 }],
    streamSimple(model: Model<any>, context: Context) {
      const stream = createAssistantMessageEventStream();
      const prompt = context.messages.filter((message) => message.role === "user").at(-1)?.content ?? [];
      const body = typeof prompt === "string" ? prompt : prompt.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const valid = body.includes("Observed issue: controlled-fixture-failure.") && body.includes("Produce a diagnostic report, not a fix.");
      const text = valid
        ? "Symptom: controlled fixture failure. KNOWN: the prompt reached Pi. UNKNOWN: root cause not measured. NOT TESTED: host state. Next step: inspect only the relevant failing check."
        : "TEMPLATE_NOT_EXPANDED";
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: model.api,
        provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
