import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditMissionStore, maintainMissionStore, redactMissionValue } from "../lib/mission-privacy.mjs";

test("mission privacy redacts secret values, enforces mode, and bounds terminal retention", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-missions-"));
  try {
    mkdirSync(path.join(root, "project"));
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(path.join(root, "project", `${index}.json`), JSON.stringify({ status: "completed", updatedAt: new Date(index * 1000).toISOString(), summary: `password=secret-${index}`, objective: "safe" }), { mode: 0o644 });
    }
    assert.match(redactMissionValue("Bearer abcdefghijklmnop"), /REDACTED/u);
    const before = auditMissionStore(root);
    assert.equal(before.secretLikeValues, 4);
    const changed = maintainMissionStore(root, { retainTerminal: 2 });
    assert.equal(changed.pruned, 2);
    assert.equal(changed.redactedFiles, 4);
    const remaining = ["2.json", "3.json"].map((name) => path.join(root, "project", name));
    for (const file of remaining) {
      assert.equal(statSync(file).mode & 0o077, 0);
      assert.doesNotMatch(readFileSync(file, "utf8"), /secret-/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret-bearing JSON keys are redacted and interrupted missions are terminal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mission-interrupted-"));
  try {
    writeFileSync(path.join(root, "run.json"), JSON.stringify({ status: "interrupted", token: "opaque-value", nested: { password: "plain-value" } }), { mode: 0o644 });
    const result = maintainMissionStore(root, { retainTerminal: 1 });
    const stored = JSON.parse(readFileSync(path.join(root, "run.json"), "utf8"));
    assert.equal(result.redactedFiles, 1);
    assert.equal(stored.token, "[REDACTED]");
    assert.equal(stored.nested.password, "[REDACTED]");
    assert.equal(auditMissionStore(root).terminal, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
