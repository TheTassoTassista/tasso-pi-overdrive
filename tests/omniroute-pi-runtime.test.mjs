import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPiOpenAiCompletionsStreamSimple } from "../lib/omniroute-tls.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN || path.join(path.dirname(process.execPath), "pi");
const phi = process.env.PHI_BIN;
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

test("Pi RPC registers OmniRoute, selects it, and restores the preceding model without inference", { skip: !piRuntimeAvailable }, async (t) => {
	assert.ok(selected?.catalogId, "routing policy must provide a deterministic OmniRoute model fixture");
	const root = mkdtempSync(path.join(os.tmpdir(), "phi-omniroute-pi-rpc-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	if (phi) {
		const target = process.env.PHI_TARGET_ROOT;
		assert.ok(target && path.isAbsolute(target) && existsSync(path.join(target, "package.json")), "stable Phi target must be identified explicitly");
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
			packages: [target], defaultProvider: "openai-codex", defaultModel: "gpt-6-sol", defaultThinkingLevel: "medium",
		}), { mode: 0o600 });
	}

	const child = spawn(phi || pi, [
		"--offline", "--no-session", "--no-context-files", "--no-tools", "--mode", "rpc",
		...(!phi ? ["--extension", extension] : []),
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
	const requests = [{ id: "models", type: "get_available_models" }];
	let nextRequest = 0;
	const send = () => {
		if (nextRequest >= requests.length) return;
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
					if (event.id === "models" && event.success) {
						const models = event.data?.models ?? [];
						const preceding = models.find((model) => model.provider && model.id && (model.provider !== "omniroute" || model.id !== selected.catalogId));
						if (preceding) requests.push(
							{ id: "preceding", type: "set_model", provider: preceding.provider, modelId: preceding.id },
							{ id: "select", type: "set_model", provider: "omniroute", modelId: selected.catalogId },
							{ id: "selected_state", type: "get_state" },
							{ id: "restore", type: "set_model", provider: preceding.provider, modelId: preceding.id },
							{ id: "restored_state", type: "get_state" },
						);
					}
					if (event.id === "restored_state" || (event.id === "models" && requests.length === 1)) child.stdin.end();
					else sendNext?.();
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
	const preceding = models.find((model) => model.provider && model.id && (model.provider !== "omniroute" || model.id !== selected.catalogId));
	assert.ok(preceding, "Pi RPC must expose a distinct model to restore");
	assert.equal(responses.get("preceding")?.success, true, "the isolated session must select its preceding model");
	assert.equal(responses.get("select")?.success, true, "Pi RPC must accept explicit selection of the OmniRoute model");
	assert.equal(responses.get("selected_state")?.data?.model?.provider, "omniroute");
	assert.equal(responses.get("selected_state")?.data?.model?.id, selected.catalogId);
	assert.equal(responses.get("restore")?.success, true, "Pi RPC must restore the preceding model");
	assert.equal(responses.get("restored_state")?.data?.model?.provider, preceding.provider);
	assert.equal(responses.get("restored_state")?.data?.model?.id, preceding.id);
	assert.equal(events.filter((event) => ["agent_start", "message_start", "message_update", "message_end"].includes(event.type)).length, 0, "RPC selection must not invoke a model");
});
