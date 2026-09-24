import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  type AssistantMessage, type AssistantMessageEventStream, type Context, createAssistantMessageEventStream,
  type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const provider = "pi-overdrive-prewalk-local";
const receiptFile = process.env.PI_OVERDRIVE_PREWALK_RECEIPT;
function receipt(value: object): void { if (receiptFile) fs.appendFileSync(receiptFile, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
function textOf(value: any): string {
  return typeof value?.content === "string" ? value.content : Array.isArray(value?.content)
    ? value.content.filter((block: any) => block?.type === "text").map((block: any) => block.text ?? "").join("\n") : "";
}
function respond(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending", timestamp: Date.now(),
    };
    try {
      const prompt = context.messages.filter((message: any) => message.role === "user").map(textOf).join("\n");
      const toolResults = context.messages.filter((message: any) => message.role === "toolResult");
      const searchDone = toolResults.some((message: any) => message.toolName === "prewalk_search");
      const readDone = toolResults.some((message: any) => message.toolName === "prewalk_read");
      const searchPath = textOf(toolResults.find((message: any) => message.toolName === "prewalk_search")).trim();
      const target = prompt.includes("- src/parser.ts") ? "src/parser.ts" : searchPath === "src/parser.ts" ? searchPath : null;
      receipt({ kind: "provider_turn", model: model.id, toolResults: toolResults.length, promptChars: prompt.length, toolCount: context.tools?.length ?? 0 });
      if (options?.onPayload) await options.onPayload({ model: model.id, messageCount: context.messages.length }, model);
      if (options?.signal?.aborted) throw new Error("prewalk_fixture_aborted");
      stream.push({ type: "start", partial: output });
      if (!readDone) {
        const toolCall = target
          ? { type: "toolCall" as const, id: `prewalk-read-${toolResults.length}`, name: "prewalk_read", arguments: { path: target } }
          : { type: "toolCall" as const, id: "prewalk-search", name: "prewalk_search", arguments: { term: "parser" } };
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: output });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }
      const source = textOf(toolResults.find((message: any) => message.toolName === "prewalk_read"));
      const final = JSON.stringify({ found: source.includes("parseInput"), path: "src/parser.ts", searchDone, readDone });
      output.content.push({ type: "text", text: final });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: final, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: final, partial: output });
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

export default function register(pi: ExtensionAPI): void {
  pi.registerProvider(provider, {
    baseUrl: "http://127.0.0.1.invalid", apiKey: "$PI_OVERDRIVE_PREWALK_KEY", api: "pi-overdrive-prewalk-local-api",
    models: [{ id: "worker", name: "Deterministic local Worker", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple: respond,
  });
  pi.registerTool({
    name: "prewalk_search", label: "Fixture repository search", description: "Search safe fixture paths.",
    parameters: Type.Object({ term: Type.String() }),
    async execute(_id, parameters) {
      if (parameters.term !== "parser") throw new Error("fixture_search_denied");
      receipt({ kind: "search_call" });
      return { content: [{ type: "text", text: "src/parser.ts" }], details: { fixture: true } };
    },
  });
  pi.registerTool({
    name: "prewalk_read", label: "Fixture safe read", description: "Read one safe fixture path.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, parameters) {
      if (parameters.path !== "src/parser.ts") throw new Error("fixture_read_denied");
      receipt({ kind: "read_call" });
      return { content: [{ type: "text", text: fs.readFileSync(path.join(process.cwd(), "src/parser.ts"), "utf8") }], details: { fixture: true } };
    },
  });
}
