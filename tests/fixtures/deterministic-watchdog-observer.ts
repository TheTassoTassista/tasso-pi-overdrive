import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveTaskPolicy } from "../../lib/task-governor.mjs";
import { WATCHDOG_EVENT, WATCHDOG_METADATA_EVENT, watchdogObservationFromWorkflow } from "../../lib/watchdog.mjs";

const hard = "Investigate intermittent race condition and production regression across parser.js and worker.js under load; fix tests and architecture";
const state = (phase: string, status: string, failures: number) => ({
  currentPhase: phase, round: failures, verificationStatus: status, finalVerificationStatus: status, blockingFindingsCount: 0,
  evidence: { roles: [], verifications: Array.from({ length: failures }, () => ({ status: "FAIL" })), transitions: [] },
});

export default function fixture(pi: ExtensionAPI): void {
  const audit = process.env.PI_OVERDRIVE_WATCHDOG_AUDIT_FILE;
  pi.events.on(WATCHDOG_METADATA_EVENT, (value) => {
    if (audit) fs.appendFileSync(audit, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  });
  pi.registerCommand("watchdog-fixture", {
    description: "Emit bounded deterministic controller observations for an offline Watchdog test",
    handler: async (args, ctx) => {
      const mode = args.trim();
      const task = resolveTaskPolicy({ task: mode === "tiny" ? "Change label text in app.js" : hard, preset: "normal", quality: "auto" });
      const emit = (value: ReturnType<typeof state>, runId: string) => pi.events.emit(WATCHDOG_EVENT, watchdogObservationFromWorkflow(value, task, runId));
      if (mode === "tiny") emit(state("VERIFICATION", "FAIL", 2), "tiny-run");
      else if (mode === "repeated") {
        emit(state("VERIFICATION", "FAIL", 1), "repeated-run");
        emit(state("VERIFICATION", "FAIL", 2), "repeated-run");
        emit(state("VERIFICATION", "FAIL", 2), "repeated-run");
      } else if (mode === "regression") {
        emit(state("VERIFICATION", "PASS", 0), "regression-run");
        emit(state("WORKER", "RUNNING", 0), "regression-run");
        emit(state("VERIFICATION", "FAIL", 1), "regression-run");
      } else if (mode === "malformed") {
        pi.events.emit(WATCHDOG_EVENT, { ...watchdogObservationFromWorkflow(state("VERIFICATION", "FAIL", 2), task, "malformed-run"), transcript: "BENCHMARK_PRIVATE_MARKER" });
      } else { ctx.ui.notify("Unknown fixture mode", "warning"); return; }
      ctx.ui.notify(`Watchdog fixture ${mode} delivered.`, "info");
    },
  });
}
