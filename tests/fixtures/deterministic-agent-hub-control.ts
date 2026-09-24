import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentAttemptController, requestExactUserCancellation } from "../../lib/agent-hub-control.mjs";
import { AGENT_HUB_EVENT, roleReceiptMetadata, roleReservationMetadata, roleStartedMetadata, workflowJournalMetadata } from "../../lib/agent-hub.mjs";
import { checkpointWorkflowJournal, createEvidenceRun, initialWorkflowJournal, taskDigest, writeWorkflowJournal } from "../../lib/workflow-evidence.mjs";
import { makeRoleReceipt, openRoleReceiptStore, writeRoleReceipt } from "../../lib/workflow-receipts.mjs";
import { cleanupRuntimeResources, createRuntimeWorktree } from "../../lib/runtime-isolation.mjs";
import { captureProcessIdentity } from "../../lib/process-identity.mjs";

const route = { provider: "agent-hub-control-local", model: "agent-hub-control-local/fixture", thinking: "off", fallbackIndex: 0 };

export default function deterministicAgentHubControl(pi: ExtensionAPI): void {
  let controller: AgentAttemptController | undefined;
  let active = false;
  pi.registerProvider("agent-hub-control-local", {
    name: "Agent Hub control no-call fixture",
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "NO_NETWORK_CALL",
    api: "agent-hub-control-no-call",
    models: [{ id: "fixture", name: "No-call fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple: () => {
      const marker = process.env.PI_OVERDRIVE_AGENT_HUB_UNEXPECTED_CALL_FILE;
      if (marker) fs.appendFileSync(marker, "UNEXPECTED_PROVIDER_CALL\n", { mode: 0o600 });
      throw new Error("The deterministic Agent Hub control benchmark must make zero provider calls");
    },
  } as any);

  pi.registerCommand("agent-hub-control-start", {
    description: "Start one bounded controller-owned local Worker fixture in an isolated worktree",
    handler: async (_args, ctx) => {
      if (active) { ctx.ui.notify("Agent Hub control fixture already active.", "warning"); return; }
      active = true;
      const root = process.env.PI_OVERDRIVE_AGENT_HUB_EVIDENCE_ROOT;
      if (!root) throw new Error("PI_OVERDRIVE_AGENT_HUB_EVIDENCE_ROOT is required");
      const run = createEvidenceRun({ root });
      const taskId = taskDigest("deterministic local Agent Hub cancellation benchmark");
      const ownerRunId = `agent-hub-control-${randomUUID()}`;
      const protocolNonce = taskDigest(ownerRunId);
      const allocation = await createRuntimeWorktree(ctx.cwd, { evidenceRunId: run.runId, ownerRunId });
      const workflowState = {
        hardLimits: { concurrency: 3, subagentDepth: 1, correctionIterations: 2 },
        spawnBudget: { configuredSpawnLimit: 42, workflowLimit: 42, used: 1, remaining: 41, retriesUsed: 0, retryReserveRemaining: 3 },
      };
      let journal = initialWorkflowJournal(run, { taskDigest: taskId, protocolNonce, workflowVersion: 5, sourceRepository: ctx.cwd, ownerRunId, workflowState });
      writeWorkflowJournal(run, journal);
      pi.events.emit(AGENT_HUB_EVENT, workflowJournalMetadata(journal));
      const store = openRoleReceiptStore(run);
      const executionId = randomUUID();
      const nodeId = "01-worker";
      const reservation = roleReservationMetadata({ runId: run.runId, taskDigest: taskId, executionId, sequence: 0, role: "worker", round: 0, iteration: 0, attempt: 1, nodeId, route, callNumber: 1, retryCount: 0, spawnBudgetUsed: 1 });
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: allocation.worktree, stdio: "ignore" });
      if (!child.pid) throw new Error("Controller-owned Worker fixture failed to start");
      if (process.env.PI_OVERDRIVE_AGENT_HUB_WORKER_IDENTITY_FILE) fs.writeFileSync(process.env.PI_OVERDRIVE_AGENT_HUB_WORKER_IDENTITY_FILE, `${JSON.stringify(captureProcessIdentity(child.pid))}\n`, { mode: 0o600 });
      let cancellationRequested = false;
      controller = new AgentAttemptController({ sessionId: ctx.sessionManager.getSessionId(), runId: run.runId, taskDigest: taskId });
      controller.reserve({ executionId, role: "worker", sequence: 0, attempt: 1, cancel: () => {
        cancellationRequested = true;
        if (!child.kill("SIGTERM")) throw new Error("Controller-owned Worker could not be signalled");
      } });
      pi.events.emit(AGENT_HUB_EVENT, reservation);
      controller.started(executionId);
      pi.events.emit(AGENT_HUB_EVENT, roleStartedMetadata(reservation));
      const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
      child.once("exit", async (exitCode) => {
        clearTimeout(timeout);
        const status = cancellationRequested ? "cancelled" : "failed";
        try {
          const receipt = makeRoleReceipt({
            runId: run.runId, taskId, protocolNonce, executionId, sequence: 0, role: "worker", round: 0, iteration: 0, attempt: 1, nodeId, ownerRunId,
            response: { status, agent: "worker", nodeId, ownerRunId, error: status === "cancelled" ? "USER_CANCELLED_EXACT_ATTEMPT" : "BOUNDED_WORKER_EXITED", failureCategory: "DETERMINISTIC", launchStatus: "launched", exitCode },
          });
          const reference = writeRoleReceipt(store, receipt);
          controller?.terminal(executionId, status);
          pi.events.emit(AGENT_HUB_EVENT, roleReceiptMetadata(receipt, reference));
          cleanupRuntimeResources(allocation.allocationId);
          journal = checkpointWorkflowJournal(run, journal, { status: "FAILED", workflow_status: "FAIL", current_phase: "FINALIZED", worker_status: status, cleanup_status: "PASS", workflow_state: workflowState });
          pi.events.emit(AGENT_HUB_EVENT, workflowJournalMetadata(journal));
          ctx.ui.notify(`Agent Hub controller terminal: ${status.toUpperCase()}; cleanup PASS.`, "info");
        } catch {
          ctx.ui.notify("Agent Hub controller terminal or cleanup FAIL.", "error");
        } finally { controller?.close(); active = false; }
      });
      ctx.ui.notify(`Agent Hub controller started Worker ${executionId}.`, "info");
    },
  });

  pi.registerCommand("agent-cancel", {
    description: "Request exact controller-owned Worker cancellation",
    handler: async (args, ctx) => {
      if (!controller || !active) { ctx.ui.notify("Agent control denied: NO_ACTIVE_CONTROLLER", "warning"); return; }
      const decision = requestExactUserCancellation(controller, { requestId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), executionId: args.trim() });
      ctx.ui.notify(`Agent control ${decision.code}.`, decision.code === "CANCEL_REQUESTED" ? "info" : "warning");
    },
  });
}
