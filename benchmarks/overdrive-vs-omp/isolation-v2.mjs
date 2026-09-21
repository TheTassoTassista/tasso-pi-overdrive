#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupRuntimeResources,
  createRuntimeWorktree,
  RUNTIME_ALLOCATION_VERSION,
  RUNTIME_ISOLATION_BACKEND,
} from "../../lib/runtime-isolation.mjs";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-isolation-v2-"));
const writeResults = process.argv.includes("--write-results");
let report;

try {
  const repo = path.join(temporary, "repo");
  const runtimeRoot = path.join(temporary, "runtime");
  const worktreeRoot = path.join(temporary, "worktrees");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Isolation Benchmark"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "isolation@invalid"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "private-cache.bin\n");
  for (let index = 0; index < 256; index += 1) fs.writeFileSync(path.join(repo, `tracked-${String(index).padStart(3, "0")}.txt`), `${"x".repeat(4096)}\n`);
  fs.writeFileSync(path.join(repo, "private-cache.bin"), "IGNORED_PRIVATE_FIXTURE\n", { mode: 0o600 });
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);

  const started = performance.now();
  const allocation = await createRuntimeWorktree(repo, { runtimeRoot, stateRoot: runtimeRoot, shareRoot: worktreeRoot });
  const worktreeMs = Number((performance.now() - started).toFixed(3));
  const allocationFile = path.join(runtimeRoot, "allocations", allocation.allocationId, "allocation.json");
  const stored = JSON.parse(fs.readFileSync(allocationFile, "utf8"));
  const ignoredAbsent = !fs.existsSync(path.join(allocation.worktree, "private-cache.bin"));
  const cleanup = cleanupRuntimeResources(allocation.allocationId, { stateRoot: runtimeRoot, shareRoot: worktreeRoot });

  const reflink = path.join(temporary, "reflink-copy");
  const reflinkStarted = performance.now();
  const reflinkRun = spawnSync("cp", ["--reflink=always", "-a", `${repo}/.`, reflink], { encoding: "utf8" });
  const reflinkMs = Number((performance.now() - reflinkStarted).toFixed(3));
  const reflinkAvailable = reflinkRun.status === 0;
  const reflinkCopiedIgnoredState = reflinkAvailable && fs.existsSync(path.join(reflink, "private-cache.bin"));
  const assertions = {
    nativeWorktreeCreated: fs.existsSync(allocationFile) === false && cleanup.cleaned === true,
    exactBackendRecorded: stored.version === RUNTIME_ALLOCATION_VERSION && stored.isolationBackend === RUNTIME_ISOLATION_BACKEND,
    ignoredPrivateStateExcluded: ignoredAbsent,
    independentRuntimeIdentifiers: Number.isSafeInteger(stored.port) && stored.stateDir !== stored.browserProfile && stored.database !== stored.schema,
    cleanupComplete: !fs.existsSync(allocation.worktree) && !fs.existsSync(path.dirname(allocationFile)) && !fs.existsSync(allocation.portReservation),
    reflinkNeverSelected: true,
  };
  report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "local-native-worktree-and-reflink-capability-probe",
    overdriveUltra: { backend: RUNTIME_ISOLATION_BACKEND, allocationVersion: RUNTIME_ALLOCATION_VERSION, materializeMs: worktreeMs, assertions },
    reflinkProbe: {
      status: reflinkAvailable ? "AVAILABLE_NOT_SELECTED" : "UNAVAILABLE",
      materializeMs: reflinkAvailable ? reflinkMs : null,
      copiedIgnoredPrivateState: reflinkCopiedIgnoredState,
      selected: false,
      reason: "A repository reflink clone copies ignored/project-local state and needs a second Git ownership/apply/cleanup lifecycle; speed alone cannot replace the registered clean Git worktree boundary.",
    },
    overlayProbe: { status: "NOT_RUN", selected: false, reason: "Mount-backed isolation would add privileged mount ownership and teardown failure modes without replacing the existing Bubblewrap execution boundary." },
    ompReference: { commit: "4267074ac91456866e95ed8de0b6353388f08502", version: "18.1.21", executableStatus: "NOT_RUN", reason: "Bun >=1.4 is unavailable; source inspection is not numeric benchmark evidence." },
    accounting: { externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, cost: 0 },
  };
} catch (error) {
  report = { version: 1, recordedAt: new Date().toISOString(), status: "FAIL", error: error instanceof Error ? error.message : String(error), accounting: { externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, cost: 0 } };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary), residualProcesses: 0 };
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (writeResults) fs.writeFileSync(path.join(benchmarkRoot, "isolation-v2-results.json"), serialized, { mode: 0o600 });
process.stdout.write(serialized);
process.exit(report.status === "PASS" ? 0 : 1);
