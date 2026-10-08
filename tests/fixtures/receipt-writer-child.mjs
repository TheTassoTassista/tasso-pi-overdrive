import process from "node:process";
import { performance } from "node:perf_hooks";
import { writeRoleReceipt } from "../../lib/workflow-receipts.mjs";

const started = performance.now();
const ordinal = process.argv[4] === "0" || process.argv[4] === "1" ? Number(process.argv[4]) : null;
let lastStage = "CHILD_START";
let cleanup = "NOT_STARTED";
let exitCategory = "PASS";

function observe(stage) {
  if (stage === "CLEANUP_STARTED") cleanup = "STARTED";
  else if (stage === "CLEANUP_COMPLETE" && cleanup === "STARTED") cleanup = "PASS";
  else if (stage.startsWith("CLEANUP_")) cleanup = "FAIL";
  else lastStage = stage;
}

function category(error) {
  if (["EACCES", "EPERM", "ENOENT", "EEXIST", "EBUSY", "EIO", "EINVAL", "ETIMEDOUT"].includes(error?.code)) return error.code;
  if (error?.message === "protected artifact security could not be verified") return "PROTECTED_ARTIFACT_UNVERIFIED";
  if (error?.message === "conflicting duplicate role receipt") return "CONFLICTING_DUPLICATE";
  if (typeof error?.message === "string" && error.message.startsWith("role receipt ")) return "RECEIPT_REJECTED";
  return "UNCLASSIFIED";
}

try {
  if (ordinal === null) throw new Error("invalid child ordinal");
  const store = JSON.parse(process.argv[2]);
  const receipt = JSON.parse(process.argv[3]);
  writeRoleReceipt(store, receipt, observe);
  lastStage = "COMPLETE";
} catch (error) {
  exitCategory = category(error);
  process.exitCode = 1;
} finally {
  // Only fixed categories and timing leave this process; no receipt, path,
  // command line, raw exception or security descriptor is published.
  process.stderr.write(`PHI_RECEIPT_CHILD_DIAGNOSTIC ${JSON.stringify({ ordinal, lastStage, exitCategory, cleanup, elapsedMs: Math.round(performance.now() - started) })}\n`);
}
