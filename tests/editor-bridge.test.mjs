import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACP_PROTOCOL_VERSION,
  EDITOR_APPROVAL_TITLE,
  EditorAcpBridge,
  EditorBridgeError,
  EditorReceiptJournal,
  attestPiBinary,
  decodeEditorApproval,
  editorApprovalIntent,
  editorBridgeChildArgs,
  encodeEditorApproval,
  findExecutable,
  parseEditorFrame,
  readEditorBridgePolicy,
  resolveEditorRoot,
  sanitizeEditorReceipt,
  validateEditorBridgePolicy,
} from "../lib/editor-bridge.mjs";

const HEX = "a".repeat(64);

class FakePi {
  constructor(options, behavior = "auto") {
    this.onEvent = options.onEvent;
    this.behavior = behavior;
    this.commands = [];
    this.sent = [];
    this.stderrBytes = 0;
    this.route = { provider: "fixture", id: "deterministic", thinking: "low" };
    this.closed = false;
  }

  start() { this.started = true; }

  async emit(event) { await this.onEvent(event); }

  async command(type, payload = {}) {
    this.commands.push({ type, payload });
    if (type === "get_state") {
      if (this.behavior === "slow-state" && this.commands.filter((entry) => entry.type === "get_state").length > 1) await new Promise((resolve) => setTimeout(resolve, 25));
      return { data: { model: { provider: this.route.provider, id: this.route.id }, thinkingLevel: this.route.thinking, isStreaming: false } };
    }
    if (type === "get_session_stats") return { data: { tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 23 }, cost: 0, contextUsage: { contextWindow: 32768, tokens: 200 } } };
    if (type === "prompt") {
      if (["auto", "slow-state"].includes(this.behavior)) queueMicrotask(async () => {
        await this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "deterministic result" } });
        await this.emit({ type: "tool_execution_start", toolCallId: "call-read-1", toolName: "read", args: { path: "secret.txt" } });
        await this.emit({ type: "tool_execution_end", toolCallId: "call-read-1", toolName: "read", result: { content: [{ type: "text", text: "raw secret output" }] }, isError: false });
        await this.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        await this.emit({ type: "agent_settled" });
      });
      if (this.behavior === "permission") queueMicrotask(async () => {
        const input = { action: "apply", path: "sensitive.ts" };
        await this.emit({ type: "tool_execution_start", toolCallId: "call-edit-1", toolName: "transactional_edit", args: input });
        await this.emit({
          type: "extension_ui_request", id: "ui-confirm-1", method: "confirm", title: EDITOR_APPROVAL_TITLE,
          message: encodeEditorApproval("call-edit-1", "transactional_edit", "edit", editorApprovalIntent("transactional_edit", input).inputDigest), timeout: 120000,
        });
      });
      return { success: true };
    }
    if (type === "abort") { queueMicrotask(() => this.emit({ type: "agent_settled" })); return { success: true }; }
    throw new Error(`unexpected fake Pi command ${type}`);
  }

  send(frame) {
    this.sent.push(frame);
    if (frame.type === "extension_ui_response" && frame.id === "ui-confirm-1") queueMicrotask(async () => {
      await this.emit({ type: "tool_execution_end", toolCallId: "call-edit-1", toolName: "transactional_edit", result: { content: [] }, isError: frame.confirmed !== true });
      await this.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      await this.emit({ type: "agent_settled" });
    });
  }

  async close(reason) { this.closed = true; this.closeReason = reason; return { code: 0, signal: null, reason }; }
}

function request(id, method, params = {}) { return { jsonrpc: "2.0", id, method, params }; }
function response(outputs, id) { return outputs.findLast((entry) => entry.type === "response" && entry.id === id); }
function rpcResponse(outputs, id) { return outputs.findLast((entry) => entry.jsonrpc === "2.0" && entry.id === id && !entry.method); }
async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}

