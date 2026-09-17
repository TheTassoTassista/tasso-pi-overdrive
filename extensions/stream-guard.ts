import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  STREAM_GUARD_ENTRY_TYPE,
  StreamGuardEngine,
  registerStreamGuardSession,
  streamGuardMetadata,
  unregisterStreamGuardSession,
} from "../lib/stream-guard.mjs";

function toolBlock(event: any): { id: string; name: string; arguments?: unknown } | undefined {
  const update = event?.assistantMessageEvent;
  const index = update?.contentIndex;
  const partial = update?.partial;
  const block = partial?.role === "assistant" && Array.isArray(partial.content) && Number.isSafeInteger(index) ? partial.content[index] : undefined;
  if (!block || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") return undefined;
  return { id: block.id, name: block.name, arguments: block.arguments };
}

export default function streamGuardExtension(pi: ExtensionAPI): void {
  let engine: StreamGuardEngine | undefined;
  let sessionId: string | undefined;
  let brokerOwner: symbol | undefined;

  const persist = (receipt: Record<string, unknown>) => {
    pi.appendEntry(STREAM_GUARD_ENTRY_TYPE, receipt);
    pi.events.emit("pi-overdrive:streamguard-metadata", streamGuardMetadata(receipt));
  };
  const persistMany = (receipts: readonly Record<string, unknown>[]) => { for (const receipt of receipts) persist(receipt); };

  const unregisterBroker = () => {
    if (sessionId && brokerOwner) unregisterStreamGuardSession(sessionId, brokerOwner);
    sessionId = undefined;
    brokerOwner = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    unregisterBroker();
    const receipts = ctx.sessionManager.getBranch().flatMap((entry: any) => entry?.type === "custom" && entry.customType === STREAM_GUARD_ENTRY_TYPE ? [entry.data] : []);
    engine = new StreamGuardEngine({ receipts });
    sessionId = ctx.sessionManager.getSessionId();
    brokerOwner = registerStreamGuardSession(sessionId, engine, (receipt: Record<string, unknown>) => persist(receipt));
  });

  pi.on("turn_start", () => { engine?.beginTurn(); });

  pi.on("message_update", (event: any) => {
    if (!engine) return;
    const update = event.assistantMessageEvent;
    if (!update || !["toolcall_start", "toolcall_delta", "toolcall_end"].includes(update.type)) return;
    const block = update.type === "toolcall_end" ? update.toolCall : toolBlock(event);
    if (!block || typeof block.id !== "string" || typeof block.name !== "string") return;
    engine.startTool(block.id, block.name);
    const reservation = update.type === "toolcall_delta"
      ? engine.observeToolDelta(block.id, block.name, update.delta)
      : update.type === "toolcall_end"
        ? engine.observeToolSnapshot(block.id, block.name, block.arguments)
        : undefined;
    if (reservation) persist(reservation as unknown as Record<string, unknown>);
  });

  pi.on("message_end", (event: any) => {
    if (event.message?.role === "assistant" && ["aborted", "error"].includes(event.message.stopReason)) persistMany((engine?.expirePending("ASSISTANT_TERMINAL") ?? []) as unknown as Record<string, unknown>[]);
  });
  pi.on("turn_end", () => { persistMany((engine?.expirePending("TURN_ENDED") ?? []) as unknown as Record<string, unknown>[]); });
  pi.on("agent_settled", () => { persistMany((engine?.expirePending("AGENT_SETTLED") ?? []) as unknown as Record<string, unknown>[]); });
  pi.on("session_shutdown", () => {
    persistMany((engine?.shutdown() ?? []) as unknown as Record<string, unknown>[]);
    unregisterBroker();
  });

  pi.registerCommand("stream-guard", {
    description: "Show local StreamGuard reservation/delivery counters without starting a model or tool",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(engine?.status() ?? { version: 1, enabled: false, active: false }, null, 2), "info"),
  });
}
