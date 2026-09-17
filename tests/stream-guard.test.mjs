import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  StreamGuardEngine,
  classifyStreamGuardIntent,
  consumeBlockedStreamGuard,
  registerStreamGuardSession,
  streamGuardMetadata,
  unregisterStreamGuardSession,
  validateStreamGuardPolicy,
} from "../lib/stream-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "config", "stream-guard.json"), "utf8"));

test("policy bounds reminders, reservations, buffers, and cooldown", () => {
  const checked = validateStreamGuardPolicy(policy);
  assert.equal(checked.maxReservationsPerTurn, 1);
  assert.equal(checked.cooldownTurns, 2);
  assert.throws(() => validateStreamGuardPolicy({ ...policy, injectPrompt: true }), /STREAM_GUARD_POLICY_UNKNOWN_FIELD/u);
  const widened = structuredClone(policy);
  widened.maxReservationsPerSession = 1000;
  assert.throws(() => validateStreamGuardPolicy(widened), /STREAM_GUARD_SESSION_LIMIT_INVALID/u);
});

test("streamed destructive arguments reserve once before the same safety-blocked result and deliver metadata-only correction", () => {
  let now = 1000;
  const engine = new StreamGuardEngine({ policy, now: () => now++ });
  const persisted = [];
  const owner = registerStreamGuardSession("session-a", engine, (receipt) => persisted.push(receipt));
  engine.beginTurn();
  engine.startTool("call-secret-value", "bash");
  assert.equal(engine.observeToolDelta("call-secret-value", "bash", "{\"command\":\"rm -"), undefined);
  const reserved = engine.observeToolDelta("call-secret-value", "bash", "rf ./fixture\"}");
  assert.equal(reserved.status, "RESERVED");
  assert.equal(engine.observeToolSnapshot("call-secret-value", "bash", { command: "rm -rf ./fixture" }), undefined);
  assert.equal(consumeBlockedStreamGuard("different-session", "call-secret-value", "bash"), undefined);
  assert.equal(consumeBlockedStreamGuard("session-a", "call-secret-value", "read"), undefined);
  const delivered = consumeBlockedStreamGuard("session-a", "call-secret-value", "bash");
  assert.equal(delivered.receipt.status, "DELIVERED");
  assert.equal(delivered.receipt.outcome, "SAME_BLOCKED_TOOL_RESULT");
  assert.match(delivered.reminder, /^ERROR \[STREAMGUARD\]/u);
  const serialized = JSON.stringify([reserved, delivered.receipt, streamGuardMetadata(delivered.receipt)]);
  assert.doesNotMatch(serialized, /rm -rf|fixture|secret-value/u);
  assert.equal(engine.status().stats.reservations, 1);
  assert.equal(engine.status().stats.delivered, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].reservationDigest, reserved.reservationDigest);
  assert.equal(unregisterStreamGuardSession("session-a", Symbol("wrong-owner")), false);
  assert.equal(unregisterStreamGuardSession("session-a", owner), true);
  assert.equal(consumeBlockedStreamGuard("session-a", "call-secret-value", "bash"), undefined);
});

test("protected paths and safe-exec bypasses are classified without examining prompts or tool output", () => {
  assert.equal(classifyStreamGuardIntent("read", { path: ".env.production" }, policy), "protected-path-intent");
  assert.equal(classifyStreamGuardIntent("write", { path: ".git/config", content: "safe" }, policy), "protected-path-intent");
  assert.equal(classifyStreamGuardIntent("safe_exec", { program: "python3", args: ["-c", "print(1)"] }, policy), "safe-exec-bypass-intent");
  assert.equal(classifyStreamGuardIntent("safe_exec", { program: "git", args: ["status"] }, policy), undefined);
  assert.equal(classifyStreamGuardIntent("read", { path: "src/index.ts" }, policy), undefined);
});

test("incomplete, malformed, and safe streamed arguments do not reserve a correction", () => {
  const engine = new StreamGuardEngine({ policy, now: () => 1 });
  engine.beginTurn();
  engine.startTool("partial", "bash");
  assert.equal(engine.observeToolDelta("partial", "bash", '{"command":"rm -rf'), undefined);
  assert.equal(engine.observeToolSnapshot("malformed", "bash", "rm -rf ./fixture"), undefined);
  assert.equal(engine.observeToolSnapshot("safe", "bash", { command: "git status --short" }), undefined);
  assert.equal(engine.status().pending, 0);
  assert.equal(engine.status().stats.malformedArguments, 1);
});

test("session replacement and receipt persistence failure drop correction fail-closed", () => {
  const oldEngine = new StreamGuardEngine({ policy, now: () => 1 });
  oldEngine.beginTurn();
  oldEngine.observeToolSnapshot("old-call", "bash", { command: "reboot" });
  const oldOwner = registerStreamGuardSession("replacement-session", oldEngine, () => {});
  const newEngine = new StreamGuardEngine({ policy, now: () => 2 });
  newEngine.beginTurn();
  const newOwner = registerStreamGuardSession("replacement-session", newEngine, () => { throw new Error("receipt unavailable"); });
  assert.equal(consumeBlockedStreamGuard("replacement-session", "old-call", "bash"), undefined);
  newEngine.observeToolSnapshot("new-call", "bash", { command: "reboot" });
  assert.equal(consumeBlockedStreamGuard("replacement-session", "new-call", "bash"), undefined);
  assert.equal(unregisterStreamGuardSession("replacement-session", oldOwner), false);
  assert.equal(unregisterStreamGuardSession("replacement-session", newOwner), true);
});

test("per-turn, cooldown, and session limits cannot be overridden by observed input", () => {
  const bounded = structuredClone(policy);
  bounded.maxReservationsPerSession = 2;
  const engine = new StreamGuardEngine({ policy: bounded, now: () => 1 });
  engine.beginTurn();
  assert.equal(engine.observeToolSnapshot("one", "read", { path: ".env" })?.status, "RESERVED");
  assert.equal(engine.observeToolSnapshot("two", "bash", { command: "shutdown now" }), undefined);
  engine.expirePending();
  engine.beginTurn();
  assert.equal(engine.observeToolSnapshot("three", "read", { path: ".env.local" }), undefined);
  engine.beginTurn();
  assert.equal(engine.observeToolSnapshot("four", "read", { path: ".env.test" })?.status, "RESERVED");
  engine.expirePending();
  engine.beginTurn();
  assert.equal(engine.observeToolSnapshot("five", "bash", { command: "shutdown now" }), undefined);
  assert.equal(engine.status().reservationCount, 2);
});

test("persisted reservations restore suppression but never replay a correction", () => {
  const first = new StreamGuardEngine({ policy, now: () => 10 });
  first.beginTurn();
  const receipt = first.observeToolSnapshot("call-a", "bash", { command: "reboot" });
  const restored = new StreamGuardEngine({ policy, receipts: [receipt], now: () => 20 });
  assert.equal(restored.status().pending, 0);
  restored.beginTurn();
  assert.equal(restored.observeToolSnapshot("call-b", "bash", { command: "reboot" }), undefined);
  assert.equal(restored.deliver("call-a"), undefined);
});

test("terminal cleanup expires a reservation and disables post-shutdown injection", () => {
  const engine = new StreamGuardEngine({ policy, now: () => 50 });
  engine.beginTurn();
  engine.observeToolSnapshot("call-a", "read", { path: ".ssh/id_ed25519" });
  const expired = engine.shutdown();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, "EXPIRED");
  assert.equal(engine.deliver("call-a"), undefined);
  assert.equal(engine.observeToolSnapshot("call-b", "read", { path: ".env" }), undefined);
});
