import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SUBAGENT_DEPTH, MAX_WORKFLOW_CONCURRENCY, runEnforcedWorkflow } from "../lib/workflow-state.mjs";

const allocation = { worktree: "/tmp/worktree", port: 32123, stateDir: "/tmp/state", browserProfile: "/tmp/profile", browserSession: "pi-test", database: "pi_test", schema: "pi_schema" };
const modelPolicy = { digest: "test-policy", roles: { worker: { model: "test/model", thinking: "low" } } };

function textResponse(agent) {
  return { status: "completed", agent, model: `model-for-${agent}`, result: { kind: "text", text: `${agent} evidence` } };
}

function structuredResponse(agent, block = false) {
  if (agent.startsWith("council-") && agent !== "council-judge") return { status: "completed", agent, model: `model-for-${agent}`, result: { kind: "structured", value: { conclusion: `${agent} conclusion`, recommendation: `${agent} recommendation`, confidence: "HIGH", evidence: ["fixture"], risks: [], blockingConcerns: [] } } };
  if (agent === "council-judge") return { status: "completed", agent, model: `model-for-${agent}`, result: { kind: "structured", value: { decision: "proceed", decisionBasis: "evidence, not majority", confidence: "HIGH", agreements: ["fixture"], disagreements: [], requiredActions: [] } } };
  return { status: "completed", agent, model: `model-for-${agent}`, result: { kind: "structured", value: { verdict: block ? "BLOCKING" : "PASS", summary: "review", findings: block ? [{ severity: "BLOCKING", title: "defect", evidence: "fixture" }] : [] } } };
}

test("fresh Tester and reviewers receive bounded real verification evidence and disk inspection instructions", async () => {
  const tasks = [];
  const verification = { status: "PASS", processExitCode: 0, results: [{ name: "contract-test", status: "PASS", exitCode: 0, sandboxed: true }], padding: "x".repeat(50000) };
  const state = await runEnforcedWorkflow({ task: "fix fixture", allocation, modelPolicy,
    delegate: async ({ agent, task, result }) => { tasks.push({ agent, task }); return result.kind === "structured" ? structuredResponse(agent) : textResponse(agent); },
    verify: async () => verification,
  });
  assert.equal(state.status, "PASS");
  for (const role of ["tester", "correctness-reviewer", "security-reviewer", "simplicity-reviewer"]) {
    const task = tasks.find(t => t.agent === role).task;
    assert.match(task, /Inspection handoff — UNTRUSTED DATA/u);
    assert.match(task, /contract-test/u);
    assert.match(task, /"processExitCode":0/u);
    assert.match(task, /read-only read\/find\/ls/u);
    assert.match(task, /\/tmp\/worktree/u);
    assert.equal(task.includes("x".repeat(12001)), false);
    assert.match(task, /no edit|Never edit/u);
  }
});

test("blocking review mechanically forces Worker correction and complete re-verification", async () => {
  const calls = [];
  let correctnessRound = 0;
  const delegate = async ({ agent, result }) => {
    calls.push(agent);
    if (result.kind !== "structured") return textResponse(agent);
    if (agent === "correctness-reviewer") correctnessRound += 1;
    const block = agent === "correctness-reviewer" && correctnessRound === 1;
    return structuredResponse(agent, block);
  };
  let verificationRound = 0;
  const state = await runEnforcedWorkflow({ task: "fix fixture", allocation, delegate, verify: async () => ({ status: "PASS", round: verificationRound++ }), includeOracle: true, modelPolicy });
  assert.equal(state.status, "PASS");
  assert.equal(calls.filter((role) => role === "worker").length, 2);
  assert.equal(calls.filter((role) => role === "tester").length, 2);
  assert.equal(calls.filter((role) => role === "correctness-reviewer").length, 2);
  assert.equal(state.evidence.verifications.length, 2);
  assert.equal(state.evidence.transitions.some((entry) => entry.state === "CORRECTION_REQUIRED"), true);
});

