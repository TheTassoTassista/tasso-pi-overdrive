import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TraceRow {
  timestamp: string;
  event: string;
  [key: string]: string | number | boolean | string[] | null | undefined;
}

function safeSessionName(sessionFile: string | undefined): string {
  if (!sessionFile) return `ephemeral-${process.pid}`;
  return path.basename(sessionFile).replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export default function (pi: ExtensionAPI) {
  const startedTools = new Map<string, number>();
  let traceFile: string | undefined;

  const record = async (row: Omit<TraceRow, "timestamp">) => {
    if (!traceFile) return;
    await appendFile(traceFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...row })}\n`, { encoding: "utf8", mode: 0o600 });
  };

  pi.on("session_start", async (_event, ctx) => {
    const root = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "pi-overdrive", "traces");
    await mkdir(root, { recursive: true, mode: 0o700 });
    traceFile = path.join(root, `${safeSessionName(ctx.sessionManager.getSessionFile())}.jsonl`);
    await record({ event: "session_start", cwd: ctx.cwd, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined });
  });
  pi.on("model_select", async (event) => record({ event: "model_select", model: `${event.model.provider}/${event.model.id}`, source: event.source }));
  pi.on("agent_start", async () => record({ event: "agent_start" }));
  pi.on("agent_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    await record({ event: "agent_end", contextTokens: usage?.tokens ?? null, contextPercent: usage?.percent ?? null });
  });
  pi.on("agent_settled", async () => record({ event: "agent_settled" }));
  pi.on("tool_execution_start", async (event) => {
    startedTools.set(event.toolCallId, Date.now());
    await record({ event: "tool_start", tool: event.toolName, inputKeys: Object.keys(event.args ?? {}).sort() });
  });
  pi.on("tool_execution_end", async (event) => {
    const started = startedTools.get(event.toolCallId);
    startedTools.delete(event.toolCallId);
    await record({ event: "tool_end", tool: event.toolName, success: !event.isError, durationMs: started ? Date.now() - started : undefined });
  });
  pi.on("session_shutdown", async () => record({ event: "session_shutdown" }));

  pi.registerCommand("trace-path", {
    description: "Show the metadata-only trace path for this session",
    handler: async (_args, ctx) => ctx.ui.notify(traceFile ?? "Trace not initialized", "info"),
  });
}
