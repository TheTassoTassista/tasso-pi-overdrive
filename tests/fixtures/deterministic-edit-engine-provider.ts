import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "pi-overdrive-edit-audit";
let previewNonMutating = false;

function textOf(message: any): string {
	if (typeof message?.content === "string") return message.content;
	return Array.isArray(message?.content) ? message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text ?? "").join("\n") : "";
}

function appendReceipt(value: object): void {
	const file = process.env.PI_OVERDRIVE_EDIT_AUDIT_RECEIPT;
	if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function digestFile(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixturePath(): string {
	const relative = process.env.PI_OVERDRIVE_EDIT_AUDIT_FIXTURE ?? "edit-fixture.txt";
	const absolute = path.resolve(process.cwd(), relative);
	if (path.relative(process.cwd(), absolute).startsWith("..") || path.isAbsolute(relative)) throw new Error("edit_audit_fixture_escape");
	return absolute;
}

function emitToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, index: number, name: string, args: object): void {
	const toolCall = { type: "toolCall" as const, id: `edit-audit-call-${index}`, name, arguments: args };
	output.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
	stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
	output.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: output });
	stream.end();
}

function emitText(stream: AssistantMessageEventStream, output: AssistantMessage, value: string): void {
	output.content.push({ type: "text", text: value });
	stream.push({ type: "text_start", contentIndex: 0, partial: output });
	stream.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
	stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
	output.stopReason = "stop";
	stream.push({ type: "done", reason: "stop", message: output });
	stream.end();
}

