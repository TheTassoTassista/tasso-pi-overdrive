import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readModelPolicy } from "../lib/model-policy.mjs";
import { getSessionQuality } from "../lib/routing-session.mjs";
import { availableContextFromPiUsage, resolveTaskPolicy } from "../lib/task-governor.mjs";
import {
  DIRECTOR_MODE_EVENT,
  directorEvent,
  directorSystemPrompt,
  directorTaskDigest,
  directorToolAllowed,
  readDirectorPolicy,
  resolveDirectorDecision,
  selectDirectorTools,
} from "../lib/director-mode.mjs";

interface DirectorState {
  taskDigest: string;
  taskPolicyDigest: string;
  sessionDigest: string;
  previousTools: string[];
  started: boolean;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export default function directorMode(pi: ExtensionAPI): void {
  const policy = readDirectorPolicy();
  let state: DirectorState | undefined;

  const publish = (status: string, reasonCode: string, activeToolCount: number, blockedTool: string | null = null) => {
    if (!state) return;
    try {
      pi.events.emit(DIRECTOR_MODE_EVENT, directorEvent({
        status, reasonCode, activeToolCount, blockedTool,
        sessionDigest: state.sessionDigest,
        taskDigest: state.taskDigest,
        taskPolicyDigest: state.taskPolicyDigest,
      }));
    } catch {}
  };

  const restore = (status: "COMPLETED" | "CANCELLED", reasonCode: "AGENT_SETTLED" | "USER_CANCELLED", ctx?: any) => {
    if (!state) return;
    const prior = state;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const restored = prior.previousTools.filter((name) => available.has(name));
    publish(status, reasonCode, pi.getActiveTools().length);
    state = undefined;
    pi.setActiveTools(restored);
    ctx?.ui?.setStatus?.("director-mode", undefined);
  };

  pi.on("session_start", () => { state = undefined; });
  pi.on("session_shutdown", () => { state = undefined; });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state) return undefined;
    if (event.messageType !== "user") {
      pi.setActiveTools(pi.getAllTools().some((tool) => tool.name === "read") ? ["read"] : []);
      publish("POLICY_MISMATCH", "TASK_POLICY_MISMATCH", pi.getActiveTools().length);
      return { systemPrompt: `${event.systemPrompt}\n\nPolicy binding failed. Do not act; report DIRECTOR_TASK_POLICY_MISMATCH.` };
    }
    try {
      const stored = readModelPolicy();
      const preset = stored.preset === "custom" ? stored.basePreset : stored.preset;
      const current = resolveTaskPolicy({ task: event.prompt, preset, quality: getSessionQuality(), availableContext: availableContextFromPiUsage(ctx.getContextUsage()) });
      const currentDecision = resolveDirectorDecision(current, policy);
      if (directorTaskDigest(event.prompt) !== state.taskDigest || !currentDecision.eligible) {
        pi.setActiveTools(pi.getAllTools().some((tool) => tool.name === "read") ? ["read"] : []);
        publish("POLICY_MISMATCH", "TASK_POLICY_MISMATCH", pi.getActiveTools().length);
        return { systemPrompt: `${event.systemPrompt}\n\n${directorSystemPrompt()}\nPolicy binding failed. Do not act; report DIRECTOR_TASK_POLICY_MISMATCH.` };
      }
      const selected = selectDirectorTools(pi.getActiveTools(), pi.getAllTools().map((tool) => tool.name), policy);
      pi.setActiveTools([...selected]);
      state.started = true;
      publish("STARTED", "ELIGIBLE_BOUNDED_DELEGATION", selected.length);
      ctx.ui.setStatus("director-mode", `director: active (${selected.length} read/delegate/verify tools)`);
      return { systemPrompt: `${event.systemPrompt}\n\n${directorSystemPrompt()}` };
    } catch {
      pi.setActiveTools(pi.getAllTools().some((tool) => tool.name === "read") ? ["read"] : []);
      publish("POLICY_MISMATCH", "TASK_POLICY_MISMATCH", pi.getActiveTools().length);
      return { systemPrompt: `${event.systemPrompt}\n\nPolicy binding failed. Do not act; report DIRECTOR_TASK_POLICY_MISMATCH.` };
    }
  });

  pi.on("tool_call", (event) => {
    if (!state || directorToolAllowed(event.toolName, policy)) return undefined;
    publish("DIRECT_TOOL_BLOCKED", "DIRECT_TOOL_FORBIDDEN", pi.getActiveTools().length, event.toolName);
    return { block: true as const, reason: `Director Mode blocks direct tool '${event.toolName}'. Delegate repository mutation through secure_coding_workflow.` };
  });

  pi.on("agent_settled", (_event, ctx) => { restore("COMPLETED", "AGENT_SETTLED", ctx); });

  pi.registerCommand("director", {
    description: "Run one policy-eligible task in read/plan/delegate/verify Director Mode: /director [status|off|TASK]",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();
        if (!input || input === "status") {
          const detail = state ? `ACTIVE task=${state.taskDigest.slice(0, 12)} policy=${state.taskPolicyDigest.slice(0, 12)} started=${state.started}` : "IDLE";
          ctx.ui.notify(`Director Mode: ${detail}\nExplicit task only; direct mutation fallback disabled; added model/provider calls: 0.`, "info");
          return;
        }
        if (input === "off") {
          if (!state) { ctx.ui.notify("Director Mode: IDLE", "info"); return; }
          if (!ctx.isIdle()) throw new Error("DIRECTOR_BUSY_CANNOT_CANCEL");
          restore("CANCELLED", "USER_CANCELLED", ctx);
          ctx.ui.notify("Director Mode cancelled; the prior tool surface was restored.", "info");
          return;
        }
        if (state) throw new Error("DIRECTOR_ALREADY_ACTIVE");
        if (!ctx.isIdle()) throw new Error("DIRECTOR_REQUIRES_IDLE_SESSION");
        const task = input.startsWith("on ") ? input.slice(3).trim() : input;
        if (!task || task.length > policy.maxTaskChars) throw new Error("DIRECTOR_TASK_INVALID");
        const stored = readModelPolicy();
        const preset = stored.preset === "custom" ? stored.basePreset : stored.preset;
        const taskPolicy = resolveTaskPolicy({ task, preset, quality: getSessionQuality(), availableContext: availableContextFromPiUsage(ctx.getContextUsage()) });
        const decision = resolveDirectorDecision(taskPolicy, policy);
        const sessionDigest = digest(ctx.sessionManager.getSessionId());
        const taskDigest = directorTaskDigest(task);
        if (!decision.eligible) {
          const rejected = { taskDigest, taskPolicyDigest: taskPolicy.digest, sessionDigest, previousTools: [] as string[], started: false };
          state = rejected;
          publish("INELIGIBLE", decision.reasonCode, 0);
          state = undefined;
          ctx.ui.notify(`Director Mode not activated: ${decision.reasonCode}. Use the normal bounded tool path; tiny/read-only tasks remain tiny.`, "warning");
          return;
        }
        const previousTools = [...pi.getActiveTools()];
        const selected = selectDirectorTools(previousTools, pi.getAllTools().map((tool) => tool.name), policy);
        state = { taskDigest, taskPolicyDigest: taskPolicy.digest, sessionDigest, previousTools, started: false };
        pi.setActiveTools([...selected]);
        publish("ACTIVATED", decision.reasonCode, selected.length);
        ctx.ui.setStatus("director-mode", `director: armed (${selected.length} tools)`);
        pi.sendUserMessage(task);
      } catch (error) {
        if (state && !state.started) restore("CANCELLED", "USER_CANCELLED", ctx);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
