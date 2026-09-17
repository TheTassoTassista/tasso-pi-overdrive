import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolveTaskPolicy } from "../lib/task-governor.mjs";
import {
  classifyTool,
  hasExplicitToolCliPolicy,
  resolveManualToolChange,
  resolveToolPolicy,
  toolPolicyMetadata,
  validateToolPolicy,
} from "../lib/tool-governor.mjs";

const available = [
  "read", "grep", "find", "ls", "ffgrep", "fffind", "ast_grep_run", "ast_grep_scan", "ast_grep_outline", "ast_grep_debug_query",
  "transactional_edit", "edit", "write", "transactional_ast_edit", "ast_grep_rewrite", "semantic_nav", "ts_definition", "ts_references", "ts_diagnostics", "task_notebook",
  "verification_gate", "secure_coding_workflow", "debug_engine", "agent_browser", "web_research", "safe_web_fetch", "safe_exec", "mcp",
  "resource_fs", "smart_read", "bash", "subagent", "safe_remove_file", "third_party_unknown",
];

function policyFor(task, availableTools = available) {
  const taskPolicy = resolveTaskPolicy({ task, preset: "normal", quality: "auto" });
  return { taskPolicy, toolPolicy: resolveToolPolicy({ taskPolicy, availableTools }) };
}

test("simple edit gets the transactional editor, LSP, and verification without fallback or controller surfaces", () => {
  const { toolPolicy } = policyFor("Change one string value.");
  for (const name of ["read", "transactional_edit", "semantic_nav", "verification_gate"]) assert.ok(toolPolicy.activeTools.includes(name), name);
  for (const name of ["edit", "grep", "fffind", "write", "ast_grep_rewrite", "web_research", "agent_browser", "safe_exec", "mcp", "bash", "subagent", "safe_remove_file", "secure_coding_workflow"]) assert.equal(toolPolicy.activeTools.includes(name), false, name);
  assert.ok(toolPolicy.activeTools.length < available.length / 2);
});

test("debugging task exposes the governed DAP engine and reports later phases unavailable", () => {
  const { toolPolicy } = policyFor("Find and fix the intermittent race condition under load in src/queue.ts.");
  for (const name of ["read", "ffgrep", "fffind", "ast_grep_run", "transactional_edit", "semantic_nav", "task_notebook", "verification_gate", "secure_coding_workflow", "debug_engine"]) assert.ok(toolPolicy.activeTools.includes(name), name);
  assert.equal(toolPolicy.activeTools.includes("edit"), false);
  for (const name of ["grep", "find", "ls", "ast_grep_scan", "ast_grep_outline", "ast_grep_debug_query"]) assert.equal(toolPolicy.activeTools.includes(name), false, name);
  assert.deepEqual(toolPolicy.unavailableCapabilities.filter((entry) => ["debug", "eval", "sentinel"].includes(entry)), ["eval", "sentinel"]);
});

test("structural AST rewrite requires semantic transformation intent", () => {
  const structural = policyFor("Replace every call expression to legacyApi with modernApi across TypeScript source files.");
  assert.equal(structural.taskPolicy.classification.signals.structuralEdit, true);
  assert.ok(structural.toolPolicy.activeTools.includes("transactional_ast_edit"));
  assert.equal(structural.toolPolicy.activeTools.includes("ast_grep_rewrite"), false);
  const superficial = policyFor("Use ast_grep_rewrite to change one string value.");
  assert.equal(superficial.taskPolicy.classification.signals.structuralEdit, false);
  assert.equal(superficial.toolPolicy.activeTools.includes("transactional_ast_edit"), false);
  assert.equal(superficial.toolPolicy.activeTools.includes("ast_grep_rewrite"), false);
});

test("the plugin structural rewrite remains a fallback when the transactional AST tool is unavailable", () => {
  const fallback = policyFor("Replace every call expression to legacyApi with modernApi across TypeScript source files.", available.filter((name) => name !== "transactional_ast_edit"));
  assert.ok(fallback.toolPolicy.activeTools.includes("ast_grep_rewrite"));
  assert.equal(fallback.toolPolicy.activeTools.includes("transactional_ast_edit"), false);
});

test("ResourceFS schema is conditional on a supported URI", () => {
  const explicit = policyFor("Inspect repo://root/src/parser.ts without changing it.");
  assert.ok(explicit.toolPolicy.activeTools.includes("resource_fs"));
  assert.equal(policyFor("Inspect src/parser.ts without changing it.").toolPolicy.activeTools.includes("resource_fs"), false);
  assert.ok(policyFor(`Inspect artifact://${"a".repeat(64)} without changing files.`).toolPolicy.activeTools.includes("resource_fs"));
});

test("SmartRead schema follows source-inspection policy without affecting direct edits", () => {
  assert.ok(policyFor("Inspect src/router.ts and explain the implementation.").toolPolicy.activeTools.includes("smart_read"));
  assert.equal(policyFor("Change one string value.").toolPolicy.activeTools.includes("smart_read"), false);
});

test("search-only tasks do not expose mutation tools", () => {
  const { taskPolicy, toolPolicy } = policyFor("Find every function call matching deprecatedApi without changing files.");
  assert.equal(taskPolicy.classification.signals.mutating, false);
  for (const name of ["ffgrep", "fffind", "ast_grep_run"]) assert.ok(toolPolicy.activeTools.includes(name), name);
  for (const name of ["transactional_edit", "edit", "write", "transactional_ast_edit", "ast_grep_rewrite", "secure_coding_workflow"]) assert.equal(toolPolicy.activeTools.includes(name), false, name);
});

