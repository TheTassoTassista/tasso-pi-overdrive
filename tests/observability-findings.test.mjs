import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendFinding } from "../lib/findings-store.mjs";
import { collectProjectObservability } from "../lib/observability.mjs";

test("observability adapters report real counts while redacting critical output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-observe-"));
  try {
    mkdirSync(path.join(root, "logs"));
    writeFileSync(path.join(root, "logs", "application.log"), "INFO ready\nERROR password=secret-value\nWARNING retry\n");
    const result = collectProjectObservability(root);
    assert.equal(result.totals.sources, 1);
    assert.equal(result.totals.critical, 1);
    assert.equal(result.totals.warnings, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-value/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("findings store is bounded metadata with private permissions and digested evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-findings-"));
  try {
    const record = appendFinding({ category: "missing_test", summary: "password=secret-value needs coverage", evidence: "raw source content" }, { root });
    assert.match(record.summary, /REDACTED/u);
    assert.equal(record.evidenceDigest.length, 64);
    const file = path.join(root, "findings.jsonl");
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.doesNotMatch(readFileSync(file, "utf8"), /raw source content|secret-value/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
