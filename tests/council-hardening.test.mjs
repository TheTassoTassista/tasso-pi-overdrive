import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyDelegationFailure, retryableDelegationFailure } from "../lib/delegation-failure.mjs";
import { validateRoleCompletion } from "../lib/role-contract.mjs";
import { COUNCIL_JUDGE_SCHEMA, COUNCIL_MEMBER_SCHEMA, councilJudgeValue, councilMemberValue } from "../lib/workflow-state.mjs";

const member = (agent = "council-1", value = {}) => ({
  status: "completed", agent, result: { kind: "structured", value: {
    conclusion: "supported", recommendation: "proceed", confidence: "HIGH", evidence: ["fixture"], risks: [], blockingConcerns: [], ...value,
  } },
});

test("native council schemas are closed and require every machine-readable field", () => {
  assert.equal(COUNCIL_MEMBER_SCHEMA.additionalProperties, false);
  assert.deepEqual(COUNCIL_MEMBER_SCHEMA.required, ["conclusion", "recommendation", "confidence", "evidence", "risks", "blockingConcerns"]);
  assert.equal(COUNCIL_JUDGE_SCHEMA.additionalProperties, false);
  assert.equal(councilMemberValue("council-1", member()).confidence, "HIGH");
  for (const response of [
    { status: "completed", agent: "council-1", result: { kind: "text", text: "prose" } },
    member("council-1", { evidence: "not-an-array" }),
    member("council-1", { unexpected: true }),
    { status: "completed", agent: "council-1", result: { kind: "structured", value: { recommendation: "partial" } } },
  ]) assert.throws(() => councilMemberValue("council-1", response), /invalid structured council evidence/u);
  assert.throws(() => councilMemberValue("council-1", member("council-2")), /role mismatch/u);
});

test("Judge requires its own complete structured contract", () => {
  const valid = { status: "completed", agent: "council-judge", result: { kind: "structured", value: { decision: "proceed", decisionBasis: "three valid reports", confidence: "HIGH", agreements: [], disagreements: [], requiredActions: [] } } };
  assert.equal(councilJudgeValue(valid).decision, "proceed");
  assert.throws(() => councilJudgeValue({ ...valid, result: { kind: "text", text: "prose" } }), /invalid structured synthesis/u);
});

test("role-aware completion allows zero-edit advisors but rejects mutation and no-op implementation", () => {
  assert.equal(validateRoleCompletion({ role: "council-1", status: "completed" }), true);
  assert.throws(() => validateRoleCompletion({ role: "council-1", status: "completed", mutationAttempted: true }), /read_only_role_mutation/u);
  assert.throws(() => validateRoleCompletion({ role: "worker", status: "completed", implementationRequired: true, mutationObserved: false }), /worker_required_mutation_missing/u);
  assert.equal(validateRoleCompletion({ role: "worker", status: "completed", implementationRequired: true, mutationObserved: true }), true);
  for (const name of ["council-1", "council-2", "council-3", "council-judge"]) {
    const profile = fs.readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8");
    assert.match(profile, /^completionGuard: false$/mu);
    assert.doesNotMatch(profile, /^tools:.*\b(?:bash|safe_exec|safe_remove_file|edit|write|subagent)\b/mu);
  }
});

test("only transport transients and attested post-launch structured output failures are retryable", () => {
  const cases = [
    [{ status: "transport_failed", error: "network reset" }, "TRANSIENT", true],
    [{ status: "failed", error: "unsupported model" }, "UNSUPPORTED_MODEL", false],
    [{ status: "failed", error: "401 unauthorized" }, "AUTH", false],
    [{ status: "protocol_rejected", error: "role mismatch" }, "POLICY", false],
    [{ status: "failed", error: "Subagent spawn limit reached for this session (24/24 used, 1 requested)." }, "RESOURCE_LIMIT", false],
    [{ status: "structured_output_failed", launchStatus: "launched", routeAttested: true, error: "missing structured output" }, "STRUCTURED_OUTPUT_MODEL_INVALID", true],
    [{ status: "structured_output_failed", launchStatus: "not_launched", routeAttested: false, error: "missing structured output" }, "STRUCTURED_OUTPUT_POLICY_ERROR", false],
    [{ status: "invalid_request", launchStatus: "not_launched", error: "result.schema must be a JSON Schema object" }, "STRUCTURED_OUTPUT_POLICY_ERROR", false],
    [{ status: "failed", error: "deterministic test failure" }, "DETERMINISTIC", false],
  ];
  for (const [input, category, retryable] of cases) {
    assert.equal(classifyDelegationFailure(input), category);
    assert.equal(retryableDelegationFailure(input), retryable);
  }
  let unsupportedCalls = 0;
  for (const failure of [{ status: "failed", error: "unsupported model" }, { status: "completed" }]) {
    unsupportedCalls += 1;
    if (!retryableDelegationFailure(failure)) break;
  }
  assert.equal(unsupportedCalls, 1, "unsupported model never consumes a second attempt");
});
