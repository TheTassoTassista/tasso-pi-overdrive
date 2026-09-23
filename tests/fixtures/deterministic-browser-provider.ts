import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "pi-overdrive-browser-audit";
const modelId = "browser-driver";

function outputMessage(model: Model<any>): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending", timestamp: Date.now(),
  };
}

function addToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, id: string, args: Record<string, unknown>): void {
  const contentIndex = output.content.length;
  const toolCall = { type: "toolCall" as const, id, name: "agent_browser", arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

function addText(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
  const contentIndex = output.content.length;
  output.content.push({ type: "text", text });
  stream.push({ type: "text_start", contentIndex, partial: output });
  stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function streamBrowser(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = outputMessage(model);
    try {
      stream.push({ type: "start", partial: output });
      const completed = context.messages.filter((message) => message.role === "toolResult").length;
      const session = process.env.PI_OVERDRIVE_BROWSER_SESSION;
      const profile = process.env.PI_OVERDRIVE_BROWSER_PROFILE;
      const url = process.env.PI_OVERDRIVE_BROWSER_URL;
      const capture = process.env.PI_OVERDRIVE_BROWSER_CAPTURE;
      if (!session || !profile || !url || !capture) throw new Error("browser audit environment is incomplete");
      const negative = process.env.PI_OVERDRIVE_BROWSER_NEGATIVE === "1";
      if (negative && completed === 0) addToolCall(stream, output, "browser-rejected-eval", { args: ["--session", session, "eval", "process.env"] });
      else if (negative) addText(stream, output, "BROWSER_NEGATIVE_DONE");
      else if (completed === 0) addToolCall(stream, output, "browser-open", { args: ["--session", session, "--profile", profile, "open", url], sessionMode: "fresh", timeoutMs: 120000 });
      else if (completed === 1) addToolCall(stream, output, "browser-snapshot", { args: ["--session", session, "snapshot", "-i"], timeoutMs: 120000 });
      else if (completed === 2) addToolCall(stream, output, "browser-fill", { args: ["--session", session, "fill", "#name", "Tasso"], timeoutMs: 120000 });
      else if (completed === 3) addToolCall(stream, output, "browser-click", { args: ["--session", session, "click", "#submit"], timeoutMs: 120000 });
      else if (completed === 4) addToolCall(stream, output, "browser-wait", { args: ["--session", session, "wait", "--text", "OVERDRIVE_BROWSER_SUBMITTED:Tasso"], timeoutMs: 120000 });
      else if (completed === 5) addToolCall(stream, output, "browser-dom", { args: ["--session", session, "get", "text", "#result"], timeoutMs: 120000 });
      else if (completed === 6) addToolCall(stream, output, "browser-capture", { args: ["--session", session, "screenshot", capture], timeoutMs: 120000 });
      else if (completed === 7) addToolCall(stream, output, "browser-close", { args: ["--session", session, "close"], timeoutMs: 120000 });
      else addText(stream, output, "BROWSER_AUDIT_DONE");
      output.stopReason = completed >= (negative ? 1 : 8) ? "stop" : "toolUse";
      stream.push({ type: "done", reason: output.stopReason, message: output });
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

export default function registerBrowserAuditProvider(pi: ExtensionAPI): void {
  pi.registerProvider(providerId, {
    baseUrl: "http://127.0.0.1.invalid", apiKey: "$PI_OVERDRIVE_BROWSER_AUDIT_KEY", api: "pi-overdrive-browser-audit-api",
    models: [{ id: modelId, name: "Pi Overdrive deterministic browser driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
    streamSimple: streamBrowser,
  });
}
