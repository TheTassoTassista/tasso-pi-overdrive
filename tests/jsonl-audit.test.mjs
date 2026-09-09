import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonlRecords } from "../lib/jsonl-audit.mjs";

test("a power-truncated final JSONL record preserves all prior valid records", () => {
  const result = parseJsonlRecords('{"status":"PASS"}\n{"status":"RUNNING"}\n{"status":');
  assert.deepEqual(result.records.map((entry) => entry.status), ["PASS", "RUNNING"]);
  assert.equal(result.truncatedTail, true);
  assert.deepEqual(result.errors, []);
});

test("a malformed complete or interior record is not tolerated", () => {
  const result = parseJsonlRecords('{"ok":true}\nnot-json\n{"ok":false}\n');
  assert.equal(result.records.length, 2);
  assert.equal(result.truncatedTail, false);
  assert.deepEqual(result.errors, [{ line: 2, reason: "malformed-complete-record" }]);
});
