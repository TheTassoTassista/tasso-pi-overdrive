import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preflight = path.join(root, "scripts", "platform-preflight.sh");
const invoke = (kernel, machine) => spawnSync("bash", [preflight, kernel, machine], { encoding: "utf8", timeout: 5000 });

test("Linux x86_64 preflight passes while native Windows and other hosts fail before install", () => {
  const linux = invoke("Linux", "x86_64");
  assert.equal(linux.status, 0);
  assert.match(linux.stdout, /Linux x86_64 supported/u);
  for (const [kernel, machine] of [["MINGW64_NT-10.0", "x86_64"], ["MSYS_NT-10.0", "x86_64"], ["Windows_NT", "x86_64"], ["Darwin", "arm64"], ["Linux", "aarch64"]]) {
    const denied = invoke(kernel, machine);
    assert.equal(denied.status, 1, `${kernel}/${machine}`);
    assert.match(denied.stderr, /no changes made/u);
  }
  const bootstrap = fs.readFileSync(path.join(root, "scripts", "prerequisites.sh"), "utf8");
  assert.ok(bootstrap.indexOf("platform-preflight.sh") < bootstrap.indexOf("--install-system"));
});
