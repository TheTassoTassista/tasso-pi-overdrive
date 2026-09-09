#!/usr/bin/env node
import { appendFinding, FINDING_CATEGORIES } from "../lib/findings-store.mjs";

const value = (flag) => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; };
try {
  const record = appendFinding({ category: value("--category"), summary: value("--summary"), source: value("--source"), evidence: value("--evidence") });
  process.stdout.write(`${JSON.stringify({ status: "RECORDED", category: record.category, recordedAt: record.recordedAt, evidenceDigest: record.evidenceDigest })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nCategories: ${FINDING_CATEGORIES.join(", ")}\n`);
  process.exitCode = 2;
}
