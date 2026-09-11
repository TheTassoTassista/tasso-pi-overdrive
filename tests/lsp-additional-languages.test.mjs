import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeLsp, shutdownLspServers } from "../lib/lsp-manager.mjs";

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

test("JavaScript fixture returns real cross-file definition and diagnostics", { timeout: 60_000 }, async () => {
  const root = fixture("pi-lsp-js-");
  writeFileSync(path.join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true }, include: ["*.js"] }));
  writeFileSync(path.join(root, "util.js"), "export function twice(value) { return value * 2; }\n");
  writeFileSync(path.join(root, "main.js"), "import { twice } from './util.js';\n/** @type {string} */\nconst bad = twice(2);\n");
  const definition = await executeLsp(root, { operation: "definition", path: "main.js", line: 3, character: 14 });
  assert.equal(definition.status, "PASS", JSON.stringify(definition));
  assert.ok(definition.entries.some((entry) => entry.path === "util.js"), JSON.stringify(definition));
  const diagnostics = await executeLsp(root, { operation: "diagnostics", path: "main.js" });
  assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
  assert.ok(diagnostics.entries.some((entry) => entry.severity === "Error"), JSON.stringify(diagnostics));
});

test("C fixture returns real definition and diagnostics", { timeout: 60_000 }, async () => {
  const root = fixture("pi-lsp-c-");
  writeFileSync(path.join(root, "compile_flags.txt"), "-std=c17\n");
  writeFileSync(path.join(root, "math.h"), "int twice(int value);\n");
  writeFileSync(path.join(root, "main.c"), "#include \"math.h\"\nint twice(int value) { return value * 2; }\nint main(void) {\n  int value = twice(21);\n  int broken = ;\n  return value;\n}\n");
  const definition = await executeLsp(root, { operation: "definition", path: "main.c", line: 4, character: 16 });
  assert.equal(definition.status, "PASS", JSON.stringify(definition));
  assert.ok(definition.entries.some((entry) => ["main.c", "math.h"].includes(entry.path)), JSON.stringify(definition));
  const diagnostics = await executeLsp(root, { operation: "diagnostics", path: "main.c" });
  assert.equal(diagnostics.status, "PASS", JSON.stringify(diagnostics));
  assert.ok(diagnostics.entries.some((entry) => entry.severity === "Error"), JSON.stringify(diagnostics));
});

test("HTML, CSS, and YAML fixtures expose document symbols", { timeout: 60_000 }, async () => {
  const fixtures = [
    { language: "html", file: "index.html", text: "<!doctype html>\n<html><body><main id=\"content\"><h1>Title</h1></main></body></html>\n", symbol: /content|h1|Title/u },
    { language: "css", file: "style.css", text: ".card { color: red; }\n", symbol: /card/u },
    { language: "yaml", file: "service.yaml", text: "service:\n  name: demo\n", symbol: /service/u },
  ];
  for (const item of fixtures) {
    const root = fixture(`pi-lsp-${item.language}-`);
    writeFileSync(path.join(root, item.file), item.text);
    const symbols = await executeLsp(root, { operation: "document_symbols", path: item.file });
    assert.equal(symbols.status, "PASS", `${item.language}: ${JSON.stringify(symbols)}`);
    assert.ok(symbols.entries.some((entry) => item.symbol.test(entry.name)), `${item.language}: ${JSON.stringify(symbols)}`);
  }
});

test("JSON fixture exposes document symbols", { timeout: 30_000 }, async () => {
  const root = fixture("pi-lsp-json-");
  writeFileSync(path.join(root, "package.json"), "{\"name\":\"demo\",\"nested\":{\"enabled\":true}}\n");
  const symbols = await executeLsp(root, { operation: "document_symbols", path: "package.json" });
  assert.equal(symbols.status, "PASS", JSON.stringify(symbols));
  assert.ok(symbols.entries.some((entry) => /name|nested/u.test(entry.name)), JSON.stringify(symbols));
});
