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
	const file = process.env.PHI_G1_AUDIT_FILE;
	if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function streamFixture(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending", timestamp: Date.now(),
		};
		try {
			stream.push({ type: "start", partial: output });
			const results = context.messages.filter((message) => message.role === "toolResult");
			const fixture = JSON.parse(process.env.PHI_G1_SEQUENCE ?? "null");
			if (!Array.isArray(fixture)) throw new Error("PHI_G1_SEQUENCE_INVALID");
			const step = fixture[results.length];
			if (!step) {
				const text = "G1_FIXTURE_COMPLETE";
				output.content.push({ type: "text", text });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
				output.stopReason = "stop";
			} else {
				if (typeof step.name !== "string" || !step.args || typeof step.args !== "object" || Array.isArray(step.args)) throw new Error("PHI_G1_STEP_INVALID");
				const args = structuredClone(step.args) as Record<string, unknown>;
				const lastText = results.length
					? (results.at(-1)?.content ?? []).filter((block: any) => block?.type === "text").map((block: any) => block.text ?? "").join("\n")
					: "";
				if (args.snapshotId === "$previous.snapshotId") {
					const match = lastText.match(/\[EDIT SNAPSHOT\] id=([0-9a-f-]{36})/iu);
					if (!match) throw new Error("PHI_G1_SNAPSHOT_NOT_RETURNED");
					args.snapshotId = match[1];
				}
				if (args.transactionId === "$previous.transactionId") {
					const match = lastText.match(/Apply transaction ([0-9a-f-]{36})/iu);
					if (!match) throw new Error("PHI_G1_TRANSACTION_NOT_RETURNED");
					args.transactionId = match[1];
				}
				appendAudit({ kind: "fixture_provider_turn", index: results.length, identity: `${model.provider}/${model.id}`, tool: step.name, argumentKeys: Object.keys(args).sort() });
				const call = { type: "toolCall" as const, id: `phi-g1-${results.length + 1}`, name: step.name, arguments: args };
				output.content.push(call);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
				output.stopReason = "toolUse";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : "PHI_G1_FIXTURE_FAILED";
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

export default function deterministicToolGovernorProvider(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		appendAudit({ kind: "registered_inventory", names: pi.getAllTools().map((tool) => tool.name).sort() });
	});
	pi.events.on("pi-overdrive:tool-metadata", (value) => {
		const row = value as Record<string, any>;
		if (row?.kind === "tool_governor_surface") appendAudit({ kind: row.kind, activeTools: row.activeTools, mode: row.mode });
		if (row?.kind === "model_harness_profile") appendAudit({ kind: row.kind, identity: row.identity, editContract: row.editContract, deniedToolCount: row.deniedToolCount });
	});
	pi.registerProvider("openai-codex", {
		name: "Phi G1 deterministic offline fixture",
		baseUrl: "https://offline.invalid",
		apiKey: "$PHI_G1_FIXTURE_KEY",
		api: "openai-completions",
		models: [{
			id: "gpt-6-sol", name: "Phi G1 deterministic offline fixture", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
		}],
		streamSimple: streamFixture,
	});
}