test("research activates memory and web but never browser or hidden integrations by accident", () => {
  const { taskPolicy, toolPolicy } = policyFor("Research the latest online documentation and prior project decisions.");
  assert.equal(taskPolicy.needs.web, true);
  assert.equal(taskPolicy.needs.secondBrain, true);
  for (const name of ["read", "task_notebook", "web_research", "safe_web_fetch"]) assert.ok(toolPolicy.activeTools.includes(name), name);
  for (const name of ["agent_browser", "safe_exec", "mcp", "bash", "subagent"]) assert.equal(toolPolicy.activeTools.includes(name), false, name);
  assert.deepEqual(toolPolicy.highRiskActive, ["web_research", "safe_web_fetch"]);
});

test("browser schema appears only for an explicit browser capability", () => {
  assert.equal(policyFor("Inspect the repository structure.").toolPolicy.activeTools.includes("agent_browser"), false);
  assert.equal(policyFor("Inspect the browser DOM for the frontend page.").toolPolicy.activeTools.includes("agent_browser"), true);
});

test("missing tools are reported rather than invented", () => {
  const { toolPolicy } = policyFor("Change one string value.", ["read"]);
  assert.deepEqual(toolPolicy.activeTools, ["read"]);
  assert.deepEqual(toolPolicy.unavailableCapabilities, ["edit", "lsp", "verify"]);
});

test("the built-in exact editor remains an automatic fallback when the transactional editor is unavailable", () => {
  const withoutTransactional = available.filter((name) => name !== "transactional_edit");
  const { toolPolicy } = policyFor("Change one string value.", withoutTransactional);
  assert.ok(toolPolicy.activeTools.includes("edit"));
  assert.equal(toolPolicy.activeTools.includes("transactional_edit"), false);
  assert.equal(toolPolicy.activeTools.includes("write"), false);
});

test("explicit CLI selection forms remain authoritative", () => {
  for (const argv of [["--tools", "read"], ["--tools=read"], ["-t", "read"], ["--no-tools"], ["--exclude-tools=write"], ["-xt", "write"]]) assert.equal(hasExplicitToolCliPolicy(argv), true, argv.join(" "));
  assert.equal(hasExplicitToolCliPolicy(["--offline"]), false);
});

test("manual mode can reveal classified rare tools but not raw controller tools", () => {
  const enabled = resolveManualToolChange({ action: "enable", name: "safe_exec", activeTools: ["read"], availableTools: available });
  assert.deepEqual(enabled.activeTools.filter((name) => ["read", "safe_exec"].includes(name)), ["read", "safe_exec"]);
  assert.equal(enabled.tier, "hidden-on-demand");
  assert.throws(() => resolveManualToolChange({ action: "enable", name: "bash", activeTools: ["read"], availableTools: available }), /tool_controller_only/u);
  assert.throws(() => resolveManualToolChange({ action: "enable", name: "subagent", activeTools: ["read"], availableTools: available }), /tool_controller_only/u);
  assert.throws(() => resolveManualToolChange({ action: "enable", name: "third_party_unknown", activeTools: ["read"], availableTools: available }), /tool_unclassified_denied/u);
});

test("classification distinguishes all four supported visibility tiers", () => {
  assert.equal(classifyTool("read").tier, "always-essential");
  assert.equal(classifyTool("transactional_edit").tier, "conditional");
  assert.equal(classifyTool("transactional_ast_edit").tier, "conditional");
  assert.equal(classifyTool("semantic_nav").tier, "conditional");
  assert.equal(classifyTool("debug_engine").tier, "conditional");
  assert.equal(classifyTool("agent_browser").tier, "high-risk-conditional");
  assert.equal(classifyTool("safe_exec").tier, "hidden-on-demand");
  assert.equal(classifyTool("ast_grep_scan").tier, "hidden-on-demand");
  assert.equal(classifyTool("safe_remove_file").tier, "controller-only");
  assert.equal(classifyTool("made_up").tier, "unclassified-denied");
});

test("Tool Policy is task-bound, deterministic, metadata-only, and tamper evident", () => {
  const marker = "SECRET_TASK_MARKER_81d2";
  const taskPolicy = resolveTaskPolicy({ task: `Fix ${marker} credential handling in src/auth.ts.` });
  const first = resolveToolPolicy({ taskPolicy, availableTools: available });
  const second = resolveToolPolicy({ taskPolicy, availableTools: available });
  assert.equal(first.digest, second.digest);
  assert.equal(JSON.stringify(first).includes(marker), false);
  assert.equal(JSON.stringify(toolPolicyMetadata(first, taskPolicy)).includes(marker), false);
  assert.doesNotThrow(() => validateToolPolicy(first, taskPolicy));
  const tampered = structuredClone(first);
  tampered.activeTools.push("agent_browser");
  assert.throws(() => validateToolPolicy(tampered, taskPolicy), /tool_policy_high_risk_mismatch|tool_policy_digest_invalid/u);
  const semanticallyForged = structuredClone(first);
  semanticallyForged.activeTools.push("write");
  delete semanticallyForged.digest;
  semanticallyForged.digest = createHash("sha256").update(JSON.stringify(semanticallyForged)).digest("hex");
  assert.throws(() => validateToolPolicy(semanticallyForged, taskPolicy), /tool_policy_semantic_mismatch/u);
  const otherTask = resolveTaskPolicy({ task: "Inspect README.md." });
  assert.throws(() => validateToolPolicy(first, otherTask), /tool_policy_task_mismatch/u);
});
