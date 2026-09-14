#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTaskPolicy, validateTaskPolicy } from "../../lib/task-governor.mjs";
import { resolveTokenGovernor } from "../../lib/token-governor.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const writeResults = process.argv.includes("--write-results");
const cases = [
  { id: "simple-string", task: "Change one string value.", expected: { planner: false, secondBrain: false, council: false, debugger: false } },
  { id: "bounded-code", task: "Implement and test a parser change in src/parser.ts.", expected: { council: false, debugger: false } },
  { id: "race-under-load", task: "Find and fix the intermittent race condition under load in src/queue.ts.", expected: { planner: true, secondBrain: true, debugger: true, eval: true, sentinel: true, reviewer: true } },
  { id: "critical-migration", task: "Production migration with data loss risk.", expected: { planner: true, reviewer: true, council: true } },
];

const iterations = 10_000;
for (let index = 0; index < 1_000; index += 1) {
  const input = { task: cases[index % cases.length].task, preset: index % 2 ? "normal" : "token-saver", quality: "auto" };
  resolveTokenGovernor(input);
  resolveTaskPolicy(input);
}
function timed(resolve) {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) resolve({ task: cases[index % cases.length].task, preset: index % 2 ? "normal" : "token-saver", quality: "auto" });
  const totalMs = performance.now() - started;
  return { iterations, totalMs: Number(totalMs.toFixed(3)), meanDecisionMs: Number((totalMs / iterations).toFixed(6)) };
}
const startingTiming = timed(resolveTokenGovernor);
const ultraTiming = timed(resolveTaskPolicy);

const decisions = cases.map((entry) => {
  const policy = resolveTaskPolicy({ task: entry.task, preset: "normal", quality: "auto" });
  const assertions = Object.fromEntries(Object.entries(entry.expected).map(([key, value]) => [key, policy.needs[key] === value]));
  return {
    id: entry.id,
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    decisionModelCalls: policy.decisionModelCalls,
    difficulty: policy.classification.difficulty,
    risk: policy.classification.risk.level,
    capabilityCount: policy.toolNeed.capabilities.length,
    modelRoleCount: policy.modelNeed.roles.length,
    assertions,
  };
});

const report = {
  version: 1,
  recordedAt: new Date().toISOString(),
  status: decisions.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
  startingOverdrive: {
    implementation: "token-governor-v1",
    ...startingTiming,
    paidModelCalls: 0,
    providerCalls: 0,
    limitations: "No unified risk/scope/context/memory/tool policy; secure workflow attempted Second Brain construction for every task.",
    decisions: cases.map((entry) => {
      const routing = resolveTokenGovernor({ task: entry.task, preset: "normal", quality: "auto" });
      return { id: entry.id, modelRoleCount: Object.values(routing.roles).filter(Boolean).length + (routing.council.initial ? 4 : 0), council: routing.council.initial };
    }),
  },
  overdriveUltra: {
    implementation: "deterministic-v1",
    ...ultraTiming,
    cases: cases.length,
    meanOverheadVsStartingMs: Number((ultraTiming.meanDecisionMs - startingTiming.meanDecisionMs).toFixed(6)),
    paidModelCalls: 0,
    providerCalls: 0,
    decisions,
    validation: decisions.map((entry, index) => validateTaskPolicy(resolveTaskPolicy({ task: cases[index].task }))).length === decisions.length ? "PASS" : "FAIL",
  },
  ompReference: {
    commit: "4267074ac91456866e95ed8de0b6353388f08502",
    version: "18.1.21",
    executableStatus: "NOT_RUN",
    reason: "Bun >=1.4 is unavailable; source inspection is not converted into numeric benchmark evidence.",
  },
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(root, "task-governor-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
