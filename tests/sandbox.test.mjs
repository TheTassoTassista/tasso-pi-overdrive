import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sandbox = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/sandbox-run.sh");

test("Bubblewrap hides host paths, clears secrets/network, and confines indirect writes", { skip: process.env.PI_OVERDRIVE_SKIP_BWRAP === "1" || process.env.PI_OVERDRIVE_IN_SANDBOX === "1" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-bwrap-test-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  try {
    mkdirSync(workspace);
    writeFileSync(outside, "protected\n");
    writeFileSync(path.join(workspace, ".env"), "WORKSPACE_SECRET_MARKER\n", { mode: 0o600 });
    mkdirSync(path.join(workspace, ".git"));
    writeFileSync(path.join(workspace, ".git", "config"), "git-metadata\n");
    const hidden = spawnSync(sandbox, [workspace, "--", "python3", "-c", `open(${JSON.stringify(outside)}).read()`], { encoding: "utf8" });
    assert.notEqual(hidden.status, 0);
    const indirect = spawnSync(sandbox, [workspace, "--", "python3", "-c", `open(${JSON.stringify(outside)},'w').write('changed')`], { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "must-not-leak" } });
    assert.notEqual(indirect.status, 0);
    assert.equal(readFileSync(outside, "utf8"), "protected\n");
    const environment = spawnSync(sandbox, [workspace, "--", "python3", "-c", "import os; print(os.getenv('OPENAI_API_KEY','ABSENT'))"], { encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "must-not-leak" } });
    assert.equal(environment.status, 0);
    assert.equal(environment.stdout.trim(), "ABSENT");
    const network = spawnSync(sandbox, [workspace, "--", "python3", "-c", "import socket; socket.create_connection(('1.1.1.1',53),0.2)"], { encoding: "utf8" });
    assert.notEqual(network.status, 0);
    const repositorySecret = spawnSync(sandbox, [workspace, "--", "python3", "-c", "print(open('/workspace/.env').read())"], { encoding: "utf8" });
    assert.equal(repositorySecret.stdout.includes("WORKSPACE_SECRET_MARKER"), false);
    const systemConfig = spawnSync(sandbox, [workspace, "--", "python3", "-c", "open('/etc/passwd').read()"], { encoding: "utf8" });
    assert.notEqual(systemConfig.status, 0);
    const piAuth = spawnSync(sandbox, [workspace, "--", "python3", "-c", "open('/home/tasso/.pi/agent/auth.json').read()"], { encoding: "utf8" });
    assert.notEqual(piAuth.status, 0);
    assert.equal(piAuth.stdout.trim(), "");
    const gitMutation = spawnSync(sandbox, [workspace, "--", "python3", "-c", "open('/workspace/.git/config','w').write('changed')"], { encoding: "utf8" });
    assert.notEqual(gitMutation.status, 0);
    assert.equal(readFileSync(path.join(workspace, ".git", "config"), "utf8"), "git-metadata\n");
    const readOnlyMutation = spawnSync(sandbox, ["--workspace-read-only", workspace, "--", "python3", "-c", "open('/workspace/read-only-escape','w').write('changed')"], { encoding: "utf8" });
    assert.notEqual(readOnlyMutation.status, 0);
    assert.equal(readFileSync(outside, "utf8"), "protected\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
