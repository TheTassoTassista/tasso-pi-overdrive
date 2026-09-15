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

const providerId = "pi-overdrive-context-fit-audit";

function appendReceipt(value: object): void {
	const file = process.env.PI_OVERDRIVE_CONTEXT_FIT_RECEIPT;
	if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function textOf(message: any): string {
	if (typeof message?.content === "string") return message.content;
	return Array.isArray(message?.content) ? message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text ?? "").join("\n") : "";
}

function finishText(stream: AssistantMessageEventStream, output: AssistantMessage, value: string): void {
	output.content.push({ type: "text", text: value });
	stream.push({ type: "text_start", contentIndex: 0, partial: output });
	stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
	stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
	output.stopReason = "stop";
	stream.push({ type: "done", reason: "stop", message: output });
	stream.end();
}

function streamContextFit(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	appendReceipt({ kind: "provider_stream_entered", provider: model.provider, model: model.id, messageCount: context.messages.length, signalAborted: options?.signal?.aborted === true });
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending", timestamp: Date.now(),
		};
		try {
			const payload = { provider: model.provider, model: model.id, messageCount: context.messages.length, toolCount: context.tools?.length ?? 0 };
			if (options?.onPayload) await options.onPayload(payload, model);
			if (options?.signal?.aborted) throw options.signal.reason ?? new Error("context_fit_aborted");
			stream.push({ type: "start", partial: output });
			const completedTools = context.messages.filter((message) => message.role === "toolResult").length;
			if (model.id === "fit-driver" && completedTools < 2) {
				const toolCall = { type: "toolCall" as const, id: `context-fit-call-${completedTools + 1}`, name: "artifact_fixture", arguments: { lines: 700 } };
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
				stream.end();
				return;
			}
			const texts = context.messages.filter((message) => message.role === "toolResult").map(textOf);
			const serialized = texts.join("\n");
			finishText(stream, output, JSON.stringify({
				messageCount: context.messages.length,
				toolResults: texts.length,
				contextCharacters: context.systemPrompt.length + context.messages.reduce((total, message) => total + textOf(message).length, 0),
				artifactReferences: serialized.match(/artifact:\/\/[0-9a-f]{64}/gu)?.length ?? 0,
				redundantMarkers: serialized.match(/REDUNDANT ARTIFACT PREVIEW OMITTED/gu)?.length ?? 0,
				criticalDiagnostics: serialized.match(/ERROR artifact benchmark critical diagnostic/gu)?.length ?? 0,
			}));
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

export default function registerContextFitProvider(pi: ExtensionAPI): void {
	pi.events.on("pi-overdrive:context-metadata", (value) => appendReceipt({ kind: "context_metadata", ...(value as object) }));
	pi.registerProvider(providerId, {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_CONTEXT_FIT_KEY",
		api: "pi-overdrive-context-fit-audit-api",
		models: [
			{ id: "fit-driver", name: "Deterministic fit driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 7600, maxTokens: 1024 },
			{ id: "blocked-driver", name: "Deterministic blocked driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 7000, maxTokens: 1024 },
		],
		streamSimple: streamContextFit,
	});
}
