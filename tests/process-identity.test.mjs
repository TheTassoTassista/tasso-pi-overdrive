import test from "node:test";
import assert from "node:assert/strict";
import { captureProcessIdentity, inspectProcessIdentity, parseProcessIdentity } from "../lib/process-identity.mjs";

const windows = { kind: "windows-process-creation", version: 1, pid: 4242, creationTime: "ffffffffffffffff" };

test("legacy Linux process identity retains its original generation semantics", () => {
  const legacy = { pid: 4242, bootId: "boot", startTicks: "9007199254740993" };
  assert.deepEqual(parseProcessIdentity(legacy, "linux"), { kind: "linux-proc", version: 1, ...legacy });
  assert.equal(parseProcessIdentity(legacy, "win32"), null);
  assert.equal(parseProcessIdentity({ kind: "linux-proc", version: 1, ...legacy }, "linux")?.startTicks, legacy.startTicks);
});

test("Windows process generation is tagged, lossless and compared exactly", () => {
  const captured = captureProcessIdentity(4242, { platform: "win32", windowsQuery: () => ({ pid: 4242, alive: true, creationTime: windows.creationTime }) });
  assert.deepEqual(captured, windows);
  assert.deepEqual(JSON.parse(JSON.stringify(captured)), windows);
  assert.equal(inspectProcessIdentity(windows, { platform: "win32", windowsQuery: () => ({ pid: 4242, alive: true, creationTime: windows.creationTime }) }).alive, true);
  assert.equal(inspectProcessIdentity(windows, { platform: "win32", windowsQuery: () => ({ pid: 4242, alive: true, creationTime: "fffffffffffffffe" }) }).reason, "pid-reused");
  assert.equal(inspectProcessIdentity(windows, { platform: "win32", windowsQuery: () => ({ pid: 4242, alive: false, creationTime: null }) }).alive, false);
});

test("unknown, malformed and unavailable process identities fail closed", () => {
  for (const identity of [
    { ...windows, kind: "unknown" }, { ...windows, version: 2 }, { ...windows, creationTime: "90071992547409931" },
    { ...windows, creationTime: 18446744073709551615 }, { pid: 4242, bootId: "boot", startTicks: "1" },
  ]) {
    assert.equal(parseProcessIdentity(identity, "win32"), null);
    assert.equal(inspectProcessIdentity(identity, { platform: "win32" }).alive, null);
  }
  assert.equal(inspectProcessIdentity(windows, { platform: "win32", windowsQuery: () => { throw new Error("access denied"); } }).alive, null);
  assert.equal(inspectProcessIdentity(windows, { platform: "win32", windowsQuery: () => ({ pid: 4242, alive: true, creationTime: null }) }).alive, null);
  assert.throws(() => captureProcessIdentity(4242, { platform: "win32", windowsQuery: () => ({ pid: 4242, alive: true, creationTime: "1" }) }), /unavailable/u);
});
