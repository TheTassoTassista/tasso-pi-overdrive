#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || "pi";
const credentialed = process.argv.includes("--credentialed");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overdrive-web-"));
const isolatedConfigHome = path.join(temporary, "config");
const providerExtension = path.join(root, "tests", "fixtures", "deterministic-single-tool-provider.ts");
const results = [];
const check = (name, condition, detail) => results.push({ name, status: condition ? "PASS" : "FAIL", detail });

function textOf(event) {
  return (event?.result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

function credentialAvailability() {
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const configPath = path.join(configRoot, "rpiv-web-tools", "config.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
  return {
    brave: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim() || config?.apiKeys?.brave?.trim() || config?.apiKey?.trim()),
    perplexity: Boolean(process.env.PERPLEXITY_API_KEY?.trim() || config?.apiKeys?.perplexity?.trim()),
  };
}

function runPi(tool, toolArgs, { isolated = true, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const environment = { ...process.env, PI_OVERDRIVE_TOOL_AUDIT_KEY: "audit-only", PI_OVERDRIVE_AUDIT_TOOL: tool, PI_OVERDRIVE_AUDIT_TOOL_ARGS: JSON.stringify(toolArgs) };
    if (isolated) {
      environment.XDG_CONFIG_HOME = isolatedConfigHome;
      delete environment.BRAVE_SEARCH_API_KEY;
      delete environment.PERPLEXITY_API_KEY;
      delete environment.WEB_SEARCH_PROVIDER;
    }
    const child = spawn(pi, ["--extension", providerExtension, "--offline", "--approve", "--no-session", "--mode", "rpc", "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--tools", tool], {
      cwd: root,
      env: environment,
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
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-6000); });
    child.stdin.write(`${JSON.stringify({ id: `web-${tool}`, type: "prompt", message: `Run the deterministic ${tool} check.` })}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const poll = setInterval(() => {
      if (!events.some((event) => event.type === "agent_settled")) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      const result = events.find((event) => event.type === "tool_execution_end" && event.toolName === tool);
      resolve({ code, result, stderr });
    });
  });
}

function runStatusCommand() {
  return new Promise((resolve) => {
    const environment = { ...process.env, XDG_CONFIG_HOME: isolatedConfigHome };
    delete environment.BRAVE_SEARCH_API_KEY;
    delete environment.PERPLEXITY_API_KEY;
    delete environment.WEB_SEARCH_PROVIDER;
    const child = spawn(pi, ["--extension", providerExtension, "--offline", "--approve", "--no-session", "--mode", "rpc", "--provider", "pi-overdrive-tool-audit", "--model", "single-tool-driver", "--api-key", "audit-only", "--no-tools"], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-3000); });
    child.stdin.write(`${JSON.stringify({ id: "web-status", type: "prompt", message: "/web-status" })}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), 15000);
    const poll = setInterval(() => {
      if (!events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.includes("Default:"))) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      const notification = events.find((event) => event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" && event.message.includes("Default:"));
      resolve({ code, notification, stderr });
    });
  });
}

