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

async function checkOperation(name, cwd, args, predicate) {
  const execution = await run(cwd, args);
  const details = execution.event?.result?.details;
  check(name, execution.code === 0 && execution.event?.isError === false && details?.status === "PASS" && predicate(details), details ?? execution.stderr);
}

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
  fs.mkdirSync(path.join(rust, "src"), { recursive: true });
  fs.writeFileSync(path.join(rust, "Cargo.toml"), "[package]\nname = \"rust_fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n");
  fs.writeFileSync(path.join(rust, "src", "lib.rs"), "pub fn twice(value: i32) -> i32 { value * 2 }\n");
  fs.writeFileSync(path.join(rust, "src", "main.rs"), "use rust_fixture::twice;\n\nfn main() {\n    let bad: &str = twice(21);\n    println!(\"{}\", twice(2));\n}\n");
  await checkOperation("pi-rust-definition", rust, { operation: "definition", path: "src/main.rs", line: 4, character: 22 }, (details) => details.entries?.some((entry) => entry.path === "src/lib.rs"));
  await checkOperation("pi-rust-references", rust, { operation: "references", path: "src/main.rs", line: 4, character: 22 }, (details) => details.entries?.some((entry) => entry.path === "src/lib.rs") && details.entries?.filter((entry) => entry.path === "src/main.rs").length >= 2);
  await checkOperation("pi-rust-diagnostics", rust, { operation: "diagnostics", path: "src/main.rs" }, (details) => details.entries?.some((entry) => entry.severity === "Error"));
  await checkOperation("pi-rust-hover", rust, { operation: "hover", path: "src/main.rs", line: 4, character: 22 }, (details) => /twice|i32/u.test(details.entries?.contents ?? ""));
  await checkOperation("pi-rust-document-symbols", rust, { operation: "document_symbols", path: "src/main.rs" }, (details) => details.entries?.some((entry) => entry.name === "main"));
  await checkOperation("pi-rust-workspace-symbols", rust, { operation: "workspace_symbols", path: "src/main.rs", query: "twice" }, (details) => details.entries?.some((entry) => entry.name === "twice" && entry.location?.path === "src/lib.rs"));
  const rustBefore = `${fs.readFileSync(path.join(rust, "src", "lib.rs"), "utf8")}${fs.readFileSync(path.join(rust, "src", "main.rs"), "utf8")}`;
  await checkOperation("pi-rust-rename-preview", rust, { operation: "rename_preview", path: "src/main.rs", line: 4, character: 22, newName: "double_value" }, (details) => details.count >= 3);
  check("pi-rust-rename-read-only", `${fs.readFileSync(path.join(rust, "src", "lib.rs"), "utf8")}${fs.readFileSync(path.join(rust, "src", "main.rs"), "utf8")}` === rustBefore, "fixture content unchanged");

  const go = path.join(temporary, "go");
  fs.mkdirSync(path.join(go, "mathx"), { recursive: true });
  fs.writeFileSync(path.join(go, "go.mod"), "module example.invalid/fixture\n\ngo 1.26\n");
  fs.writeFileSync(path.join(go, "mathx", "mathx.go"), "package mathx\n\nfunc Twice(value int) int { return value * 2 }\n");
  fs.writeFileSync(path.join(go, "main.go"), "package main\n\nimport (\n    \"fmt\"\n    \"example.invalid/fixture/mathx\"\n)\n\nfunc main() {\n    var bad string = mathx.Twice(21)\n    fmt.Println(mathx.Twice(2), bad)\n}\n");
  await checkOperation("pi-go-definition", go, { operation: "definition", path: "main.go", line: 9, character: 30 }, (details) => details.entries?.some((entry) => entry.path === "mathx/mathx.go"));
  await checkOperation("pi-go-references", go, { operation: "references", path: "main.go", line: 9, character: 30 }, (details) => details.entries?.some((entry) => entry.path === "mathx/mathx.go") && details.entries?.filter((entry) => entry.path === "main.go").length >= 2);
  await checkOperation("pi-go-diagnostics", go, { operation: "diagnostics", path: "main.go" }, (details) => details.entries?.some((entry) => entry.severity === "Error"));
  await checkOperation("pi-go-hover", go, { operation: "hover", path: "main.go", line: 9, character: 30 }, (details) => /Twice|int/u.test(details.entries?.contents ?? ""));
  await checkOperation("pi-go-document-symbols", go, { operation: "document_symbols", path: "main.go" }, (details) => details.entries?.some((entry) => entry.name === "main"));
  await checkOperation("pi-go-workspace-symbols", go, { operation: "workspace_symbols", path: "main.go", query: "Twice" }, (details) => details.entries?.some((entry) => entry.name === "Twice" && entry.location?.path === "mathx/mathx.go"));
  const goBefore = `${fs.readFileSync(path.join(go, "mathx", "mathx.go"), "utf8")}${fs.readFileSync(path.join(go, "main.go"), "utf8")}`;
  await checkOperation("pi-go-rename-preview", go, { operation: "rename_preview", path: "main.go", line: 9, character: 30, newName: "Double" }, (details) => details.count >= 3);
  check("pi-go-rename-read-only", `${fs.readFileSync(path.join(go, "mathx", "mathx.go"), "utf8")}${fs.readFileSync(path.join(go, "main.go"), "utf8")}` === goBefore, "fixture content unchanged");
} catch (error) {
  check("lsp-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const status = results.length === 21 && results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, isolation: "bubblewrap-read-only-no-network", results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
