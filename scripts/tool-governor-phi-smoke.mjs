#!/usr/bin/env node
// Runs the real Phi -> Pi RPC path with an explicitly supplied, disposable Pi
// candidate and a deterministic local provider. No network/provider call occurs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piRoot = process.env.PHI_G1_TEST_PI_ROOT;
if (!piRoot || !path.isAbsolute(piRoot)) throw new Error("PHI_G1_TEST_PI_ROOT_REQUIRED");
const piPackage = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));
assert.equal(piPackage.name, "@earendil-works/pi-coding-agent");
assert.equal(piPackage.version, "1.5.0", "only the already-isolated candidate runtime is accepted");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "phi-g1-tool-governor-"));
const home = path.join(temp, "home");
const agent = path.join(temp, "agent");
const config = path.join(temp, "config");
const state = path.join(temp, "state");
const audit = path.join(temp, "audit.jsonl");
const policy = path.join(temp, "model-policy.json");
const provider = path.join(root, "tests/fixtures/deterministic-tool-governor-provider.ts");
for (const dir of [home, agent, config, state]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(config, "phi"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(agent, "settings.json"), `${JSON.stringify({
	packages: [root], defaultProvider: "openai-codex", defaultModel: "gpt-6-sol", defaultThinkingLevel: "medium",
})}\n`, { mode: 0o600 });
fs.writeFileSync(policy, `${JSON.stringify({ version: 2, preset: "normal", basePreset: "normal", overrides: {} })}\n`, { mode: 0o600 });

function readAudit() {
	if (!fs.existsSync(audit)) return [];
	return fs.readFileSync(audit, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function invoke({ name, cwd, message, sequence, extraArgs = [] }) {
	const args = [
		root + "/bin/phi.mjs", "--offline", "--approve", "--no-session", "--mode", "rpc",
		"--extension", provider, "--provider", "openai-codex", "--model", "gpt-6-sol", ...extraArgs,
	];
	const env = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: config,
		XDG_STATE_HOME: state,
		PI_CODING_AGENT_DIR: agent,
		PHI_PI_ROOT: piRoot,
		PI_OVERDRIVE_MODEL_POLICY: policy,
		PHI_G1_FIXTURE_KEY: "fixture-only-not-a-credential",
		PHI_G1_AUDIT_FILE: audit,
		PHI_G1_SEQUENCE: JSON.stringify(sequence),
		PI_OFFLINE: "1",
	};
	const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const events = [];
	let stderr = "";
	let buffer = "";
	const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline).replace(/\r$/u, "");
			buffer = buffer.slice(newline + 1);
			try { if (line) events.push(JSON.parse(line)); } catch { /* RPC stdout may include protocol-neutral notices. */ }
		}
	});
	child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
	child.stdin.write(`${JSON.stringify({ id: name, type: "prompt", message })}\n`);
	const deadline = Date.now() + 60000;
	while (!events.some((event) => event.type === "agent_settled") && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
	if (!events.some((event) => event.type === "agent_settled")) {
		child.kill("SIGTERM");
		await closed;
		throw new Error(`${name}:PHI_G1_RPC_NOT_SETTLED`);
	}
	child.stdin.end();
	const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
	const exit = await closed;
	clearTimeout(timer);
	assert.notEqual(exit.signal, "SIGKILL", `${name}:unexpected forced kill`);
	assert.equal(exit.code, 0, `${name}:Phi/Pi RPC exited unsuccessfully (${exit.code ?? exit.signal}); ${stderr.includes("PHI_LOCAL_FAILURE") ? "sanitized startup failure" : "inspect isolated test output"}`);
	return events;
}

