import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENT_HUB_EVENT,
  roleReceiptMetadata,
  roleReservationMetadata,
  roleStartedMetadata,
  workflowJournalMetadata,
} from "../../lib/agent-hub.mjs";
import { checkpointWorkflowJournal, createEvidenceRun, initialWorkflowJournal, taskDigest, writeWorkflowJournal } from "../../lib/workflow-evidence.mjs";
import { makeRoleReceipt, openRoleReceiptStore, writeRoleReceipt } from "../../lib/workflow-receipts.mjs";

const route = { provider: "agent-hub-local", model: "agent-hub-local/fixture", thinking: "low", fallbackIndex: 0 };

export default function deterministicAgentHubController(pi: ExtensionAPI): void {
  pi.registerProvider("agent-hub-local", {
    name: "Agent Hub no-call fixture",
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "AGENT_HUB_NO_CALL",
    api: "agent-hub-no-call",
    models: [{ id: "fixture", name: "Agent Hub no-call fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple: () => {
      const audit = process.env.PI_OVERDRIVE_AGENT_HUB_UNEXPECTED_CALL_FILE;
      if (audit) fs.appendFileSync(audit, "UNEXPECTED_PROVIDER_CALL\n", { mode: 0o600 });
      throw new Error("Agent Hub benchmark must not invoke a provider");
    },
  } as any);

  pi.registerCommand("agent-hub-fixture", {
    description: "Emit deterministic controller-owned metadata and durable role receipts",
    handler: async (_args, ctx) => {
      const root = process.env.PI_OVERDRIVE_AGENT_HUB_EVIDENCE_ROOT;
      if (!root) throw new Error("PI_OVERDRIVE_AGENT_HUB_EVIDENCE_ROOT is required");
      const run = createEvidenceRun({ root });
      const taskId = taskDigest("deterministic Agent Hub lifecycle fixture");
      const ownerRunId = "agent-hub-deterministic-controller";
      const protocolNonce = taskDigest("agent-hub-deterministic-protocol");
      const workflowState = {
        hardLimits: { concurrency: 3, subagentDepth: 1, correctionIterations: 2 },
        spawnBudget: { configuredSpawnLimit: 42, workflowLimit: 42, used: 0, remaining: 42, retriesUsed: 0, retryReserveRemaining: 3 },
      };
      let journal = initialWorkflowJournal(run, { taskDigest: taskId, protocolNonce, workflowVersion: 5, sourceRepository: ctx.cwd, ownerRunId, workflowState });
      writeWorkflowJournal(run, journal);
      pi.events.emit(AGENT_HUB_EVENT, workflowJournalMetadata(journal));
      const store = openRoleReceiptStore(run);

      const identities = [
        { role: "worker", sequence: 0, executionId: "10000000-0000-4000-8000-000000000001", nodeId: "01-worker" },
        { role: "tester", sequence: 1, executionId: "10000000-0000-4000-8000-000000000002", nodeId: "02-tester" },
        { role: "correctness-reviewer", sequence: 2, executionId: "10000000-0000-4000-8000-000000000003", nodeId: "03-correctness-reviewer" },
      ];
      const reservations = identities.map((identity, index) => roleReservationMetadata({
        runId: run.runId,
        taskDigest: taskId,
        executionId: identity.executionId,
        sequence: identity.sequence,
        role: identity.role,
        round: 0,
        iteration: 0,
        attempt: 1,
        nodeId: identity.nodeId,
        route,
        callNumber: index + 1,
        retryCount: 0,
        spawnBudgetUsed: index + 1,
      }));
      for (const reservation of reservations) {
        pi.events.emit(AGENT_HUB_EVENT, reservation);
        pi.events.emit(AGENT_HUB_EVENT, roleStartedMetadata(reservation));
      }

      const completed = makeRoleReceipt({
        runId: run.runId, taskId, protocolNonce, executionId: identities[0].executionId, sequence: 0,
        role: "worker", round: 0, iteration: 0, attempt: 1, nodeId: identities[0].nodeId, ownerRunId,
        response: {
          status: "completed", agent: "worker", nodeId: identities[0].nodeId, ownerRunId,
          runId: "20000000-0000-4000-8000-000000000001", provider: route.provider, model: route.model, thinking: route.thinking,
          exitCode: 0, launchStatus: "launched", usage: { input: 200, output: 50, cacheRead: 25, cacheWrite: 0, cost: 0.02, turns: 1, toolCalls: 3, durationMs: 1200 },
        },
      });
      const completedReference = writeRoleReceipt(store, completed);
      pi.events.emit(AGENT_HUB_EVENT, roleReceiptMetadata(completed, completedReference));

      const failed = makeRoleReceipt({
        runId: run.runId, taskId, protocolNonce, executionId: identities[2].executionId, sequence: 2,
        role: "correctness-reviewer", round: 0, iteration: 0, attempt: 1, nodeId: identities[2].nodeId, ownerRunId,
        response: {
          status: "failed", agent: "correctness-reviewer", nodeId: identities[2].nodeId, ownerRunId,
          runId: "20000000-0000-4000-8000-000000000003", provider: route.provider, model: route.model, thinking: route.thinking,
          exitCode: 1, launchStatus: "launched", failureCategory: "DETERMINISTIC", error: "fixture failure content must remain digest-only",
        },
      });
      const failedReference = writeRoleReceipt(store, failed);
      pi.events.emit(AGENT_HUB_EVENT, roleReceiptMetadata(failed, failedReference));

      journal = checkpointWorkflowJournal(run, journal, {
        checkpoint_seq: journal.checkpoint_seq + 1,
        current_phase: "REVIEW",
        worker_status: "completed",
        tester_status: "RUNNING",
        review_status: "FAILED",
        workflow_state: {
          ...workflowState,
          spawnBudget: { ...workflowState.spawnBudget, used: 3, remaining: 39 },
        },
      });
      pi.events.emit(AGENT_HUB_EVENT, workflowJournalMetadata(journal));
      ctx.ui.notify("Agent Hub deterministic lifecycle fixture emitted.", "info");
    },
  });

  pi.registerCommand("agent-hub-invalid-event", {
    description: "Inject one forbidden-field event to prove the optional projection fails soft",
    handler: async (_args, ctx) => {
      pi.events.emit(AGENT_HUB_EVENT, {
        version: 1,
        kind: "role_reserved",
        transcript: "FORBIDDEN_FIXTURE_TRANSCRIPT",
      });
      ctx.ui.notify("Invalid Agent Hub event emitted; controller remains available.", "info");
    },
  });
}
