#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pi = process.env.PI_BIN || "pi";
const model = process.env.PI_SMOKE_MODEL || "openai-codex/gpt-5.6-luna";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-runtime-"));
const repo = path.join(root, "repo");
const results = [];

function check(name, condition, detail) {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail });
}

function toolText(event) {
  return (event?.result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

async function runPi() {
  const tools = ["fffind", "ffgrep", "ast_grep_run", "semantic_nav", "web_fetch"];
  const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--model", model, "--thinking", "low", "--tools", tools.join(",")], {
    cwd: repo,
    env: { ...process.env, XDG_STATE_HOME: path.join(root, "state") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  const waiters = new Set();
  let buffer = "";
  let stderr = "";
  const receive = (event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { receive(JSON.parse(line)); } catch { receive({ type: "invalid_json" }); }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000); });
  const waitFor = (predicate, label, timeoutMs) => {
    const prior = events.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${label}. ${stderr}`)); }, timeoutMs) };
      waiters.add(waiter);
    });
  };
  const prompt = [
    "This is a deterministic tool integration audit. Call every named tool exactly once, in this exact order, using exactly these inputs; never simulate a result and do not use another tool:",
    "1. fffind {\"pattern\":\"defs\",\"path\":\"src/**\",\"limit\":10}",
    "2. ffgrep {\"pattern\":\"function add\",\"path\":\"src/\",\"limit\":10}",
    "3. ast_grep_run {\"pattern\":\"add($$$ARGS)\",\"lang\":\"typescript\",\"path\":\"src\",\"max_results\":10}",
    "4. semantic_nav {\"operation\":\"diagnostics\",\"path\":\"src/use.ts\"}",
    "5. semantic_nav {\"operation\":\"definition\",\"path\":\"src/use.ts\",\"line\":1,\"character\":10}",
    "6. semantic_nav {\"operation\":\"references\",\"path\":\"src/use.ts\",\"line\":2,\"character\":21}",
    "7. web_fetch {\"url\":\"https://example.com/\",\"raw\":false}",
    "After all seven tools finish, answer only AUDIT_DONE.",
  ].join("\n");
  child.stdin.write(`${JSON.stringify({ id: "audit", type: "prompt", message: prompt })}\n`);
  const accepted = await waitFor((event) => event.type === "response" && event.id === "audit", "prompt acceptance", 30000);
  await waitFor((event) => event.type === "agent_settled", "agent settlement", 12 * 60 * 1000);
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  return { accepted, events, stderr, tools };
}

try {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "defs.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
  fs.writeFileSync(path.join(repo, "src", "use.ts"), "import { add } from './defs.js';\nconst bad: string = add(1, 2);\nconsole.log(add(3, 4));\n");
  fs.writeFileSync(path.join(repo, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true }, include: ["src/**/*.ts"] }, null, 2)}\n`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Pi Runtime Audit"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "pi-runtime@invalid"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "runtime fixture"], { cwd: repo });

  const invocation = await runPi();
  check("pi-rpc-prompt-accepted", invocation.accepted.success === true, invocation.accepted.success);
  const ends = invocation.events.filter((event) => event.type === "tool_execution_end");
  const byName = new Map(ends.map((event) => [event.toolName, event]));
  const semanticEvents = ends.filter((event) => event.toolName === "semantic_nav");
  check("exact-tool-set-executed", invocation.tools.every((name) => byName.has(name)) && semanticEvents.length === 3 && ends.filter((event) => event.toolName !== "semantic_nav" && invocation.tools.includes(event.toolName)).length === invocation.tools.length - 1, ends.map((event) => event.toolName));
  const successful = (name) => byName.has(name) && byName.get(name).isError !== true;
  check("fff-file-search-runtime", successful("fffind") && /defs\.ts/u.test(toolText(byName.get("fffind"))), toolText(byName.get("fffind")).slice(0, 500));
  check("fff-content-search-runtime", successful("ffgrep") && /function add/u.test(toolText(byName.get("ffgrep"))), toolText(byName.get("ffgrep")).slice(0, 500));
  check("ast-grep-runtime", successful("ast_grep_run") && Number(byName.get("ast_grep_run")?.result?.details?.total_matches) >= 2, byName.get("ast_grep_run")?.result?.details);
  const semanticByOperation = new Map(semanticEvents.map((event) => [event.result?.details?.operation, event]));
  const diagnosticsEvent = semanticByOperation.get("diagnostics");
  const diagnostics = diagnosticsEvent?.result?.details;
  check("typescript-diagnostics-runtime", diagnosticsEvent?.isError !== true && diagnostics?.status === "PASS" && diagnostics?.entries?.some((entry) => String(entry.code) === "2322"), diagnostics);
  const definitionEvent = semanticByOperation.get("definition");
  const definitions = definitionEvent?.result?.details;
  check("typescript-definition-runtime", definitionEvent?.isError !== true && definitions?.status === "PASS" && definitions?.entries?.some((entry) => entry.path === "src/defs.ts"), definitions);
  const referencesEvent = semanticByOperation.get("references");
  const references = referencesEvent?.result?.details;
  check("typescript-references-runtime", referencesEvent?.isError !== true && references?.status === "PASS" && references?.count >= 3, references);
  check("web-fetch-runtime", successful("web_fetch") && /Example Domain/iu.test(toolText(byName.get("web_fetch"))), toolText(byName.get("web_fetch")).slice(0, 500));
} catch (error) {
  check("runtime-capability-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const status = results.length >= 9 && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, model, results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
