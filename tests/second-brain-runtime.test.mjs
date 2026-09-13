import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSecondBrainRuntime } from "../lib/second-brain-runtime.mjs";

const response = (value) => ({ ok: true, status: 200, async json() { return value; } });

test("explicit durable memory projects once to local OpenViking and Hindsight", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "second-brain-runtime-"));
  try {
    const calls = [];
    const config = {
      version: 1, enabled: true, root, vaultRoot: path.join(root, "vault"),
      openViking: { mode: "auto", endpoint: "http://127.0.0.1:1933", timeoutMs: 100, writeTimeoutMs: 100, candidateLimit: 8, targetUri: "viking://~/resources" },
      hindsight: { mode: "auto", endpoint: "http://127.0.0.1:8889", timeoutMs: 100, writeTimeoutMs: 100, bankPrefix: "pi-overdrive", reflect: "explicit-only" },
      ace: { enabled: true, maxEntries: 128 }
    };
    const runtime = createSecondBrainRuntime({ cwd: root, config, fetch: async (url, options) => {
      calls.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
      return response(url.endsWith("/memories") ? { items_count: 1 } : { status: "ok", result: {} });
    } });
    const accepted = runtime.ledger.accept({ type: "decision", project: runtime.projectId, content: "Use only local CPU embeddings for durable memory.", source: "explicit user decision", sourceType: "user", trustLevel: "USER", confidence: 1, verified: false, importance: "high", retentionDays: 0, tags: ["decision"], reason: "Explicit durable choice" });
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal((await runtime.publishDurable(accepted.entry)).status, "OK");
    assert.equal(calls.filter((call) => call.url.includes("/content/write")).length, 3);
    assert.equal(calls.filter((call) => call.url.endsWith("/memories")).length, 1);
    assert.equal((await runtime.publishDurable(accepted.entry)).status, "OK");
    assert.equal(calls.length, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
