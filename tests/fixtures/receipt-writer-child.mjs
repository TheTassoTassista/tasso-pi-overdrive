import process from "node:process";
import { writeRoleReceipt } from "../../lib/workflow-receipts.mjs";

const store = JSON.parse(process.argv[2]);
const receipt = JSON.parse(process.argv[3]);
try {
  const result = writeRoleReceipt(store, receipt);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
