#!/usr/bin/node
import fs from "node:fs";
import readline from "node:readline";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

let context;
let typescript;

function createContext() {
  const sandbox = Object.create(null);
  const next = vm.createContext(sandbox, {
    name: "pi-overdrive-eval",
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(`
    (() => {
      let output = [];
      let outputChars = 0;
      let outputTruncated = false;
      let maximumOutput = 262144;
      const render = (value) => {
        if (typeof value === "string") return value;
        if (typeof value === "bigint") return value.toString() + "n";
        if (typeof value === "undefined") return "undefined";
        try {
          const seen = new WeakSet();
          const json = JSON.stringify(value, (_key, item) => {
            if (typeof item === "bigint") return item.toString() + "n";
            if (typeof item === "object" && item !== null) {
              if (seen.has(item)) return "[Circular]";
              seen.add(item);
            }
            return item;
          });
          return json === undefined ? String(value) : json;
        } catch { try { return String(value); } catch { return "<unrenderable>"; } }
      };
      const append = (...values) => {
        const text = values.map(render).join(" ") + "\\n";
        const remaining = Math.max(0, maximumOutput - outputChars);
        if (remaining > 0) output.push(text.slice(0, remaining));
        outputChars += Math.min(text.length, remaining);
        if (text.length > remaining) outputTruncated = true;
      };
      Object.defineProperty(globalThis, "console", { value: Object.freeze({ log: append, info: append, warn: append, error: append }), writable: false, configurable: false });
      Object.defineProperty(globalThis, "display", { value: append, writable: false, configurable: false });
      for (const name of ["process", "require", "module", "Buffer", "fetch", "WebAssembly", "SharedArrayBuffer"]) {
        Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
      }
      Object.defineProperty(globalThis, "__overdriveBegin", { value: (maximum) => { output = []; outputChars = 0; outputTruncated = false; maximumOutput = maximum; }, writable: false, configurable: false });
      Object.defineProperty(globalThis, "__overdriveDrain", { value: () => ({ stdout: output.join(""), outputTruncated }), writable: false, configurable: false });
      Object.defineProperty(globalThis, "__overdriveRender", { value: (value, maximum) => { const text = render(value); return { value: text.slice(0, maximum), valueTruncated: text.length > maximum }; }, writable: false, configurable: false });
    })();
  `, { filename: "overdrive-bootstrap.js" }).runInContext(next);
  return next;
}

function resetContext() {
  context = createContext();
}

async function loadTypeScript() {
  if (typescript) return typescript;
  const candidate = "/workspace/typescript.js";
  if (!fs.statSync(candidate).isFile()) throw new Error("EVAL_TYPESCRIPT_UNAVAILABLE");
  const imported = await import(pathToFileURL(candidate).href);
  typescript = imported.default ?? imported;
  return typescript;
}

async function prepareCode(code, dialect) {
  if (dialect !== "typescript") return code;
  const ts = await loadTypeScript();
  const result = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None, isolatedModules: true, ignoreDeprecations: "6.0" },
    reportDiagnostics: true,
    fileName: "overdrive-eval.ts",
  });
  const blocking = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (blocking.length) throw new Error(`EVAL_TYPESCRIPT_SYNTAX:${blocking[0].code}`);
  return result.outputText;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function execute(request) {
  const started = process.hrtime.bigint();
  context.__overdriveBegin(request.maxOutputBytes);
  try {
    const source = await prepareCode(request.code, request.dialect);
    const script = new vm.Script(source, { filename: `<overdrive-${request.dialect}-eval>` });
    const result = script.runInContext(context, { breakOnSigint: true });
    const rendered = context.__overdriveRender(result, request.maxValueChars);
    const output = context.__overdriveDrain();
    return { status: "PASS", stderr: "", ...output, ...rendered, durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
  } catch (error) {
    const output = context.__overdriveDrain();
    const errorType = error instanceof Error ? error.name : "Error";
    const raw = `${errorType}: ${error instanceof Error ? error.message : String(error)}`;
    return { status: "ERROR", stderr: "", ...output, value: "", valueTruncated: false, errorType, error: raw.slice(0, request.maxValueChars), durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
  }
}

resetContext();
emit({ type: "ready", language: "javascript", protocol: 1 });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on("line", (line) => {
  queue = queue.then(async () => {
    try {
      const request = JSON.parse(line);
      if (!request || request.op !== "execute" || typeof request.id !== "string" || typeof request.code !== "string" || !["javascript", "typescript"].includes(request.dialect)) throw new Error("EVAL_REQUEST_INVALID");
      emit({ type: "result", id: request.id, ...(await execute(request)) });
    } catch (error) {
      emit({ type: "protocol_error", error: error instanceof Error ? error.name : "Error" });
    }
  });
});
