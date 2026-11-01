#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findRuntimeAllocation } from "../lib/runtime-isolation.mjs";
import { requireCodingBackend, sandboxInvocation, verifyCodingProject } from "../platform/shared/coding-execution.mjs";

const argv = new Set(process.argv.slice(2));
const mode = argv.has("--full") ? "full" : "quick";
const listOnly = argv.has("--list");
const asJson = argv.has("--json");
if (process.platform === "win32") {
  const index = process.argv.indexOf("--cwd");
  const cwd = index >= 0 ? process.argv[index + 1] : process.cwd();
  let summary;
  try { summary = await verifyCodingProject({ cwd, mode, listOnly }); }
  catch (error) { summary = { status: "FAIL", error: /^[A-Z_]+$/u.test(error.code ?? "") ? error.code : "PHI_CODING_BACKEND_UNAVAILABLE", results: [] }; }
  process.stdout.write(asJson ? JSON.stringify(summary) + "\n" : "Verification: " + summary.status + "\n");
  process.exit(summary.status === "PASS" || summary.status === "LIST_ONLY" ? 0 : summary.status === "NO_CHECKS" ? 2 : 1);
}
try { requireCodingBackend("verification"); }
catch (error) {
  const summary = { status: "FAIL", error: "PHI_CODING_BACKEND_UNAVAILABLE", results: [] };
  process.stdout.write(asJson ? `${JSON.stringify(summary)}\n` : "Verification: FAIL (secure production backend unavailable)\n");
  process.exit(1);
}
const cwdIndex = process.argv.indexOf("--cwd");
const cwd = path.resolve(cwdIndex >= 0 && process.argv[cwdIndex + 1] ? process.argv[cwdIndex + 1] : process.cwd());
const allocation = findRuntimeAllocation(cwd);
const checks = [];

function add(name, command, args, reason) {
  if (!checks.some((item) => item.name === name)) checks.push({ name, command, args, reason });
}

function commandExists(command) {
  return spawnSync("which", [command], { cwd, stdio: "ignore" }).status === 0;
}

if (existsSync(path.join(cwd, "package.json"))) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")); } catch {}
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || (Object.hasOwn(pkg, "scripts") && (!pkg.scripts || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts)))) {
    const summary = { cwd, mode, sandboxed: true, allocationId: allocation?.allocationId ?? null,
      status: "FAIL", error: "PACKAGE_JSON_INVALID", results: [] };
    process.stdout.write(asJson ? `${JSON.stringify(summary)}\n` : "Verification: FAIL (package manifest invalid)\n");
    process.exit(1);
  }
  const scripts = pkg.scripts ?? {};
  const manager = existsSync(path.join(cwd, "pnpm-lock.yaml")) && commandExists("pnpm") ? "pnpm"
    : existsSync(path.join(cwd, "bun.lock")) && commandExists("bun") ? "bun"
      : existsSync(path.join(cwd, "yarn.lock")) && commandExists("yarn") ? "yarn" : "npm";
  const run = (script) => manager === "npm" ? ["run", script] : ["run", script];
  const order = mode === "full" ? ["typecheck", "lint", "format:check", "test", "test:unit", "build", "test:e2e"] : ["typecheck", "lint", "test"];
  for (const name of order) if (typeof scripts[name] === "string") add(name, manager, run(name), `package.json script ${name}`);
}

if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "pytest.ini"))) {
  if (commandExists("python")) add("python-compile", "python", ["-m", "compileall", "-q", "."], "Python syntax check");
  if (commandExists("pytest")) add("pytest", "pytest", ["-q"], "Python tests");
  if (commandExists("basedpyright")) add("basedpyright", "basedpyright", [], "Python typecheck");
  else if (commandExists("pyright")) add("pyright", "pyright", [], "Python typecheck");
}

if (existsSync(path.join(cwd, "Cargo.toml")) && commandExists("cargo")) {
  add("cargo-test", "cargo", ["test", "--quiet"], "Rust tests");
  if (mode === "full") {
    add("cargo-fmt", "cargo", ["fmt", "--", "--check"], "Rust format check");
    add("cargo-clippy", "cargo", ["clippy", "--all-targets", "--", "-D", "warnings"], "Rust lint");
  }
}

if (existsSync(path.join(cwd, "go.mod")) && commandExists("go")) add("go-test", "go", ["test", "./..."], "Go tests");

if (existsSync(path.join(cwd, "CMakeLists.txt")) && existsSync(path.join(cwd, "build")) && commandExists("cmake")) {
  add("cmake-build", "cmake", ["--build", "build"], "CMake build");
  if (commandExists("ctest")) add("ctest", "ctest", ["--test-dir", "build", "--output-on-failure"], "CMake tests");
}

if ((existsSync(path.join(cwd, ".git")) || spawnSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0) && commandExists("git")) {
  add("git-diff-check", "git", ["diff", "--check"], "Whitespace/conflict-marker check");
}

if (listOnly) {
  process.stdout.write(`${JSON.stringify({ cwd, mode, sandboxed: true, allocationId: allocation?.allocationId ?? null, checks }, null, asJson ? 0 : 2)}\n`);
  process.exit(0);
}

const results = checks.map((check) => {
  const started = Date.now();
  const runtimeArgs = allocation ? [
    "--runtime-state", allocation.stateDir,
    "--browser-profile", allocation.browserProfile,
    "--port", String(allocation.port),
    "--database", allocation.database,
    "--schema", allocation.schema,
  ] : [];
  const directGitRead = check.name === "git-diff-check";
  const invocation = directGitRead ? null : sandboxInvocation("verification", [...runtimeArgs, cwd, "--cwd", ".", "--", check.command, ...check.args]);
  const run = directGitRead
    ? spawnSync(check.command, check.args, { cwd, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", CI: "1" } })
    : spawnSync(invocation.command, invocation.args, { cwd, shell: invocation.shell, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  const output = combined.length > 5000 ? `[output truncated]\n${combined.slice(-5000)}` : combined;
  return {
    name: check.name,
    status: run.status === 0 ? "PASS" : run.error?.code === "ETIMEDOUT" ? "TIMEOUT" : "FAIL",
    exitCode: run.status,
    durationMs: Date.now() - started,
    sandboxed: !directGitRead,
    output,
  };
});

const summary = {
  cwd,
  mode,
  sandboxed: true,
  allocationId: allocation?.allocationId ?? null,
  status: results.some((item) => item.status !== "PASS") ? "FAIL"
    : results.some((item) => item.name !== "git-diff-check") ? "PASS" : "NO_CHECKS",
  results,
};
if (asJson) process.stdout.write(`${JSON.stringify(summary)}\n`);
else {
  for (const result of results) process.stdout.write(`${result.name}: ${result.status} (${result.durationMs} ms)\n`);
  process.stdout.write(`Overall: ${summary.status}\n`);
}
process.exit(summary.status === "PASS" ? 0 : summary.status === "NO_CHECKS" ? 2 : 1);
