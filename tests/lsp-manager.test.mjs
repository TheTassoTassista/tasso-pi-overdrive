import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeLsp, lspRuntimeStatus, shutdownLspServers } from "../lib/lsp-manager.mjs";

const roots = [];
function fixture(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

after(async () => {
  await shutdownLspServers();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("TypeScript LSP is lazy, project-aware, reused, and supports diagnostics/definition/references", { timeout: 60_000 }, async () => {
  await shutdownLspServers();
  const before = lspRuntimeStatus();
  assert.equal(before.activeServers, 0);
  const root = fixture("pi-lsp-ts-");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true }, include: ["src"] }));
  writeFileSync(path.join(root, "src", "math.ts"), "export function twice(value: number): number { return value * 2; }\n");
  writeFileSync(path.join(root, "src", "main.ts"), "import { twice } from './math';\nconst value: string = twice(21);\nconsole.log(twice(2));\n");
  const definition = await executeLsp(root, { operation: "definition", path: "src/main.ts", line: 1, character: 10 });
  assert.equal(definition.status, "PASS", JSON.stringify(definition));
  assert.equal(definition.serverReused, false);
  assert.ok(definition.entries.some((entry) => entry.path === "src/math.ts" && entry.start.line === 1), JSON.stringify(definition));
  const references = await executeLsp(root, { operation: "references", path: "src/main.ts", line: 2, character: 23 });
  assert.equal(references.status, "PASS", JSON.stringify(references));
  assert.equal(references.serverReused, true);
  assert.ok(references.entries.filter((entry) => entry.path === "src/main.ts").length >= 2, JSON.stringify(references));
  const diagnostics = await executeLsp(root, { operation: "diagnostics", path: "src/main.ts" });
  assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
  assert.ok(diagnostics.entries.some((entry) => String(entry.code) === "2322"), JSON.stringify(diagnostics));
  const hover = await executeLsp(root, { operation: "hover", path: "src/main.ts", line: 2, character: 23 });
  assert.equal(hover.status, "PASS", JSON.stringify(hover));
  assert.match(hover.entries?.contents ?? "", /twice|number/u);
  const documentSymbols = await executeLsp(root, { operation: "document_symbols", path: "src/main.ts" });
  assert.equal(documentSymbols.status, "PASS", JSON.stringify(documentSymbols));
  assert.ok(documentSymbols.entries.some((entry) => entry.name === "value"), JSON.stringify(documentSymbols));
  const workspaceSymbols = await executeLsp(root, { operation: "workspace_symbols", path: "src/main.ts", query: "twice" });
  assert.equal(workspaceSymbols.status, "PASS", JSON.stringify(workspaceSymbols));
  assert.ok(workspaceSymbols.entries.some((entry) => entry.name.startsWith("twice")), JSON.stringify(workspaceSymbols));
  const original = readFileSync(path.join(root, "src", "main.ts"), "utf8");
  const rename = await executeLsp(root, { operation: "rename_preview", path: "src/main.ts", line: 2, character: 23, newName: "doubleValue" });
  assert.equal(rename.status, "PASS", JSON.stringify(rename));
  assert.ok(rename.entries.length >= 3, JSON.stringify(rename));
  assert.equal(readFileSync(path.join(root, "src", "main.ts"), "utf8"), original, "rename preview mutated the source");
  assert.equal(lspRuntimeStatus().activeServers, 1);
});

test("Python LSP returns real diagnostics, definitions, and references", { timeout: 60_000 }, async () => {
  const root = fixture("pi-lsp-python-");
  writeFileSync(path.join(root, "pyrightconfig.json"), JSON.stringify({ typeCheckingMode: "strict" }));
  writeFileSync(path.join(root, "util.py"), "def twice(value: int) -> int:\n    return value * 2\n");
  writeFileSync(path.join(root, "main.py"), "from util import twice\nresult: str = twice(21)\nprint(twice(2))\n");
  const definition = await executeLsp(root, { operation: "definition", path: "main.py", line: 2, character: 15 });
  assert.equal(definition.status, "PASS", JSON.stringify(definition));
  assert.ok(definition.entries.some((entry) => entry.path === "util.py" && entry.start.line === 1), JSON.stringify(definition));
  const references = await executeLsp(root, { operation: "references", path: "main.py", line: 2, character: 15 });
  assert.equal(references.status, "PASS", JSON.stringify(references));
  assert.ok(references.entries.some((entry) => entry.path === "util.py"), JSON.stringify(references));
  assert.ok(references.entries.filter((entry) => entry.path === "main.py").length >= 2, JSON.stringify(references));
  const diagnostics = await executeLsp(root, { operation: "diagnostics", path: "main.py" });
  assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
  assert.ok(diagnostics.entries.some((entry) => entry.severity === "Error" && /not assignable|cannot be assigned/u.test(entry.message)), JSON.stringify(diagnostics));
});