try {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const installedPackage = JSON.parse(fs.readFileSync(path.join(agentDirectory, "npm", "node_modules", "@juicesharp", "rpiv-web-tools", "package.json"), "utf8"));
  check("pinned-provider-runtime-loads", installedPackage.version === "2.9.0", { package: "@juicesharp/rpiv-web-tools", version: installedPackage.version });

  const isolatedConfigDir = path.join(isolatedConfigHome, "rpiv-web-tools");
  fs.mkdirSync(isolatedConfigDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(root, "config", "web-tools.json"), path.join(isolatedConfigDir, "config.json"));
  fs.chmodSync(path.join(isolatedConfigDir, "config.json"), 0o600);

  const statusCommand = await runStatusCommand();
  const statusText = statusCommand.notification?.message ?? "";
  check("web-status-is-key-free-and-accurate", statusCommand.code === 0 && statusText.includes("Default: Brave") && statusText.includes("Fallback: Perplexity") && statusText.includes("Brave: missing credential") && statusText.includes("Perplexity: missing credential") && !/api[_ -]?key\s*[:=]\s*\S+/iu.test(statusText), statusText || statusCommand.stderr);

  const fetched = await runPi("web_fetch", { url: "https://example.com/", raw: false });
  check("web-fetch-process-exit", fetched.code === 0, fetched.code === 0 ? 0 : fetched.stderr);
  check("web-fetch-real-public-page", fetched.result?.isError === false && /Example Domain/iu.test(textOf(fetched.result)), fetched.result?.isError === false ? "Example Domain received" : textOf(fetched.result).slice(0, 500));

  const safeFetched = await runPi("safe_web_fetch", { url: "https://example.com/", raw: false });
  check("safe-web-fetch-process-exit", safeFetched.code === 0, safeFetched.code === 0 ? 0 : safeFetched.stderr);
  check("safe-web-fetch-real-public-page", safeFetched.result?.isError === false && /Example Domain/iu.test(textOf(safeFetched.result)) && safeFetched.result?.result?.details?.received_bytes > 0, safeFetched.result?.isError === false ? safeFetched.result?.result?.details : textOf(safeFetched.result).slice(0, 500));

  const unsupported = await runPi("safe_web_fetch", { url: "file:///etc/passwd", raw: false });
  const unsupportedError = textOf(unsupported.result);
  check("web-fetch-blocks-unsupported-scheme", unsupported.code === 0 && unsupported.result?.isError === true && /Only HTTP and HTTPS/iu.test(unsupportedError) && !unsupportedError.includes("/etc/passwd"), unsupportedError.slice(0, 500));
  const privateTarget = await runPi("safe_web_fetch", { url: "http://127.0.0.1/", raw: false });
  const privateError = textOf(privateTarget.result);
  check("web-fetch-blocks-private-network", privateTarget.code === 0 && privateTarget.result?.isError === true && /Private, loopback/iu.test(privateError), privateError.slice(0, 500));

  const braveMissing = await runPi("web_research", { query: "Pi Coding Agent", max_results: 1, provider: "brave" });
  const braveError = textOf(braveMissing.result);
  check("brave-missing-key-fails-explicitly", braveMissing.code === 0 && braveMissing.result?.isError === true && braveError.includes("BRAVE_SEARCH_API_KEY"), braveError.slice(0, 500));
  check("brave-does-not-silently-fallback", !/PERPLEXITY_API_KEY/u.test(braveError), braveError.slice(0, 500));

  const perplexityMissing = await runPi("web_research", { query: "Pi Coding Agent", max_results: 1, provider: "perplexity" });
  const perplexityError = textOf(perplexityMissing.result);
  check("perplexity-missing-key-fails-explicitly", perplexityMissing.code === 0 && perplexityMissing.result?.isError === true && perplexityError.includes("PERPLEXITY_API_KEY"), perplexityError.slice(0, 500));
  check("perplexity-does-not-silently-fallback", !/BRAVE_SEARCH_API_KEY/u.test(perplexityError), perplexityError.slice(0, 500));

  if (credentialed) {
    const available = credentialAvailability();
    check("brave-credential-available", available.brave, available.brave ? "configured without disclosure" : "BRAVE_SEARCH_API_KEY or /web-tools Brave key is missing");
    check("perplexity-credential-available", available.perplexity, available.perplexity ? "configured without disclosure" : "PERPLEXITY_API_KEY or /web-tools Perplexity key is missing");
    if (available.brave) {
      const brave = await runPi("web_research", { query: "official Pi Coding Agent documentation", max_results: 2, provider: "brave" }, { isolated: false });
      check("brave-real-search", brave.code === 0 && brave.result?.isError === false && brave.result?.result?.details?.backend === "brave" && brave.result?.result?.details?.resultCount > 0, { backend: brave.result?.result?.details?.backend, resultCount: brave.result?.result?.details?.resultCount, error: brave.result?.isError ? textOf(brave.result).slice(0, 300) : undefined });
    }
    if (available.perplexity) {
      const perplexity = await runPi("web_research", { query: "official Pi Coding Agent documentation", max_results: 2, provider: "perplexity" }, { isolated: false });
      check("perplexity-real-override", perplexity.code === 0 && perplexity.result?.isError === false && perplexity.result?.result?.details?.backend === "perplexity" && perplexity.result?.result?.details?.resultCount > 0, { backend: perplexity.result?.result?.details?.backend, resultCount: perplexity.result?.result?.details?.resultCount, error: perplexity.result?.isError ? textOf(perplexity.result).slice(0, 300) : undefined });
    }
  }
} catch (error) {
  check("web-smoke-harness", false, error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const status = results.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL";
process.stdout.write(`${JSON.stringify({ status, credentialed, credentialAvailability: credentialAvailability(), results }, null, 2)}\n`);
process.exit(status === "PASS" ? 0 : 1);
