import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { CONTEXT_FIT_STATUS, contextFitMetadata, governContext, readContextGovernorPolicy, renderContextFit } from "../lib/context-governor.mjs";

interface FitProof {
  status: string;
  provider: string;
  model: string;
  proofDigest: string;
}

function toolsFor(pi: ExtensionAPI) {
  return { tools: pi.getAllTools(), activeToolNames: pi.getActiveTools() };
}

function runGate(pi: ExtensionAPI, messages: AgentMessage[], ctx: ExtensionContext, reserveOutputTokens?: number) {
  if (!ctx.model) throw new Error("context_model_unavailable");
  const usage = ctx.getContextUsage();
  return governContext({
    messages,
    systemPrompt: ctx.getSystemPrompt(),
    ...toolsFor(pi),
    model: ctx.model,
    reserveOutputTokens,
    reportedUsageTokens: usage?.tokens ?? undefined,
    reportedContextWindow: usage?.contextWindow,
    policy: readContextGovernorPolicy(),
  });
}

export default function contextGovernorExtension(pi: ExtensionAPI): void {
  let latest: ReturnType<typeof governContext> | undefined;
  let providerProof: FitProof | undefined;

  pi.on("context", (event, ctx) => {
    try {
      latest = runGate(pi, event.messages, ctx);
      const metadata = contextFitMetadata(latest);
      providerProof = { status: metadata.status, provider: metadata.provider, model: metadata.model, proofDigest: metadata.proofDigest };
      pi.events.emit("pi-overdrive:context-metadata", metadata);
      ctx.ui.setStatus("context-fit", metadata.status === CONTEXT_FIT_STATUS.PASS ? `fit ${metadata.finalInputTokens}/${metadata.usableInputTokens}` : "fit BLOCKED");
      if (metadata.status !== CONTEXT_FIT_STATUS.PASS) {
        ctx.abort();
        if (ctx.hasUI) ctx.ui.notify(renderContextFit(latest), "error");
      }
      return { messages: latest.messages };
    } catch (error) {
      providerProof = undefined;
      ctx.abort();
      pi.events.emit("pi-overdrive:context-metadata", { kind: "context_fit", version: 1, status: "BLOCKED", reason: "CONTEXT_GATE_ERROR", errorCode: error instanceof Error && /^context_[a-z0-9_]+$/u.test(error.message) ? error.message : "context_gate_failed" });
      ctx.ui.setStatus("context-fit", "fit BLOCKED");
      if (ctx.hasUI) ctx.ui.notify("Context Fit Gate failed closed before provider access.", "error");
      return { messages: event.messages };
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!providerProof || providerProof.status !== CONTEXT_FIT_STATUS.PASS || !model || providerProof.provider !== model.provider || providerProof.model !== model.id) {
      ctx.abort();
      pi.events.emit("pi-overdrive:context-metadata", { kind: "context_fit_provider_attestation", status: "BLOCKED", reason: "MISSING_OR_STALE_CONTEXT_FIT_PROOF", provider: model?.provider ?? null, model: model?.id ?? null });
      return event.payload;
    }
    pi.events.emit("pi-overdrive:context-metadata", { kind: "context_fit_provider_attestation", status: "PASS", provider: providerProof.provider, model: providerProof.model, proofDigest: providerProof.proofDigest });
    return event.payload;
  });

  pi.registerCommand("context-fit", {
    description: "Show a zero-model-call Context Fit Gate report for the active target",
    handler: async (_args, ctx) => {
      try {
        const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages) as AgentMessage[];
        latest = runGate(pi, messages, ctx);
        ctx.ui.notify(renderContextFit(latest), latest.proof.status === CONTEXT_FIT_STATUS.PASS ? "info" : "warning");
      } catch {
        ctx.ui.notify("Context Fit Gate report is unavailable; provider access remains fail-closed.", "error");
      }
    },
  });
}