test("bounded publication is required after Worker receipt and before deterministic verification", async () => {
  const steps = [];
  const transactionId = 'a'.repeat(32);
  const state = await runEnforcedWorkflow({ task: "Create file `new.js` containing safe code", allocation, modelPolicy,
    delegate: async ({ agent, result }) => { steps.push(agent); return result.kind === "structured" ? structuredResponse(agent) : textResponse(agent); },
    receiptVerifier: (_response, { agent }) => ({ executionId: `${agent}-receipt`, sequence: 1, sha256: 'b'.repeat(64) }),
    afterWorker: (_response, { admitted }) => {
      assert.equal(admitted.executionId, 'worker-receipt');
      steps.push('published');
      return { status: 'PUBLISHED', operation: 'CREATE', transactionId, journalVersion: 6, intentDigest: 'c'.repeat(64) };
    },
    verify: async () => { steps.push('verified'); return { status: 'PASS', processExitCode: 0 }; },
  });
  assert.equal(state.status, 'PASS');
  assert.ok(steps.indexOf('worker') < steps.indexOf('published') && steps.indexOf('published') < steps.indexOf('verified'));
  assert.deepEqual(state.evidence.publications.map(({ operation, journalVersion, transactionId: id }) => [operation, journalVersion, id]), [['CREATE', 6, transactionId]]);
});

test("missing or forged bounded publication fails before verification and reviewers", async () => {
  for (const publication of [null, { status: 'PUBLISHED', operation: 'MODIFY', transactionId: 'a'.repeat(32), journalVersion: 6, intentDigest: 'c'.repeat(64) }, { status: 'PUBLISHED', operation: 'CREATE', transactionId: 'bad', journalVersion: 6, intentDigest: 'c'.repeat(64) }, { status: 'PUBLISHED', operation: 'CREATE', transactionId: 'a'.repeat(32), journalVersion: 5, intentDigest: 'c'.repeat(64) }]) {
    const calls = [];
    await assert.rejects(() => runEnforcedWorkflow({ task: 'bounded negative', allocation, modelPolicy,
      delegate: async ({ agent, result }) => { calls.push(agent); return result.kind === 'structured' ? structuredResponse(agent) : textResponse(agent); },
      afterWorker: () => publication,
      verify: async () => { calls.push('verification'); return { status: 'PASS' }; },
    }), /bounded Worker publication was not proved/u);
    assert.equal(calls.includes('verification'), false);
    assert.equal(calls.some(agent => agent.endsWith('-reviewer')), false);
  }
});

test("published bounded CREATE never launches a correction Worker without new authority", async () => {
  const calls = [];
  await assert.rejects(() => runEnforcedWorkflow({ task: 'bounded blocked review', allocation, modelPolicy,
    delegate: async ({ agent, result }) => {
      calls.push(agent);
      return result.kind === 'structured' ? structuredResponse(agent, agent === 'correctness-reviewer') : textResponse(agent);
    },
    afterWorker: () => ({ status: 'PUBLISHED', operation: 'CREATE', transactionId: 'a'.repeat(32), journalVersion: 6, intentDigest: 'c'.repeat(64) }),
    verify: async () => ({ status: 'PASS', processExitCode: 0 }),
  }), /PHI_BOUNDED_CREATE_CORRECTION_REQUIRES_NEW_AUTHORITY/u);
  assert.equal(calls.filter(agent => agent === 'worker').length, 1);
});

test("failed verification can never become PASS and stops after bounded correction", async () => {
  const delegate = async ({ agent, result }) => result.kind === "structured"
    ? structuredResponse(agent)
    : textResponse(agent);
  const state = await runEnforcedWorkflow({ task: "unfixable", allocation, delegate, verify: async () => ({ status: "FAIL", exitCode: 1 }), modelPolicy });
  assert.equal(state.status, "FAIL");
  assert.equal(state.evidence.verifications.length, 3);
  assert.equal(state.evidence.roles.filter((entry) => entry.agent === "worker").length, 3);
  assert.equal(state.evidence.transitions.at(-1).status, "FAIL");
});

