import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  type AssistantMessage, type AssistantMessageEventStream, type Context,
  createAssistantMessageEventStream, type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerTools } from "./provider-context-compat.ts";
import { inferOperatorRepair } from "./phi-autonomy-repair.mjs";

const modelIds = ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function textOf(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("\n") : "";
}
function audit(value: object): void {
  const file = process.env.PHI_BOUNDED_TEST_AUDIT;
  if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
function stream(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    providerThinkingLevel: options?.reasoning,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    try {
      const tools = new Set(providerTools(context).map(tool => tool.name));
      const results = context.messages.filter((message: any) => message.role === "toolResult");
      const topLevel = tools.has("secure_coding_workflow");
      const userTask = [...context.messages].reverse().find((message: any) => message.role === "user");
      const task = textOf(userTask).trim();
      audit({ kind: "local_model_turn", provider: model.provider, model: model.id, thinking: options?.reasoning ?? null,
        lane: topLevel ? "controller" : "worker", toolResults: results.length, toolErrors: results.map((result: any) => result.isError === true), toolCount: tools.size });
      events.push({ type: "start", partial: output });
      let call: { name: string; arguments: object } | undefined;
      if (topLevel && results.length === 0) call = { name: "secure_coding_workflow", arguments: { task, includeOracle: false, includeSecurity: false } };
      else if (process.env.PHI_CAMPAIGN3_E1 === "1" && !topLevel && tools.has("safe_exec") && results.length < 4) {
        if (!tools.has("read") || !tools.has("verification_gate")) throw new Error("PHI_E1_PRODUCTION_TOOLS_UNAVAILABLE");
        if (results.length === 0) call = { name: "read", arguments: { path: "calc.js" } };
        else if (results.length === 1) call = { name: "read", arguments: { path: "test.cjs" } };
        else if (results.length === 2) {
          if (results.some((result: any) => result.isError === true)) throw new Error("PHI_E1_READ_FAILED");
          const repair = inferOperatorRepair(textOf(results[0]), textOf(results[1]));
          audit({ kind: "e1_repair_decision", assertionCount: repair.assertionCount, operation: repair.operation, sourceObserved: true, testObserved: true });
          call = { name: "safe_exec", arguments: { program: "node", args: ["edit.cjs", "calc.js", repair.oldText, repair.newText] } };
        } else call = { name: "verification_gate", arguments: { mode: "full" } };
      }
      else if (!topLevel && tools.has("safe_exec") && results.length < 3) {
        call = results.length === 0 ? { name: "safe_exec", arguments: { program: "node", args: ["edit.cjs"] } }
          : results.length === 1 ? { name: "semantic_nav", arguments: { operation: "diagnostics", path: "config.json" } }
            : { name: "verification_gate", arguments: { mode: "full" } };
      }
      if (call) {
        if (!tools.has(call.name)) throw new Error(`PHI_TEST_TOOL_UNAVAILABLE:${call.name}`);
        const toolCall = { type: "toolCall" as const, id: `phi-bounded-${topLevel ? "parent" : "child"}-${results.length}`, ...call };
        output.content.push(toolCall);
        events.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        events.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: output });
        events.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        output.stopReason = "toolUse";
      } else {
        const value = results.some((result: any) => result.isError === true) ? "PHI_TEST_TOOL_FAILURE" : "PHI_TEST_LOCAL_COMPLETE";
        output.content.push({ type: "text", text: value });
        events.push({ type: "text_start", contentIndex: 0, partial: output });
        events.push({ type: "text_delta", contentIndex: 0, delta: value, partial: output });
        events.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
        output.stopReason = "stop";
      }
      events.push({ type: "done", reason: output.stopReason, message: output });
      events.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      events.push({ type: "error", reason: output.stopReason, error: output });
      events.end();
    }
  });
  return events;
}

