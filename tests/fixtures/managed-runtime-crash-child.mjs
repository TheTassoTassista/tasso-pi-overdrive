import fs from "node:fs";
import path from "node:path";
import { promoteManagedRuntime } from "../../lib/managed-runtime-transaction.mjs";

const [runtimeRoot, stagingRoot] = process.argv.slice(2);
if (!runtimeRoot || !stagingRoot) process.exit(2);

const inspect = (root) => {
  try {
    return { status: JSON.parse(fs.readFileSync(path.join(root, "install-record.json"), "utf8")).valid === true ? "PASS" : "FAIL" };
  } catch {
    return { status: "FAIL" };
  }
};

promoteManagedRuntime({
  runtimeRoot,
  stagingRoot,
  inspect,
  removeTree: (root) => fs.rmSync(root, { recursive: true, force: true }),
  transactionId: "abrupt-child",
  fault: (point) => {
    if (point === "after_previous_preserved") process.kill(process.pid, "SIGKILL");
  },
});
