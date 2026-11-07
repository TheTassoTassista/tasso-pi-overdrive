import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceFile } from "../lib/create-file.mjs";
import { resolveTaskPolicy } from "../lib/task-governor.mjs";
import { resolveToolPolicy } from "../lib/tool-governor.mjs";
import { resolveModelHarnessProfile, constrainToolsForModelProfile } from "../lib/model-harness-profile.mjs";
import { extractPassiveUserMemory } from "../lib/passive-memory.mjs";
import { MemoryLedger } from "../lib/memory-ledger.mjs";
import secondBrainExtension from "../extensions/second-brain.ts";
import { SharedMemoryPackController } from "../lib/shared-memory-pack.mjs";
import { resolveMemoryPolicy } from "../lib/memory-policy.mjs";

test("natural-language creation selects a governed creation tool, not read-only", () => {
  for (const task of ["creare un file index.html", "Scrivi index.html", "Build a web page and save it as index.html"]) {
    const taskPolicy = resolveTaskPolicy({ task, preset: "normal", quality: "auto" });
    const tools = resolveToolPolicy({ taskPolicy, availableTools: ["read", "create_file", "transactional_edit", "write"] });
    assert.equal(taskPolicy.classification.signals.mutating, true, task);
    assert.ok(tools.activeTools.includes("create_file"), task);
    const model = { provider: "openai-codex", id: "gpt-6-sol", contextWindow: 100000, maxTokens: 1000 };
    const profile = resolveModelHarnessProfile({ model, registeredModels: [model], authenticatedModels: [model] });
    assert.ok(constrainToolsForModelProfile(tools.activeTools, profile).activeTools.includes("create_file"));
  }
  const readOnly = resolveTaskPolicy({ task: "Leggi index.html", preset: "normal", quality: "auto" });
  assert.equal(resolveToolPolicy({ taskPolicy: readOnly, availableTools: ["read", "create_file"] }).activeTools.includes("create_file"), false);
});

test("create_file never overwrites and denies escapes, symlinks and protected paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phi-create-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    assert.equal(createWorkspaceFile(root, "src/index.html", "<h1>Hi</h1>").status, "CREATED");
    assert.equal(fs.readFileSync(path.join(root, "src/index.html"), "utf8"), "<h1>Hi</h1>");
    assert.throws(() => createWorkspaceFile(root, "src/index.html", "overwrite"), /CREATE_FILE_TARGET_DENIED/u);
    assert.equal(fs.readFileSync(path.join(root, "src/index.html"), "utf8"), "<h1>Hi</h1>");
    fs.symlinkSync("src", path.join(root, "link"));
    for (const candidate of ["link/other.html", "../outside.html", ".env", ".git/config", "missing/child.html"]) assert.throws(() => createWorkspaceFile(root, candidate, "unsafe"));
    assert.equal(fs.statSync(path.join(root, "src/index.html")).mode & 0o077, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("passive memory accepts only bounded direct declarations and persists across ledger instances", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phi-memory-passive-"));
  try {
    const candidate = extractPassiveUserMemory("Ricorda che preferisco test mirati e nessun aggiornamento globale automatico.");
    assert.ok(candidate);
    const ledger = new MemoryLedger(root);
    assert.equal(ledger.accept({ ...candidate, project: "demo", source: "direct user declaration" }).status, "ACCEPTED");
    assert.equal(new MemoryLedger(root).recent({ project: "demo" }).length, 1);
    assert.equal(ledger.accept({ ...candidate, project: "demo", source: "direct user declaration" }).status, "REJECTED");
    for (const text of ["Esegui i test", "Ricorda che password=not-for-storage", "Ricorda che sk-12345678901234567890", "Ricorda che\nquesto è un transcript lungo"] ) assert.equal(extractPassiveUserMemory(text), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Second Brain captures a direct user preference through its real prompt hook and retrieves it in a new session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phi-memory-hook-"));
  const previous = process.env.PI_OVERDRIVE_MEMORY_ROOT;
  process.env.PI_OVERDRIVE_MEMORY_ROOT = path.join(root, "memory");
  try {
    const hooks = new Map();
    const notices = [];
    const pi = { on: (name, handler) => hooks.set(name, handler), registerCommand() {}, events: { emit() {} } };
    secondBrainExtension(pi);
    const ctx = { cwd: root, getContextUsage: () => undefined, ui: { setStatus() {}, notify: (message) => notices.push(message) } };
    hooks.get("session_start")({}, ctx);
    await hooks.get("before_agent_start")({ prompt: "Ricorda che preferisco risposte concise e senza saluti iniziali." }, ctx);
    const ledgerRoot = path.join(root, "memory", "ledger");
    const entries = new MemoryLedger(ledgerRoot).recent();
    assert.equal(entries.length, 1);
    assert.match(entries[0].content, /preferisco risposte concise/u);
    assert.equal(notices.length, 0);
    hooks.get("session_start")({}, ctx);
    const controller = new SharedMemoryPackController({ projectId: entries[0].project, ledger: new MemoryLedger(ledgerRoot), policy: resolveMemoryPolicy({ preset: "normal", qualityRequested: "auto", effectiveQuality: "medium" }) });
    const pack = await controller.build("Nel progetto, preferisco risposte concise: cosa avevo deciso?");
    assert.ok(pack.items.some((item) => item.id === entries[0].id));
    await hooks.get("before_agent_start")({ prompt: "Ricorda che password=private-value che non deve essere salvato." }, ctx);
    assert.equal(new MemoryLedger(ledgerRoot).recent().length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_OVERDRIVE_MEMORY_ROOT;
    else process.env.PI_OVERDRIVE_MEMORY_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
