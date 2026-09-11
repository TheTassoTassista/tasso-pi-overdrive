#!/usr/bin/env node
import { spawn } from "node:child_process";
import { MODEL_ROLES } from "../lib/model-policy.mjs";
import { summarizeProviderCapabilities } from "../lib/model-inventory-report.mjs";

const pi = process.env.PI_BIN || "pi";
const live = process.argv.includes("--live");
const presets = ["budget", "efficient", "balanced", "max-quality"];

function runPi({ id, message, model = "openai-codex/gpt-5.6-luna", thinking = "low", timeoutMs = 180_000, waitForNotification = false }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(pi, ["--offline", "--approve", "--no-session", "--mode", "rpc", "--model", model, "--thinking", thinking, "--no-tools"], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-5000); });
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const poll = setInterval(() => {
      const complete = waitForNotification
        ? events.some((event) => event.type === "extension_ui_request" && event.method === "notify")
        : events.some((event) => event.type === "agent_settled");
      if (!complete) return;
      clearInterval(poll);
      child.stdin.end();
    }, 20);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ code, runtimeMs: Number((performance.now() - started).toFixed(1)), events, stderr });
    });
  });
}

function notification(run) {
  return run.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => event.message).filter((value) => typeof value === "string").at(-1) ?? "";
}

function parseRoutes(text) {
  const routes = {};
  for (const role of MODEL_ROLES) {
    const line = text.split("\n").find((candidate) => candidate.startsWith(`${role}: `));
    const match = line ? /^([^:]+): (.+):(off|minimal|low|medium|high|xhigh|max)$/u.exec(line) : undefined;
    if (match) routes[role] = { model: match[2], thinking: match[3] };
  }
  return routes;
}

function normalizedRate(routes, catalog, roles) {
  let total = 0;
  for (const role of roles) {
    const metadata = catalog.get(routes[role]?.model);
    if (!metadata?.cost || !Number.isFinite(metadata.cost.input) || !Number.isFinite(metadata.cost.output)) return null;
    total += metadata.cost.input + metadata.cost.output;
  }
  return Number(total.toFixed(3));
}

async function liveReview(preset, route) {
  const prompt = "Inspect this JavaScript expression: `index <= values.length ? values[index] : undefined`. If it has an array-boundary defect, reply with exactly BOUNDARY_BUG. Otherwise reply exactly NO_BUG. Do not call tools.";
  const run = await runPi({ id: `preset-${preset}`, message: prompt, model: route.model, thinking: route.thinking, timeoutMs: 240_000 });
  const ended = run.events.findLast((event) => event.type === "agent_end");
  const assistant = [...(ended?.messages ?? [])].reverse().find((message) => message.role === "assistant");
  const text = (assistant?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("").trim();
  return {
    status: run.code === 0 && assistant?.stopReason === "stop" && text === "BOUNDARY_BUG" ? "PASS" : "FAIL",
    model: route.model,
    thinking: route.thinking,
    latencyMs: run.runtimeMs,
    inputTokens: assistant?.usage?.input ?? null,
    outputTokens: assistant?.usage?.output ?? null,
    cacheReadTokens: assistant?.usage?.cacheRead ?? null,
    cacheWriteTokens: assistant?.usage?.cacheWrite ?? null,
    apiReportedCostUsd: assistant?.usage?.cost?.total ?? null,
    retries: 0,
    validFindings: text === "BOUNDARY_BUG" ? 1 : 0,
    missedFindings: text === "BOUNDARY_BUG" ? 0 : 1,
    falsePositives: null,
    reviewOnly: true,
    correctionRounds: null,
    response: text.slice(0, 80),
  };
}

let report;
try {
  const catalogRun = await runPi({ id: "model-catalog", message: "/models", waitForNotification: true });
  const inventory = JSON.parse(notification(catalogRun));
  const providerSummary = summarizeProviderCapabilities(inventory);
  const catalog = new Map((inventory.availableModels ?? []).map((entry) => [entry.model, entry]));
  const comparisons = [];
  for (const preset of presets) {
    const started = performance.now();
    const preview = await runPi({ id: `preview-${preset}`, message: `/model-preset preview ${preset}`, waitForNotification: true });
    const previewText = notification(preview);
    const routes = parseRoutes(previewText);
    const controllerRoles = ["scout", "planner", "worker", "tester", "correctness", "security", "simplicity"];
    const councilRoles = ["oracle", "council-1", "council-2", "council-3", "council-judge"];
    const policyUnchanged = previewText.includes("Preview only; persistent policy unchanged.");
    const deterministic = {
      status: preview.code === 0 && Object.keys(routes).length === MODEL_ROLES.length && Object.values(routes).every((route) => catalog.get(route.model)?.usable === true) && policyUnchanged ? "PASS" : "FAIL",
      latencyMs: Number((performance.now() - started).toFixed(1)),
      rolesAssigned: Object.keys(routes).length,
      modelIdentities: new Set(Object.values(routes).map((route) => route.model)).size,
      providers: new Set(Object.values(routes).map((route) => route.model.split("/")[0])).size,
      normalPathRateUsdPerMillionInputPlusOutputPerRole: normalizedRate(routes, catalog, controllerRoles),
      highRiskAdditionalRateUsdPerMillionInputPlusOutputPerRole: normalizedRate(routes, catalog, councilRoles),
      retries: 0,
      reviewerFindings: null,
      correctionRounds: 0,
      toolSchemaTokens: 0,
      note: "Policy/controller validation only; route-rate figures sum published per-million input+output rates and are not a task cost estimate.",
    };
    comparisons.push({ preset, routes, deterministic, liveReview: live ? await liveReview(preset, routes.correctness) : "NOT_RUN" });
  }
  const allGreen = comparisons.every((entry) => entry.deterministic.status === "PASS" && (!live || entry.liveReview.status === "PASS"));
  report = {
    status: allGreen ? "PASS" : "FAIL",
    mode: live ? "deterministic-plus-bounded-live-review" : "deterministic-policy-evaluation",
    paidModelCalls: live ? comparisons.length : 0,
    registeredProviders: inventory.providers ?? [],
    authenticatedProviders: providerSummary.authenticatedProviders,
    providerCapabilities: providerSummary.providerCapabilities,
    crossProviderQualityComparison: "NOT_RUN_SINGLE_AUTHENTICATED_PROVIDER",
    defaultSelection: "efficient",
    defaultRationale: "Retains Luna discovery/testing, Terra implementation, Sol review/planning, and Astra escalation while admitting only routes with cached runtime-callable evidence; live review is reported separately.",
    comparisons,
  };
} catch (error) {
  report = { status: "FAIL", mode: live ? "deterministic-plus-bounded-live-review" : "deterministic-policy-evaluation", error: error instanceof Error ? error.message : String(error) };
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.status === "PASS" ? 0 : 1);
