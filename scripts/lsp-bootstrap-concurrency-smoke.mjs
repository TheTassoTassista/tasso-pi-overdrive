#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(packageRoot, "scripts", script)], {
      cwd: packageRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-16 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); });
    child.once("close", (code) => resolve({ script, code, stdout, stderr }));
  });
}

const results = await Promise.all([run("lsp-smoke.mjs"), run("bootstrap-smoke.mjs")]);
const status = results.every((result) => result.code === 0) ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, strategy: "isolated-temporary-bootstrap-lsp-runtime", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
