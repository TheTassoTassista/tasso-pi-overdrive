import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "pi-overdrive-runtime-audit";
const modelId = "runtime-driver";

function outputMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function addToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, id: string, name: string, args: Record<string, unknown>): void {
	const contentIndex = output.content.length;
	const toolCall = { type: "toolCall" as const, id, name, arguments: args };
	output.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

function addText(stream: AssistantMessageEventStream, output: AssistantMessage, value: string): void {
	const contentIndex = output.content.length;
	output.content.push({ type: "text", text: value });
	stream.push({ type: "text_start", contentIndex, partial: output });
	stream.push({ type: "text_delta", contentIndex, delta: value, partial: output });
	stream.push({ type: "text_end", contentIndex, content: value, partial: output });
}

function streamRuntimeAudit(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = outputMessage(model);
		try {
			stream.push({ type: "start", partial: output });
			const calls: Array<[string, Record<string, unknown>]> = [
					["fffind", { pattern: "defs", path: "src/**", limit: 10 }],
					["ffgrep", { pattern: "function add", path: "src/", limit: 10 }],
					["ast_grep_run", { pattern: "add($$$ARGS)", lang: "typescript", path: "src", max_results: 10 }],
					["semantic_nav", { operation: "diagnostics", path: "src/use.ts" }],
					["semantic_nav", { operation: "definition", path: "src/use.ts", line: 1, character: 10 }],
					["semantic_nav", { operation: "references", path: "src/use.ts", line: 2, character: 21 }],
					["web_fetch", { url: "https://example.com/", raw: false }],
			];
			const completed = context.messages.filter((message) => message.role === "toolResult").length;
			if (completed >= calls.length) {
				addText(stream, output, "AUDIT_DONE");
				output.stopReason = "stop";
			} else {
				const [name, args] = calls[completed];
				addToolCall(stream, output, `runtime-audit-${completed + 1}`, name, args);
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

export default function registerRuntimeAuditProvider(pi: ExtensionAPI): void {
	pi.registerProvider(providerId, {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_RUNTIME_AUDIT_KEY",
		api: "pi-overdrive-runtime-audit-api",
		models: [{ id: modelId, name: "Pi Overdrive deterministic runtime driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
		streamSimple: streamRuntimeAudit,
	});
}
