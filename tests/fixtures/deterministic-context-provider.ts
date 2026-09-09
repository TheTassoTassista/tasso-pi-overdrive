import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "pi-overdrive-context-audit";
const modelId = "context-driver";

const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4);

function estimateContentTokens(content: unknown): number {
	if (typeof content === "string") return estimateTextTokens(content);
	if (!Array.isArray(content)) return 0;
	return content.reduce((total, block: any) => {
		if (block?.type === "text") return total + estimateTextTokens(block.text ?? "");
		if (block?.type === "thinking") return total + estimateTextTokens(block.thinking ?? "");
		if (block?.type === "toolCall") return total + estimateTextTokens(`${block.name ?? ""}${JSON.stringify(block.arguments ?? {})}`);
		return total;
	}, 0);
}

function estimateContext(context: Context): number {
	const prefix = estimateTextTokens(context.systemPrompt ?? "") + estimateTextTokens(JSON.stringify(context.tools ?? []));
	return prefix + context.messages.reduce((total, message: any) => total + estimateContentTokens(message.content), 0);
}

function streamContextAudit(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const tools = context.tools ?? [];
		const serializedTools = JSON.stringify(tools);
		const value = JSON.stringify({
			estimatedContextTokens: estimateContext(context),
			systemPromptCharacters: context.systemPrompt?.length ?? 0,
			messageCount: context.messages.length,
			toolCount: tools.length,
			toolNames: tools.map((tool) => tool.name),
			toolSchemaCharacters: serializedTools.length,
			estimatedToolSchemaTokens: estimateTextTokens(serializedTools),
		});
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
			output.content.push({ type: "text", text: value });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
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

export default function registerContextAuditProvider(pi: ExtensionAPI): void {
	pi.registerProvider(providerId, {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_CONTEXT_AUDIT_KEY",
		api: "pi-overdrive-context-audit-api",
		models: [{ id: modelId, name: "Pi Overdrive deterministic context auditor", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 2048 }],
		streamSimple: streamContextAudit,
	});
}
