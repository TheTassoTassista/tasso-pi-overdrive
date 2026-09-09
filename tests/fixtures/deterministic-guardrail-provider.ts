import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "pi-overdrive-audit";
const modelId = "guardrail-driver";

function outputMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function addToolCall(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	id: string,
	name: string,
	args: Record<string, unknown>,
): void {
	const contentIndex = output.content.length;
	const toolCall = { type: "toolCall" as const, id, name, arguments: args };
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

function streamAudit(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = outputMessage(model);
		try {
			stream.push({ type: "start", partial: output });
			const hasToolResults = context.messages.some((message) => message.role === "toolResult");
			if (hasToolResults) {
				addText(stream, output, "GUARDRAILS_DONE");
				output.stopReason = "stop";
			} else {
				const outside = process.env.PI_OVERDRIVE_AUDIT_OUTSIDE;
				if (!outside) throw new Error("PI_OVERDRIVE_AUDIT_OUTSIDE is required");
				const calls: Array<[string, Record<string, unknown>]> = [
					["read", { path: ".env" }],
					["read", { path: "secret-link" }],
					["write", { path: "secret-link", content: "attempted overwrite" }],
					["fffind", { pattern: "outside", path: "../", limit: 5 }],
					["ast_grep_run", { pattern: "eval($A)", lang: "javascript", path: outside, max_results: 5 }],
					["bash", { command: "python3 -c \"open('.env').read()\"" }],
					["bash", { command: "printf x > ../outside/escape.txt" }],
					["bash", { command: "find . -name '*.txt' -delete" }],
					["bash", { command: "git -C . reset --hard HEAD" }],
					["safe_exec", { program: "python3", args: ["-c", "open('.env').read()"] }],
					["safe_exec", { program: "git", args: ["reset", "--hard", "HEAD"] }],
					["safe_exec", { program: "fd", args: ["--exec", "python3", "-c", "open('../outside/escape.txt','w').write('x')"] }],
					["safe_exec", { program: "rg", args: ["--pre", "python3 -c pass", "marker"] }],
				];
				calls.forEach(([name, args], index) => addToolCall(stream, output, `audit-call-${index + 1}`, name, args));
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

export default function registerAuditProvider(pi: ExtensionAPI): void {
	pi.registerProvider(providerId, {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_AUDIT_KEY",
		api: "pi-overdrive-audit-api",
		models: [{
			id: modelId,
			name: "Pi Overdrive deterministic guardrail driver",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		}],
		streamSimple: streamAudit,
	});
}