test("clangd returns real diagnostics, definitions, and references", { timeout: 60_000 }, async () => {
  const root = fixture("pi-lsp-cpp-");
  writeFileSync(path.join(root, "compile_flags.txt"), "-std=c++17\n");
  writeFileSync(path.join(root, "math.hpp"), "int twice(int value);\n");
  writeFileSync(path.join(root, "main.cpp"), "#include \"math.hpp\"\nint twice(int value) { return value * 2; }\nint main() { const char* bad = twice(21); return twice(2); }\n");
  const definition = await executeLsp(root, { operation: "definition", path: "main.cpp", line: 3, character: 32 });
  assert.equal(definition.status, "PASS", JSON.stringify(definition));
  assert.ok(definition.entries.some((entry) => (entry.path === "main.cpp" && entry.start.line === 2) || (entry.path === "math.hpp" && entry.start.line === 1)), JSON.stringify(definition));
  const references = await executeLsp(root, { operation: "references", path: "main.cpp", line: 3, character: 32 });
  assert.equal(references.status, "PASS", JSON.stringify(references));
  assert.ok(references.entries.length >= 3, JSON.stringify(references));
  const diagnostics = await executeLsp(root, { operation: "diagnostics", path: "main.cpp" });
  assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
  assert.ok(diagnostics.entries.some((entry) => entry.severity === "Error"), JSON.stringify(diagnostics));
});

test("recognized missing Rust and Go servers are PARTIAL for diagnostics/definition/references, and project switching does not leak", { timeout: 60_000 }, async () => {
  const rust = fixture("pi-lsp-rust-");
  writeFileSync(path.join(rust, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  writeFileSync(path.join(rust, "main.rs"), "fn main() {}\n");
  for (const operation of ["diagnostics", "definition", "references"]) {
    const rustResult = await executeLsp(rust, { operation, path: "main.rs", line: 1, character: 4 });
    assert.equal(rustResult.status, "PARTIAL", JSON.stringify(rustResult));
    assert.equal(rustResult.language, "rust");
  }

  const go = fixture("pi-lsp-go-");
  writeFileSync(path.join(go, "go.mod"), "module example.invalid/fixture\n\ngo 1.22\n");
  writeFileSync(path.join(go, "main.go"), "package main\nfunc main() {}\n");
  for (const operation of ["diagnostics", "definition", "references"]) {
    const goResult = await executeLsp(go, { operation, path: "main.go", line: 2, character: 6 });
    assert.equal(goResult.status, "PARTIAL", JSON.stringify(goResult));
    assert.equal(goResult.language, "go");
  }

  const second = fixture("pi-lsp-second-");
  writeFileSync(path.join(second, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(path.join(second, "unique.ts"), "export const onlyHere = 1;\nconsole.log(onlyHere);\n");
  const result = await executeLsp(second, { operation: "definition", path: "unique.ts", line: 2, character: 13 });
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.deepEqual(new Set(result.entries.map((entry) => entry.path)), new Set(["unique.ts"]));
  assert.equal(result.projectRoot, ".");
});

test("server failure is reported and cleanup is explicit", { timeout: 30_000 }, async () => {
  const crash = fixture("pi-lsp-crash-");
  writeFileSync(path.join(crash, "pyrightconfig.json"), "{}\n");
  writeFileSync(path.join(crash, "crash.py"), "value = 1\n");
  const crashed = await executeLsp(crash, { operation: "diagnostics", path: "crash.py" }, { sandboxRunner: "/usr/bin/false" });
  assert.equal(crashed.status, "FAIL", JSON.stringify(crashed));
  assert.match(crashed.error, /language_server_(?:exited|start_failed)/u);

  const root = fixture("pi-lsp-unsupported-");
  writeFileSync(path.join(root, "notes.txt"), "text\n");
  const result = await executeLsp(root, { operation: "diagnostics", path: "notes.txt" });
  assert.equal(result.status, "FAIL");
  assert.equal(result.error, "unsupported_language");
  await shutdownLspServers();
  assert.equal(lspRuntimeStatus().activeServers, 0);
});
