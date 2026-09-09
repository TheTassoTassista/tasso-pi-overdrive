import process from "node:process";
import { runEnforcedWorkflow, WORKFLOW_VERSION } from "../../lib/workflow-state.mjs";
import { checkpointWorkflowJournal, createEvidenceRun, initialWorkflowJournal, writeWorkflowJournal } from "../../lib/workflow-evidence.mjs";

const root = process.env.PI_TEST_EVIDENCE_ROOT;
const runId = process.env.PI_TEST_RUN_ID;
const digest = process.env.PI_TEST_TASK_DIGEST;
const ownerRunId = "interruption-test-owner";
const allocation = { allocationId: "00000000-0000-4000-8000-000000000099", worktree: "/tmp/interruption-test-worktree", port: 39876, stateDir: "/tmp/interruption-state", browserProfile: "/tmp/interruption-browser", browserSession: "interruption-browser", database: "interruption_db", schema: "interruption_schema" };
const modelPolicy = { digest: "recovery-test-policy", roles: {} };
const run = createEvidenceRun({ root, runId });
let journal = initialWorkflowJournal(run, { taskDigest: digest, workflowVersion: WORKFLOW_VERSION, sourceRepository: "/tmp/interruption-source", ownerRunId, allocationId: allocation.allocationId });
writeWorkflowJournal(run, journal);
let identity = 0;
let correctnessRound = 0;
const delegate = async ({ agent, result }) => {
  const response = { status: "completed", agent, model: `model-${agent}`, runId: `child-run-${identity}`, nodeId: `${String(++identity).padStart(2, "0")}-${agent}`, ownerRunId };
  if (result.kind !== "structured") return { ...response, result: { kind: "text", text: `${agent} evidence` } };
  if (agent.startsWith("council-") && agent !== "council-judge") return { ...response, result: { kind: "structured", value: { conclusion: "correct the blocker", recommendation: "correct", confidence: "HIGH", evidence: ["fixture"], risks: [], blockingConcerns: ["planted correction"] } } };
  if (agent === "council-judge") return { ...response, result: { kind: "structured", value: { decision: "correct", decisionBasis: "one reviewer has reproducible evidence", confidence: "HIGH", agreements: [], disagreements: ["review verdicts differ"], requiredActions: ["correct planted defect"] } } };
  if (agent === "correctness-reviewer") correctnessRound += 1;
  const blocking = agent === "correctness-reviewer" && correctnessRound === 1;
  return { ...response, result: { kind: "structured", value: { verdict: blocking ? "BLOCKING" : "PASS", summary: "crash fixture", findings: blocking ? [{ severity: "BLOCKING", title: "planted correction", evidence: "fixture" }] : [] } } };
};

await runEnforcedWorkflow({
  task: "simulated interruption fixture",
  allocation,
  delegate,
  verify: async () => ({ status: "PASS", processExitCode: 0 }),
  ownerRunId,
  runId,
  taskId: digest,
  modelPolicy,
  onCheckpoint: (state) => {
    journal = checkpointWorkflowJournal(run, journal, {
      status: "RUNNING",
      workflow_status: state.status,
      current_phase: state.currentPhase,
      round: state.round,
      worker_status: state.workerStatus,
      tester_status: state.testerStatus,
      verification_status: state.verificationStatus,
      review_status: state.reviewStatus,
      blocking_findings_count: state.blockingFindingsCount,
      correction_performed: state.correctionPerformed,
      final_verification_status: state.finalVerificationStatus,
      workflow_state: state,
    });
    const transition = state.evidence.transitions.at(-1);
    if (transition?.state === "CORRECTION_REQUIRED" && transition.phase === "enforced") process.kill(process.pid, "SIGKILL");
  },
});
