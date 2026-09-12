import test, { after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("managed rust-analyzer supports read-only cross-file semantic navigation", { timeout: 120_000 }, async () => {
  const rust = fixture("pi-lsp-rust-");
  mkdirSync(path.join(rust, "src"));
  writeFileSync(path.join(rust, "Cargo.toml"), "[package]\nname = \"rust_fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n");
  writeFileSync(path.join(rust, "src", "lib.rs"), "pub fn twice(value: i32) -> i32 { value * 2 }\n");
  writeFileSync(path.join(rust, "src", "main.rs"), "use rust_fixture::twice;\n\nfn main() {\n    let bad: &str = twice(21);\n    println!(\"{}\", twice(2));\n}\n");
  const definition = await executeLsp(rust, { operation: "definition", path: "src/main.rs", line: 4, character: 22 });
  assert.equal(definition.status, "PASS", JSON.stringify(definition));
  assert.ok(definition.entries.some((entry) => entry.path === "src/lib.rs" && entry.start.line === 1), JSON.stringify(definition));
  const references = await executeLsp(rust, { operation: "references", path: "src/main.rs", line: 4, character: 22 });
  assert.equal(references.status, "PASS", JSON.stringify(references));
  assert.ok(references.entries.some((entry) => entry.path === "src/lib.rs"), JSON.stringify(references));
  assert.ok(references.entries.filter((entry) => entry.path === "src/main.rs").length >= 2, JSON.stringify(references));
  const diagnostics = await executeLsp(rust, { operation: "diagnostics", path: "src/main.rs" });
  assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
  assert.ok(diagnostics.entries.some((entry) => entry.severity === "Error"), JSON.stringify(diagnostics));
  const hover = await executeLsp(rust, { operation: "hover", path: "src/main.rs", line: 4, character: 22 });
  assert.equal(hover.status, "PASS", JSON.stringify(hover));
  assert.match(hover.entries?.contents ?? "", /twice|i32/u);
  const documentSymbols = await executeLsp(rust, { operation: "document_symbols", path: "src/main.rs" });
  assert.equal(documentSymbols.status, "PASS", JSON.stringify(documentSymbols));
  assert.ok(documentSymbols.entries.some((entry) => entry.name === "main"), JSON.stringify(documentSymbols));
  const workspaceSymbols = await executeLsp(rust, { operation: "workspace_symbols", path: "src/main.rs", query: "twice" });
  assert.equal(workspaceSymbols.status, "PASS", JSON.stringify(workspaceSymbols));
  assert.ok(workspaceSymbols.entries.some((entry) => entry.name === "twice" && entry.location?.path === "src/lib.rs"), JSON.stringify(workspaceSymbols));
  const originalLibrary = readFileSync(path.join(rust, "src", "lib.rs"), "utf8");
  const originalMain = readFileSync(path.join(rust, "src", "main.rs"), "utf8");
  const rename = await executeLsp(rust, { operation: "rename_preview", path: "src/main.rs", line: 4, character: 22, newName: "double_value" });
  assert.equal(rename.status, "PASS", JSON.stringify(rename));
  assert.ok(rename.entries.length >= 3, JSON.stringify(rename));
  assert.equal(readFileSync(path.join(rust, "src", "lib.rs"), "utf8"), originalLibrary, "rename preview mutated the Rust library");
  assert.equal(readFileSync(path.join(rust, "src", "main.rs"), "utf8"), originalMain, "rename preview mutated the Rust caller");
});

test("managed gopls supports read-only cross-package semantic navigation", { timeout: 120_000 }, async () => {
  const go = fixture("pi-lsp-go-");
  mkdirSync(path.join(go, "mathx"));
  writeFileSync(path.join(go, "go.mod"), "module example.invalid/fixture\n\ngo 1.26\n");
  writeFileSync(path.join(go, "mathx", "mathx.go"), "package mathx\n\nfunc Twice(value int) int { return value * 2 }\n");
  writeFileSync(path.join(go, "main.go"), "package main\n\nimport (\n    \"fmt\"\n    \"example.invalid/fixture/mathx\"\n)\n\nfunc main() {\n    var bad string = mathx.Twice(21)\n    fmt.Println(mathx.Twice(2), bad)\n}\n");
  const definition = await executeLsp(go, { operation: "definition", path: "main.go", line: 9, character: 30 });
  assert.equal(definition.status, "PASS", JSON.stringify(definition));
  assert.ok(definition.entries.some((entry) => entry.path === "mathx/mathx.go" && entry.start.line === 3), JSON.stringify(definition));
  const references = await executeLsp(go, { operation: "references", path: "main.go", line: 9, character: 30 });
  assert.equal(references.status, "PASS", JSON.stringify(references));
  assert.ok(references.entries.some((entry) => entry.path === "mathx/mathx.go"), JSON.stringify(references));
  assert.ok(references.entries.filter((entry) => entry.path === "main.go").length >= 2, JSON.stringify(references));
  const diagnostics = await executeLsp(go, { operation: "diagnostics", path: "main.go" });
  assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
  assert.ok(diagnostics.entries.some((entry) => entry.severity === "Error"), JSON.stringify(diagnostics));
  const hover = await executeLsp(go, { operation: "hover", path: "main.go", line: 9, character: 30 });
  assert.equal(hover.status, "PASS", JSON.stringify(hover));
  assert.match(hover.entries?.contents ?? "", /Twice|int/u);
  const documentSymbols = await executeLsp(go, { operation: "document_symbols", path: "main.go" });
  assert.equal(documentSymbols.status, "PASS", JSON.stringify(documentSymbols));
  assert.ok(documentSymbols.entries.some((entry) => entry.name === "main"), JSON.stringify(documentSymbols));
  const workspaceSymbols = await executeLsp(go, { operation: "workspace_symbols", path: "main.go", query: "Twice" });
  assert.equal(workspaceSymbols.status, "PASS", JSON.stringify(workspaceSymbols));
  assert.ok(workspaceSymbols.entries.some((entry) => entry.name === "Twice" && entry.location?.path === "mathx/mathx.go"), JSON.stringify(workspaceSymbols));
  const originalLibrary = readFileSync(path.join(go, "mathx", "mathx.go"), "utf8");
  const originalMain = readFileSync(path.join(go, "main.go"), "utf8");
  const rename = await executeLsp(go, { operation: "rename_preview", path: "main.go", line: 9, character: 30, newName: "Double" });
  assert.equal(rename.status, "PASS", JSON.stringify(rename));
  assert.ok(rename.entries.length >= 3, JSON.stringify(rename));
  assert.equal(readFileSync(path.join(go, "mathx", "mathx.go"), "utf8"), originalLibrary, "rename preview mutated the Go library");
  assert.equal(readFileSync(path.join(go, "main.go"), "utf8"), originalMain, "rename preview mutated the Go caller");
});

test("pinned Bash LSP provides sandboxed cross-file semantics despite PATH shadowing", { timeout: 120_000 }, async () => {
  await shutdownLspServers();
  const before = lspRuntimeStatus();
  assert.equal(before.activeServers, 0);

  const root = fixture("pi-lsp-bash-");
  const files = {
    ".shellcheckrc": "shell=bash\n",
    "lib.sh": "#!/usr/bin/env bash\n\ndouble_value() {\n    local value=\"$1\"\n    printf '%s\\n' \"$((value * 2))\"\n}\n",
    "main.sh": "#!/usr/bin/env bash\n\nsource ./lib.sh\n\nresult=\"$(double_value 21)\"\nprintf '%s\\n' \"$result\"\n",
    "helper.bash": "#!/usr/bin/env bash\n\nhelper_value() {\n    printf '%s\\n' \"$1\"\n}\n",
    "broken.sh": "#!/usr/bin/env bash\n\nsource ./missing.sh\n",
  };
  for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(root, name), contents);
  const originals = new Map(Object.keys(files).map((name) => [name, readFileSync(path.join(root, name))]));

  const shadow = fixture("pi-lsp-bash-shadow-");
  const marker = path.join(shadow, "path-shadow-ran");
  const fakeServer = path.join(shadow, "bash-language-server");
  writeFileSync(fakeServer, `#!/bin/sh\nprintf shadow > ${JSON.stringify(marker)}\nexit 99\n`);
  chmodSync(fakeServer, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shadow}${path.delimiter}${previousPath ?? ""}`;

  try {
    const policy = lspRuntimeStatus().languages.bash;
    assert.equal(policy.version, "bash-language-server@5.6.0");
    assert.equal(policy.binaryPath, path.join(before.runtimeRoot, "node_modules", ".bin", "bash-language-server"));
    assert.equal(policy.source, "runtime/lsp/package-lock.json");
    assert.equal(policy.pinned, true);
    assert.equal(policy.allowed, true);

    const definition = await executeLsp(root, { operation: "definition", path: "main.sh", line: 5, character: 15 });
    assert.equal(definition.status, "PASS", JSON.stringify(definition));
    assert.equal(definition.backend, "bash-language-server@5.6.0");
    assert.equal(definition.serverReused, false);
    assert.equal(definition.sandbox, "bubblewrap-read-only-no-network");
    assert.ok(definition.entries.some((entry) => entry.path === "lib.sh" && entry.start.line === 3), JSON.stringify(definition));
    assert.equal(lspRuntimeStatus().starts, before.starts + 1, "Bash server did not start lazily exactly once");
    assert.equal(lspRuntimeStatus().activeServers, 1);

    const references = await executeLsp(root, { operation: "references", path: "main.sh", line: 5, character: 15 });
    assert.equal(references.status, "PASS", JSON.stringify(references));
    assert.equal(references.serverReused, true);
    assert.ok(references.entries.some((entry) => entry.path === "lib.sh"), JSON.stringify(references));
    assert.ok(references.entries.some((entry) => entry.path === "main.sh"), JSON.stringify(references));

    const hover = await executeLsp(root, { operation: "hover", path: "main.sh", line: 5, character: 15 });
    assert.equal(hover.status, "PASS", JSON.stringify(hover));
    assert.match(hover.entries?.contents ?? "", /double_value|lib\.sh/u);

    const documentSymbols = await executeLsp(root, { operation: "document_symbols", path: "lib.sh" });
    assert.equal(documentSymbols.status, "PASS", JSON.stringify(documentSymbols));
    assert.ok(documentSymbols.entries.some((entry) => entry.name === "double_value"), JSON.stringify(documentSymbols));

    const workspaceSymbols = await executeLsp(root, { operation: "workspace_symbols", path: "main.sh", query: "double_value" });
    assert.equal(workspaceSymbols.status, "PASS", JSON.stringify(workspaceSymbols));
    assert.ok(workspaceSymbols.entries.some((entry) => entry.name === "double_value" && entry.location?.path === "lib.sh"), JSON.stringify(workspaceSymbols));

    const rename = await executeLsp(root, { operation: "rename_preview", path: "main.sh", line: 5, character: 15, newName: "twice_value" });
    assert.equal(rename.status, "PASS", JSON.stringify(rename));
    assert.ok(rename.entries.some((entry) => entry.path === "lib.sh" && entry.newText === "twice_value"), JSON.stringify(rename));
    assert.ok(rename.entries.some((entry) => entry.path === "main.sh" && entry.newText === "twice_value"), JSON.stringify(rename));

    const bashExtension = await executeLsp(root, { operation: "document_symbols", path: "helper.bash" });
    assert.equal(bashExtension.status, "PASS", JSON.stringify(bashExtension));
    assert.equal(bashExtension.language, "bash");
    assert.ok(bashExtension.entries.some((entry) => entry.name === "helper_value"), JSON.stringify(bashExtension));

    const diagnostics = await executeLsp(root, { operation: "diagnostics", path: "broken.sh" });
    assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
    assert.ok(diagnostics.entries.some((entry) => entry.source === "bash-language-server" && /Source command could not be analyzed/u.test(entry.message)), JSON.stringify(diagnostics));

    for (const [name, original] of originals) {
      assert.deepEqual(readFileSync(path.join(root, name)), original, `${name} changed during read-only Bash LSP operations`);
    }
  } finally {
    process.env.PATH = previousPath;
    await shutdownLspServers();
  }

  assert.equal(lspRuntimeStatus().activeServers, 0);
  assert.equal(existsSync(marker), false, "PATH-shadowed bash-language-server was executed");
});

test("project switching does not leak and an arbitrary PATH server remains rejected", { timeout: 60_000 }, async () => {
  const second = fixture("pi-lsp-second-");
  writeFileSync(path.join(second, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(path.join(second, "unique.ts"), "export const onlyHere = 1;\nconsole.log(onlyHere);\n");
  const result = await executeLsp(second, { operation: "definition", path: "unique.ts", line: 2, character: 13 });
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.deepEqual(new Set(result.entries.map((entry) => entry.path)), new Set(["unique.ts"]));
  assert.equal(result.projectRoot, ".");

  const unpinnedBin = fixture("pi-lsp-unpinned-");
  const jdtls = path.join(unpinnedBin, "jdtls");
  writeFileSync(jdtls, "#!/bin/sh\nexit 0\n");
  chmodSync(jdtls, 0o755);
  const java = fixture("pi-lsp-java-");
  writeFileSync(path.join(java, "Main.java"), "class Main {}\n");
  const previousPath = process.env.PATH;
  process.env.PATH = `${unpinnedBin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const rejected = await executeLsp(java, { operation: "diagnostics", path: "Main.java" });
    assert.equal(rejected.status, "PARTIAL", JSON.stringify(rejected));
    assert.equal(rejected.error, "language_server_unpinned", JSON.stringify(rejected));
    assert.equal(lspRuntimeStatus().languages.java.runtimeStatus, "REJECTED_UNPINNED");
  } finally {
    process.env.PATH = previousPath;
  }
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
