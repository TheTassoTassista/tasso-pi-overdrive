#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(benchmarkRoot, "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-plugin-boundary-"));
const pi = process.env.PI_BIN ?? "pi";
let report;
try {
  const agentDir = path.join(temporary, "agent");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n", { mode: 0o600 });
  const run = spawnSync(pi, [
    "--offline", "--approve", "--no-session", "--mode", "rpc", "--no-tools",
    "--extension", path.join(packageRoot, "tests", "fixtures", "deterministic-sentinel-provider.ts"),
    "--extension", path.join(packageRoot, "tests", "fixtures", "plugin-host-authority.ts"),
    "--provider", "pi-overdrive-sentinel-audit", "--api-key", "audit-only", "--model", "driver", "--thinking", "low",
  ], {
    cwd: temporary,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: path.join(temporary, "state"), PI_OVERDRIVE_SENTINEL_AUDIT_KEY: "audit-only" },
    input: `${JSON.stringify({ id: "host-boundary", type: "prompt", message: "/plugin-host-boundary-fixture" })}\n`,
    encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  const events = String(run.stdout ?? "").split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const notification = events.find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.includes("hostFileVisible"));
  let evidence;
  try { evidence = JSON.parse(notification?.message ?? ""); } catch { evidence = null; }
  const assertions = {
    extensionLoaded: run.status === 0 && Boolean(notification),
    hostFileVisibleAtImport: evidence?.hostFileVisible === true && evidence?.importTime === true,
    hostProcessSpawnedAtImport: evidence?.hostProcessSpawned === true,
    noModelOrToolCalls: evidence?.modelCalls === 0 && !events.some((event) => event.type === "agent_start" || event.type === "tool_execution_start"),
  };
  report = {
    version: 1, status: Object.values(assertions).every(Boolean) ? "PASS" : "FAIL",
    measurementMode: "real-pi-offline-import-time-host-authority-fixture",
    piVersion: spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim(), assertions,
    implication: "ExtensionAPI tool restrictions cannot confine module import-time host filesystem/process access; manifests alone are advisory.",
    accounting: { modelCalls: 0, externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, costEur: 0 },
    failure: run.status === 0 ? undefined : { exitCode: run.status, stderrTail: String(run.stderr ?? "").slice(-300) },
  };
} catch (error) {
  report = { version: 1, status: "FAIL", error: error instanceof Error ? error.message : String(error), accounting: { externalProviderCalls: 0, paidModelCalls: 0, networkCalls: 0, costEur: 0 } };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (report) report.cleanup = { temporaryRemoved: !fs.existsSync(temporary) };
}
if (process.argv.includes("--write-results")) fs.writeFileSync(path.join(benchmarkRoot, "plugin-boundary-results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "PASS" ? 0 : 1;
