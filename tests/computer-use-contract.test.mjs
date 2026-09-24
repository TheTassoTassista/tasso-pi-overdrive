import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTER_ACTIONS, ComputerUseController, unavailableComputerBackend } from "../lib/computer-use-contract.mjs";

const frameDigest = "a".repeat(64);
const artifactDigest = "b".repeat(64);
function fixture(platform = "linux") {
  let clock = 1000;
  let approved = true;
  let performed = 0;
  let currentFrame = frameDigest;
  const target = { id: "window-1", applicationId: "fixture.app", windowId: "window-1", processId: 42, epoch: "generation-1", classification: "ORDINARY", width: 800, height: 600 };
  const element = { id: "button-1", targetId: "window-1", epoch: "element-1", classification: "ORDINARY" };
  const backend = {
    platform,
    capabilities: Object.fromEntries(COMPUTER_ACTIONS.map((action) => [action, "REQUIRES_APPROVAL"])),
    async resolveTarget() { return { ...target }; },
    async resolveElement() { return { ...element }; },
    async currentFrameDigest() { return currentFrame; },
    async perform(action) {
      performed++;
      if (action.action === "screenshot") return { frameDigest, artifactDigest, classification: "REDACTED_SAFE" };
      if (action.action === "inspect") return { artifactDigest, classification: "REDACTED_SAFE" };
      return {};
    },
    async close() {},
  };
  const broker = new ComputerUseController({ backend, approve: async (request) => ({ approved, actionDigest: request.actionDigest }), now: () => clock });
  return { broker, backend, target, element, setClock(value) { clock = value; }, setApproved(value) { approved = value; }, setFrame(value) { currentFrame = value; }, get performed() { return performed; } };
}

test("Linux and Windows expose the same unavailable-by-default contract without host actions", async () => {
  for (const platform of ["linux", "win32"]) {
    const broker = new ComputerUseController({ backend: unavailableComputerBackend(platform), approve: async () => ({ approved: false }) });
    assert.equal(broker.capabilities().platform, platform);
    for (const action of COMPUTER_ACTIONS) assert.equal(broker.capabilities()[action], "UNAVAILABLE");
    await assert.rejects(broker.open("window-1"), /COMPUTER_BACKEND_UNAVAILABLE/u);
  }
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} fixture requires per-action approval, exact target and fresh frame while emitting metadata only`, async () => {
    const item = fixture(platform);
    const opened = await item.broker.open("window-1");
    assert.equal(opened.platform, platform);
    await assert.rejects(item.broker.execute({ sessionId: opened.sessionId, action: "click", frameDigest, x: 10, y: 20 }), /COMPUTER_FRAME_STALE/u);
    const capture = await item.broker.execute({ sessionId: opened.sessionId, action: "screenshot" });
    assert.equal(capture.frameDigest, frameDigest);
    assert.equal(capture.artifactDigest, artifactDigest);
    const click = await item.broker.execute({ sessionId: opened.sessionId, action: "click", frameDigest, x: 10, y: 20, elementId: "button-1" });
    assert.equal(click.status, "PASS");
    const typed = await item.broker.execute({ sessionId: opened.sessionId, action: "type", elementId: "button-1", text: "private text" });
    assert.equal(JSON.stringify(typed).includes("private text"), false);
    assert.equal(item.performed, 3);
    assert.deepEqual(await item.broker.revoke(opened.sessionId), { status: "REVOKED", sessionId: opened.sessionId });
    await assert.rejects(item.broker.execute({ sessionId: opened.sessionId, action: "inspect" }), /COMPUTER_SESSION_EXPIRED/u);
  });
}

test("approval denial, target replacement, stale frame and changed element all fail before input", async () => {
  const item = fixture();
  const { sessionId } = await item.broker.open("window-1");
  item.setApproved(false);
  await assert.rejects(item.broker.execute({ sessionId, action: "screenshot" }), /COMPUTER_APPROVAL_DENIED/u);
  assert.equal(item.performed, 0);
  item.setApproved(true);
  await item.broker.execute({ sessionId, action: "screenshot" });
  item.setClock(7001);
  await assert.rejects(item.broker.execute({ sessionId, action: "click", frameDigest, x: 10, y: 20 }), /COMPUTER_FRAME_STALE/u);
  item.setClock(2000);
  item.setFrame("c".repeat(64));
  await assert.rejects(item.broker.execute({ sessionId, action: "click", frameDigest, x: 10, y: 20 }), /COMPUTER_FRAME_STALE/u);
  item.target.epoch = "generation-2";
  await assert.rejects(item.broker.execute({ sessionId, action: "focus", elementId: "button-1" }), /COMPUTER_TARGET_CHANGED/u);
  assert.equal(item.performed, 1);
});

test("element replacement during approval is rejected before type or focus reaches the backend", async () => {
  const item = fixture("win32");
  const { sessionId } = await item.broker.open("window-1");
  item.broker.approve = async (request) => {
    item.element.epoch = "element-2";
    return { approved: true, actionDigest: request.actionDigest };
  };
  await assert.rejects(item.broker.execute({ sessionId, action: "type", elementId: "button-1", text: "safe" }), /COMPUTER_ELEMENT_CHANGED/u);
  assert.equal(item.performed, 0);
});

test("malformed, global, shell-like and protected-key requests never reach a backend", async () => {
  const item = fixture();
  const { sessionId } = await item.broker.open("window-1");
  const denied = [
    { sessionId, action: "execute", command: "sh" },
    { sessionId, action: "click", x: 1, y: 1, frameDigest, host: "0.0.0.0" },
    { sessionId, action: "type", elementId: "button-1", text: "\u0000" },
    { sessionId, action: "key", elementId: "button-1", key: "Win+R" },
    { sessionId, action: "focus" },
  ];
  for (const request of denied) await assert.rejects(item.broker.execute(request), /COMPUTER_/u);
  assert.equal(item.performed, 0);
});

test("sensitive target and unredacted screenshot are denied; revocation during consent prevents execution", async () => {
  const item = fixture();
  item.target.classification = "CREDENTIAL_DIALOG";
  await assert.rejects(item.broker.open("window-1"), /COMPUTER_SENSITIVE_TARGET_DENIED/u);
  item.target.classification = "ORDINARY";
  item.backend.perform = async () => ({ frameDigest, artifactDigest, classification: "RAW" });
  const { sessionId } = await item.broker.open("window-1");
  await assert.rejects(item.broker.execute({ sessionId, action: "screenshot" }), /COMPUTER_CAPTURE_UNSAFE/u);
  await item.broker.revoke(sessionId);

  const pending = fixture();
  let release;
  pending.broker.approve = (request) => new Promise((resolve) => { release = () => resolve({ approved: true, actionDigest: request.actionDigest }); });
  const opened = await pending.broker.open("window-1");
  const action = pending.broker.execute({ sessionId: opened.sessionId, action: "inspect" });
  await Promise.resolve();
  await Promise.resolve();
  await pending.broker.revoke(opened.sessionId);
  release();
  await assert.rejects(action, /COMPUTER_ACTION_CANCELLED/u);
  assert.equal(pending.performed, 0);
});

test("revocation aborts an in-flight backend action without returning a success receipt", async () => {
  const item = fixture();
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  item.backend.perform = (_action, _target, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("backend aborted")), { once: true });
    started();
  });
  const { sessionId } = await item.broker.open("window-1");
  const execution = item.broker.execute({ sessionId, action: "inspect" });
  await entered;
  await item.broker.revoke(sessionId);
  await assert.rejects(execution, /COMPUTER_ACTION_CANCELLED/u);
});
