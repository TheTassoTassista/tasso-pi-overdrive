import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_FIT_STATUS, contextFitMetadata, governContext, readContextGovernorPolicy } from "../lib/context-governor.mjs";
import { readModelPolicy, resolveModelPolicy } from "../lib/model-policy.mjs";
import { getSessionQuality } from "../lib/routing-session.mjs";
import {
  SENTINEL_ENTRY_TYPE,
  SENTINEL_MESSAGE_TYPE,
  SentinelError,
  SentinelLedger,
  prepareSentinelInvocation,
  readSentinelPolicy,
  renderSentinelAdvice,
  sentinelMetadata,
  validateSentinelAdvice,
} from "../lib/sentinel.mjs";
import { availableContextFromPiUsage, resolveTaskPolicy, taskPolicyMetadata } from "../lib/task-governor.mjs";

function codeFor(error: unknown): string {
  if (error instanceof SentinelError) return error.code;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "SENTINEL_TIMEOUT";
  return "SENTINEL_CALL_FAILED";
}

function notifyFailure(ctx: ExtensionContext, code: string): void {
  ctx.ui.notify(`Sentinel unavailable: ${code}. The primary Pi workflow is unchanged.`, "warning");
}

function responseText(response: any): string {
  if (response?.stopReason !== "stop") throw new SentinelError("SENTINEL_RESPONSE_NOT_TERMINAL");
  if (!Array.isArray(response.content) || response.content.some((entry: any) => entry?.type === "toolCall")) throw new SentinelError("SENTINEL_TOOL_CALL_REJECTED");
  const text = response.content.filter((entry: any) => entry?.type === "text").map((entry: any) => entry.text ?? "").join("");
  if (!text) throw new SentinelError("SENTINEL_STRUCTURED_OUTPUT_INVALID");
  return text;
}

export default function sentinelExtension(pi: ExtensionAPI): void {
  let ledger: SentinelLedger | undefined;

  const emit = (value: Record<string, unknown>) => pi.events.emit("pi-overdrive:sentinel-metadata", sentinelMetadata(value));
  const persist = (receipt: Record<string, unknown>) => {
    pi.appendEntry(SENTINEL_ENTRY_TYPE, receipt);
    emit(receipt);
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      const receipts = ctx.sessionManager.getBranch().flatMap((entry: any) => entry?.type === "custom" && entry.customType === SENTINEL_ENTRY_TYPE ? [entry.data] : []);
      ledger = new SentinelLedger({ sessionId: ctx.sessionManager.getSessionId(), receipts });
    } catch { ledger = undefined; }
  });
  pi.on("session_shutdown", () => { ledger = undefined; });

  pi.registerCommand("sentinel", {
    description: "Run one bounded read-only second opinion for a hard debugging task, or show status",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!action || action === "status") {
        const policy = (() => { try { return readSentinelPolicy(); } catch { return undefined; } })();
        ctx.ui.notify(JSON.stringify({ ...(ledger?.status() ?? { version: 1, enabled: false, active: false }), routeRole: policy?.routeRole ?? "unavailable", maxInputTokens: policy?.maxInputTokens ?? null, maxOutputTokens: policy?.maxOutputTokens ?? null, maxEstimatedCostUsd: policy?.maxEstimatedCostUsd ?? null }, null, 2), "info");
        return;
      }

      let reservation: Record<string, unknown> | undefined;
      let response: any;
      let launched = false;
      let taskPolicyDigest: string | undefined;
      try {
        if (!ledger) throw new SentinelError("SENTINEL_SESSION_UNAVAILABLE");
        const policy = readSentinelPolicy();
        const stored = readModelPolicy();
        const preset = stored.preset === "custom" ? stored.basePreset : stored.preset;
        const quality = getSessionQuality();
        const taskPolicy = resolveTaskPolicy({ task: action, preset, quality, availableContext: availableContextFromPiUsage(ctx.getContextUsage()) });
        taskPolicyDigest = taskPolicy.digest;
        pi.events.emit("pi-overdrive:routing-metadata", taskPolicyMetadata(taskPolicy));
        if (!taskPolicy.needs.sentinel) throw new SentinelError("SENTINEL_TASK_POLICY_DENIED");
        ledger.assertAvailable();

        const registeredModels = ctx.modelRegistry.getAll();
        const modelPolicy: any = resolveModelPolicy(ctx.modelRegistry.getAvailable(), stored, {
          registeredModels,
          qualityRequested: quality,
          effectiveQuality: quality === "auto" ? taskPolicy.effectiveQuality : quality,
        });
        const route = modelPolicy.roles[policy.routeRole];
        const model = ctx.modelRegistry.find(route.provider, route.modelId);
        if (!model) throw new SentinelError("SENTINEL_ROUTE_UNAVAILABLE");
        const prepared = prepareSentinelInvocation({ task: action, taskPolicy, modelPolicyDigest: modelPolicy.digest, route, model, policy });
        const messages = prepared.messages as Message[];
        const fit = governContext({
          messages, systemPrompt: prepared.systemPrompt, tools: [], activeToolNames: [], model,
          reserveOutputTokens: policy.maxOutputTokens, policy: readContextGovernorPolicy(),
        });
        pi.events.emit("pi-overdrive:context-metadata", { ...contextFitMetadata(fit), kind: "context_fit_direct_sentinel" });
        if (fit.proof.status !== CONTEXT_FIT_STATUS.PASS) throw new SentinelError("SENTINEL_CONTEXT_BLOCKED");

        reservation = ledger.reserve(prepared) as unknown as Record<string, unknown>;
        persist(reservation);
        launched = true;
        response = await ctx.modelRegistry.complete(model as any, { systemPrompt: prepared.systemPrompt, messages: fit.messages as Message[] }, {
          reasoning: route.thinking,
          cacheRetention: "none",
          sessionId: `sentinel-${String(reservation.invocationId)}`,
          maxTokens: policy.maxOutputTokens,
          maxRetries: 0,
          timeoutMs: policy.timeoutMs,
          signal: AbortSignal.timeout(policy.timeoutMs),
        } as any);
        if (response.provider !== route.provider || response.model !== route.modelId) throw new SentinelError("SENTINEL_EXECUTED_ROUTE_MISMATCH");
        const advice = validateSentinelAdvice(responseText(response), policy);
        const completed = ledger.complete(reservation, response, advice, policy) as unknown as Record<string, unknown>;
        persist(completed);
        pi.sendMessage({
          customType: SENTINEL_MESSAGE_TYPE,
          content: renderSentinelAdvice(advice, policy),
          display: true,
          details: { adviceDigest: completed.adviceDigest, severity: advice.severity, confidence: advice.confidence, receiptDigest: completed.receiptDigest },
        }, { triggerTurn: false });
        ctx.ui.notify("Sentinel completed one bounded read-only review; no additional agent turn was started.", "info");
      } catch (error) {
        const code = codeFor(error);
        if (reservation && ledger && launched) {
          try { persist(ledger.fail(reservation, code, response) as unknown as Record<string, unknown>); } catch {}
        } else {
          try { emit({ status: "BLOCKED", errorCode: code, taskPolicyDigest } as Record<string, unknown>); } catch {}
        }
        notifyFailure(ctx, code);
      }
    },
  });
}
