import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTaskPolicy } from "../lib/task-governor.mjs";
import {
  directorEvent,
  directorSystemPrompt,
  directorTaskDigest,
  directorToolAllowed,
  resolveDirectorDecision,
  selectDirectorTools,
  validateDirectorEvent,
  validateDirectorPolicy,
} from "../lib/director-mode.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "config", "director-mode.json"), "utf8"));
const allTools = [...policy.allowedTools, "write", "edit", "transactional_edit", "transactional_ast_edit", "ast_grep_rewrite", "safe_exec", "bash", "subagent", "agent_browser", "safe_remove_file", "unknown_tool"];

test("Director policy is explicit, one-task, fail-closed, and cannot enable mutation fallback", () => {
  assert.equal(validateDirectorPolicy(policy).directMutationFallback, false);
  assert.throws(() => validateDirectorPolicy({ ...policy, directMutationFallback: true }), /DIRECTOR_POLICY_INVALID/u);
  assert.throws(() => validateDirectorPolicy({ ...policy, maxTaskChars: 16001 }), /DIRECTOR_POLICY_INVALID/u);
  assert.throws(() => validateDirectorPolicy({ ...policy, allowedTools: [...policy.allowedTools, "write"] }), /DIRECTOR_POLICY_ALLOWED_TOOLS_INVALID/u);
});

test("only non-trivial mutating tasks with existing delegation value are eligible", () => {
  const complex = resolveTaskPolicy({ task: "Refactor the concurrent recovery state machine and integration tests.", preset: "normal", quality: "auto" });
  const direct = resolveTaskPolicy({ task: "Change one string value.", preset: "normal", quality: "auto" });
  const readOnly = resolveTaskPolicy({ task: "Inspect src/router.ts and explain the implementation.", preset: "normal", quality: "auto" });
  assert.deepEqual([resolveDirectorDecision(complex, policy).eligible, resolveDirectorDecision(direct, policy).eligible, resolveDirectorDecision(readOnly, policy).eligible], [true, false, false]);
  assert.equal(resolveDirectorDecision(direct, policy).reasonCode, "DIRECT_SMALL_EDIT");
  assert.equal(resolveDirectorDecision(readOnly, policy).reasonCode, "TASK_READ_ONLY");
});

test("context-pressure changes do not invalidate the same eligible task before provider entry", () => {
  const task = "Refactor the concurrent recovery state machine and integration tests.";
  const before = resolveTaskPolicy({ task, preset: "normal", quality: "auto", availableContext: { maxChars: 100000, usedChars: 10000 } });
  const after = resolveTaskPolicy({ task, preset: "normal", quality: "auto", availableContext: { maxChars: 100000, usedChars: 92000 } });
  assert.notEqual(before.digest, after.digest);
  assert.equal(resolveDirectorDecision(before, policy).eligible, true);
  assert.equal(resolveDirectorDecision(after, policy).eligible, true);
});

test("Director surface retains read/plan/delegate/verify tools and removes direct mutation/control", () => {
  const selected = selectDirectorTools(allTools, allTools, policy);
  for (const name of policy.requiredTools) assert.ok(selected.includes(name), name);
  for (const name of ["write", "edit", "transactional_edit", "transactional_ast_edit", "ast_grep_rewrite", "safe_exec", "bash", "subagent", "agent_browser", "safe_remove_file", "unknown_tool"]) assert.equal(selected.includes(name), false, name);
  assert.throws(() => selectDirectorTools(["read"], ["read"], policy), /DIRECTOR_REQUIRED_TOOLS_UNAVAILABLE/u);
});

test("runtime tool barrier is allowlist-based rather than a shell blacklist", () => {
  for (const name of policy.allowedTools) assert.equal(directorToolAllowed(name, policy), true, name);
  for (const name of ["write", "safe_exec", "bash", "subagent", "agent_browser", "made_up_mutator"]) assert.equal(directorToolAllowed(name, policy), false, name);
});

test("Director instructions preserve the existing controller and contain no task data", () => {
  const prompt = directorSystemPrompt();
  for (const marker of ["READ, PLAN, DELEGATE, VERIFY", "secure_coding_workflow", "spawn budget 42", "concurrency 3", "depth 1", "correction rounds 2", "Council/Judge", "There is no direct-mutation fallback"]) assert.match(prompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(prompt, /SECRET_DIRECTOR_TASK|steer|kill|revive/u);
});

test("metadata is digest-only and rejects prompt, transcript, tool payload, path, and secret fields", () => {
  const task = "Refactor SECRET_DIRECTOR_TASK in src/private.ts.";
  const taskPolicy = resolveTaskPolicy({ task });
  const event = directorEvent({ status: "ACTIVATED", reasonCode: "ELIGIBLE_BOUNDED_DELEGATION", sessionDigest: "a".repeat(64), taskDigest: directorTaskDigest(task), taskPolicyDigest: taskPolicy.digest, activeToolCount: 3 });
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /SECRET_DIRECTOR_TASK|private\.ts/u);
  for (const key of ["prompt", "transcript", "toolArgs", "toolResult", "path", "secret", "credential", "councilOutput"]) assert.throws(() => validateDirectorEvent({ ...event, [key]: "FORBIDDEN" }), /DIRECTOR_EVENT_FIELDS_INVALID/u);
});

test("Director extension is command-only and cannot create a parallel worker/controller implementation", () => {
  const extension = fs.readFileSync(path.join(root, "extensions", "director-mode.ts"), "utf8");
  assert.match(extension, /registerCommand\("director"/u);
  assert.match(extension, /pi\.sendUserMessage\(task\)/u);
  assert.match(extension, /pi\.on\("tool_call"/u);
  assert.match(extension, /pi\.on\("agent_settled"/u);
  assert.doesNotMatch(extension, /pi\.registerTool|ctx\.modelRegistry|pi\.exec|node:child_process|prompt-template:subagent:request|prompt-template:subagent:cancel/u);
});

test("existing secure workflow remains the only implementation state machine and fixed limit owner", () => {
  const workflow = fs.readFileSync(path.join(root, "extensions", "secure-workflow.ts"), "utf8");
  const state = fs.readFileSync(path.join(root, "lib", "workflow-state.mjs"), "utf8");
  const budget = fs.readFileSync(path.join(root, "lib", "workflow-spawn-budget.mjs"), "utf8");
  assert.match(workflow, /createRuntimeWorktree/u);
  assert.match(workflow, /writeRoleReceipt/u);
  assert.match(state, /MAX_WORKFLOW_CONCURRENCY/u);
  assert.match(state, /MAX_SUBAGENT_DEPTH/u);
  assert.match(budget, /configuredSpawnLimit/u);
});

test("task digest is bounded and deterministic without retaining the task", () => {
  assert.equal(directorTaskDigest("  Implement bounded change.  "), directorTaskDigest("Implement bounded change."));
  assert.throws(() => directorTaskDigest(""), /DIRECTOR_TASK_INVALID/u);
  assert.throws(() => directorTaskDigest("x".repeat(16001)), /DIRECTOR_TASK_INVALID/u);
});
