#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { pruneKnownTraceLogs, resolveRetentionDays } from "../lib/trace-retention.mjs";

const mode = process.argv[2] ?? "--dry-run";
if (!["--dry-run", "--apply"].includes(mode) || process.argv.length > 3) {
  process.stderr.write("usage: trace-retention.mjs [--dry-run|--apply]\n");
  process.exit(2);
}
const configured = process.env.PI_OVERDRIVE_TRACE_RETENTION_DAYS ?? process.env.PI_OVERDRIVE_TRACE_DAYS;
const retention = resolveRetentionDays(configured);
if (!retention.valid) {
  process.stderr.write("Trace retention is disabled for this run: retention days must be an integer from 1 to 3650.\n");
  process.exit(2);
}
const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
const summary = await pruneKnownTraceLogs({ stateHome, days: retention.days, apply: mode === "--apply" });
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exit(summary.status === "PASS" ? 0 : 1);
