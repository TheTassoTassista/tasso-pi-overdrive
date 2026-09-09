#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-evaluator-"));
const results = [];
function evaluate(task, run) {
  const started = performance.now();
  try {
    const evidence = run();
    results.push({ task, success: true, latencyMs: Number((performance.now() - started).toFixed(3)), model: null, inputTokens: null, outputTokens: null, cachedTokens: null, cost: 0, retries: 0, evidence });
  } catch (error) {
    results.push({ task, success: false, latencyMs: Number((performance.now() - started).toFixed(3)), model: null, inputTokens: null, outputTokens: null, cachedTokens: null, cost: 0, retries: 0, error: error.message });
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };

try {
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "service.mjs"), "export function boundary(values, index) { return index <= values.length ? (values[index] ?? values[0]) : undefined; }\n");
  fs.writeFileSync(path.join(source, "service.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { boundary } from './service.mjs'; test('end is outside',()=>assert.equal(boundary([1],1),undefined));\n");

  evaluate("repository-navigation", () => {
    const output = execFileSync("rg", ["-n", "function boundary", source], { encoding: "utf8" });
    assert(output.includes("service.mjs:1"), "entry point was not found");
    return { matchedFiles: 1 };
  });
  evaluate("simple-bug", () => {
    const before = spawnSync("node", ["--test", "service.test.mjs"], { cwd: source });
    assert(before.status !== 0, "negative control unexpectedly passed");
    fs.writeFileSync(path.join(source, "service.mjs"), "export function boundary(values, index) { return index < values.length ? values[index] : undefined; }\n");
    const after = spawnSync("node", ["--test", "service.test.mjs"], { cwd: source });
    assert(after.status === 0, "known fix did not pass");
    return { beforeExit: before.status, afterExit: after.status };
  });
  evaluate("moderate-refactor", () => {
    const before = [1, 2, 3].map((value) => value * 2).join(",");
    const twice = (value) => value * 2;
    const after = [1, 2, 3].map(twice).join(",");
    assert(before === after, "refactor changed behavior");
    return { behaviorEqual: true, duplicateExpressionsBefore: 2, after: 1 };
  });
  evaluate("test-failure-diagnosis", () => {
    const failure = spawnSync("node", ["-e", "require('node:assert/strict').equal(1,2)"], { encoding: "utf8" });
    const output = `${failure.stdout}${failure.stderr}`;
    assert(failure.status !== 0 && /AssertionError/u.test(output) && /1 !== 2/u.test(output), "failure evidence was not diagnosable");
    return { exitCode: failure.status, category: "assertion-mismatch" };
  });
  evaluate("difficult-reasoning-planning", () => {
    const decision = { rollback: "retain old package until runtime verification", compatibility: "Pi 0.85.1 exact", failureModes: ["package load", "auth regression", "stale path"] };
    assert(Boolean(decision.rollback && decision.compatibility && decision.failureModes.length >= 3), "decision rubric incomplete");
    return { rubricFields: 3 };
  });
  evaluate("code-review", () => {
    const planted = "return index <= values.length ? values[index] : undefined";
    assert(/index\s*<=\s*values\.length/u.test(planted), "planted boundary defect not detected");
    return { finding: "off-by-one", severity: "BLOCKING" };
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const report = { recordedAt: new Date().toISOString(), mode: "deterministic-harness-control", paidModelCalls: 0, success: results.every((entry) => entry.success), results };
if (process.argv.includes("--write-results")) fs.writeFileSync(new URL("./evaluator-results.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.success ? 0 : 1);
