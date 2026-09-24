import test from "node:test";
import assert from "node:assert/strict";
import { runEditContractCorpus } from "../benchmarks/overdrive-vs-omp/edit-contract-corpus.mjs";

test("20-class real edit-contract corpus uses exact oracles and no model calls", async () => {
  const report = await runEditContractCorpus();
  assert.equal(report.status, "PASS", JSON.stringify(report.cases.filter((entry) => entry.status !== "PASS")));
  assert.equal(report.cases.length, 20);
  assert.equal(report.accounting.editSuccesses, 16);
  assert.equal(report.accounting.expectedDenials, 4);
  assert.equal(report.accounting.modelCalls, 0);
  assert.equal(report.accounting.externalProviderCalls, 0);
  assert.equal(report.accounting.inputTokens, null);
  assert.equal(report.cleanup.temporaryRemoved, true);
  assert.ok(report.cases.every((entry) => Object.values(entry.assertions).every(Boolean)));
  assert.equal(report.cases.find((entry) => entry.id === "ast-structural")?.contract, "AST_STRUCTURAL");
  assert.equal(report.cases.find((entry) => entry.id === "recovery-after-first-failure")?.firstAttempt, false);
  assert.equal(report.cases.find((entry) => entry.id === "external-insertion")?.recoveryPath, "SAFE_RECOVERY");
  assert.equal(report.cases.find((entry) => entry.id === "malformed-ast-output")?.failureCode, "AST_OUTPUT_INVALID");
  assert.equal(report.contracts.APPLY_PATCH, "NOT_AVAILABLE_AS_REGISTERED_PRODUCTION_TOOL");
  assert.equal(report.contracts.REPLACE, "NOT_EQUIVALENT_TO_TRANSACTIONAL_PATH");
  assert.ok(!JSON.stringify(report).includes("external-work"), "benchmark metadata must not include sidecar contents");
});
