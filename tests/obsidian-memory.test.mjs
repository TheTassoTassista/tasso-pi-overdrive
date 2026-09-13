import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryLedger } from "../lib/memory-ledger.mjs";
import { parseMemoryNote, syncObsidianVault } from "../lib/obsidian-sync.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), "pi-obsidian-test-")); }

test("Obsidian note parser requires explicit frontmatter", () => {
  assert.equal(parseMemoryNote("# ordinary note"), undefined);
  const parsed = parseMemoryNote("---\nmemory: true\ntype: decision\ntags: [one, two]\n---\nA durable decision with evidence.");
  assert.equal(parsed.metadata.memory, true);
  assert.deepEqual(parsed.metadata.tags, ["one", "two"]);
});

test("explicit Obsidian sync is local, incremental, and curated", () => {
  const root = temporary();
  try {
    const vault = path.join(root, "vault");
    const ledger = new MemoryLedger(path.join(root, "ledger"));
    fs.mkdirSync(path.join(vault, "03 Decisions"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(vault, "03 Decisions", "Routing.md"), "---\nmemory: true\ntitle: Routing decision\ntype: decision\ntrust: USER\nverified: true\nimportance: high\ntags: [routing]\n---\nKeep the existing provider routing unchanged while adding memory.\n", { mode: 0o600 });
    fs.writeFileSync(path.join(vault, "draft.md"), "# unmarked draft\n", { mode: 0o600 });
    const first = syncObsidianVault({ vaultRoot: vault, projectId: "pi-overdrive", ledger });
    const second = syncObsidianVault({ vaultRoot: vault, projectId: "pi-overdrive", ledger });
    assert.deepEqual({ scanned: first.scanned, changed: first.changed, accepted: first.accepted }, { scanned: 2, changed: 1, accepted: 1 });
    assert.equal(second.changed, 0);
    assert.equal(ledger.search("provider routing", { project: "pi-overdrive" })[0].source, "obsidian:03 Decisions/Routing.md");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Obsidian sync rejects symlinked notes", () => {
  const root = temporary();
  try {
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault, { mode: 0o700 });
    const outside = path.join(root, "outside.md");
    fs.writeFileSync(outside, "---\nmemory: true\n---\nOutside content must not be followed.\n", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(vault, "escape.md"));
    assert.throws(() => syncObsidianVault({ vaultRoot: vault, projectId: "pi-overdrive", ledger: new MemoryLedger(path.join(root, "ledger")) }), /symlink/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Obsidian projection hook never receives a Curator-rejected note", () => {
  const root = temporary();
  try {
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault, { mode: 0o700 });
    const secret = ["ghp", "_", "A".repeat(30)].join("");
    fs.writeFileSync(path.join(vault, "unsafe.md"), `---\nmemory: true\ntype: resource\n---\nDo not publish ${secret}.\n`, { mode: 0o600 });
    let published = 0;
    const result = syncObsidianVault({ vaultRoot: vault, projectId: "pi-overdrive", ledger: new MemoryLedger(path.join(root, "ledger")), publishResource: () => { published += 1; } });
    assert.equal(result.rejected, 1);
    assert.equal(result.published, 0);
    assert.equal(published, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Obsidian external provenance is not escalated to project-document trust", () => {
  const root = temporary();
  try {
    const vault = path.join(root, "vault");
    const ledger = new MemoryLedger(path.join(root, "ledger"));
    fs.mkdirSync(vault, { mode: 0o700 });
    fs.writeFileSync(path.join(vault, "research.md"), "---\nmemory: true\ntype: resource\ntrust: EXTERNAL\n---\nExternal research that still requires primary-source verification.\n", { mode: 0o600 });
    assert.equal(syncObsidianVault({ vaultRoot: vault, projectId: "pi-overdrive", ledger }).accepted, 1);
    assert.equal(ledger.search("external research", { project: "pi-overdrive" })[0].trustLevel, "EXTERNAL");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("setup creates a private portable vault and is idempotent", () => {
  const root = temporary();
  try {
    const data = path.join(root, "data");
    const first = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "setup-second-brain.mjs")], { cwd: packageRoot, env: { ...process.env, XDG_DATA_HOME: data }, encoding: "utf8" });
    const vault = path.join(data, "pi-overdrive", "second-brain", "vault", "SecondBrain");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.existsSync(path.join(vault, "01 Projects", "Pi Overdrive", "Architecture.md")), true);
    assert.equal(fs.statSync(vault).mode & 0o077, 0);
    const architecture = path.join(vault, "01 Projects", "Pi Overdrive", "Architecture.md");
    fs.appendFileSync(architecture, "\nHuman edit retained.\n");
    const second = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "setup-second-brain.mjs")], { cwd: packageRoot, env: { ...process.env, XDG_DATA_HOME: data }, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.match(fs.readFileSync(architecture, "utf8"), /Human edit retained/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
