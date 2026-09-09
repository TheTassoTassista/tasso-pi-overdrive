import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { typescriptDefinition, typescriptDiagnostics, typescriptReferences } from "../lib/typescript-navigation.mjs";

test("pinned TypeScript service returns real diagnostics, definitions, and references", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ts-nav-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true }, include: ["src"] }));
    writeFileSync(path.join(root, "src", "math.ts"), "export function twice(value: number): number { return value * 2; }\n");
    writeFileSync(path.join(root, "src", "main.ts"), "import { twice } from './math.js';\nconst answer: string = twice(21);\nconsole.log(twice(2));\n");
    const definitions = typescriptDefinition(root, "src/main.ts", 2, 26);
    assert.equal(definitions.some((entry) => entry.file === "src/math.ts" && entry.line === 1), true, JSON.stringify(definitions));
    const references = typescriptReferences(root, "src/main.ts", 2, 26);
    assert.equal(references.some((entry) => entry.file === "src/math.ts"), true, JSON.stringify(references));
    assert.equal(references.filter((entry) => entry.file === "src/main.ts").length >= 2, true, JSON.stringify(references));
    const diagnostics = typescriptDiagnostics(root, "src/main.ts");
    assert.equal(diagnostics.some((entry) => entry.code === 2322), true, JSON.stringify(diagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