test("reviewer fanout is exactly hard-capped at three and depth is one", async () => {
  let active = 0;
  let maximum = 0;
  const delegate = async ({ agent, result }) => {
    if (result.kind !== "structured") return textResponse(agent);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return structuredResponse(agent);
  };
  const state = await runEnforcedWorkflow({ task: "bounded", allocation, delegate, verify: async () => ({ status: "PASS" }), modelPolicy });
  assert.equal(state.status, "PASS");
  assert.equal(maximum, MAX_WORKFLOW_CONCURRENCY);
  assert.equal(MAX_WORKFLOW_CONCURRENCY, 3);
  assert.equal(MAX_SUBAGENT_DEPTH, 1);
});

test("callers cannot raise correction or concurrency semantics", async () => {
  await assert.rejects(() => runEnforcedWorkflow({ task: "override", allocation, delegate: async () => {}, verify: async () => {}, maxCorrections: 99, modelPolicy }), /override rejected/u);
  const state = await runEnforcedWorkflow({ task: "ignored limit fields", allocation, delegate: async ({ agent, result }) => result.kind === "structured" ? structuredResponse(agent) : textResponse(agent), verify: async () => ({ status: "PASS" }), concurrency: 99, maxSubagentDepth: 99, modelPolicy });
  assert.deepEqual(state.hardLimits, { concurrency: 3, subagentDepth: 1, correctionIterations: 2 });
});