function streamEditAudit(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending", timestamp: Date.now(),
		};
		try {
			if (options?.signal?.aborted) throw options.signal.reason ?? new Error("edit_audit_aborted");
			stream.push({ type: "start", partial: output });
			const results = context.messages.filter((message) => message.role === "toolResult");
			const completed = results.length;
			const scenario = process.env.PI_OVERDRIVE_EDIT_AUDIT_SCENARIO ?? "recovery";
			const mode = process.env.PI_OVERDRIVE_EDIT_AUDIT_MODE ?? "exact";
			const target = fixturePath();
			appendReceipt({ kind: "provider_turn", provider: model.provider, model: model.id, completedTools: completed, scenario, mode, fixtureDigest: digestFile(target) });
			if (completed === 0) {
				emitToolCall(stream, output, 1, "read", { path: path.relative(process.cwd(), target) });
				return;
			}
			if (completed === 1) {
				const snapshotId = textOf(results[0]).match(/\[EDIT SNAPSHOT\]\s+id=([0-9a-f-]{36})/iu)?.[1];
				if (!snapshotId) throw new Error("edit_audit_snapshot_missing");
				if (scenario === "recovery" && mode === "exact") fs.writeFileSync(target, `external prefix\n${fs.readFileSync(target, "utf8")}`);
				if (mode === "ast") emitToolCall(stream, output, 2, "transactional_ast_edit", { action: "preview", snapshotId, pattern: "legacy($X)", rewrite: "modern($X)", lang: "javascript", expectedMatches: 2 });
				else if (scenario === "lsp-regression") emitToolCall(stream, output, 2, "transactional_edit", { action: "preview", snapshotId, edits: [{ oldText: "'safe'", newText: "1" }] });
				else if (scenario === "lsp-success") emitToolCall(stream, output, 2, "transactional_edit", { action: "preview", snapshotId, edits: [{ oldText: "'safe'", newText: "'safer'" }] });
				else emitToolCall(stream, output, 2, "transactional_edit", { action: "preview", snapshotId, edits: [{ oldText: "anchor old", newText: "anchor new" }] });
				return;
			}
			if (completed === 2) {
				const preview = textOf(results[1]);
				const transactionId = preview.match(/Apply transaction ([0-9a-f-]{36})/iu)?.[1];
				if (scenario === "lsp-regression") {
					emitText(stream, output, JSON.stringify({
						scenario, mode, toolResults: completed, snapshotBound: /\[EDIT SNAPSHOT\]/u.test(textOf(results[0])),
						previewIsError: (results[1] as any)?.isError === true,
						previewStatus: /LSP_NEW_BLOCKING_DIAGNOSTIC/u.test(preview) ? "LSP_NEW_BLOCKING_DIAGNOSTIC" : "UNKNOWN",
						finalDigest: digestFile(target),
					}));
					return;
				}
				if (!transactionId) throw new Error("edit_audit_transaction_missing");
				const current = fs.readFileSync(target, "utf8");
				previewNonMutating = mode === "ast" ? current.includes("legacy(value)") && !current.includes("modern(value)") : scenario === "lsp-success" ? current.includes("'safe'") && !current.includes("'safer'") : current.includes("anchor old") && !current.includes("anchor new");
				if (scenario === "stale") fs.writeFileSync(target, "external after preview\n");
				if (scenario === "receipt-create-fail") {
					const receiptRoot = path.join(process.env.XDG_STATE_HOME ?? "", "pi-overdrive", "edit-receipts");
					for (const entry of fs.readdirSync(receiptRoot)) fs.chmodSync(path.join(receiptRoot, entry), 0o500);
				}
				if (["receipt-write-fail", "receipt-sync-fail", "receipt-publish-fail", "receipt-dir-sync-fail"].includes(scenario)) {
					const marker = process.env.PI_OVERDRIVE_RECEIPT_FAULT_MARKER;
					if (!marker) throw new Error("edit_audit_fault_marker_missing");
					fs.writeFileSync(marker, "active", { flag: "wx", mode: 0o600 });
				}
				emitToolCall(stream, output, 3, mode === "ast" ? "transactional_ast_edit" : "transactional_edit", { action: "apply", transactionId });
				return;
			}
			if (["verify", "verify-fail", "verify-error", "verify-no-checks", "verify-invalid-manifest"].includes(scenario) && completed === 3) {
				if (scenario === "verify-invalid-manifest") fs.writeFileSync(path.join(process.cwd(), "package.json"), '{"scripts":');
				emitToolCall(stream, output, 4, "verification_gate", { mode: "full" });
				return;
			}
			const previewText = textOf(results[1]);
			const applyText = textOf(results[2]);
			emitText(stream, output, JSON.stringify({
				scenario, mode,
				toolResults: completed,
				snapshotBound: /\[EDIT SNAPSHOT\]/u.test(textOf(results[0])),
				previewStatus: previewText.includes("status=SAFE_RECOVERY") ? "SAFE_RECOVERY" : previewText.includes("status=READY") ? "READY" : "UNKNOWN",
				previewNonMutating,
				applyIsError: (results[2] as any)?.isError === true,
				applyStatus: /APPLIED(?: AST)? transaction/u.test(applyText) ? "APPLIED" : /STALE_EDIT/u.test(applyText) ? "STALE_EDIT" : "UNKNOWN",
				applyGuidancePresent: scenario !== "stale" ? null : applyText.includes("Read the exact range again") && applyText.includes("never retry the old transaction"),
				...(["verify", "verify-fail", "verify-error", "verify-no-checks", "verify-invalid-manifest"].includes(scenario) ? (() => { let summary: any; try { summary = JSON.parse(textOf(results[3])); } catch {} return { verificationIsError: (results[3] as any)?.isError === true, verificationStatus: summary?.status ?? "INVALID", verificationError: summary?.error ?? null, verificationTest: summary?.results?.find((entry: any) => entry.name === "test")?.status ?? "MISSING", verificationSandboxed: summary?.results?.find((entry: any) => entry.name === "test")?.sandboxed === true, verificationProcessFault: textOf(results[3]).includes("verification process exited 76") }; })() : {}),
				finalDigest: digestFile(target),
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

export default function registerEditAuditProvider(pi: ExtensionAPI): void {
	pi.events.on("pi-overdrive:edit-metadata", (value) => appendReceipt({ auditKind: "edit_metadata", ...(value as object) }));
	pi.registerProvider(providerId, {
		baseUrl: "http://127.0.0.1.invalid",
		apiKey: "$PI_OVERDRIVE_EDIT_AUDIT_KEY",
		api: "pi-overdrive-edit-audit-api",
		models: [{ id: "edit-driver", name: "Deterministic edit engine driver", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
		streamSimple: streamEditAudit,
	});
}
