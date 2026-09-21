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
  const file = process.env.PI_OVERDRIVE_DIRECTOR_AUDIT_FILE;
  if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function emitText(stream: AssistantMessageEventStream, output: AssistantMessage, value: string): void {
  output.content.push({ type: "text", text: value });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
  output.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
}

function emitToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, name: string, args: object): void {
  const toolCall = { type: "toolCall" as const, id: "director-forbidden-write", name, arguments: args };
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
  output.stopReason = "toolUse";
  stream.push({ type: "done", reason: "toolUse", message: output });
  stream.end();
}

function streamDirector(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending", timestamp: Date.now(),
    };
    try {
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error("director_fixture_aborted");
      stream.push({ type: "start", partial: output });
      const toolResults = context.messages.filter((message) => message.role === "toolResult");
      const tools = (context.tools ?? []).map((tool) => tool.name).sort();
      appendAudit({
        kind: "provider_turn",
        provider: model.provider,
        model: model.id,
        toolResultCount: toolResults.length,
        tools,
        directorPrompt: context.systemPrompt.includes("<pi-overdrive-director>"),
      });
      if (toolResults.length === 0) {
        emitToolCall(stream, output, "write", { path: process.env.PI_OVERDRIVE_DIRECTOR_SENTINEL ?? "director-must-not-write.txt", content: "DIRECT_MUTATION_OCCURRED\n" });
        return;
      }
      const blocked = (toolResults.at(-1)?.content ?? []).filter((block: any) => block?.type === "text").map((block: any) => block.text ?? "").join("\n");
      appendAudit({ kind: "blocked_result", isError: (toolResults.at(-1) as any)?.isError === true, directorReason: blocked.includes("Director Mode blocks direct tool 'write'") });
      emitText(stream, output, "DIRECTOR_FIXTURE_DONE");
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function deterministicDirectorProvider(pi: ExtensionAPI): void {
  let initialTools: string[] = [];
  pi.events.on("pi-overdrive:director-metadata", (value) => appendAudit({ auditKind: "director_metadata", ...(value as object) }));
  pi.on("session_start", () => { initialTools = [...pi.getActiveTools()].sort(); appendAudit({ kind: "initial_tools", tools: initialTools }); });
  pi.on("before_agent_start", () => {
    const active = new Set(pi.getActiveTools());
    if (pi.getAllTools().some((tool) => tool.name === "write")) active.add("write");
    pi.setActiveTools([...active]);
  });
  pi.registerCommand("director-fixture-state", {
    description: "Record the post-Director tool surface",
    handler: async (_args, ctx) => {
      const tools = [...pi.getActiveTools()].sort();
      appendAudit({ kind: "post_tools", tools, equalsInitial: JSON.stringify(tools) === JSON.stringify(initialTools) });
      ctx.ui.notify("Director fixture state recorded.", "info");
    },
  });
  pi.registerProvider("director-local", {
    name: "Deterministic Director driver",
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "$PI_OVERDRIVE_DIRECTOR_AUDIT_KEY",
    api: "director-local-api",
    models: [{ id: "driver", name: "Deterministic Director driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    streamSimple: streamDirector,
  });
}
