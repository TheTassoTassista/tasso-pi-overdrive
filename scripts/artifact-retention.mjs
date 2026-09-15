#!/usr/bin/env node
import { pruneArtifactStore } from "../lib/artifact-store.mjs";

const mode = process.argv[2] ?? "--dry-run";
if (!["--dry-run", "--apply"].includes(mode) || process.argv.length > 3) {
  process.stderr.write("usage: artifact-retention.mjs [--dry-run|--apply]\n");
  process.exit(2);
}
const summary = pruneArtifactStore({ apply: mode === "--apply" });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(summary.status === "PASS" || summary.status.startsWith("SKIPPED_") ? 0 : 1);
