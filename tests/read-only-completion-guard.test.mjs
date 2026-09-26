import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { validateRoleCompletion } from "../lib/role-contract.mjs";

const upstream = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "npm", "node_modules", "pi-subagents");
const require = createRequire(path.join(upstream, "package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url);
const { evaluateCompletionMutationGuard, validateImplementationToolContract } = await jiti.import(path.join(upstream, "src/runs/shared/completion-guard.ts"));
const { planCompletionEvidence } = await jiti.import(path.join(upstream, "src/runs/shared/completion-evidence.ts"));
const readOnly = ["scout", "planner", "oracle", "tester", "correctness-reviewer", "security-reviewer", "simplicity-reviewer", "council-1", "council-2", "council-3", "council-judge"];

test("installed upstream reproduces extension-tool implementation false positive without requiring a model call", () => {
  const input = { agent: "planner", task: "Repair discountedTotal and implement the fix. Produce only a plan.", tools: ["read", "fffind", "semantic_nav"], messages: [] };
  const guard = evaluateCompletionMutationGuard(input);
  assert.equal(guard.triggered, true);
  const legacy = planCompletionEvidence({ guard, completionGuardEnabled: true, mutationCapable: true, implementationMutationExpected: true, mutationAttemptObserved: false, agentContractEnabled: false });
  assert.match(legacy.legacyFailureError, /without making edits/u);
  assert.equal(validateImplementationToolContract({ ...input, completionGuard: false, acceptanceRole: "read-only" }), undefined);
  const advisory = planCompletionEvidence({ completionGuardEnabled: false, mutationCapable: true, implementationMutationExpected: true, mutationAttemptObserved: false, agentContractEnabled: false });
  assert.equal(advisory.mutationExpected, false);
  assert.equal(advisory.legacyFailureError, undefined);
});

test("all advisory roles disable only implementation-completion heuristics while mutation remains rejected", () => {
  for (const role of readOnly) {
    const source = fs.readFileSync(new URL(`../agents/${role}.md`, import.meta.url), "utf8");
    assert.match(source, /^acceptanceRole: read-only$/mu, role);
    assert.match(source, /^completionGuard: false$/mu, role);
    assert.throws(() => validateRoleCompletion({ role, status: "completed", mutationAttempted: true }), /read_only_role_mutation/u, role);
    assert.throws(() => validateRoleCompletion({ role, status: "completed", mutationObserved: true }), /read_only_role_mutation/u, role);
  }
  const worker = fs.readFileSync(new URL("../agents/worker.md", import.meta.url), "utf8");
  assert.match(worker, /^acceptanceRole: writer$/mu);
  assert.doesNotMatch(worker, /^completionGuard: false$/mu);
});
