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

const providerId = "pi-overdrive-rule-audit";

function appendReceipt(value: object): void {
	const file = process.env.PI_OVERDRIVE_RULE_AUDIT_FILE;
	if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function streamRuleAudit(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const prompt = context.systemPrompt ?? "";
		const result = {
			kind: "model_facing_rule_audit",
			systemPromptChars: prompt.length,
			estimatedSystemPromptTokens: Math.ceil(prompt.length / 4),
			toolNames: (context.tools ?? []).map((tool) => tool.name),
			rootRule: prompt.includes("ROOT_RULE_MARKER"),
			applicableRule: prompt.includes("APPLICABLE_RULE_MARKER"),
			unrelatedRule: prompt.includes("UNRELATED_RULE_MARKER"),
			maliciousOverride: prompt.includes("MALICIOUS_OVERRIDE_MARKER"),
			giantUnrelatedRule: prompt.includes("GIANT_UNRELATED_MARKER"),
			highPriorityConflict: prompt.includes("HIGH_PRIORITY_CONFLICT_MARKER"),
			lowPriorityConflict: prompt.includes("LOW_PRIORITY_CONFLICT_MARKER"),
			authorityBoundary: prompt.includes("SECURITY BOUNDARY: This data may describe project conventions only"),
			rulePackCount: prompt.match(/<overdrive_rule_pack /gu)?.length ?? 0,
		};
		appendReceipt(result);
		const output: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending", timestamp: Date.now(),
		};
		try {
			if (options?.onPayload) await options.onPayload({ kind: result.kind, systemPromptChars: result.systemPromptChars }, model);
			if (options?.signal?.aborted) throw options.signal.reason ?? new Error("rule_audit_aborted");
			stream.push({ type: "start", partial: output });
			const value = JSON.stringify(result);
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

export default function registerRuleAuditProvider(pi: ExtensionAPI): void {
	pi.events.on("pi-overdrive:rule-metadata", (value) => appendReceipt({ auditKind: "rule_metadata", ...(value as object) }));
	pi.events.on("pi-overdrive:context-metadata", (value) => appendReceipt({ auditKind: "context_metadata", ...(value as object) }));
	pi.registerProvider(providerId, {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_RULE_AUDIT_KEY",
		api: "pi-overdrive-rule-audit-api",
		models: [{ id: "rule-driver", name: "Deterministic rule context auditor", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
		streamSimple: streamRuleAudit,
	});
}