function harness(t, behavior = "auto") {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-editor-bridge-test-"));
  const root = path.join(temporary, "repo");
  const state = path.join(temporary, "state");
  fs.mkdirSync(root, { mode: 0o700 });
  const policy = readEditorBridgePolicy();
  const journal = new EditorReceiptJournal({ policy, stateDir: state });
  const outputs = [];
  let fake;
  const bridge = new EditorAcpBridge({
    policy,
    root,
    identity: { version: "0.87.1", digest: HEX },
    journal,
    send: async (value) => { outputs.push(value); },
    piFactory: (options) => { fake = new FakePi(options, behavior); return fake; },
  });
  t.after(async () => {
    await bridge.dispose("test_cleanup");
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return { temporary, root, state, policy, journal, outputs, bridge, get fake() { return fake; } };
}

async function initializeAndOpen(h) {
  await h.bridge.receive(request("init", "initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "test-client", version: "1" } }));
  await h.bridge.receive(request("auth", "authenticate", { methodId: "agent" }));
  await h.bridge.receive(request("new", "session/new", { cwd: h.root, mcpServers: [] }));
  const opened = rpcResponse(h.outputs, "new");
  assert.ok(opened?.result?.sessionId);
  return opened.result.sessionId;
}

test("editor policy hard-caps one ephemeral session, one prompt, no client authority, and fixed approvals", () => {
  const policy = readEditorBridgePolicy();
  assert.equal(policy.maxSessions, 1);
  assert.equal(policy.maxConcurrentPrompts, 1);
  assert.equal(policy.allowSessionPersistence, false);
  assert.equal(policy.allowClientMcp, false);
  assert.equal(policy.allowClientFilesystem, false);
  assert.equal(policy.allowClientTerminal, false);
  assert.equal(policy.allowClientRouteChanges, false);
  assert.equal(policy.allowSlashCommands, false);
  assert.ok(policy.approvalTools.includes("secure_coding_workflow"));
  assert.ok(policy.approvalTools.includes("transactional_edit"));
  assert.throws(() => validateEditorBridgePolicy({ ...policy, maxSessions: 2 }), /editor_policy_sessions_invalid/u);
  assert.throws(() => validateEditorBridgePolicy({ ...policy, allowClientRouteChanges: true }), /editor_policy_authority_invalid/u);
  assert.throws(() => validateEditorBridgePolicy({ ...policy, approvalTools: policy.approvalTools.filter((name) => name !== "safe_exec") }), /editor_policy_approval_tools_invalid/u);
});

test("strict ACP framing rejects malformed, batched, oversized, and non-object input", () => {
  const policy = readEditorBridgePolicy();
  assert.deepEqual(parseEditorFrame('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', policy).id, 1);
  for (const value of ["{", "[]", '"text"', "null", "x".repeat(policy.maxFrameBytes + 1)]) assert.throws(() => parseEditorFrame(value, policy), EditorBridgeError);
});

test("project and Pi binary identities are canonical, owner-safe, executable, and version-attested", () => {
  const root = resolveEditorRoot(process.cwd());
  assert.equal(root, fs.realpathSync(process.cwd()));
  const pi = findExecutable("pi");
  const identity = attestPiBinary(pi, readEditorBridgePolicy());
  assert.equal(identity.version, "0.87.1");
  assert.match(identity.digest, /^[0-9a-f]{64}$/u);
  assert.throws(() => attestPiBinary("/bin/false", readEditorBridgePolicy()), /editor_pi_(?:version_mismatch|binary_unsafe)/u);
});

test("root traversal and symlink aliases cannot retarget an editor session", async (t) => {
  const h = harness(t);
  const alias = path.join(h.temporary, "alias");
  fs.symlinkSync(h.root, alias, "dir");
  assert.throws(() => resolveEditorRoot(`${h.temporary}/repo/../repo`), /editor_root_ambiguous/u);
  assert.throws(() => resolveEditorRoot(alias), /editor_root_unsafe/u);
  await h.bridge.receive(request("init", "initialize", { protocolVersion: 1 }));
  await h.bridge.receive(request("auth", "authenticate", { methodId: "agent" }));
  await h.bridge.receive(request("alias", "session/new", { cwd: alias, mcpServers: [] }));
  assert.equal(rpcResponse(h.outputs, "alias")?.error?.message, "editor_root_unsafe");
  fs.renameSync(h.root, `${h.root}-old`);
  fs.mkdirSync(h.root, { mode: 0o700 });
  await h.bridge.receive(request("swapped", "session/new", { cwd: h.root, mcpServers: [] }));
  assert.equal(rpcResponse(h.outputs, "swapped")?.error?.message, "editor_root_changed");
});

test("approval classification is explicit and transactional previews remain read-only", () => {
  assert.equal(editorApprovalIntent("read", { path: "a.ts" }), undefined);
  assert.equal(editorApprovalIntent("transactional_edit", { action: "preview" }), undefined);
  assert.equal(editorApprovalIntent("transactional_edit", { action: "apply" })?.toolKind, "edit");
  assert.equal(editorApprovalIntent("verification_gate", {})?.toolKind, "execute");
  assert.equal(editorApprovalIntent("safe_web_fetch", {})?.toolKind, "fetch");
  const encoded = encodeEditorApproval("call-1", "safe_exec", "execute", HEX);
  assert.deepEqual(decodeEditorApproval(EDITOR_APPROVAL_TITLE, encoded), { toolCallId: "call-1", toolName: "safe_exec", toolKind: "execute", inputDigest: HEX });
  assert.throws(() => decodeEditorApproval("Other", encoded), /editor_approval_request_invalid/u);
});

test("receipt schemas reject raw prompt, path, output, credential, and unknown fields", () => {
  const valid = sanitizeEditorReceipt("prompt_started", { requestDigest: HEX, promptDigest: HEX, promptChars: 12, sequence: 1 }, 1);
  assert.equal(valid.kind, "prompt_started");
  for (const field of ["prompt", "path", "output", "credential", "secret", "toolArgs"]) {
    assert.throws(() => sanitizeEditorReceipt("prompt_started", { requestDigest: HEX, promptDigest: HEX, promptChars: 12, sequence: 1, [field]: "leak" }, 1), /editor_receipt_shape_invalid/u);
  }
});

test("initialize advertises no remote filesystem, terminal, MCP, route, or persisted-session capability", async (t) => {
  const h = harness(t);
  await h.bridge.receive(request("init", "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "hostile", version: "1" } }));
  const initialized = rpcResponse(h.outputs, "init")?.result;
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentCapabilities.loadSession, false);
  assert.deepEqual(initialized.agentCapabilities.mcpCapabilities, { http: false, sse: false });
  assert.equal(initialized.agentCapabilities.promptCapabilities.embeddedContext, false);
  assert.deepEqual(initialized.authMethods.map((entry) => entry.id), ["agent"]);
});

test("session creation requires an explicit existing-auth handshake", async (t) => {
  const h = harness(t);
  await h.bridge.receive(request("init", "initialize", { protocolVersion: 1 }));
  await h.bridge.receive(request("new", "session/new", { cwd: h.root, mcpServers: [] }));
  assert.equal(rpcResponse(h.outputs, "new")?.error?.message, "editor_not_authenticated");
  assert.equal(h.fake, undefined);
});

test("session root is exact and client MCP, extra directories, and a second session fail closed", async (t) => {
  const h = harness(t);
  await h.bridge.receive(request("init", "initialize", { protocolVersion: 1 }));
  await h.bridge.receive(request("auth", "authenticate", { methodId: "agent" }));
  await h.bridge.receive(request("bad-root", "session/new", { cwd: h.temporary, mcpServers: [] }));
  assert.equal(rpcResponse(h.outputs, "bad-root")?.error?.message, "editor_session_root_mismatch");
  await h.bridge.receive(request("bad-mcp", "session/new", { cwd: h.root, mcpServers: [{ name: "hostile" }] }));
  assert.equal(rpcResponse(h.outputs, "bad-mcp")?.error?.message, "editor_client_mcp_denied");
  await h.bridge.receive(request("bad-extra", "session/new", { cwd: h.root, mcpServers: [], additionalDirectories: [h.temporary] }));
  assert.equal(rpcResponse(h.outputs, "bad-extra")?.error?.message, "editor_additional_directories_denied");
  await h.bridge.receive(request("new", "session/new", { cwd: h.root, mcpServers: [] }));
  await h.bridge.receive(request("again", "session/new", { cwd: h.root, mcpServers: [] }));
  assert.equal(rpcResponse(h.outputs, "again")?.error?.message, "editor_session_limit");
});

test("client route changes, direct commands, slash commands, and unknown protocol methods never reach Pi", async (t) => {
  const h = harness(t);
  const sessionId = await initializeAndOpen(h);
  const initialCommands = h.fake.commands.length;
  await h.bridge.receive(request("route", "session/set_config_option", { sessionId, configId: "model", value: "hostile/model" }));
  await h.bridge.receive(request("terminal", "terminal/create", { sessionId, command: "sh" }));
  await h.bridge.receive(request("slash", "session/prompt", { sessionId, prompt: [{ type: "text", text: "/model hostile" }] }));
  assert.equal(rpcResponse(h.outputs, "route")?.error?.code, -32601);
  assert.equal(rpcResponse(h.outputs, "terminal")?.error?.code, -32601);
  assert.equal(rpcResponse(h.outputs, "slash")?.error?.message, "editor_slash_command_denied");
  assert.equal(h.fake.commands.length, initialCommands);
});

test("a prompt streams bounded ACP updates while receipts remain metadata-only", async (t) => {
  const h = harness(t);
  const sessionId = await initializeAndOpen(h);
  const secret = "PROMPT_SECRET_SHOULD_NOT_ENTER_RECEIPTS";
  await h.bridge.receive(request("prompt-1", "session/prompt", { sessionId, prompt: [{ type: "text", text: `Inspect the code. ${secret}` }] }));
  const result = rpcResponse(h.outputs, "prompt-1")?.result;
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.usage.totalTokens, 23);
  assert.ok(h.outputs.some((entry) => entry.method === "session/update" && entry.params.update.sessionUpdate === "agent_message_chunk"));
  assert.ok(h.outputs.some((entry) => entry.method === "session/update" && entry.params.update.sessionUpdate === "tool_call"));
  assert.ok(!JSON.stringify(h.outputs).includes("raw secret output"));
  const receiptFile = h.journal.file;
  await h.bridge.dispose("test_complete");
  const receipts = fs.readFileSync(receiptFile, "utf8");
  assert.ok(!receipts.includes(secret));
  assert.ok(!receipts.includes("secret.txt"));
  assert.ok(!receipts.includes("raw secret output"));
  assert.match(receipts, /"provider":"fixture"/u);
  assert.match(receipts, /"model":"deterministic"/u);
  assert.match(receipts, /"thinking":"low"/u);
});

test("concurrent prompts are rejected before a second Pi prompt command", async (t) => {
  const h = harness(t, "hold");
  const sessionId = await initializeAndOpen(h);
  const first = h.bridge.receive(request("first", "session/prompt", { sessionId, prompt: [{ type: "text", text: "First task" }] }));
  await waitFor(() => h.fake.commands.some((entry) => entry.type === "prompt"));
  await h.bridge.receive(request("second", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Second task" }] }));
  assert.equal(rpcResponse(h.outputs, "second")?.error?.message, "editor_session_busy");
  assert.equal(h.fake.commands.filter((entry) => entry.type === "prompt").length, 1);
  await h.fake.emit({ type: "agent_settled" });
  await first;
});

test("concurrent prompts are rejected even while the first route check is pending", async (t) => {
  const h = harness(t, "slow-state");
  const sessionId = await initializeAndOpen(h);
  const first = h.bridge.receive(request("first", "session/prompt", { sessionId, prompt: [{ type: "text", text: "First task" }] }));
  await h.bridge.receive(request("second", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Second task" }] }));
  await first;
  assert.equal(rpcResponse(h.outputs, "second")?.error?.message, "editor_session_busy");
  assert.equal(h.fake.commands.filter((entry) => entry.type === "prompt").length, 1);
});

test("mutation permission is one-shot, exactly correlated, and has no allow-always option", async (t) => {
  const h = harness(t, "permission");
  const sessionId = await initializeAndOpen(h);
  const prompt = h.bridge.receive(request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Apply the deterministic edit" }] }));
  const permission = await waitFor(() => h.outputs.find((entry) => entry.method === "session/request_permission"));
  assert.equal(permission.params.sessionId, sessionId);
  assert.equal(permission.params.toolCall.toolCallId, "call-edit-1");
  assert.deepEqual(permission.params.options.map((entry) => entry.optionId), ["allow_once", "reject_once"]);
  await h.bridge.receive({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  await prompt;
  assert.equal(h.fake.sent.find((entry) => entry.id === "ui-confirm-1")?.confirmed, true);
  assert.equal(rpcResponse(h.outputs, "prompt")?.result?.stopReason, "end_turn");
  const originalCount = h.outputs.filter((entry) => entry.method === "session/request_permission").length;
  await h.fake.emit({ type: "extension_ui_request", id: "ui-replay", method: "confirm", title: EDITOR_APPROVAL_TITLE, message: encodeEditorApproval("call-edit-1", "transactional_edit", "edit", editorApprovalIntent("transactional_edit", { action: "apply", path: "sensitive.ts" }).inputDigest) });
  assert.equal(h.fake.sent.find((entry) => entry.id === "ui-replay")?.confirmed, false);
  assert.equal(h.outputs.filter((entry) => entry.method === "session/request_permission").length, originalCount);
});

test("permission with a different target digest fails before it reaches the ACP client", async (t) => {
  const h = harness(t, "permission");
  const sessionId = await initializeAndOpen(h);
  const prompt = h.bridge.receive(request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Apply one edit" }] }));
  const genuine = await waitFor(() => h.outputs.find((entry) => entry.method === "session/request_permission"));
  const forgedDigest = editorApprovalIntent("transactional_edit", { action: "apply", path: "other.ts" }).inputDigest;
  await h.fake.emit({ type: "extension_ui_request", id: "ui-forged", method: "confirm", title: EDITOR_APPROVAL_TITLE, message: encodeEditorApproval("call-edit-1", "transactional_edit", "edit", forgedDigest) });
  assert.equal(h.fake.sent.find((entry) => entry.id === "ui-forged")?.confirmed, false);
  assert.equal(h.outputs.filter((entry) => entry.method === "session/request_permission").length, 1);
  await h.bridge.receive({ jsonrpc: "2.0", id: genuine.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  await prompt;
});

test("allow-always, unknown, cancelled, and malformed permission outcomes fail closed", async (t) => {
  const h = harness(t, "permission");
  const sessionId = await initializeAndOpen(h);
  const prompt = h.bridge.receive(request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Apply edit" }] }));
  const permission = await waitFor(() => h.outputs.find((entry) => entry.method === "session/request_permission"));
  await h.bridge.receive({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow_always" } } });
  await prompt;
  assert.equal(h.fake.sent.find((entry) => entry.id === "ui-confirm-1")?.confirmed, false);
  assert.ok(!JSON.stringify(h.outputs).includes("allow_always"));
});

test("permission responses with extra authority fields cannot grant a mutation", async (t) => {
  const h = harness(t, "permission");
  const sessionId = await initializeAndOpen(h);
  const prompt = h.bridge.receive(request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Apply edit" }] }));
  const permission = await waitFor(() => h.outputs.find((entry) => entry.method === "session/request_permission"));
  await h.bridge.receive({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow_once", persist: true } } });
  await prompt;
  assert.equal(h.fake.sent.find((entry) => entry.id === "ui-confirm-1")?.confirmed, false);
});

test("closing a session invalidates pending and late allow-once decisions", async (t) => {
  const h = harness(t, "permission");
  const sessionId = await initializeAndOpen(h);
  const prompt = h.bridge.receive(request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Apply edit" }] }));
  const permission = await waitFor(() => h.outputs.find((entry) => entry.method === "session/request_permission"));
  await h.bridge.receive(request("close", "session/close", { sessionId }));
  await h.bridge.receive({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  await prompt;
  assert.equal(h.fake.sent.some((entry) => entry.type === "extension_ui_response" && entry.confirmed === true), false);
  assert.equal(rpcResponse(h.outputs, "close")?.result !== undefined, true);
});

test("session cancellation aborts the exact Pi turn and returns cancelled without retry", async (t) => {
  const h = harness(t, "hold");
  const sessionId = await initializeAndOpen(h);
  const prompt = h.bridge.receive(request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Long task" }] }));
  await waitFor(() => h.fake.commands.some((entry) => entry.type === "prompt"));
  await h.bridge.receive({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  await prompt;
  assert.equal(h.fake.commands.filter((entry) => entry.type === "abort").length, 1);
  assert.equal(rpcResponse(h.outputs, "prompt")?.result?.stopReason, "cancelled");
});

test("route drift after a turn fails closed instead of silently accepting client-visible success", async (t) => {
  const h = harness(t, "hold");
  const sessionId = await initializeAndOpen(h);
  const prompt = h.bridge.receive(request("prompt", "session/prompt", { sessionId, prompt: [{ type: "text", text: "Task" }] }));
  await waitFor(() => h.fake.commands.some((entry) => entry.type === "prompt"));
  h.fake.route.id = "changed";
  await h.fake.emit({ type: "agent_settled" });
  await prompt;
  assert.equal(rpcResponse(h.outputs, "prompt")?.error?.message, "editor_route_drift");
});

test("fixed Pi child arguments preserve package routing and disable transcript persistence", () => {
  const args = editorBridgeChildArgs();
  assert.deepEqual(args.slice(0, 6), ["--offline", "--approve", "--no-session", "--mode", "rpc", "--extension"]);
  assert.ok(!args.some((entry) => ["--provider", "--model", "--thinking", "--api-key", "--tools", "--config"].includes(entry)));
  assert.ok(args.at(-1).endsWith("/extensions/editor-approval.ts"));
});
