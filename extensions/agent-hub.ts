import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_HUB_EVENT, AgentHubProjection, readAgentHubPolicy, renderAgentHubSnapshot } from "../lib/agent-hub.mjs";

export default function agentHubExtension(pi: ExtensionAPI): void {
  let projection: AgentHubProjection | undefined;
  let startupError: string | null = null;

  const initialize = () => {
    try {
      projection = new AgentHubProjection({ policy: readAgentHubPolicy() });
      startupError = null;
    } catch (error: any) {
      projection = undefined;
      startupError = typeof error?.code === "string" ? error.code : "AGENT_HUB_UNAVAILABLE";
    }
  };

  initialize();
  pi.events.on(AGENT_HUB_EVENT, (value) => {
    if (!projection) return;
    try { projection.ingest(value); }
    catch (error) { projection.failSoft(error); }
  });

  pi.on("session_start", () => {
    if (!projection) initialize();
    else projection.reset();
  });
  pi.on("session_shutdown", () => { projection?.reset(); });

  pi.registerCommand("agents", {
    description: "Show the read-only metadata roster from durable workflow journals and role receipts",
    handler: async (_args, ctx) => {
      const snapshot = projection?.snapshot() ?? {
        version: 1,
        enabled: false,
        mode: "READ_ONLY_METADATA",
        status: "DEGRADED",
        errorCode: startupError ?? "AGENT_HUB_UNAVAILABLE",
        authority: { modelCalls: 0, tools: 0, steering: false, revive: false, kill: false, spawn: false },
      };
      ctx.ui.notify(renderAgentHubSnapshot(snapshot), snapshot.status === "DEGRADED" ? "warning" : "info");
    },
  });
}
