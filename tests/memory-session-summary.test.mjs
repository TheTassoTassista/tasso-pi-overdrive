import test from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionSummaryStore } from "../lib/memory-session-summary.mjs";
import secondBrainExtension from "../extensions/second-brain.ts";

test("session summary explains attached memory without retaining content or source paths", () => {
  const store = createMemorySessionSummaryStore();
  const secretContent = "private retrieved memory body";
  const privateSource = "file:///home/user/private/project.md";
  store.record({
    outcome: "ATTACHED",
    pack: {
      route: { decision: "MIXED", sources: ["openviking", "hindsight"], reasons: ["project-context", "temporal-intent"] },
      metadata: { status: "PARTIAL", candidateCount: 4, itemCount: 2, approximateTokens: 37, degradationCount: 1 },
      items: [
        { id: "memory-1", backend: "openviking", trustLevel: "PROJECT_DOC", level: 0, content: secretContent, source: privateSource },
        { id: "memory-2", backend: "hindsight", trustLevel: "USER", level: 1, content: secretContent, source: privateSource },
      ],
      text: secretContent,
    },
  });

  const summary = store.render();
  assert.match(summary, /ATTACHED; retrieval status=PARTIAL/u);
  assert.match(summary, /Route=MIXED; sources=openviking, hindsight/u);
  assert.match(summary, /project-context, temporal-intent/u);
  assert.match(summary, /Candidates=4; entries attached=2; estimated context=37 tokens; degraded sources=1/u);
  assert.match(summary, /memory-1 \[openviking; PROJECT_DOC; L0\]/u);
  assert.match(summary, /whether the model semantically used it cannot be observed/u);
  assert.doesNotMatch(summary, /private retrieved memory body|file:\/\/|\/home\/user/u);
  assert.equal(JSON.stringify(store.current()).includes(secretContent), false);
  assert.equal(JSON.stringify(store.current()).includes(privateSource), false);
});

test("session summary records deliberate skips and unavailable retrieval distinctly", () => {
  const store = createMemorySessionSummaryStore();
  assert.match(store.render(), /No automatic memory decision/u);

  store.record({ outcome: "SKIPPED", reason: "task-policy-current-context-sufficient" });
  assert.match(store.render(), /SKIPPED; retrieval status=SKIPPED/u);
  assert.match(store.render(), /Reason=task-policy-current-context-sufficient/u);
  assert.match(store.render(), /sources=none/u);

  store.record({ outcome: "EMPTY", pack: {
    route: { decision: "HINDSIGHT", sources: ["hindsight"], reasons: ["temporal-intent"] },
    metadata: { status: "DEGRADED", candidateCount: 0, itemCount: 0, approximateTokens: 0, degradationCount: 1 },
    items: [],
    text: "",
  } });
  assert.match(store.render(), /EMPTY; retrieval status=DEGRADED/u);
  assert.match(store.render(), /sources=hindsight/u);
  assert.match(store.render(), /degraded sources=1/u);

  store.record({ outcome: "UNAVAILABLE", reason: "retrieval-error" });
  assert.match(store.render(), /UNAVAILABLE; retrieval status=UNKNOWN/u);
  assert.match(store.render(), /Reason=retrieval-error/u);
});

test("summary sanitizes malformed metadata and resets at a session boundary", () => {
  const store = createMemorySessionSummaryStore();
  store.record({ outcome: "ATTACHED", pack: {
    route: { decision: "MIXED\nBearer secret", sources: ["openviking", "private-token"], reasons: ["project-context", "token=secret"] },
    metadata: { status: "OK\nsecret", candidateCount: -1, itemCount: 1, approximateTokens: 10, degradationCount: 0 },
    items: [{ id: "id\u001b[31msecret", backend: "private-token", trustLevel: "USER\nsecret", level: 8 }],
  } });
  const summary = store.render();
  assert.match(summary, /Route=UNKNOWN; sources=openviking/u);
  assert.match(summary, /Reason=project-context/u);
  assert.match(summary, /entry-id-withheld \[UNKNOWN; UNKNOWN; level unknown\]/u);
  assert.doesNotMatch(summary, /Bearer secret|token=secret|private-token|\u001b/u);

  store.reset();
  assert.equal(store.current(), null);
  assert.match(store.render(), /No automatic memory decision/u);
});

test("Second Brain command reports the actual session policy skip and resets on a new session", async () => {
  const hooks = new Map();
  const commands = new Map();
  const statuses = [];
  const notices = [];
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    events: { emit() {} },
  };
  secondBrainExtension(pi);
  assert.ok(commands.has("memory-last"));
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => undefined,
    ui: {
      setStatus: (...args) => statuses.push(args),
      notify: (message, level) => notices.push({ message, level }),
    },
  };

  hooks.get("session_start")({}, ctx);
  await hooks.get("before_agent_start")({ messageType: "user", prompt: "Change src/index.ts line 7" }, ctx);
  assert.deepEqual(statuses.at(-1), ["second-brain", "memory: skipped (context sufficient)"]);
  await commands.get("memory-last").handler("", ctx);
  assert.match(notices.at(-1).message, /SKIPPED/u);
  assert.match(notices.at(-1).message, /task-policy-current-context-sufficient/u);
  assert.match(notices.at(-1).message, /semantically used it cannot be observed/u);

  hooks.get("session_start")({}, ctx);
  await commands.get("memory-last").handler("", ctx);
  assert.match(notices.at(-1).message, /No automatic memory decision/u);
});
