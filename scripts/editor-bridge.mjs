#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  EditorAcpBridge,
  EditorReceiptJournal,
  attestPiBinary,
  findExecutable,
  parseEditorFrame,
  readEditorBridgePolicy,
  resolveEditorRoot,
} from "../lib/editor-bridge.mjs";

function parseArgs(argv) {
  const result = { cwd: process.cwd(), piBin: undefined, stateDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd" || argument === "--pi-bin" || argument === "--state-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing value for ${argument}`);
      result[argument === "--cwd" ? "cwd" : argument === "--pi-bin" ? "piBin" : "stateDir"] = value;
      index += 1;
    } else if (argument === "--help") {
      process.stderr.write("Usage: editor-bridge.mjs [--cwd ABSOLUTE_PROJECT] [--pi-bin ABSOLUTE_PI] [--state-dir ABSOLUTE_STATE]\n");
      process.exit(0);
    } else throw new Error(`unsupported argument: ${argument}`);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
const policy = readEditorBridgePolicy();
const root = resolveEditorRoot(path.resolve(options.cwd));
const piBin = options.piBin ? fs.realpathSync(path.resolve(options.piBin)) : findExecutable("pi");
const identity = attestPiBinary(piBin, policy);
const journal = new EditorReceiptJournal({ policy, stateDir: options.stateDir, environment: process.env });
let writeTail = Promise.resolve();
const send = (message) => {
  const line = `${JSON.stringify(message)}\n`;
  writeTail = writeTail.then(() => new Promise((resolve, reject) => process.stdout.write(line, (error) => error ? reject(error) : resolve())));
  return writeTail;
};
const bridge = new EditorAcpBridge({ policy, root, identity, journal, environment: process.env, send });
let buffer = "";
let stopping;

async function stop(status) {
  if (!stopping) stopping = bridge.dispose(status).finally(() => { process.exitCode = 0; });
  return stopping;
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (Buffer.byteLength(buffer) > policy.maxFrameBytes && !buffer.includes("\n")) {
    void send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "editor_frame_size_invalid" } }).finally(() => stop("frame_limit"));
    return;
  }
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/u, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { void bridge.receive(parseEditorFrame(line, policy)); }
    catch (error) { void send({ jsonrpc: "2.0", id: null, error: { code: error?.rpcCode ?? -32700, message: error?.code ?? "editor_frame_invalid" } }); }
  }
});
process.stdin.on("end", () => { void stop("transport_closed"); });
process.stdin.on("error", () => { void stop("transport_error"); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop(signal.toLowerCase()); });
process.on("uncaughtException", () => { void stop("uncaught_exception").finally(() => { process.exitCode = 1; }); });
process.on("unhandledRejection", () => { void stop("unhandled_rejection").finally(() => { process.exitCode = 1; }); });
