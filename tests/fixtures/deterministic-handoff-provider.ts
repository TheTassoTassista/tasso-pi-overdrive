import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerTools } from "./provider-context-compat.ts";

function createOutput(model: Model<any>): AssistantMessage {
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

function text(stream: AssistantMessageEventStream, output: AssistantMessage, value: string): void {
	const contentIndex = output.content.length;
	output.content.push({ type: "text", text: value });
	stream.push({ type: "text_start", contentIndex, partial: output });
	stream.push({ type: "text_delta", contentIndex, delta: value, partial: output });
	stream.push({ type: "text_end", contentIndex, content: value, partial: output });
}

function streamHandoff(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = createOutput(model);
		try {
			stream.push({ type: "start", partial: output });
			const marker = process.env.PI_OVERDRIVE_HANDOFF_MARKER;
			if (!marker) throw new Error("PI_OVERDRIVE_HANDOFF_MARKER is required");
			const hasNotebookTool = providerTools(context).some((tool) => tool.name === "task_notebook");
			const hasToolResult = context.messages.some((message) => message.role === "toolResult");
			if (hasNotebookTool && !hasToolResult) {
				const contentIndex = output.content.length;
				const args = { action: "set-goal", text: marker };
				const toolCall = { type: "toolCall" as const, id: "handoff-notebook-seed", name: "task_notebook", arguments: args };
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
				output.stopReason = "toolUse";
			} else if (hasToolResult) {
				text(stream, output, "Notebook state recorded.");
				output.stopReason = "stop";
			} else {
				const serialized = context.messages.map((message) => JSON.stringify(message)).join("\n");
				if (!serialized.includes(marker)) throw new Error("canonical notebook marker was absent from handoff context");
				text(stream, output, `Continue from a clean session. Verified canonical notebook goal: ${marker}`);
				output.stopReason = "stop";
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

export default function registerHandoffProvider(pi: ExtensionAPI): void {
	pi.registerProvider("pi-overdrive-handoff-audit", {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_HANDOFF_AUDIT_KEY",
		api: "pi-overdrive-handoff-audit-api",
		models: [{
			id: "handoff-driver",
			name: "Pi Overdrive deterministic handoff driver",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16384,
			maxTokens: 2048,
		}],
		streamSimple: streamHandoff,
	});
}
