import fs from "node:fs";
import {
  type AssistantMessage, type AssistantMessageEventStream, type Context,
  createAssistantMessageEventStream, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerTools } from "./provider-context-compat.ts";

const modelIds = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function textOf(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n") : "";
}
function audit(value: object): void {
  const file = process.env.PHI_BOUNDED_TEST_AUDIT;
  if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
function stream(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    providerThinkingLevel: options?.reasoning,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    try {
      const tools = new Set(providerTools(context).map(tool => tool.name));
      const results = context.messages.filter((message: any) => message.role === "toolResult");
      const topLevel = tools.has("secure_coding_workflow");
      const userTask = [...context.messages].reverse().find((message: any) => message.role === "user");
      const task = textOf(userTask).trim();
      audit({ kind: "local_model_turn", provider: model.provider, model: model.id, thinking: options?.reasoning ?? null,
        lane: topLevel ? "controller" : "worker", toolResults: results.length, toolErrors: results.map((result: any) => result.isError === true), toolCount: tools.size });
      events.push({ type: "start", partial: output });
      let call: { name: string; arguments: object } | undefined;
      if (topLevel && results.length === 0) call = { name: "secure_coding_workflow", arguments: { task, includeOracle: false, includeSecurity: false } };
      else if (!topLevel && tools.has("safe_exec") && results.length < 3) {
        call = results.length === 0 ? { name: "safe_exec", arguments: { program: "node", args: ["edit.cjs"] } }
          : results.length === 1 ? { name: "semantic_nav", arguments: { operation: "diagnostics", path: "config.json" } }
            : { name: "verification_gate", arguments: { mode: "full" } };
      }
      if (call) {
        if (!tools.has(call.name)) throw new Error(`PHI_TEST_TOOL_UNAVAILABLE:${call.name}`);
        const toolCall = { type: "toolCall" as const, id: `phi-bounded-${topLevel ? "parent" : "child"}-${results.length}`, ...call };
        output.content.push(toolCall);
        events.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        events.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: output });
        events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        output.stopReason = "toolUse";
      } else {
        const value = results.some((result: any) => result.isError === true) ? "PHI_TEST_TOOL_FAILURE" : "PHI_TEST_LOCAL_COMPLETE";
        output.content.push({ type: "text", text: value });
        events.push({ type: "text_start", contentIndex: 0, partial: output });
        events.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
        events.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
        output.stopReason = "stop";
      }
      events.push({ type: "done", reason: output.stopReason, message: output });
      events.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      events.push({ type: "error", reason: output.stopReason, error: output });
      events.end();
    }
  });
  return events;
}

export default function register(pi: ExtensionAPI): void {
  pi.registerProvider("openai-codex", {
    name: "Phi bounded-publication offline fixture", baseUrl: "http://127.0.0.1.invalid",
    apiKey: "$PHI_BOUNDED_TEST_KEY", api: "phi-bounded-offline-api",
    models: modelIds.map(id => ({ id, name: `Phi offline ${id}`, reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text"] as ["text"], cost,
      contextWindow: 278528, maxTokens: 32768 })), streamSimple: stream,
  });
}
