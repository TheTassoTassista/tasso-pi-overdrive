import test from "node:test";
import assert from "node:assert/strict";
import { syncDirectory } from "../lib/portable-directory-sync.mjs";

test("Windows directory sync is explicitly unsupported without masking file flush", () => {
  const filesystem = { openSync() { throw new Error("directory open must not occur"); } };
  assert.equal(syncDirectory("unused", { platform: "win32", filesystem }), "UNSUPPORTED_ON_WINDOWS");
});

test("POSIX directory sync flushes and closes the handle", () => {
  const calls = [];
  const filesystem = {
    constants: { O_RDONLY: 0, O_DIRECTORY: 65536 },
    openSync(directory, flags) { calls.push(["open", directory, flags]); return 7; },
    fsyncSync(fd) { calls.push(["fsync", fd]); },
    closeSync(fd) { calls.push(["close", fd]); },
  };
  assert.equal(syncDirectory("fixture", { platform: "linux", filesystem }), "SYNCED");
  assert.deepEqual(calls, [["open", "fixture", 65536], ["fsync", 7], ["close", 7]]);
});

test("POSIX directory sync failures propagate after closing the handle", () => {
  const calls = [];
  const filesystem = {
    constants: { O_RDONLY: 0, O_DIRECTORY: 65536 },
    openSync() { return 7; },
    fsyncSync() { throw Object.assign(new Error("flush failed"), { code: "EIO" }); },
    closeSync(fd) { calls.push(fd); },
  };
  assert.throws(() => syncDirectory("fixture", { platform: "linux", filesystem }), { code: "EIO" });
  assert.deepEqual(calls, [7]);
});
