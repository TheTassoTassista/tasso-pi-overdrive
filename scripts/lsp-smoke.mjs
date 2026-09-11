#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || "pi";
const provider = path.join(packageRoot, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const lspExtension = path.join(packageRoot, "extensions", "lsp.ts");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-lsp-smoke-"));
const auditHome = path.join(temporary, "home");
const auditAgent = path.join(auditHome, ".pi", "agent");
const auditConfig = path.join(temporary, "config");
fs.mkdirSync(auditAgent, { recursive: true, mode: 0o700 });
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

function run(cwd, args, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    const child = spawn(pi, ["--extension", provider, "--extension", lspExtension, "--offline", "--approve", "--no-session", "--mode", "rpc", "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--tools", "semantic_nav"], {
      cwd,
      env: {
        ...process.env,
        HOME: auditHome,
        PI_CODING_AGENT_DIR: auditAgent,
        XDG_CONFIG_HOME: auditConfig,
        XDG_STATE_HOME: path.join(temporary, "state"),
        npm_config_cache: path.join(temporary, "npm-cache"),
        PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only",
        PI_OVERDRIVE_AUDIT_TOOL: "semantic_nav",
        PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify(args),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        try { if (line) events.push(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
    child.stdin.write(`${JSON.stringify({ id: "lsp-smoke", type: "prompt", message: "Run the deterministic semantic navigation check." })}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const poll = setInterval(() => {
      if (!events.some((event) => event.type === "agent_settled")) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    child.once("close", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ code, stderr, event: events.find((event) => event.type === "tool_execution_end" && event.toolName === "semantic_nav") });
    });
  });
}

try {
  const ts = path.join(temporary, "typescript");
  fs.mkdirSync(path.join(ts, "src"), { recursive: true });
  fs.writeFileSync(path.join(ts, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
  fs.writeFileSync(path.join(ts, "src", "defs.ts"), "export function twice(value: number): number { return value * 2; }\n");
  fs.writeFileSync(path.join(ts, "src", "use.ts"), "import { twice } from './defs';\nconst bad: string = twice(2);\nconsole.log(twice(3));\n");
  const tsDefinition = await run(ts, { operation: "definition", path: "src/use.ts", line: 1, character: 10 });
  const tsDetails = tsDefinition.event?.result?.details;
  check("pi-typescript-definition", tsDefinition.code === 0 && tsDefinition.event?.isError === false && tsDetails?.status === "PASS" && tsDetails?.entries?.some((entry) => entry.path === "src/defs.ts"), tsDetails ?? tsDefinition.stderr);
  const tsDiagnostics = await run(ts, { operation: "diagnostics", path: "src/use.ts" });
  const tsDiagnosticDetails = tsDiagnostics.event?.result?.details;
  check("pi-typescript-diagnostics", tsDiagnostics.code === 0 && tsDiagnostics.event?.isError === false && tsDiagnosticDetails?.entries?.some((entry) => String(entry.code) === "2322"), tsDiagnosticDetails ?? tsDiagnostics.stderr);

  const python = path.join(temporary, "python");
  fs.mkdirSync(python);
  fs.writeFileSync(path.join(python, "pyrightconfig.json"), JSON.stringify({ typeCheckingMode: "strict" }));
  fs.writeFileSync(path.join(python, "util.py"), "def twice(value: int) -> int:\n    return value * 2\n");
  fs.writeFileSync(path.join(python, "main.py"), "from util import twice\nresult: str = twice(21)\nprint(twice(2))\n");
  const pyDefinition = await run(python, { operation: "definition", path: "main.py", line: 2, character: 15 });
  const pyDetails = pyDefinition.event?.result?.details;
  check("pi-python-definition", pyDefinition.code === 0 && pyDefinition.event?.isError === false && pyDetails?.entries?.some((entry) => entry.path === "util.py"), pyDetails ?? pyDefinition.stderr);
  const pyReferences = await run(python, { operation: "references", path: "main.py", line: 2, character: 15 });
  const pyReferenceDetails = pyReferences.event?.result?.details;
  check("pi-python-references", pyReferences.code === 0 && pyReferences.event?.isError === false && pyReferenceDetails?.count >= 3, pyReferenceDetails ?? pyReferences.stderr);

  const cpp = path.join(temporary, "cpp");
  fs.mkdirSync(cpp);
  fs.writeFileSync(path.join(cpp, "compile_flags.txt"), "-std=c++17\n");
  fs.writeFileSync(path.join(cpp, "main.cpp"), "int twice(int value) { return value * 2; }\nint main() { const char* bad = twice(2); return twice(3); }\n");
  const cppDiagnostics = await run(cpp, { operation: "diagnostics", path: "main.cpp" });
  const cppDetails = cppDiagnostics.event?.result?.details;
  check("pi-cpp-diagnostics", cppDiagnostics.code === 0 && cppDiagnostics.event?.isError === false && cppDetails?.entries?.some((entry) => entry.severity === "Error"), cppDetails ?? cppDiagnostics.stderr);

  const rust = path.join(temporary, "rust");
  fs.mkdirSync(rust);
  fs.writeFileSync(path.join(rust, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  fs.writeFileSync(path.join(rust, "main.rs"), "fn main() {}\n");
  const missing = await run(rust, { operation: "diagnostics", path: "main.rs" });
  const missingDetails = missing.event?.result?.details;
  check("pi-rust-missing-server-visible", missing.code === 0 && missing.event?.isError === false && missingDetails?.status === "PARTIAL" && missingDetails?.error === "language_server_missing", missingDetails ?? missing.stderr);
} catch (error) {
  check("lsp-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const status = results.length === 6 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, isolation: "bubblewrap-read-only-no-network", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
