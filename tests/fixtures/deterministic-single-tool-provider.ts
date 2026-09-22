import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

function appendAudit(value: object): void {
	const file = process.env.PI_OVERDRIVE_AUDIT_EVENT_FILE;
	if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

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
			const completedResults = context.messages.filter((message) => message.role === "toolResult");
			const completedTools = completedResults.length;
			const lastToolText = completedResults.length ? (completedResults.at(-1)?.content ?? []).filter((block: any) => block?.type === "text").map((block: any) => block.text ?? "").join("\n") : "";
			appendAudit({ kind: "provider_turn", provider: model.provider, model: model.id, completedTools, modelFacingLastToolChars: lastToolText.length, modelFacingLastToolArtifact: /artifact:\/\/[0-9a-f]{64}/u.test(lastToolText), modelFacingLastToolStreamGuard: /ERROR \[STREAMGUARD\]/u.test(lastToolText) });
			const sequenceValue = process.env.PI_OVERDRIVE_AUDIT_TOOL_ARGS_SEQUENCE;
			const sequence = sequenceValue ? JSON.parse(sequenceValue) : null;
			const hasNextSequenceTool = Array.isArray(sequence) && completedTools < sequence.length;
			if ((!Array.isArray(sequence) && completedTools > 0) || (Array.isArray(sequence) && !hasNextSequenceTool)) {
				const value = "AUDIT_TOOL_FINISHED";
				output.content.push({ type: "text", text: value });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
				output.stopReason = "stop";
			} else {
				const step = hasNextSequenceTool ? sequence[completedTools] : null;
				const name = step && typeof step === "object" && typeof step.name === "string" ? step.name : process.env.PI_OVERDRIVE_AUDIT_TOOL;
				if (!name) throw new Error("PI_OVERDRIVE_AUDIT_TOOL is required");
				const args = hasNextSequenceTool ? (step && typeof step === "object" && !Array.isArray(step) && "args" in step ? step.args : step) : JSON.parse(process.env.PI_OVERDRIVE_AUDIT_TOOL_ARGS ?? "{}");
				const toolCall = { type: "toolCall" as const, id: hasNextSequenceTool ? `audit-call-${completedTools + 1}` : "single-audit-call", name, arguments: args };
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
	pi.events.on("pi-overdrive:dap-metadata", (value) => appendAudit({ auditKind: "dap_metadata", ...(value as object) }));
	pi.events.on("pi-overdrive:eval-metadata", (value) => appendAudit({ auditKind: "eval_metadata", ...(value as object) }));
	pi.events.on("pi-overdrive:streamguard-metadata", (value) => appendAudit({ auditKind: "stream_guard_metadata", ...(value as object) }));
	pi.events.on("pi-overdrive:artifact-metadata", (value) => appendAudit({ auditKind: "artifact_metadata", ...(value as object) }));
	pi.events.on("pi-overdrive:commit-plan-metadata", (value) => appendAudit({ auditKind: "commit_plan_metadata", ...(value as object) }));
	pi.registerProvider("pi-overdrive-tool-audit", {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_TOOL_AUDIT_KEY",
		api: "pi-overdrive-tool-audit-api",
		models: [
			{ id: "single-tool-driver", name: "Pi Overdrive deterministic single-tool driver", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
			{ id: "single-tool-driver-alt", name: "Pi Overdrive deterministic alternate model", reasoning: true, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 }, contextWindow: 16384, maxTokens: 2048 },
		],
		streamSimple: streamSingleTool,
	});
}
