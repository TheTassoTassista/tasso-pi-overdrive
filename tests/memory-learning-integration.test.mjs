import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcePlaybook } from "../lib/ace-playbook.mjs";
import { resolveMemoryPolicy } from "../lib/memory-policy.mjs";
import { SharedMemoryPackController } from "../lib/shared-memory-pack.mjs";

test("a verified correction is ranked before and retains the relevant failed strategy", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phi-ace-learning-"));
  try {
    const ace = new AcePlaybook(path.join(root, "ace"));
    const failed = ace.add({
      title: "Avoid ambient tool discovery",
      procedure: "Do not resolve tools from ambient PATH because it changed between runs and produced inconsistent diagnostics.",
      outcome: "failed",
      failureReason: "The selected analyzer binary differed across identical checks.",
      conditions: "Applies when multiple tool versions are installed.",
      project: "fixture-project",
      source: "test:failure-learning",
      sourceType: "test",
      verified: true,
      tags: ["tool", "debugging"],
      reason: "Failure reproduced in a deterministic fixture.",
    });
    const corrected = ace.add({
      title: "Pin the managed tool runtime",
      procedure: "Resolve the analyzer through the project-managed runtime and verify its exact path before checking source.",
      outcome: "success",
      project: "fixture-project",
      source: "test:verified-correction",
      sourceType: "test",
      verified: true,
      tags: ["tool", "debugging"],
      reason: "The repeated fixture passed with a pinned runtime.",
    });
    assert.equal(failed.status, "ACCEPTED");
    assert.equal(corrected.status, "ACCEPTED");

    const controller = new SharedMemoryPackController({
      projectId: "fixture-project",
      policy: resolveMemoryPolicy({ preset: "normal", qualityRequested: "medium" }),
      ace,
    });
    const pack = await controller.build("What debugging strategy should we use for the tool runtime?");
    assert.deepEqual(pack.route.sources, ["ace"]);
    assert.equal(pack.metadata.status, "OK");
    assert.equal(pack.metadata.itemCount, 2);
    assert.match(pack.items[0].content, /Pin the managed tool runtime/u);
    assert.match(pack.items[1].content, /Avoid ambient tool discovery/u);
    assert.match(pack.items[1].content, /Failed because: The selected analyzer binary differed/u);
    assert.equal(pack.items.every((item) => item.trustLevel === "VERIFIED" && item.verified), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