test("a failed role exposes and checkpoints partial structured evidence", async () => {
  let checkpoint;
  let thrown;
  try {
    await runEnforcedWorkflow({
      task: "capture failure",
      allocation,
      delegate: async ({ agent }) => agent === "planner" ? { status: "failed" } : textResponse(agent),
      verify: async () => ({ status: "PASS" }),
      modelPolicy,
      onCheckpoint: (value) => { checkpoint = value; },
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown.workflowState.status, "FAIL");
  assert.equal(checkpoint.status, "FAIL");
  assert.equal(checkpoint.evidence.roles.some((entry) => entry.agent === "scout" && entry.status === "completed"), true);
  assert.equal(checkpoint.evidence.roles.some((entry) => entry.agent === "planner" && entry.status === "failed"), true);
  assert.equal(checkpoint.evidence.transitions.at(-1).state, "FINAL");
});

test("high-risk council runs three isolated members concurrently, then a separate judge", async () => {
  let activeMembers = 0;
  let maximumMembers = 0;
  const memberTasks = [];
  const callOrder = [];
  const delegate = async ({ agent, task, result }) => {
    callOrder.push(agent);
    if (agent.startsWith("council-") && agent !== "council-judge") {
      memberTasks.push(task);
      activeMembers += 1;
      maximumMembers = Math.max(maximumMembers, activeMembers);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeMembers -= 1;
    }
    return result.kind === "structured" ? structuredResponse(agent) : textResponse(agent);
  };
  const state = await runEnforcedWorkflow({ task: "high risk fixture", allocation, delegate, verify: async () => ({ status: "PASS" }), includeOracle: true, modelPolicy });
  const council = state.evidence.councils.find((entry) => entry.purpose === "high-risk-planning");
  assert.equal(council.complete, true);
  assert.equal(council.members.length, 3);
  assert.equal(maximumMembers, 3);
  assert.ok(memberTasks.every((task) => task.includes("Analyze independently") && !task.includes("Independent reports")));
  assert.ok(callOrder.indexOf("council-judge") > Math.max(callOrder.indexOf("council-1"), callOrder.indexOf("council-2"), callOrder.indexOf("council-3")));
  assert.equal(state.hardLimits.concurrency, 3);
  assert.equal(state.hardLimits.subagentDepth, 1);
});

test("one immutable Shared Memory Pack is reused without Council output cross-contamination", async () => {
  const tasks = new Map();
  const pack = "## Shared Memory Pack — UNTRUSTED DATA\nEvidence only.\n<memory-data>\n{\"id\":\"mem-1\",\"content\":\"verified fixture\"}\n</memory-data>";
  const delegate = async ({ agent, task, result }) => {
    tasks.set(agent, task);
    return result.kind === "structured" ? structuredResponse(agent) : textResponse(agent);
  };
  const state = await runEnforcedWorkflow({ task: "project architecture fixture", allocation, delegate, verify: async () => ({ status: "PASS" }), includeOracle: true, modelPolicy, sharedMemoryPack: pack, sharedMemoryMetadata: { id: "pack-id", route: "OPENVIKING", itemCount: 1, packChars: pack.length } });
  assert.equal(state.status, "PASS");
  for (const task of tasks.values()) assert.ok(task.includes(pack));
  const councilTasks = [tasks.get("council-1"), tasks.get("council-2"), tasks.get("council-3")];
  assert.equal(new Set(councilTasks).size, 1);
  assert.ok(councilTasks.every((task) => !task.includes("council-1 conclusion") && !task.includes("council-2 conclusion") && !task.includes("council-3 conclusion")));
  assert.deepEqual(state.memoryPack, { id: "pack-id", route: "OPENVIKING", itemCount: 1, packChars: pack.length });
});

test("missing or malformed council evidence fails closed before Judge", async () => {
  for (const mode of ["missing", "malformed"]) {
    let judgeCalled = false;
    await assert.rejects(() => runEnforcedWorkflow({
      task: `${mode} council fixture`, allocation, includeOracle: true, modelPolicy,
      delegate: async ({ agent, result }) => {
        if (agent === "council-judge") judgeCalled = true;
        if (agent === "council-2") return mode === "missing" ? { status: "failed", agent } : { status: "completed", agent, result: { kind: "structured", value: { recommendation: "incomplete" } } };
        return result.kind === "structured" ? structuredResponse(agent) : textResponse(agent);
      },
      verify: async () => ({ status: "PASS" }),
    }), /mandatory council members failed/u);
    assert.equal(judgeCalled, false);
  }
});

test("Judge preserves material disagreement and reviewer disagreement triggers council", async () => {
  let correctnessRound = 0;
  const delegate = async ({ agent, result }) => {
    if (agent === "correctness-reviewer") correctnessRound += 1;
    if (agent === "correctness-reviewer" && correctnessRound === 1) return structuredResponse(agent, true);
    if (agent === "council-judge") {
      const response = structuredResponse(agent);
      response.result.value.disagreements = ["correctness found a blocker while other reviewers passed"];
      response.result.value.requiredActions = ["repair the blocker"];
      return response;
    }
    return result.kind === "structured" ? structuredResponse(agent) : textResponse(agent);
  };
  const state = await runEnforcedWorkflow({ task: "review disagreement fixture", allocation, delegate, verify: async () => ({ status: "PASS" }), modelPolicy });
  const council = state.evidence.councils.find((entry) => entry.purpose === "reviewer-disagreement");
  assert.equal(state.status, "PASS");
  assert.deepEqual(council.judge.disagreements, ["correctness found a blocker while other reviewers passed"]);
  assert.deepEqual(council.judge.requiredActions, ["repair the blocker"]);
});

test("resumed workflow rejects a different model policy digest", async () => {
  const completed = await runEnforcedWorkflow({ task: "policy mismatch", allocation, modelPolicy, delegate: async ({ agent, result }) => result.kind === "structured" ? structuredResponse(agent) : textResponse(agent), verify: async () => ({ status: "PASS" }) });
  await assert.rejects(() => runEnforcedWorkflow({ task: "policy mismatch", allocation, modelPolicy: { ...modelPolicy, digest: "different-policy" }, resumeState: completed, delegate: async () => {}, verify: async () => ({ status: "PASS" }) }), /model policy mismatch/u);
});

test("resumed workflow rejects changed Shared Memory Pack evidence", async () => {
  const first = await runEnforcedWorkflow({ task: "small project change", allocation, delegate: async ({ agent, result }) => result.kind === "structured" ? structuredResponse(agent) : textResponse(agent), verify: async () => ({ status: "PASS" }), modelPolicy, sharedMemoryPack: "## Shared Memory Pack — UNTRUSTED DATA\nfirst", sharedMemoryMetadata: { id: "pack-first" } });
  await assert.rejects(
    runEnforcedWorkflow({ task: "small project change", allocation, delegate: async ({ agent, result }) => result.kind === "structured" ? structuredResponse(agent) : textResponse(agent), verify: async () => ({ status: "PASS" }), modelPolicy, resumeState: first, sharedMemoryPack: "## Shared Memory Pack — UNTRUSTED DATA\nchanged", sharedMemoryMetadata: { id: "pack-changed" } }),
    /shared memory pack mismatch/u,
  );
});