export default function register(pi: ExtensionAPI): void {
  pi.events.on("pi-overdrive:execution-metadata", (value) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.backend !== "windows-lpac-broker" || !["EDIT", "LSP_READ_ONLY", "TEST"].includes(String(record.profile))) return;
    audit({ kind: "owned_execution", profile: record.profile,
      operation: ["safe-exec", "lsp", "verification"].includes(String(record.operation)) ? record.operation : null,
      role: ["worker", "tester"].includes(String(record.role)) ? record.role : null,
      scopeDigest: typeof record.scopeId === "string" && /^[0-9a-f]{32}$/u.test(record.scopeId)
        ? createHash("sha256").update(record.scopeId).digest("hex") : null,
      targetStarted: typeof record.targetStarted === "boolean" ? record.targetStarted : null,
      jobAttested: typeof record.jobAttested === "boolean" ? record.jobAttested : null,
      jobEmptyVerified: typeof record.jobEmptyVerified === "boolean" ? record.jobEmptyVerified : null,
      brokerHelperClosed: typeof record.brokerHelperClosed === "boolean" ? record.brokerHelperClosed : null,
      brokerPipesDrained: typeof record.brokerPipesDrained === "boolean" ? record.brokerPipesDrained : null,
      cleanup: record.cleanup === "PASS" ? "PASS" : "NOT_PASS",
      exitCode: typeof record.exitCode === "number" && Number.isSafeInteger(record.exitCode) ? record.exitCode : null,
      securityFailure: record.securityFailure === null ? null : "PRESENT_OR_UNKNOWN",
      timedOut: typeof record.timedOut === "boolean" ? record.timedOut : null });
  });
  pi.events.on("pi-overdrive:create-stage-metadata", (value) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const stages = new Set(["WORKFLOW_ADMITTED", "EVIDENCE_RUN_START", "EVIDENCE_RUN_CREATED", "JOURNAL_CREATED", "RUNTIME_ALLOCATED",
      "ENVELOPE_ESTABLISHED", "WORKER_RESERVED", "WORKER_REQUESTED", "WORKER_STARTED", "WORKER_RESULT", "WORKER_REVOKED",
      "CONTROLLER_VALIDATION_START", "CREATE_INTENT_AND_V6_READY", "OPERATION_INTENT_READY", "NATIVE_PUBLICATION_CALL_ENTERED", "NATIVE_RESULT_OBSERVED",
      "PHYSICAL_POSTVERIFY_COMPLETE", "EXECUTION_THROWN", "PRE_CLEANUP_PHYSICAL_SNAPSHOT", "RETAINED_WORKER_RESERVATIONS_CLEARED",
      "EVIDENCE_FINALIZATION_START", "EXECUTION_EVIDENCE_WRITTEN", "EVIDENCE_WRITE_FAILED", "RUNTIME_CLEANUP_COMPLETE",
      "RUNTIME_CLEANUP_FAILED", "FINAL_RECEIPT_WRITTEN", "TERMINAL_STATUS_COMMITTED", "FINAL_RECEIPT_FAILED"]);
    if (!stages.has(String(record.stage))) return;
    audit({ kind: "create_stage", stage: record.stage, monotonicMs: Number.isSafeInteger(record.monotonicMs) ? record.monotonicMs : null,
      afterStage: stages.has(String(record.afterStage)) ? record.afterStage : null,
      errorCode: typeof record.errorCode === "string" && /^(?:EACCES|EEXIST|EISDIR|ENOENT|ENOTSUP|EPERM|PHI_[A-Z_]{3,80}|OTHER)$/u.test(record.errorCode) ? record.errorCode : null,
      targetState: ["PRESENT", "ABSENT", "NO_WORKTREE", "UNKNOWN", "NOT_SAMPLED"].includes(String(record.targetState)) ? record.targetState : null,
      digestMatch: typeof record.digestMatch === "boolean" ? record.digestMatch : null,
      identityMatch: typeof record.identityMatch === "boolean" ? record.identityMatch : null,
      v6Phase: typeof record.v6Phase === "string" && /^(?:[A-Z_]{3,40}|NOT_ESTABLISHED|NOT_FOUND|UNKNOWN)$/u.test(record.v6Phase) ? record.v6Phase : null,
      v6Observed: typeof record.v6Observed === "string" && /^(?:[A-Z_]{3,40}|NOT_ESTABLISHED|NOT_FOUND|UNKNOWN)$/u.test(record.v6Observed) ? record.v6Observed : null,
      result: ["COMPLETED", "OTHER"].includes(String(record.result)) ? record.result : null,
      reserved: record.reserved === true, authorityRetained: record.authorityRetained === true,
      published: record.published === true, grantConsumed: record.grantConsumed === true,
      transactionEstablished: record.transactionEstablished === true, grantIssued: record.grantIssued === true,
      cleanupStatus: ["PASS", "FAIL", "RELEASED", "NOT_ALLOCATED"].includes(String(record.cleanupStatus)) ? record.cleanupStatus : null,
      workflowStatus: ["PASS", "FAIL"].includes(String(record.workflowStatus)) ? record.workflowStatus : null });
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "secure_coding_workflow") return;
    const branch = ctx.sessionManager.getBranch();
    const lastUser = Array.isArray(branch) ? [...branch].reverse().find((entry: any) => entry?.type === "message" && entry.message?.role === "user") : undefined;
    const content = lastUser?.message?.content;
    audit({ kind: "controller_user_shape", branchArray: Array.isArray(branch), singleText: Array.isArray(content) && content.length === 1 && content[0]?.type === "text",
      exactTaskMatch: Array.isArray(content) && content.length === 1 && typeof content[0]?.text === "string" && content[0].text.trim() === (event.input as any)?.task });
  });
  pi.registerProvider("openai-codex", {
    name: "Phi bounded-publication offline fixture", baseUrl: "http://127.0.0.1.invalid",
    apiKey: "$PHI_BOUNDED_TEST_KEY", api: "phi-bounded-offline-api",
    models: modelIds.map(id => ({ id, name: `Phi offline ${id}`, reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text"] as ["text"], cost,
      contextWindow: 278528, maxTokens: 32768 })), streamSimple: stream,
  });
}
