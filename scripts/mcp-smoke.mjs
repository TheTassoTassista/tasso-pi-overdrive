#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || "pi";
const online = process.argv.includes("--online");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-mcp-"));
const provider = path.join(root, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const adapter = path.join(root, "runtime", "mcp", "node_modules", "pi-mcp-adapter", "index.ts");
const server = path.join(root, "tests", "fixtures", "mcp-mutating-server.mjs");
const marker = path.join(temporary, "mutation-marker");
const trace = path.join(temporary, "mcp-trace.jsonl");
const config = path.join(temporary, "mcp.json");
const isolatedAgentDir = path.join(temporary, "agent");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

function runPi({ args, toolArgs, noExtensions = false, timeoutMs = 60000, uiResponse }) {
  return new Promise((resolve) => {
    const cli = [
      ...(noExtensions ? ["--extension", provider, "--extension", adapter, "--mcp-config", config] : ["--extension", provider]),
      "--approve", "--no-session", "--mode", "rpc", "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--tools", "mcp",
      ...args,
    ];
    const child = spawn(pi, cli, {
      cwd: root,
      env: { ...process.env, ...(noExtensions ? { PI_CODING_AGENT_DIR: isolatedAgentDir } : {}), PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_TOOL: "mcp", PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify(toolArgs) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    const answeredUiRequests = new Set();
    let buffer = "";
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = `${stdout}${text}`.slice(-12000);
      buffer += text;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        try {
          if (!line) continue;
          const event = JSON.parse(line);
          events.push(event);
          if (
            uiResponse
            && event.type === "extension_ui_request"
            && event.method === "select"
            && Array.isArray(event.options)
            && event.options.includes(uiResponse)
            && !answeredUiRequests.has(event.id)
          ) {
            answeredUiRequests.add(event.id);
            child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, value: uiResponse })}\n`);
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-6000); });
    child.stdin.write(`${JSON.stringify({ id: "mcp-smoke", type: "prompt", message: "Run the deterministic MCP check." })}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const poll = setInterval(() => {
      if (!events.some((event) => event.type === "agent_settled")) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ code, events, stderr, stdout, cli });
    });
  });
}

try {
  fs.mkdirSync(isolatedAgentDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, `${JSON.stringify({
    settings: { directTools: false, scriptMode: false, approveTools: true, sampling: false, elicitation: false, trace: { enabled: true, file: trace, maxBytes: 65536, maxEvents: 1000 } },
    mcpServers: { local: { command: process.execPath, args: [server, marker], inheritEnv: false, lifecycle: "lazy", exposeResources: false, directTools: false, includeTools: ["mutate"], approveTools: true, trace: true } },
  }, null, 2)}\n`, { mode: 0o600 });

  const gated = await runPi({ args: ["--offline"], toolArgs: { tool: "local_mutate", args: { secretSentinel: "RAW_ARGUMENT_MUST_NOT_APPEAR" } }, noExtensions: true, uiResponse: "Deny" });
  const gateResult = gated.events.find((event) => event.type === "tool_execution_end" && event.toolName === "mcp");
  const gateText = JSON.stringify(gateResult?.result ?? {});
  check("adapter-process-exit", gated.code === 0, gated.code === 0 ? 0 : (gated.stderr || gated.stdout || gated.code));
  check("explicit-mutation-denial-is-enforced", gateResult?.isError === false && /approval|denied|deny/iu.test(gateText), gateResult ? gateText.slice(0, 1000) : { stderr: gated.stderr, stdout: gated.stdout, cli: gated.cli, events: gated.events.map((event) => ({ type: event.type, toolName: event.toolName, error: event.error, result: event.result })).slice(-30) });
  check("blocked-tool-had-no-side-effect", !fs.existsSync(marker), marker);

  const excluded = await runPi({ args: ["--offline"], toolArgs: { tool: "local_hidden_read", args: {} }, noExtensions: true });
  const excludedResult = excluded.events.find((event) => event.type === "tool_execution_end" && event.toolName === "mcp");
  const excludedText = JSON.stringify(excludedResult?.result ?? {});
  check("allowlist-excludes-hidden-tool", excluded.code === 0 && excludedResult?.isError === false && /not found|unknown|unavailable/iu.test(excludedText), excludedResult ? excludedText.slice(0, 1000) : { stderr: excluded.stderr, stdout: excluded.stdout, events: excluded.events.slice(-30) });
  check("excluded-tool-had-no-side-effect", !fs.existsSync(marker), marker);
  const traceText = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "";
  check("trace-is-metadata-only", traceText.includes('"method":"tools/list"') && !traceText.includes("RAW_ARGUMENT_MUST_NOT_APPEAR") && !traceText.includes("mutation ran"), traceText ? "metadata fields only; raw sentinel/result absent" : "trace missing");

  if (online) {
    const read = await runPi({ args: [], toolArgs: { tool: "context7_resolve-library-id", args: { libraryName: "typescript", query: "TypeScript language service definition API" } }, timeoutMs: 90000 });
    const readResult = read.events.find((event) => event.type === "tool_execution_end" && event.toolName === "mcp");
    const readText = JSON.stringify(readResult?.result ?? {});
    const statusEvents = read.events.filter((event) => event.type === "extension_ui_request" && event.statusKey === "mcp").map((event) => event.statusText);
    check("context7-process-exit", read.code === 0, read.code === 0 ? 0 : (read.stderr || read.stdout || read.code));
    check("context7-started-lazily", statusEvents.some((value) => typeof value === "string" && value.includes("0/1")) && statusEvents.some((value) => typeof value === "string" && value.includes("connecting")), statusEvents);
    check("context7-real-read", readResult?.isError === false && readText.includes("/microsoft/typescript"), readText.slice(0, 1200));
  }
} catch (error) {
  check("mcp-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  if (process.env.PI_OVERDRIVE_KEEP_TEST_ARTIFACTS !== "1") fs.rmSync(temporary, { recursive: true, force: true });
}

const status = results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, online, temporary: process.env.PI_OVERDRIVE_KEEP_TEST_ARTIFACTS === "1" ? temporary : undefined, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
