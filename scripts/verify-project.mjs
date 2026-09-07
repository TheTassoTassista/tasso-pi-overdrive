#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const argv = new Set(process.argv.slice(2));
const mode = argv.has("--full") ? "full" : "quick";
const listOnly = argv.has("--list");
const asJson = argv.has("--json");
const cwdIndex = process.argv.indexOf("--cwd");
const cwd = path.resolve(cwdIndex >= 0 && process.argv[cwdIndex + 1] ? process.argv[cwdIndex + 1] : process.cwd());
const checks = [];

function add(name, command, args, reason) {
  if (!checks.some((item) => item.name === name)) checks.push({ name, command, args, reason });
}

function commandExists(command) {
  return spawnSync("sh", ["-c", "command -v -- \"$1\" >/dev/null 2>&1", "sh", command], { cwd }).status === 0;
}

function loadJson(file) {
  try { return JSON.parse(readFileSync(path.join(cwd, file), "utf8")); } catch { return undefined; }
}

if (existsSync(path.join(cwd, "package.json"))) {
  const pkg = loadJson("package.json") ?? {};
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
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

if (existsSync(path.join(cwd, ".git")) && commandExists("git")) add("git-diff-check", "git", ["diff", "--check"], "Whitespace/conflict-marker check");

if (listOnly) {
  process.stdout.write(`${JSON.stringify({ cwd, mode, checks }, null, asJson ? 0 : 2)}\n`);
  process.exit(0);
}

const results = checks.map((check) => {
  const started = Date.now();
  const run = spawnSync(check.command, check.args, { cwd, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", CI: "1" } });
  const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  const output = combined.length > 5000 ? `[output truncated]\n${combined.slice(-5000)}` : combined;
  return {
    name: check.name,
    status: run.status === 0 ? "PASS" : run.error?.code === "ETIMEDOUT" ? "TIMEOUT" : "FAIL",
    exitCode: run.status,
    durationMs: Date.now() - started,
    output,
  };
});

const summary = {
  cwd,
  mode,
  status: results.length === 0 ? "NO_CHECKS" : results.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
  results,
};
if (asJson) process.stdout.write(`${JSON.stringify(summary)}\n`);
else {
  for (const result of results) process.stdout.write(`${result.name}: ${result.status} (${result.durationMs} ms)\n`);
  process.stdout.write(`Overall: ${summary.status}\n`);
}
process.exit(summary.status === "FAIL" ? 1 : 0);
