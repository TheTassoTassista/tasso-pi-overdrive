import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function streamSingleTool(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
		try {
			stream.push({ type: "start", partial: output });
			if (context.messages.some((message) => message.role === "toolResult")) {
				const value = "AUDIT_TOOL_FINISHED";
				output.content.push({ type: "text", text: value });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
				output.stopReason = "stop";
			} else {
				const name = process.env.PI_OVERDRIVE_AUDIT_TOOL;
				if (!name) throw new Error("PI_OVERDRIVE_AUDIT_TOOL is required");
				const args = JSON.parse(process.env.PI_OVERDRIVE_AUDIT_TOOL_ARGS ?? "{}");
				const toolCall = { type: "toolCall" as const, id: "single-audit-call", name, arguments: args };
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
				output.stopReason = "toolUse";
			}
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

export default function registerSingleToolProvider(pi: ExtensionAPI): void {
	pi.registerProvider("pi-overdrive-tool-audit", {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_TOOL_AUDIT_KEY",
		api: "pi-overdrive-tool-audit-api",
		models: [{ id: "single-tool-driver", name: "Pi Overdrive deterministic single-tool driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
		streamSimple: streamSingleTool,
	});
}
