import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localReviewPolicy } from "../lib/review-policy.mjs";

test("local policy returns structured blocking evidence until planted defect is corrected", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-review-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "unsafe.mjs"), "export const run = (text) => eval(text);\n");
    writeFileSync(path.join(root, ".pi-overdrive-review-blocker.json"), JSON.stringify({ version: 1, file: "src/unsafe.mjs", pattern: "eval(" }));
    const blocked = localReviewPolicy(root);
    assert.equal(blocked.blocking, true);
    assert.equal(blocked.findings.every((finding) => finding.severity === "BLOCKING"), true);
    writeFileSync(path.join(root, "src", "unsafe.mjs"), "export const run = (text) => JSON.parse(text);\n");
    unlinkSync(path.join(root, ".pi-overdrive-review-blocker.json"));
    assert.equal(localReviewPolicy(root).blocking, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local policy ignores unsafe syntax used only in test fixtures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-review-fixture-"));
  try {
    mkdirSync(path.join(root, "test"));
    writeFileSync(path.join(root, "test", "fixture.mjs"), "eval('fixture only');\n");
    assert.equal(localReviewPolicy(root).blocking, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
