import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPiOpenAiCompletionsStreamSimple } from "../lib/omniroute-tls.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || path.join(path.dirname(process.execPath), "pi");
const extension = path.join(packageRoot, "extensions", "omniroute.ts");
const policy = JSON.parse(readFileSync(path.join(packageRoot, "config", "routing-policy.json"), "utf8"));
const selected = Object.values(policy.models).find((model) => model.source === "OmniRoute" && model.catalogId);
const runtimeRoots = [
	process.env.PI_PACKAGE_ROOT,
	process.env.PHI_PI_ROOT,
	path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
	path.resolve(path.dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent"),
].filter(Boolean);
const piRuntimeAvailable = existsSync(pi) && runtimeRoots.some((root) => {
	try { return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent"; } catch { return false; }
});

test("loads Pi's exported OpenAI-completions stream adapter from the installed runtime", { skip: !piRuntimeAvailable }, () => {
	assert.equal(typeof loadPiOpenAiCompletionsStreamSimple(), "function");
});

test("Pi RPC loads the worktree extension, registers OmniRoute, and selects its local fixture model", { skip: !piRuntimeAvailable }, async (t) => {
	assert.ok(selected?.catalogId, "routing policy must provide a deterministic OmniRoute model fixture");
	const root = mkdtempSync(path.join(os.tmpdir(), "phi-omniroute-pi-rpc-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const child = spawn(pi, [
		"--offline", "--no-session", "--no-context-files", "--no-tools", "--mode", "rpc",
		"--extension", extension, "--provider", "omniroute", "--model", selected.catalogId,
	], {
		cwd: root,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? root,
			USER: process.env.USER ?? "phi-test",
			LANG: process.env.LANG ?? "C.UTF-8",
			PI_CODING_AGENT_DIR: agentDir,
			OMNIROUTER_API_KEY: "fixture-only-token",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	const events = [];
	let stdout = "";
	let stderr = "";
	let pending = "";
	let timedOut = false;
	let spawnError;
	const responses = new Map();
	let sendNext;
	const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 20_000);
	const requests = [
		{ id: "models", type: "get_available_models" },
		{ id: "select", type: "set_model", provider: "omniroute", modelId: selected.catalogId },
		{ id: "state", type: "get_state" },
	];
	let nextRequest = 0;
	const send = () => {
		if (nextRequest >= requests.length) { child.stdin.end(); return; }
		child.stdin.write(`${JSON.stringify(requests[nextRequest++])}\n`);
	};
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		pending += chunk;
		const lines = pending.split(/\r?\n/u);
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (!line) continue;
			try {
				const event = JSON.parse(line);
				events.push(event);
				if (event.type === "response" && event.id === requests[nextRequest - 1]?.id) {
					responses.set(event.id, event);
					if (event.id !== "state") sendNext?.();
					else child.stdin.end();
				}
			} catch {}
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdin.on("error", () => {});
	child.on("error", (error) => { spawnError = error.message; });
	sendNext = send;

	const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
	send();
	const exit = await closed;
	clearTimeout(timeout);
	if (pending.trim()) {
		try { events.push(JSON.parse(pending)); } catch {}
	}
	assert.equal(timedOut, false, `Pi RPC timed out; stderr=${stderr.slice(-3000)}`);
	assert.equal(spawnError, undefined, `Pi RPC could not start: ${spawnError}`);
	assert.equal(exit.code, 0, `Pi RPC exited ${exit.code} (${exit.signal}); stdout=${stdout.slice(-3000)} stderr=${stderr.slice(-3000)}`);
	assert.equal(responses.get("models")?.success, true, `model catalog request failed: ${stderr.slice(-3000)}`);
	const models = responses.get("models")?.data?.models ?? [];
	assert.ok(models.some((model) => model.provider === "omniroute" && model.id === selected.catalogId), "Pi RPC catalog must contain the extension-registered fixture model");
	assert.equal(responses.get("select")?.success, true, "Pi RPC must accept explicit selection of the OmniRoute model");
	assert.equal(responses.get("state")?.data?.model?.provider, "omniroute");
	assert.equal(responses.get("state")?.data?.model?.id, selected.catalogId);
	assert.equal(events.filter((event) => ["agent_start", "message_start", "message_update", "message_end"].includes(event.type)).length, 0, "RPC selection must not invoke a model");
});