const result = { status: "FAIL", piVersion: piPackage.version, providerCalls: 0, scenarios: [] };
try {
	const createDir = path.join(temp, "allowed-create");
	fs.mkdirSync(createDir, { mode: 0o700 });
	const createEvents = await invoke({ name: "allowed-create", cwd: createDir, message: "Crea un file index.html per il progetto.", sequence: [{ name: "create_file", args: { path: "index.html", content: "<h1>Offline fixture</h1>\n" } }] });
	const createSurface = readAudit().findLast((row) => row.kind === "tool_governor_surface");
	const created = createEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "create_file");
	assert.ok(createSurface?.activeTools.includes("create_file"), "creation intent must activate the guarded creation tool");
	assert.equal(created?.isError, false);
	assert.equal(fs.readFileSync(path.join(createDir, "index.html"), "utf8"), "<h1>Offline fixture</h1>\n");
	const overwriteEvents = await invoke({ name: "overwrite-denied", cwd: createDir, message: "Crea un file index.html per il progetto.", sequence: [{ name: "create_file", args: { path: "index.html", content: "overwrite" } }] });
	assert.equal(overwriteEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "create_file")?.isError, true);
	assert.equal(fs.readFileSync(path.join(createDir, "index.html"), "utf8"), "<h1>Offline fixture</h1>\n");
	result.scenarios.push({ name: "create-file-allowed-no-overwrite", status: "PASS", active: true, creation: true, overwriteDenied: true });

	const editDir = path.join(temp, "allowed-edit");
	fs.mkdirSync(editDir, { mode: 0o700 });
	fs.writeFileSync(path.join(editDir, "sample.ts"), "const value = 1;\n", { mode: 0o600 });
	const editEvents = await invoke({
		name: "allowed-edit",
		cwd: editDir,
		message: "Change one string value in sample.ts.",
		sequence: [
			{ name: "read", args: { path: "sample.ts" } },
			{ name: "transactional_edit", args: { action: "preview", snapshotId: "$previous.snapshotId", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] } },
			{ name: "transactional_edit", args: { action: "apply", transactionId: "$previous.transactionId" } },
		],
	});
	const editAudit = readAudit();
	const inventory = editAudit.find((row) => row.kind === "registered_inventory");
	const surface = editAudit.findLast((row) => row.kind === "tool_governor_surface");
	const profile = editAudit.findLast((row) => row.kind === "model_harness_profile");
	const editEnds = editEvents.filter((event) => event.type === "tool_execution_end");
	assert.ok(inventory?.names.includes("transactional_edit") && inventory.names.includes("write"), "tools must be registered before policy selection");
	assert.ok(surface?.activeTools.includes("transactional_edit"), "normal edit task must activate governed editor");
	assert.equal(surface.activeTools.includes("write"), false, "raw write remains out of the selected exact edit contract");
	assert.equal(profile?.editContract, "HASH_ANCHORED");
	assert.deepEqual(editEnds.map((event) => [event.toolName, event.isError]), [["read", false], ["transactional_edit", false], ["transactional_edit", false]]);
	assert.equal(fs.readFileSync(path.join(editDir, "sample.ts"), "utf8"), "const value = 2;\n");
	result.scenarios.push({ name: "governed-edit-allowed", status: "PASS", registered: true, active: true, invocations: editEnds.length, fileChangedOnlyInDisposableFixture: true });

	const readDir = path.join(temp, "read-only");
	fs.mkdirSync(readDir, { mode: 0o700 });
	fs.writeFileSync(path.join(readDir, "sample.ts"), "const safe = true;\n", { mode: 0o600 });
	const writeEvents = await invoke({ name: "raw-write-denied", cwd: readDir, message: "Inspect sample.ts and summarize it without modifying any files.", sequence: [{ name: "write", args: { path: "should-not-exist.txt", content: "unauthorized fixture write" } }] });
	const writeSurface = readAudit().findLast((row) => row.kind === "tool_governor_surface");
	const writeStart = writeEvents.some((event) => event.type === "tool_execution_start" && event.toolName === "write");
	const writeEnd = writeEvents.findLast((event) => event.type === "tool_execution_end" && event.toolName === "write");
	assert.equal(writeSurface?.activeTools.includes("write"), false, "read-only task must not activate raw write");
	assert.equal(writeEnd?.isError, true, `inactive raw write must be rejected (start=${writeStart}, file=${fs.existsSync(path.join(readDir, "should-not-exist.txt"))})`);
	assert.equal(fs.existsSync(path.join(readDir, "should-not-exist.txt")), false, "inactive tool attempt must not mutate the disposable workspace");
	result.scenarios.push({ name: "raw-write-inactive-denied", status: "PASS", registered: true, active: false, executionStarted: writeStart, fileCreated: false, rejectionObserved: true });

	const debugDir = path.join(temp, "debug-eval");
	fs.mkdirSync(debugDir, { mode: 0o700 });
	fs.writeFileSync(path.join(debugDir, ".env"), "FIXTURE_ONLY=not-a-secret\n", { mode: 0o600 });
	const debugEvents = await invoke({
		name: "debug-eval",
		cwd: debugDir,
		message: "Debug the race condition in src/queue.ts and calculate a small example.",
		sequence: [
			{ name: "persistent_javascript", args: { action: "execute", code: "console.log(2 + 2)" } },
			{ name: "debug_engine", args: { action: "set_breakpoint", file: ".env", line: 1 } },
		],
	});
	const debugAudit = readAudit();
	const debugSurface = debugAudit.findLast((row) => row.kind === "tool_governor_surface");
	const evalEnd = debugEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "persistent_javascript");
	const debugEnd = debugEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "debug_engine");
	assert.ok(debugSurface?.activeTools.includes("debug_engine") && debugSurface.activeTools.includes("persistent_javascript"));
	assert.equal(debugSurface.activeTools.includes("write"), false);
	assert.equal(evalEnd?.isError, false, "allowed persistent JavaScript must execute in its sandbox");
	assert.match((evalEnd?.result?.content ?? []).map((item) => item.text ?? "").join("\n"), /4/u);
	assert.equal(debugEnd?.isError, true, "active debug tool must still pass through the safety hook");
	assert.match((debugEnd?.result?.content ?? []).map((item) => item.text ?? "").join("\n"), /workspace path denied|protected|denied/iu);
	assert.equal(fs.readFileSync(path.join(debugDir, ".env"), "utf8"), "FIXTURE_ONLY=not-a-secret\n");
	result.scenarios.push({ name: "debug-eval-active-and-enforced", status: "PASS", debugActive: true, evalActive: true, evalInvoked: evalEnd?.isError === false, debugAttemptRejectedBySafety: debugEnd?.isError === true, protectedFixtureUnchanged: true });

	const staleDir = path.join(temp, "stale-transaction");
	fs.mkdirSync(staleDir, { mode: 0o700 });
	fs.writeFileSync(path.join(staleDir, "sample.ts"), "const stable = 1;\n", { mode: 0o600 });
	const staleEvents = await invoke({
		name: "stale-transaction-denied",
		cwd: staleDir,
		message: "Change one string value in sample.ts.",
		sequence: [
			{ name: "read", args: { path: "sample.ts" } },
			{ name: "transactional_edit", args: { action: "apply", transactionId: "00000000-0000-4000-8000-000000000000" } },
		],
	});
	const staleEnd = staleEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "transactional_edit");
	assert.equal(staleEnd?.isError, true, "apply without a preview-owned transaction must fail closed");
	assert.equal(fs.readFileSync(path.join(staleDir, "sample.ts"), "utf8"), "const stable = 1;\n");
	result.scenarios.push({ name: "mutating-tool-invalid-transaction-denied", status: "PASS", invocable: true, invalidAuthorityRejected: staleEnd?.isError === true, fileUnchanged: true });

	result.providerCalls = readAudit().filter((row) => row.kind === "fixture_provider_turn").length;
	assert.equal(result.providerCalls, 10, "all model turns came from the local deterministic stream fixture");
	result.status = "PASS";
} catch (error) {
	result.failure = error instanceof Error ? error.message : "PHI_G1_SMOKE_FAILED";
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.status === "PASS" ? 0 : 1;
